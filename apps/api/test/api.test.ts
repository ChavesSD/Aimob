import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/client.js';
import { makeTestDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { seedDemo } from '../src/db/seed.js';
import { scoreLead } from '../src/domain/scoring.js';
import { propertyHealth } from '../src/domain/propertyHealth.js';
import { signToken } from '../src/auth.js';
import { assignRoundRobin } from '../src/domain/distribution.js';
import { config } from '../src/config.js';

const PW = 'senha-de-teste-123';
let db: Db;
let app: FastifyInstance;

const tokens = new Map<string, string>();
async function login(email: string): Promise<string> {
  const cached = tokens.get(email);
  if (cached) return cached;
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
  expect(r.statusCode).toBe(200);
  tokens.set(email, r.json().token);
  return r.json().token;
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  config.jwtSecret = 'x'.repeat(40);
  db = await makeTestDb();
  app = await buildApp(db);
  await seedDemo(db, { tenantName: 'A', password: PW, emailPrefix: 'a' });
  await seedDemo(db, { tenantName: 'B', password: PW, emailPrefix: 'b' });
}, 60_000);

describe('autenticação', () => {
  it('rejeita senha errada e rota sem token', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@a.demo', password: 'errada' } });
    expect(bad.statusCode).toBe(401);
    expect((await app.inject({ url: '/api/dashboard' })).statusCode).toBe(401);
  });

  it('rejeita JWT sem exp', async () => {
    const { SignJWT } = await import('jose');
    const t = await new SignJWT({ tid: 'x', role: 'owner' }).setProtectedHeader({ alg: 'HS256' }).setSubject('x')
      .sign(new TextEncoder().encode(config.jwtSecret));
    expect((await app.inject({ url: '/api/dashboard', headers: auth(t) })).statusCode).toBe(401);
  });
});

describe('isolamento entre tenants', () => {
  it('lista apenas dados do próprio tenant', async () => {
    const a = await login('owner@a.demo');
    const r = await app.inject({ url: '/api/properties?limit=100', headers: auth(a) });
    const { items, total } = r.json();
    expect(total).toBe(40);
    const { rows } = await db.query<any>('SELECT tenant_id FROM users WHERE email = $1', ['owner@a.demo']);
    const ids = items.map((i: any) => i.id);
    const { rows: foreign } = await db.query('SELECT id FROM properties WHERE id = ANY($1::uuid[]) AND tenant_id <> $2', [ids, rows[0].tenant_id]);
    expect(foreign).toHaveLength(0);
  });

  it('IDOR: tenant A não lê nem altera imóvel do tenant B', async () => {
    const a = await login('owner@a.demo');
    const b = await login('owner@b.demo');
    const bList = (await app.inject({ url: '/api/properties?limit=1', headers: auth(b) })).json();
    const bId = bList.items[0].id;
    expect((await app.inject({ url: `/api/properties/${bId}`, headers: auth(a) })).statusCode).toBe(404);
    const patch = await app.inject({ method: 'PATCH', url: `/api/properties/${bId}`, headers: auth(a), payload: { priceCents: 1 } });
    expect(patch.statusCode).toBe(404);
    expect((await app.inject({ url: `/api/properties/${bId}`, headers: auth(b) })).statusCode).toBe(200);
  });

  it('não vincula lead a imóvel de outro tenant', async () => {
    const a = await login('owner@a.demo');
    const b = await login('owner@b.demo');
    const bId = (await app.inject({ url: '/api/properties?limit=1', headers: auth(b) })).json().items[0].id;
    const r = await app.inject({ method: 'POST', url: '/api/leads', headers: auth(a), payload: { name: 'Teste', propertyId: bId } });
    expect(r.statusCode).toBe(404);
  });

  it('dashboard e auditoria são por tenant', async () => {
    const a = await login('owner@a.demo');
    const r = await app.inject({ url: '/api/audit', headers: auth(a) });
    expect(r.statusCode).toBe(200);
    const d = (await app.inject({ url: '/api/dashboard', headers: auth(a) })).json();
    expect(d.kpis.activeProperties).toBe(36); // 40 imóveis, 4 alugados
    expect(d.attention.length).toBeGreaterThan(0);
    expect(d.attention.every((x: any) => x.action.href)).toBe(true);
  });
});

describe('filtros dos alertas', () => {
  it('filtro do CRM bate com a contagem do alerta do dashboard', async () => {
    const a = await login('owner@a.demo');
    const d = (await app.inject({ url: '/api/dashboard', headers: auth(a) })).json();
    const alert = d.attention.find((x: any) => x.id === 'leads-sem-atendimento');
    const r = (await app.inject({ url: '/api/leads?limit=100&filtro=sem-atendimento', headers: auth(a) })).json();
    expect(r.items).toHaveLength(alert.count);
    const bad = await app.inject({ url: '/api/leads?filtro=1%20OR%201=1', headers: auth(a) });
    expect(bad.statusCode).toBe(400);
  });
  it('filtro de imóveis com poucas fotos', async () => {
    const a = await login('owner@a.demo');
    const r = (await app.inject({ url: '/api/properties?filtro=poucas-fotos&limit=100', headers: auth(a) })).json();
    expect(r.items.every((p: any) => p.photos < 5)).toBe(true);
  });
});

describe('visitas e pipeline', () => {
  const inDays = (d: number, h: number) => { const x = new Date(Date.now() + d * 86_400_000); x.setUTCHours(h, 0, 0, 0); return x.toISOString(); };
  async function firstLeadAndProperty(email: string) {
    const t = await login(email);
    const lead = (await app.inject({ url: '/api/leads?limit=1', headers: auth(t) })).json().items[0];
    const prop = (await app.inject({ url: '/api/properties?limit=1', headers: auth(t) })).json().items[0];
    return { t, lead, prop };
  }

  it('agenda visita, bloqueia conflito de horário e atualiza o score', async () => {
    const { t, lead, prop } = await firstLeadAndProperty('manager@a.demo');
    const before = lead.score;
    const when = inDays(20, 14);
    const ok = await app.inject({ method: 'POST', url: '/api/visits', headers: auth(t), payload: { leadId: lead.id, propertyId: prop.id, scheduledAt: when } });
    expect(ok.statusCode).toBe(201);
    const clash = await app.inject({ method: 'POST', url: '/api/visits', headers: auth(t), payload: { leadId: lead.id, propertyId: prop.id, scheduledAt: inDays(20, 14) } });
    expect(clash.statusCode).toBe(409);
    const after = (await app.inject({ url: '/api/leads?limit=100', headers: auth(t) })).json().items.find((l: any) => l.id === lead.id);
    expect(after.score).toBeGreaterThanOrEqual(before);
    expect(after.stage_position).toBeGreaterThanOrEqual(0);
  });

  it('recusa horário passado e lead/imóvel de outro tenant', async () => {
    const { t, lead, prop } = await firstLeadAndProperty('owner@a.demo');
    const past = await app.inject({ method: 'POST', url: '/api/visits', headers: auth(t), payload: { leadId: lead.id, propertyId: prop.id, scheduledAt: inDays(-3, 10) } });
    expect(past.statusCode).toBe(400);
    const b = await firstLeadAndProperty('owner@b.demo');
    const cross = await app.inject({ method: 'POST', url: '/api/visits', headers: auth(t), payload: { leadId: b.lead.id, propertyId: prop.id, scheduledAt: inDays(25, 10) } });
    expect(cross.statusCode).toBe(404);
    const cross2 = await app.inject({ method: 'POST', url: '/api/visits', headers: auth(t), payload: { leadId: lead.id, propertyId: b.prop.id, scheduledAt: inDays(26, 10) } });
    expect(cross2.statusCode).toBe(404);
  });

  it('feedback registra resultado uma única vez e escreve na vida do imóvel', async () => {
    const t = await login('owner@a.demo');
    const pending = (await app.inject({ url: '/api/visits?filtro=sem-feedback', headers: auth(t) })).json().items;
    expect(pending.length).toBeGreaterThan(0);
    const v = pending[0];
    const r = await app.inject({ method: 'POST', url: `/api/visits/${v.id}/feedback`, headers: auth(t), payload: { outcome: 'gostou', notes: 'achou a cozinha pequena' } });
    expect(r.statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: `/api/visits/${v.id}/feedback`, headers: auth(t), payload: { outcome: 'gostou' } });
    expect(again.statusCode).toBe(409);
    const left = (await app.inject({ url: '/api/visits?filtro=sem-feedback', headers: auth(t) })).json().items;
    expect(left.find((x: any) => x.id === v.id)).toBeUndefined();
  });

  it('tenant B não registra feedback em visita do tenant A', async () => {
    const a = await login('owner@a.demo');
    const b = await login('owner@b.demo');
    const v = (await app.inject({ url: '/api/visits?filtro=proximas', headers: auth(a) })).json().items[0];
    const r = await app.inject({ method: 'POST', url: `/api/visits/${v.id}/feedback`, headers: auth(b), payload: { outcome: 'gostou' } });
    expect(r.statusCode).toBe(404);
  });

  it('kanban move etapa, valida limites e audita com texto legível', async () => {
    const t = await login('owner@a.demo');
    const board = (await app.inject({ url: '/api/pipeline/venda', headers: auth(t) })).json();
    expect(board.stages).toHaveLength(10);
    const lead = board.stages.find((s: any) => s.leads.length).leads[0];
    expect((await app.inject({ method: 'POST', url: `/api/leads/${lead.id}/stage`, headers: auth(t), payload: { position: 99 } })).statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: `/api/leads/${lead.id}/stage`, headers: auth(t), payload: { position: 6 } });
    expect(ok.json().stage).toBe('Negociação');
    const audit = (await app.inject({ url: '/api/audit', headers: auth(t) })).json().items;
    expect(audit.some((a: any) => /Etapa alterada de ".*" para "Negociação"/.test(a.summary ?? ''))).toBe(true);
    const b = await login('owner@b.demo');
    expect((await app.inject({ method: 'POST', url: `/api/leads/${lead.id}/stage`, headers: auth(b), payload: { position: 2 } })).statusCode).toBe(404);
  });

  it('papel é lido do banco: token antigo não preserva privilégio após rebaixamento', async () => {
    const { t, lead, prop } = await firstLeadAndProperty('manager@b.demo');
    await db.query(`UPDATE users SET role = 'marketing' WHERE email = 'manager@b.demo'`);
    const r = await app.inject({ method: 'POST', url: '/api/visits', headers: auth(t), payload: { leadId: lead.id, propertyId: prop.id, scheduledAt: inDays(30, 10) } });
    expect(r.statusCode).toBe(403);
    await db.query(`UPDATE users SET role = 'manager' WHERE email = 'manager@b.demo'`);
  });
});

describe('distribuição de leads', () => {
  const newLead = (t: string, name: string, source = 'portal') =>
    app.inject({ method: 'POST', url: '/api/leads', headers: auth(t), payload: { name, source } });
  const ownerOf = async (t: string, id: string) =>
    (await app.inject({ url: '/api/leads?limit=100', headers: auth(t) })).json().items.find((l: any) => l.id === id)?.owner_id;

  it('rodízio reparte leads de canal igualmente entre os corretores ativos', async () => {
    const t = await login('owner@a.demo');
    expect((await app.inject({ method: 'PUT', url: '/api/settings/distribution', headers: auth(t), payload: { mode: 'roundrobin' } })).statusCode).toBe(200);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await newLead(t, `Rodizio ${i}`)).json().id);
    const owners = await Promise.all(ids.map((id) => ownerOf(t, id)));
    const counts = new Map<string, number>();
    owners.forEach((o) => counts.set(o, (counts.get(o) ?? 0) + 1));
    expect(counts.size).toBe(3);
    expect(Math.max(...counts.values()) - Math.min(...counts.values())).toBeLessThanOrEqual(1);
  });

  it('lead manual fica com quem cadastrou, mesmo com rodízio ligado', async () => {
    const t = await login('manager@a.demo');
    const id = (await newLead(t, 'Manual Gerente', 'manual')).json().id;
    const me = (await app.inject({ url: '/api/team', headers: auth(t) })).json().items.find((u: any) => u.role === 'manager').id;
    expect(await ownerOf(t, id)).toBe(me);
  });

  it('corretor que não aceita leads e corretor inativo são pulados', async () => {
    const t = await login('owner@a.demo');
    const team = (await app.inject({ url: '/api/team', headers: auth(t) })).json().items.filter((u: any) => u.role === 'broker');
    const skip = team[0].id;
    expect((await app.inject({ method: 'PUT', url: `/api/team/${skip}/accepts-leads`, headers: auth(t), payload: { acceptsLeads: false } })).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) {
      const id = (await newLead(t, `Skip ${i}`)).json().id;
      expect(await ownerOf(t, id)).not.toBe(skip);
    }
    await app.inject({ method: 'PUT', url: `/api/team/${skip}/accepts-leads`, headers: auth(t), payload: { acceptsLeads: true } });
  });

  it('não distribui para corretor de outro tenant nem atribui a ele', async () => {
    const a = await login('owner@a.demo');
    const b = await login('owner@b.demo');
    const bBroker = (await app.inject({ url: '/api/team', headers: auth(b) })).json().items.find((u: any) => u.role === 'broker').id;
    const aLeads = (await app.inject({ url: '/api/leads?limit=1', headers: auth(a) })).json().items[0].id;
    const r = await app.inject({ method: 'POST', url: `/api/leads/${aLeads}/assign`, headers: auth(a), payload: { ownerId: bBroker } });
    expect(r.statusCode).toBe(404);
    const teamA = (await app.inject({ url: '/api/team', headers: auth(a) })).json().items.map((u: any) => u.id);
    expect(teamA).not.toContain(bBroker);
  });

  it('só gestão atribui e altera regra; corretor recebe 403', async () => {
    const broker = await login('broker@a.demo');
    const lead = (await app.inject({ url: '/api/leads?limit=1', headers: auth(broker) })).json().items[0].id;
    expect((await app.inject({ method: 'POST', url: `/api/leads/${lead}/assign`, headers: auth(broker), payload: { ownerId: lead } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/leads/distribute', headers: auth(broker) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/distribution', headers: auth(broker), payload: { mode: 'manual' } })).statusCode).toBe(403);
  });

  it('distribui em lote os leads sem responsável e alerta some', async () => {
    const t = await login('owner@a.demo');
    const before = (await app.inject({ url: '/api/dashboard', headers: auth(t) })).json().attention.find((x: any) => x.id === 'leads-sem-responsavel');
    expect(before.count).toBe(8);
    const filtered = (await app.inject({ url: '/api/leads?limit=100&filtro=sem-responsavel', headers: auth(t) })).json().items;
    expect(filtered).toHaveLength(8);
    const r = (await app.inject({ method: 'POST', url: '/api/leads/distribute', headers: auth(t) })).json();
    expect(r.distributed).toBe(8);
    const after = (await app.inject({ url: '/api/dashboard', headers: auth(t) })).json().attention.find((x: any) => x.id === 'leads-sem-responsavel');
    expect(after).toBeUndefined();
    const log = (await app.inject({ url: '/api/audit', headers: auth(t) })).json().items;
    expect(log.some((a: any) => /8 lead\(s\) distribuído\(s\)/.test(a.summary ?? ''))).toBe(true);
  });

  it('atribuições simultâneas por rodízio ficam balanceadas (lock consultivo do banco)', async () => {
    const t = await login('owner@a.demo');
    await app.inject({ method: 'PUT', url: '/api/settings/distribution', headers: auth(t), payload: { mode: 'roundrobin' } });
    const tid = (await db.query<any>(`SELECT tenant_id FROM users WHERE email = 'owner@a.demo'`)).rows[0].tenant_id;
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await db.query<any>(
      `INSERT INTO contacts (tenant_id, name) VALUES ($1, $2) RETURNING id`, [tid, `Conc ${i}`])).rows[0].id);
    const leads = await Promise.all(ids.map(async (cid) => (await db.query<any>(
      `INSERT INTO leads (tenant_id, contact_id, source) VALUES ($1, $2, 'site') RETURNING id`, [tid, cid])).rows[0].id));
    const owners = await Promise.all(leads.map((l) => assignRoundRobin(db, tid, l)));
    const counts = new Map<string, number>();
    owners.forEach((o) => counts.set(o!, (counts.get(o!) ?? 0) + 1));
    expect(counts.size).toBe(3);
    expect(Math.max(...counts.values()) - Math.min(...counts.values())).toBeLessThanOrEqual(1);
  });

  it('leads simultâneos não escolhem o mesmo corretor (lock por tenant)', async () => {
    const t = await login('owner@a.demo');
    await app.inject({ method: 'PUT', url: '/api/settings/distribution', headers: auth(t), payload: { mode: 'roundrobin' } });
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => newLead(t, `Paralelo ${i}`, 'site')));
    const owners = await Promise.all(res.map(async (r) => ownerOf(t, r.json().id)));
    const counts = new Map<string, number>();
    owners.forEach((o) => counts.set(o, (counts.get(o) ?? 0) + 1));
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
  });
});

describe('permissões e auditoria', () => {
  it('corretor não vê auditoria; gerente vê', async () => {
    const broker = await login('broker@a.demo');
    const mgr = await login('manager@a.demo');
    expect((await app.inject({ url: '/api/audit', headers: auth(broker) })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/audit', headers: auth(mgr) })).statusCode).toBe(200);
  });

  it('alteração de preço gera evento legível na vida do imóvel e auditoria', async () => {
    const a = await login('owner@a.demo');
    const id = (await app.inject({ url: '/api/properties?limit=1', headers: auth(a) })).json().items[0].id;
    const r = await app.inject({ method: 'PATCH', url: `/api/properties/${id}`, headers: auth(a), payload: { priceCents: 68_000_000 } });
    expect(r.json().summary).toMatch(/Preço alterado de .* para .*680\.000/);
    const det = (await app.inject({ url: `/api/properties/${id}`, headers: auth(a) })).json();
    expect(det.timeline[0].kind).toBe('preco');
  });

  it('usuário desativado perde acesso mesmo com token válido', async () => {
    const tok = await login('broker@b.demo');
    await db.query(`UPDATE users SET active = false WHERE email = 'broker@b.demo'`);
    expect((await app.inject({ url: '/api/leads', headers: auth(tok) })).statusCode).toBe(401);
    const { rows: [u] } = await db.query<any>(`SELECT id, tenant_id, role FROM users WHERE email='broker@b.demo'`);
    expect(await signToken({ sub: u.id, tid: u.tenant_id, role: u.role })).toBeTruthy();
  });
});

describe('domínio', () => {
  it('lead score explica o motivo e classifica', () => {
    const r = scoreLead({ source: 'indicacao', hasBudget: true, hasPhone: true, hasPropertyInterest: true,
      hoursSinceCreated: 5, hoursSinceLastContact: 2, visits: 2, stagePosition: 5 });
    expect(r.heat).toBe('muito_quente');
    expect(r.reasons.length).toBeGreaterThan(4);
  });
  it('saúde do imóvel diagnostica', () => {
    const h = propertyHealth({ photos: 1, description: '', priceCents: 0, area: null, neighborhood: '', daysOnMarket: 100, leads: 0, visits: 0 });
    expect(h.score).toBeLessThan(40);
    expect(h.diagnosis).toMatch(/foto/);
  });
});
