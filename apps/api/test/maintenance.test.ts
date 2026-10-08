import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/client.js';
import { makeTestDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { seedDemo } from '../src/db/seed.js';
import { config } from '../src/config.js';

const PW = 'senha-de-teste-123';
const NEW_PW = 'Inquilina#2026Forte';
let db: Db;
let app: FastifyInstance;
let ipN = 0;
const tokens = new Map<string, string>();
const nextIp = () => `10.9.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;
const call = (t: string | null, method: any, url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as any, headers: t ? { authorization: `Bearer ${t}` } : {}, remoteAddress: nextIp() });
async function login(email: string, password = PW) {
  const k = `${email}|${password}`;
  if (tokens.has(k)) return tokens.get(k)!;
  const r = await call(null, 'POST', '/api/auth/login', { email, password });
  if (r.statusCode === 200 && r.json().token) tokens.set(k, r.json().token);
  return r.json().token as string;
}
const tokenFromUrl = (url: string) => new URL(url, 'http://x').searchParams.get('token')!;
const contactId = async (staff: string, kind: 'owner' | 'renter', name: string) => (await call(staff, 'GET', `/api/contacts?kind=${kind}`)).json().items.find((c: any) => c.name === name).id as string;
async function onboardById(staff: string, contactId: string, email: string) {
  const inv = await call(staff, 'POST', '/api/portal/invites', { contactId, email });
  expect(inv.statusCode).toBe(201);
  expect((await call(null, 'POST', '/api/auth/accept-invite', { token: tokenFromUrl(inv.json().inviteUrl), password: NEW_PW })).statusCode).toBe(200);
  return login(email, NEW_PW);
}

let mgr: string, mgrB: string, broker: string, larissa: string, landlord: string, otherLandlord: string, otherRenter: string;
let contractId: string, otherContractId: string, tenantA: string, tenantB: string;
const sample = (over: object = {}) => ({ contractId, title: 'Vazamento na pia', description: 'A pia da cozinha vaza quando abro a torneira.', category: 'hydraulic', urgency: 'normal', ...over });

beforeAll(async () => {
  config.jwtSecret = 'm'.repeat(40);
  process.env.DATA_ENC_KEY = 'd'.repeat(40);
  db = await makeTestDb();
  app = await buildApp(db);
  await seedDemo(db, { tenantName: 'A', password: PW, emailPrefix: 'a' });
  await seedDemo(db, { tenantName: 'B', password: PW, emailPrefix: 'b' });
  mgr = await login('manager@a.demo'); mgrB = await login('manager@b.demo'); broker = await login('broker@a.demo');
  tenantA = (await db.query<any>(`SELECT tenant_id FROM users WHERE email = 'owner@a.demo'`)).rows[0].tenant_id;
  tenantB = (await db.query<any>(`SELECT tenant_id FROM users WHERE email = 'owner@b.demo'`)).rows[0].tenant_id;

  // Dois contratos ativos de inquilinos e proprietários diferentes, no tenant A.
  const cs = (await db.query<any>(`SELECT id, renter_id, landlord_id FROM rental_contracts WHERE tenant_id = $1 AND status = 'active' ORDER BY id`, [tenantA])).rows;
  const a = cs[0], b = cs.find((c: any) => c.renter_id !== a.renter_id && c.landlord_id !== a.landlord_id);
  expect(b, 'o seed precisa ter dois contratos ativos independentes').toBeTruthy();
  contractId = a.id; otherContractId = b.id;
  larissa = await onboardById(mgr, a.renter_id, 'inq1@inquilino.example');
  otherRenter = await onboardById(mgr, b.renter_id, 'inq2@inquilino.example');
  landlord = await onboardById(mgr, a.landlord_id, 'prop1@proprietario.example');
  otherLandlord = await onboardById(mgr, b.landlord_id, 'prop2@proprietario.example');
}, 120_000);

describe('abertura do chamado pelo inquilino', () => {
  it('abre chamado no próprio contrato e avisa a gestão; contrato de outro inquilino e de outro tenant dão 404', async () => {
    const r = await call(larissa, 'POST', '/api/renter/maintenance', sample());
    expect(r.statusCode).toBe(201);
    const notes = (await db.query<any>(`SELECT message FROM notifications WHERE tenant_id = $1 AND message LIKE '%Vazamento na pia%'`, [tenantA])).rows;
    expect(notes.length).toBeGreaterThan(0);
    expect((await call(larissa, 'POST', '/api/renter/maintenance', sample({ contractId: otherContractId }))).statusCode).toBe(404);
    expect((await call(larissa, 'POST', '/api/renter/maintenance', sample({ contractId: '00000000-0000-0000-0000-000000000000' }))).statusCode).toBe(404);
  });

  it('valida o conteúdo e urgência dispara aviso destacado', async () => {
    expect((await call(larissa, 'POST', '/api/renter/maintenance', sample({ title: '   ' }))).statusCode).toBe(400);
    expect((await call(larissa, 'POST', '/api/renter/maintenance', sample({ description: 'x'.repeat(2001) }))).statusCode).toBe(400);
    expect((await call(larissa, 'POST', '/api/renter/maintenance', sample({ category: 'magia' }))).statusCode).toBe(400);
    expect((await call(larissa, 'POST', '/api/renter/maintenance', sample({ title: 'Cheiro de gás', urgency: 'urgent' }))).statusCode).toBe(201);
    const n = (await db.query<any>(`SELECT 1 FROM notifications WHERE tenant_id = $1 AND message LIKE 'Chamado URGENTE%Cheiro de gás'`, [tenantA])).rows;
    expect(n.length).toBeGreaterThan(0);
  });

  it('contrato encerrado não abre chamado', async () => {
    await db.query(`UPDATE rental_contracts SET status = 'ended' WHERE id = $1`, [otherContractId]);
    expect((await call(otherRenter, 'POST', '/api/renter/maintenance', sample({ contractId: otherContractId }))).statusCode).toBe(404);
    await db.query(`UPDATE rental_contracts SET status = 'active' WHERE id = $1`, [otherContractId]);
  });

  it('limita chamados em andamento por inquilino', async () => {
    const have = Number((await db.query<any>(`SELECT count(*)::int n FROM maintenance_requests WHERE requester_contact_id = (SELECT renter_id FROM rental_contracts WHERE id = $1) AND status IN ('open','in_progress','waiting_tenant')`, [contractId])).rows[0].n);
    for (let i = have; i < 10; i++) {
      await db.query(`INSERT INTO maintenance_requests (tenant_id, contract_id, property_id, requester_contact_id, title, description)
        SELECT tenant_id, id, property_id, renter_id, 'carga ' || $2::text, 'x' FROM rental_contracts WHERE id = $1`, [contractId, i]);
    }
    const r = await call(larissa, 'POST', '/api/renter/maintenance', sample({ title: 'Um a mais' }));
    expect(r.statusCode).toBe(429);
    await db.query(`DELETE FROM maintenance_requests WHERE title LIKE 'carga %'`);
  });
});

describe('isolamento do inquilino', () => {
  it('cada inquilino só vê, lê e escreve nos próprios chamados', async () => {
    const mine = (await call(larissa, 'GET', '/api/renter/maintenance')).json().items;
    expect(mine.length).toBeGreaterThan(0);
    const id = mine[0].id;
    expect((await call(otherRenter, 'GET', '/api/renter/maintenance')).json().items.some((i: any) => i.id === id)).toBe(false);
    expect((await call(otherRenter, 'GET', `/api/renter/maintenance/${id}`)).statusCode).toBe(404);
    expect((await call(otherRenter, 'POST', `/api/renter/maintenance/${id}/messages`, { body: 'oi' })).statusCode).toBe(404);
    expect((await call(otherRenter, 'POST', `/api/renter/maintenance/${id}/cancel`)).statusCode).toBe(404);
    expect((await call(larissa, 'GET', `/api/renter/maintenance/${id}`)).statusCode).toBe(200);
  });
});

describe('conversa e tratamento pela equipe', () => {
  let id: string;
  beforeAll(async () => { id = (await call(larissa, 'POST', '/api/renter/maintenance', sample({ title: 'Porta empenada' }))).json().id; });

  it('nota interna nunca chega ao inquilino; resposta pública chega', async () => {
    expect((await call(mgr, 'POST', `/api/maintenance/${id}/messages`, { body: 'SEGREDO: orçar com o Zé', internal: true })).statusCode).toBe(201);
    expect((await call(mgr, 'POST', `/api/maintenance/${id}/messages`, { body: 'Vamos enviar um técnico amanhã.' })).statusCode).toBe(201);
    const seen = (await call(larissa, 'GET', `/api/renter/maintenance/${id}`)).json();
    expect(seen.messages.map((m: any) => m.body)).toEqual(['Vamos enviar um técnico amanhã.']);
    expect(JSON.stringify(seen)).not.toContain('SEGREDO');
    const staff = (await call(mgr, 'GET', `/api/maintenance/${id}`)).json();
    expect(staff.messages).toHaveLength(2);
    expect(staff.messages.find((m: any) => m.internal).body).toContain('SEGREDO');
  });

  it('o inquilino responde; resposta em "aguardando inquilino" volta para "em andamento"', async () => {
    expect((await call(mgr, 'PATCH', `/api/maintenance/${id}`, { status: 'waiting_tenant' })).statusCode).toBe(200);
    expect((await call(larissa, 'POST', `/api/renter/maintenance/${id}/messages`, { body: 'Posso receber de manhã.' })).statusCode).toBe(201);
    expect((await call(mgr, 'GET', `/api/maintenance/${id}`)).json().status).toBe('in_progress');
  });

  it('resolver registra a data; chamado encerrado não aceita mensagem nem cancelamento do inquilino', async () => {
    expect((await call(mgr, 'PATCH', `/api/maintenance/${id}`, { status: 'resolved' })).statusCode).toBe(200);
    const d = (await call(mgr, 'GET', `/api/maintenance/${id}`)).json();
    expect(d.status).toBe('resolved'); expect(d.resolvedAt).toBeTruthy();
    expect((await call(larissa, 'POST', `/api/renter/maintenance/${id}/messages`, { body: 'ainda?' })).statusCode).toBe(409);
    expect((await call(larissa, 'POST', `/api/renter/maintenance/${id}/cancel`)).statusCode).toBe(409);
    expect((await call(mgr, 'PATCH', `/api/maintenance/${id}`, { status: 'open' })).statusCode).toBe(200); // equipe pode reabrir
    expect((await call(mgr, 'GET', `/api/maintenance/${id}`)).json().resolvedAt).toBeNull();
  });

  it('cancelamento pelo inquilino é definitivo: equipe não reabre e não responde', async () => {
    const c = (await call(larissa, 'POST', '/api/renter/maintenance', sample({ title: 'Desisti' }))).json().id;
    expect((await call(larissa, 'POST', `/api/renter/maintenance/${c}/cancel`)).statusCode).toBe(200);
    expect((await call(mgr, 'PATCH', `/api/maintenance/${c}`, { status: 'open' })).statusCode).toBe(404);
    expect((await call(mgr, 'POST', `/api/maintenance/${c}/messages`, { body: 'oi' })).statusCode).toBe(409);
  });

  it('a gestão filtra por situação; chamados urgentes ativos vêm primeiro; corretor só consulta', async () => {
    const list = (await call(mgr, 'GET', '/api/maintenance?active=1')).json().items;
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((i: any) => ['open', 'in_progress', 'waiting_tenant'].includes(i.status))).toBe(true);
    expect(list[0].urgency).toBe('urgent');
    expect((await call(mgr, 'GET', '/api/maintenance?status=canceled')).json().items.every((i: any) => i.status === 'canceled')).toBe(true);
    expect((await call(broker, 'GET', '/api/maintenance')).statusCode).toBe(200);
    expect((await call(broker, 'PATCH', `/api/maintenance/${id}`, { status: 'resolved' })).statusCode).toBe(403);
    expect((await call(broker, 'POST', `/api/maintenance/${id}/messages`, { body: 'x' })).statusCode).toBe(403);
  });

  it('outra imobiliária não enxerga nem altera', async () => {
    expect((await call(mgrB, 'GET', '/api/maintenance')).json().items.some((i: any) => i.id === id)).toBe(false);
    expect((await call(mgrB, 'GET', `/api/maintenance/${id}`)).statusCode).toBe(404);
    expect((await call(mgrB, 'PATCH', `/api/maintenance/${id}`, { status: 'resolved' })).statusCode).toBe(404);
    expect((await call(mgrB, 'POST', `/api/maintenance/${id}/messages`, { body: 'x' })).statusCode).toBe(404);
    expect(tenantB).not.toBe(tenantA);
  });

  it('as ações ficam na auditoria', async () => {
    const acts = (await db.query<any>(`SELECT DISTINCT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'maintenance.%'`, [tenantA])).rows.map((r) => r.action);
    expect(acts).toEqual(expect.arrayContaining(['maintenance.create', 'maintenance.status', 'maintenance.note', 'maintenance.reply', 'maintenance.cancel']));
  });
});

describe('proprietário acompanha sem ver a conversa', () => {
  it('vê só os chamados dos imóveis dele, sem mensagens e sem identificar o inquilino', async () => {
    const mine = (await call(landlord, 'GET', '/api/portal/maintenance')).json().items;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((i: any) => i.property.title)).toBe(true);
    const raw = JSON.stringify(mine);
    expect(raw).not.toContain('SEGREDO'); expect(raw).not.toContain('Vamos enviar um técnico');
    expect(raw).not.toMatch(/messages|renterName|inquilino\.example/);
    expect(mine.some((i: any) => i.status === 'canceled')).toBe(false);
    const other = (await call(otherLandlord, 'GET', '/api/portal/maintenance')).json().items;
    const ids = new Set(mine.map((i: any) => i.id));
    expect(other.some((i: any) => ids.has(i.id))).toBe(false);
  });

  it('proprietário não abre nem trata chamados; inquilino não usa o portal do proprietário', async () => {
    expect((await call(landlord, 'POST', '/api/renter/maintenance', sample())).statusCode).toBe(403);
    expect((await call(landlord, 'GET', '/api/maintenance')).statusCode).toBe(403);
    expect((await call(larissa, 'GET', '/api/portal/maintenance')).statusCode).toBe(403);
    expect((await call(larissa, 'GET', '/api/maintenance')).statusCode).toBe(403);
    expect((await call(mgr, 'GET', '/api/renter/maintenance')).statusCode).toBe(403);
  });
});

describe('aviso ao inquilino dentro do portal', () => {
  let id: string;
  const unread = async (t: string) => (await call(t, 'GET', '/api/renter/notifications')).json();
  beforeAll(async () => {
    id = (await call(larissa, 'POST', '/api/renter/maintenance', sample({ title: 'Lâmpada queimada' }))).json().id;
    await call(larissa, 'POST', '/api/renter/notifications/read');
  });

  it('resposta pública e mudança de situação avisam o inquilino; nota interna e mesma situação não', async () => {
    expect((await unread(larissa)).unread).toBe(0);
    await call(mgr, 'POST', `/api/maintenance/${id}/messages`, { body: 'ORÇAMENTO INTERNO', internal: true });
    expect((await unread(larissa)).unread).toBe(0);
    await call(mgr, 'POST', `/api/maintenance/${id}/messages`, { body: 'Técnico a caminho.' });
    let n = await unread(larissa);
    expect(n.unread).toBe(1);
    expect(n.items[0].message).toContain('Lâmpada queimada');
    await call(mgr, 'PATCH', `/api/maintenance/${id}`, { status: 'in_progress' });
    await call(mgr, 'PATCH', `/api/maintenance/${id}`, { status: 'in_progress' }); // repetido: sem novo aviso
    n = await unread(larissa);
    const prog = n.items.filter((i: any) => i.message.includes('está em andamento'));
    expect(prog).toHaveLength(1); expect(prog[0].count).toBe(1); // avisos iguais são agrupados: contador > 1 revelaria aviso duplicado
    expect(JSON.stringify(n)).not.toContain('ORÇAMENTO');
  });

  it('cada inquilino só vê os próprios avisos; marcar como lido afeta só o dele', async () => {
    expect(JSON.stringify(await unread(otherRenter))).not.toContain('Lâmpada');
    const before = (await unread(larissa)).unread;
    expect(before).toBeGreaterThan(0);
    await call(otherRenter, 'POST', '/api/renter/notifications/read');
    expect((await unread(larissa)).unread).toBe(before);
    expect((await call(larissa, 'POST', '/api/renter/notifications/read')).json().marked).toBe(before);
    expect((await unread(larissa)).unread).toBe(0);
  });

  it('proprietário e equipe não usam os avisos do inquilino', async () => {
    expect((await call(landlord, 'GET', '/api/renter/notifications')).statusCode).toBe(403);
    expect((await call(mgr, 'GET', '/api/renter/notifications')).statusCode).toBe(403);
    expect((await call(larissa, 'GET', '/api/notifications')).statusCode).toBe(403);
  });
});
