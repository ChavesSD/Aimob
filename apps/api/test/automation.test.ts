import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/client.js';
import { makeTestDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { seedDemo } from '../src/db/seed.js';
import { evaluate, fireTrigger } from '../src/domain/automation.js';
import { config } from '../src/config.js';

const PW = 'senha-de-teste-123';
let db: Db;
let app: FastifyInstance;
const tokens = new Map<string, string>();

async function login(email: string) {
  const c = tokens.get(email);
  if (c) return c;
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
  tokens.set(email, r.json().token);
  return r.json().token as string;
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const inject = (t: string, method: any, url: string, payload?: unknown) => app.inject({ method, url, headers: auth(t), payload: payload as any });

async function enable(t: string, templateId: string) {
  const r = await inject(t, 'POST', '/api/automations', { templateId });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}
const runs = async (t: string) => (await inject(t, 'GET', '/api/automations')).json().runs as any[];

beforeAll(async () => {
  config.jwtSecret = 'y'.repeat(40);
  db = await makeTestDb();
  app = await buildApp(db);
  await seedDemo(db, { tenantName: 'A', password: PW, emailPrefix: 'a' });
  await seedDemo(db, { tenantName: 'B', password: PW, emailPrefix: 'b' });
}, 60_000);

describe('avaliação de condições', () => {
  it('compara tipos e trata fato ausente como não satisfeito', () => {
    expect(evaluate([{ field: 'score', op: '>=', value: 40 }], { score: 40 })).toBe(true);
    expect(evaluate([{ field: 'source', op: '=', value: 'portal' }], { source: 'site' })).toBe(false);
    expect(evaluate([{ field: 'outcome', op: '!=', value: 'x' }], {})).toBe(false);
    expect(evaluate([], {})).toBe(true);
  });
});

describe('regras e gatilhos', () => {
  it('rejeita regra inválida (ação ou campo fora da lista fechada)', async () => {
    const t = await login('owner@a.demo');
    const bad1 = await inject(t, 'POST', '/api/automations', { name: 'Ruim', trigger: 'lead.created', actions: [{ type: 'send_whatsapp', text: 'oi' }] });
    expect(bad1.statusCode).toBe(400);
    const bad2 = await inject(t, 'POST', '/api/automations', { name: 'Ruim 2', trigger: 'lead.created', conditions: [{ field: 'password', op: '=', value: 'x' }], actions: [{ type: 'assign_round_robin' }] });
    expect(bad2.statusCode).toBe(400);
    expect((await inject(t, 'POST', '/api/automations', { templateId: 'nao-existe' })).statusCode).toBe(404);
  });

  it('lead de portal com bom score gera tarefa para o responsável, sem duplicar', async () => {
    const t = await login('owner@a.demo');
    await enable(t, 'retorno-portal');
    const propertyId = (await inject(t, 'GET', '/api/properties?limit=1')).json().items[0].id;
    const lead = (await inject(t, 'POST', '/api/leads', { name: 'Portal Quente', source: 'portal', phone: '83999990000', budgetCents: 50_000_000, propertyId })).json();
    expect(lead.score).toBeGreaterThanOrEqual(40);
    const tasks = (await inject(t, 'GET', '/api/tasks?escopo=todas')).json().items.filter((x: any) => x.lead_name === 'Portal Quente');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].source).toBe('automation');
    // mesmo evento disparado de novo não repete (idempotência)
    await fireTrigger(db, (await db.query<any>(`SELECT tenant_id FROM leads WHERE id = $1`, [lead.id])).rows[0].tenant_id, 'lead.created', lead.id);
    const again = (await inject(t, 'GET', '/api/tasks?escopo=todas')).json().items.filter((x: any) => x.lead_name === 'Portal Quente');
    expect(again).toHaveLength(1);
  });

  it('lead que não atende a condição não dispara', async () => {
    const t = await login('owner@a.demo');
    await inject(t, 'POST', '/api/leads', { name: 'Site Frio', source: 'site' });
    const tasks = (await inject(t, 'GET', '/api/tasks?escopo=todas')).json().items.filter((x: any) => x.lead_name === 'Site Frio');
    expect(tasks).toHaveLength(0);
  });

  it('lead parado: varredura executa uma vez, cria tarefa e notifica gestores', async () => {
    const t = await login('owner@a.demo');
    await enable(t, 'lead-parado-72h');
    const leadId = (await inject(t, 'GET', '/api/leads?limit=1')).json().items[0].id;
    await db.query(`UPDATE leads SET last_contact_at = now() - interval '100 hours' WHERE id = $1`, [leadId]);
    await inject(t, 'POST', '/api/automations/sweep');
    const mine = (await runs(t)).filter((r) => r.rule_name.includes('72h') && r.status === 'executed');
    expect(mine.length).toBeGreaterThan(0);
    const before = mine.length;
    await inject(t, 'POST', '/api/automations/sweep'); // segunda varredura não repete
    expect((await runs(t)).filter((r) => r.rule_name.includes('72h') && r.status === 'executed').length).toBe(before);
    const n = (await inject(t, 'GET', '/api/notifications')).json();
    expect(n.unread).toBeGreaterThan(0);
    // avisos idênticos são agrupados em um só, com contador, em vez de uma notificação por lead
    const generic = n.items.filter((x: any) => /72 horas/.test(x.message));
    expect(generic).toHaveLength(1);
    expect(generic[0].count).toBe(mine.length);
    await inject(t, 'POST', '/api/notifications/read');
    expect((await inject(t, 'GET', '/api/notifications')).json().unread).toBe(0);
  });

  it('autonomia assistida só executa após aprovação; rejeição não executa', async () => {
    const t = await login('owner@a.demo');
    await enable(t, 'alto-valor');
    const mk = async (name: string) => (await inject(t, 'POST', '/api/leads', { name, source: 'manual', budgetCents: 150_000_000 })).json().id as string;
    const a = await mk('Alto Valor A'), b = await mk('Alto Valor B');
    await inject(t, 'POST', '/api/notifications/read');
    await inject(t, 'POST', `/api/leads/${a}/stage`, { position: 5 });
    await inject(t, 'POST', `/api/leads/${b}/stage`, { position: 5 });
    const pending = (await runs(t)).filter((r) => r.status === 'pending_approval');
    expect(pending).toHaveLength(2);
    expect((await inject(t, 'GET', '/api/notifications')).json().unread).toBe(0); // nada executou ainda

    const pa = pending.find((r) => r.lead_name === 'Alto Valor A');
    const pb = pending.find((r) => r.lead_name === 'Alto Valor B');
    const ok = await inject(t, 'POST', `/api/automation-runs/${pa.id}/approve`);
    expect(ok.json().status).toBe('executed');
    expect((await inject(t, 'GET', '/api/notifications')).json().unread).toBe(1);
    expect((await inject(t, 'POST', `/api/automation-runs/${pa.id}/approve`)).statusCode).toBe(409);
    const rej = await inject(t, 'POST', `/api/automation-runs/${pb.id}/reject`);
    expect(rej.json().status).toBe('rejected');
    expect((await inject(t, 'GET', '/api/notifications')).json().unread).toBe(1);
  });

  it('resultado de visita dispara follow-up, exceto não comparecimento', async () => {
    const t = await login('owner@a.demo');
    await enable(t, 'pos-visita');
    const pend = (await inject(t, 'GET', '/api/visits?filtro=sem-feedback')).json().items;
    expect(pend.length).toBeGreaterThan(1);
    const before = (await inject(t, 'GET', '/api/tasks?escopo=todas')).json().items.length;
    await inject(t, 'POST', `/api/visits/${pend[0].id}/feedback`, { outcome: 'gostou' });
    await inject(t, 'POST', `/api/visits/${pend[1].id}/feedback`, { outcome: 'nao_compareceu' });
    const after = (await inject(t, 'GET', '/api/tasks?escopo=todas')).json().items.length;
    expect(after - before).toBe(1);
  });

  it('regra desligada não dispara', async () => {
    const t = await login('owner@a.demo');
    const rules = (await inject(t, 'GET', '/api/automations')).json().rules;
    const rr = rules.find((r: any) => r.name.includes('Lead de portal'));
    expect((await inject(t, 'PATCH', `/api/automations/${rr.id}`, { enabled: false })).statusCode).toBe(200);
    await inject(t, 'POST', '/api/leads', { name: 'Portal Desligado', source: 'portal', phone: '83988880000', budgetCents: 50_000_000, propertyId: (await inject(t, 'GET', '/api/properties?limit=1')).json().items[0].id });
    const tasks = (await inject(t, 'GET', '/api/tasks?escopo=todas')).json().items.filter((x: any) => x.lead_name === 'Portal Desligado');
    expect(tasks).toHaveLength(0);
  });

  it('falha ao disparar nunca lança para quem chamou', async () => {
    await expect(fireTrigger(db, 'nao-e-uuid', 'lead.created', 'x')).resolves.toBeUndefined();
  });
});

describe('segurança das automações', () => {
  it('corretor não vê nem cria automações; tarefas "minhas" só mostram as suas', async () => {
    const broker = await login('broker@a.demo');
    expect((await inject(broker, 'GET', '/api/automations')).statusCode).toBe(403);
    expect((await inject(broker, 'POST', '/api/automations', { templateId: 'pos-visita' })).statusCode).toBe(403);
    const mine = (await inject(broker, 'GET', '/api/tasks?escopo=todas')).json().items;
    const me = (await db.query<any>(`SELECT id FROM users WHERE email = 'broker@a.demo'`)).rows[0].id;
    const names = new Set(mine.map((x: any) => x.assignee_name));
    expect([...names].every((n) => n === 'Corretor Demo')).toBe(true);
    expect(me).toBeTruthy();
  });

  it('tenant B não aprova, liga nem lê automações do tenant A', async () => {
    const a = await login('owner@a.demo');
    const b = await login('owner@b.demo');
    const a1 = (await inject(a, 'GET', '/api/automations')).json();
    const anyRun = a1.runs[0];
    expect((await inject(b, 'POST', `/api/automation-runs/${anyRun.id}/approve`)).statusCode).toBe(404);
    expect((await inject(b, 'PATCH', `/api/automations/${a1.rules[0].id}`, { enabled: false })).statusCode).toBe(404);
    const b1 = (await inject(b, 'GET', '/api/automations')).json();
    expect(b1.rules).toHaveLength(0);
    expect(b1.runs).toHaveLength(0);
    // notificações e tarefas também são isoladas
    expect((await inject(b, 'GET', '/api/tasks?escopo=todas')).json().items).toHaveLength(0);
  });

  it('ativar e aprovar ficam na auditoria com texto legível', async () => {
    const a = await login('owner@a.demo');
    const log = (await inject(a, 'GET', '/api/audit')).json().items.map((x: any) => x.summary ?? '');
    expect(log.some((s: string) => /Automação ".*" criada/.test(s))).toBe(true);
    expect(log.some((s: string) => /Execução de ".*" aprovada/.test(s))).toBe(true);
    expect(log.some((s: string) => /Automação ".*" desligada/.test(s))).toBe(true);
  });
});
