import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/client.js';
import { makeTestDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { seedDemo } from '../src/db/seed.js';
import { config } from '../src/config.js';
import { FakeAsaas } from './fakeAsaas.js';
import { normalizeDocument } from '../src/domain/document.js';
import { providerTuning } from '../src/payments/service.js';

const PW = 'senha-de-teste-123';
const CPF = '529.982.247-25';       // CPF válido de exemplo
const CNPJ = '11.444.777/0001-61';  // CNPJ válido de exemplo
let db: Db;
let app: FastifyInstance;
let asaas: FakeAsaas;
let ipN = 0;
const tokens = new Map<string, string>();
const nextIp = () => `10.7.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;

async function login(email: string) {
  if (tokens.has(email)) return tokens.get(email)!;
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW }, remoteAddress: nextIp() });
  tokens.set(email, r.json().token);
  return r.json().token as string;
}
const call = (t: string | null, method: any, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: payload as any, headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...headers }, remoteAddress: nextIp() });

const tenantOf = async (email: string) => (await db.query<any>(`SELECT tenant_id FROM users WHERE email = $1`, [email])).rows[0].tenant_id as string;
const charges = async (t: string) => (await call(t, 'GET', '/api/charges')).json().items as any[];
const chargeOf = async (t: string, renter: string, pred: (c: any) => boolean = () => true) => (await charges(t)).find((c) => c.renter_name === renter && pred(c));
const renterId = async (t: string, name: string) => (await call(t, 'GET', '/api/contacts?kind=renter')).json().items.find((c: any) => c.name === name).id as string;

async function connect(t: string, key = asaas.validKey) {
  const r = await call(t, 'PUT', '/api/payments/account', { environment: 'sandbox', apiKey: key });
  expect(r.statusCode).toBe(200);
  return r.json() as { webhookUrl: string; webhookToken: string };
}
const hook = (tid: string, token: string | null, body: unknown) =>
  call(null, 'POST', `/api/webhooks/asaas/${tid}`, body, token ? { 'asaas-access-token': token } : {});
let evSeq = 0;
const received = (paymentId: string, value: number, extra: any = {}) => ({
  id: `evt_${++evSeq}_${Date.now()}`, event: 'PAYMENT_RECEIVED', dateCreated: '2026-10-05 10:00:00',
  payment: { id: paymentId, value, status: 'RECEIVED', paymentDate: null, ...extra },
});

beforeAll(async () => {
  config.jwtSecret = 'p'.repeat(40);
  process.env.DATA_ENC_KEY = 'd'.repeat(40);
  process.env.PUBLIC_API_URL = 'https://api.exemplo.com.br';
  providerTuning.backoffMs = [0, 0];
  asaas = new FakeAsaas();
  db = await makeTestDb();
  app = await buildApp(db, { fetchImpl: asaas.fetch });
  await seedDemo(db, { tenantName: 'A', password: PW, emailPrefix: 'a' });
  await seedDemo(db, { tenantName: 'B', password: PW, emailPrefix: 'b' });
}, 120_000);

describe('CPF/CNPJ', () => {
  it('valida dígitos verificadores e rejeita sequências repetidas', () => {
    expect(normalizeDocument(CPF)).toBe('52998224725');
    expect(normalizeDocument(CNPJ)).toBe('11444777000161');
    for (const bad of ['111.111.111-11', '529.982.247-24', '123', '', '11.444.777/0001-62', '00000000000000']) expect(normalizeDocument(bad)).toBeNull();
  });

  it('documento é validado, guardado criptografado e nunca devolvido por inteiro', async () => {
    const t = await login('owner@a.demo');
    const id = await renterId(t, 'Felipe Nunes');
    expect((await call(t, 'PUT', `/api/contacts/${id}/document`, { document: '123.456.789-00' })).statusCode).toBe(400);
    expect((await call(t, 'PUT', `/api/contacts/${id}/document`, { document: CPF })).statusCode).toBe(200);
    const { rows } = await db.query<any>(`SELECT document_enc, document_last2 FROM contacts WHERE id = $1`, [id]);
    expect(rows[0].document_enc).not.toContain('52998224725');
    expect(rows[0].document_last2).toBe('25');
    const list = (await call(t, 'GET', '/api/contacts?kind=renter')).json();
    expect(JSON.stringify(list)).not.toContain('52998224725');
    expect(list.items.find((c: any) => c.id === id)).toMatchObject({ hasDocument: true, documentMask: '***25' });
    const log = (await call(t, 'GET', '/api/audit')).json().items.map((x: any) => `${x.summary}`).join('\n');
    expect(log).not.toContain('52998224725'); // nem na auditoria
  });
});

describe('conta do provedor', () => {
  it('só quem administra o financeiro conecta; chave inválida não é salva', async () => {
    const broker = await login('broker@a.demo');
    expect((await call(broker, 'PUT', '/api/payments/account', { environment: 'sandbox', apiKey: asaas.validKey })).statusCode).toBe(403);
    const t = await login('owner@a.demo');
    const bad = await call(t, 'PUT', '/api/payments/account', { environment: 'sandbox', apiKey: '$aact_chave_errada_xxxxxxxxxxxxxx' });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().error).toMatch(/chave de API.*recusada/);
    expect((await db.query('SELECT 1 FROM payment_accounts')).rows).toHaveLength(0);
    expect((await call(t, 'PUT', '/api/payments/account', { environment: 'sandbox', apiKey: 'curta' })).statusCode).toBe(400);
  });

  it('conecta, guarda a chave criptografada e nunca a devolve nem a registra', async () => {
    const t = await login('owner@a.demo');
    const r = await connect(t);
    expect(r.webhookToken.length).toBeGreaterThanOrEqual(32); // exigência do Asaas: 32 a 255
    expect(r.webhookUrl).toBe(`https://api.exemplo.com.br/api/webhooks/asaas/${await tenantOf('owner@a.demo')}`);
    const { rows } = await db.query<any>(`SELECT api_key_enc, webhook_token_hash FROM payment_accounts`);
    expect(rows[0].api_key_enc).not.toContain(asaas.validKey);
    expect(rows[0].webhook_token_hash).not.toBe(r.webhookToken); // só o hash
    const acc = JSON.stringify((await call(t, 'GET', '/api/payments/account')).json());
    expect(acc).not.toContain(asaas.validKey);
    expect(acc).toContain('"connected":true');
    const audit = JSON.stringify((await call(t, 'GET', '/api/audit')).json());
    expect(audit).not.toContain(asaas.validKey);
    expect(audit).not.toContain(r.webhookToken);
    // a chave só trafega no header, nunca no corpo das chamadas
    expect(asaas.calls.every((c) => !JSON.stringify(c.body ?? {}).includes(asaas.validKey))).toBe(true);
  });
});

describe('emissão de Pix/boleto', () => {
  it('exige conta conectada e CPF/CNPJ do inquilino', async () => {
    const t = await login('owner@b.demo'); // tenant B: sem conta
    const anyCharge = (await charges(t)).find((c) => c.status === 'open');
    expect((await call(t, 'POST', `/api/charges/${anyCharge.id}/issue`)).statusCode).toBe(409);
    const a = await login('owner@a.demo');
    const c = await chargeOf(a, 'Marcos Teles', (x) => x.status === 'open'); // sem documento
    const r = await call(a, 'POST', `/api/charges/${c.id}/issue`);
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatch(/CPF ou CNPJ/);
    expect(asaas.count('POST', /^\/payments$/)).toBe(0); // nada foi enviado ao provedor
  });

  it('emite com os dados corretos, guarda link e Pix e não duplica ao repetir', async () => {
    const t = await login('owner@a.demo');
    const c = await chargeOf(t, 'Felipe Nunes', (x) => x.status === 'open');
    const r = await call(t, 'POST', `/api/charges/${c.id}/issue`);
    expect(r.statusCode).toBe(200);
    const post = asaas.calls.find((x) => x.method === 'POST' && x.path === '/payments')!;
    expect(post.headers['access_token']).toBe(asaas.validKey);
    expect(post.body).toMatchObject({ billingType: 'UNDEFINED', value: c.amount_cents / 100, dueDate: c.due_date, externalReference: c.id, fine: { value: 2 }, interest: { value: 1 } });
    const cust = asaas.calls.find((x) => x.method === 'POST' && x.path === '/customers')!;
    expect(cust.body.cpfCnpj).toBe('52998224725');
    const after = await chargeOf(t, 'Felipe Nunes', (x) => x.id === c.id);
    expect(after.payment).toMatchObject({ status: 'PENDING', url: expect.stringContaining('sandbox.asaas.com/i/'), pixPayload: expect.stringContaining('br.gov.bcb.pix') });
    const before = asaas.count('POST', /^\/payments$/);
    const again = await call(t, 'POST', `/api/charges/${c.id}/issue`);
    expect(again.json().alreadyIssued).toBe(true);
    expect(asaas.count('POST', /^\/payments$/)).toBe(before); // nenhuma chamada nova
    expect((await call(t, 'POST', `/api/charges/${c.id}/pay`, {})).statusCode).toBe(200); // baixa manual segue valendo
    expect((await call(t, 'POST', `/api/charges/${c.id}/issue`)).statusCode).toBe(409); // cobrança paga não emite
  });

  it('clique duplo simultâneo emite uma única cobrança no provedor', async () => {
    const t = await login('owner@a.demo');
    const id = await renterId(t, 'Larissa Duarte');
    await call(t, 'PUT', `/api/contacts/${id}/document`, { document: CNPJ });
    const c = await chargeOf(t, 'Larissa Duarte', (x) => x.status === 'open');
    const before = asaas.count('POST', /^\/payments$/);
    asaas.delayMs = 150; // força as 3 tentativas a se sobreporem de verdade, mesmo com conexões lentas no pool
    const rs = await Promise.all([1, 2, 3].map(() => call(t, 'POST', `/api/charges/${c.id}/issue`)));
    asaas.delayMs = 0;
    // Invariante: exatamente UMA emissão nova. As demais recebem "em andamento" (409) ou "já emitida" (200), nunca outra emissão.
    expect(rs.filter((r) => r.statusCode === 200 && r.json().alreadyIssued === false)).toHaveLength(1);
    expect(rs.every((r) => r.statusCode === 409 || (r.statusCode === 200))).toBe(true);
    expect(asaas.count('POST', /^\/payments$/) - before).toBe(1);
  });

  it('falha ambígua (cobrança criada, resposta perdida) não gera boleto duplicado', async () => {
    const t = await login('owner@a.demo');
    const c = await chargeOf(t, 'Larissa Duarte', (x) => x.status === 'overdue');
    const before = [...asaas.payments.values()].filter((p) => p.externalReference === c.id).length;
    expect(before).toBe(0);
    asaas.failNext(/POST \/payments$/, 'lost-response');
    const r = await call(t, 'POST', `/api/charges/${c.id}/issue`);
    expect(r.statusCode).toBe(200);
    expect([...asaas.payments.values()].filter((p) => p.externalReference === c.id)).toHaveLength(1);
  });

  it('erro transitório é repetido; indisponibilidade persistente vira mensagem humana e libera nova tentativa', async () => {
    const t = await login('owner@a.demo');
    await call(t, 'PUT', `/api/contacts/${await renterId(t, 'Gustavo Reis')}/document`, { document: CPF });
    const c = await chargeOf(t, 'Gustavo Reis', (x) => x.status === 'open');
    asaas.failNext(/POST \/customers$/, 'http500', 2); // 2 falhas e a 3ª tentativa passa
    asaas.failNext(/POST \/payments$/, 'network', 1);
    const ok = await call(t, 'POST', `/api/charges/${c.id}/issue`);
    expect(ok.statusCode).toBe(200);

    const c2 = (await charges(t)).find((x) => x.renter_name === 'Gustavo Reis' && x.status === 'open' && !x.payment);
    asaas.failNext(/POST \/payments$/, 'http500', 10);
    const down = await call(t, 'POST', `/api/charges/${c2.id}/issue`);
    expect(down.statusCode).toBe(503);
    expect(down.json().error).toMatch(/indisponível/);
    expect(down.body).not.toContain(asaas.validKey);
    asaas.clearFailures();
    // a reserva foi liberada: tentar de novo agora funciona
    const retry = await call(t, 'POST', `/api/charges/${c2.id}/issue`);
    expect(retry.statusCode).toBe(200);
  });

  it('rejeição do provedor (4xx) mostra o motivo; chave revogada pede reconexão', async () => {
    const t = await login('owner@a.demo');
    const c = (await charges(t)).find((x) => x.status === 'open' && !x.payment && x.renter_name === 'Larissa Duarte');
    asaas.failNext(/POST \/payments$/, 'http400', 1);
    const r = await call(t, 'POST', `/api/charges/${c.id}/issue`);
    expect(r.statusCode).toBe(422);
    asaas.failNext(/POST \/payments$/, 'http401', 1);
    const r2 = await call(t, 'POST', `/api/charges/${c.id}/issue`);
    expect(r2.statusCode).toBe(502);
    expect(r2.json().error).toMatch(/Reconecte/);
  });

  it('emissão em lote conta emitidas, sem documento e falhas', async () => {
    const t = await login('owner@a.demo');
    const r = (await call(t, 'POST', '/api/charges/issue-batch', { daysAhead: 60 })).json();
    expect(r.considered).toBeGreaterThan(0);
    expect(r.skippedNoDocument).toBeGreaterThan(0); // Marcos Teles não tem CPF
    expect(r.issued + r.skippedNoDocument + r.failed.length + r.inProgress).toBe(r.considered);
  });
});

describe('webhooks', () => {
  let tenantA: string, tokenA: string, paymentId: string, chargeId: string, amount: number;

  beforeAll(async () => {
    const t = await login('owner@a.demo');
    tenantA = await tenantOf('owner@a.demo');
    tokenA = (await call(t, 'POST', '/api/payments/account/webhook-token')).json().webhookToken;
    // Cobrança vencida da Larissa, emitida no teste da "resposta perdida": já passou por multa/juros na baixa.
    const c = (await charges(t)).find((x) => x.renter_name === 'Larissa Duarte' && x.status === 'overdue' && x.payment)!;
    expect(c, 'precisa existir a cobrança vencida emitida').toBeTruthy();
    chargeId = c.id;
    paymentId = (await db.query<any>(`SELECT gateway_id FROM rental_charges WHERE id = $1`, [c.id])).rows[0].gateway_id;
    amount = c.amount_cents / 100;
  });

  it('exige o token certo; imobiliária inexistente e token de outra respondem igual', async () => {
    const b = received(paymentId, amount);
    const noToken = await hook(tenantA, null, b);
    const wrong = await hook(tenantA, 'token-errado-com-mais-de-trinta-e-dois-caracteres', b);
    const ghost = await hook('00000000-0000-0000-0000-000000000000', tokenA, b);
    const bTok = (await call(await login('owner@b.demo'), 'PUT', '/api/payments/account', { environment: 'sandbox', apiKey: asaas.validKey })).json().webhookToken;
    const crossTenant = await hook(tenantA, bTok, b); // token válido, mas de outra imobiliária
    for (const r of [noToken, wrong, ghost, crossTenant]) { expect(r.statusCode).toBe(401); expect(r.json()).toEqual({ error: 'Não autorizado.' }); }
    expect((await db.query('SELECT 1 FROM payment_events')).rows).toHaveLength(0); // nada foi gravado
    expect((await hook(tenantA, tokenA, { event: 'PAYMENT_RECEIVED' })).statusCode).toBe(400); // sem id
  });

  it('PAYMENT_CONFIRMED sozinho não dá baixa (dinheiro ainda não recebido)', async () => {
    const r = await hook(tenantA, tokenA, { id: 'evt_conf_1', event: 'PAYMENT_CONFIRMED', payment: { id: paymentId, value: amount, status: 'CONFIRMED' } });
    expect(r.statusCode).toBe(200);
    expect((await db.query<any>(`SELECT status FROM rental_charges WHERE id = $1`, [chargeId])).rows[0].status).toBe('open');
  });

  it('valor divergente não dá baixa: vai para revisão e avisa a equipe', async () => {
    const r = await hook(tenantA, tokenA, received(paymentId, amount - 100));
    expect(r.statusCode).toBe(200);
    const ch = (await db.query<any>(`SELECT status, reconciliation FROM rental_charges WHERE id = $1`, [chargeId])).rows[0];
    expect(ch.status).toBe('open');
    expect(ch.reconciliation).toBe('divergent');
    const ev = (await call(await login('owner@a.demo'), 'GET', '/api/payments/events')).json().items.find((e: any) => e.status === 'needs_review');
    expect(ev.detail).toMatch(/valor divergente/);
    const n = (await call(await login('owner@a.demo'), 'GET', '/api/notifications')).json().items.map((x: any) => x.message).join(' ');
    expect(n).toMatch(/valor diferente do cobrado/);
  });

  it('pagamento correto dá baixa automática, gera um repasse e audita sem usuário', async () => {
    const ev = received(paymentId, amount, { paymentDate: new Date().toISOString().slice(0, 10) });
    const r = await hook(tenantA, tokenA, ev);
    expect(r.statusCode).toBe(200);
    const ch = (await db.query<any>(`SELECT status, reconciliation, paid_principal_cents FROM rental_charges WHERE id = $1`, [chargeId])).rows[0];
    expect(ch.status).toBe('paid');
    expect(ch.reconciliation).toBe('ok');
    expect((await db.query('SELECT 1 FROM rental_payouts WHERE charge_id = $1', [chargeId])).rows).toHaveLength(1);
    const log = (await db.query<any>(`SELECT actor_id, summary FROM audit_log WHERE resource_id = $1 AND summary LIKE '%automaticamente%'`, [chargeId])).rows;
    expect(log).toHaveLength(1);
    expect(log[0].actor_id).toBeNull();
    // mesmo evento reenviado: reconhecido, mas nada acontece de novo
    const dup = await hook(tenantA, tokenA, ev);
    expect(dup.json().duplicate).toBe(true);
    expect((await db.query('SELECT 1 FROM rental_payouts WHERE charge_id = $1', [chargeId])).rows).toHaveLength(1);
    expect((await db.query('SELECT 1 FROM payment_events WHERE event_id = $1', [ev.id])).rows).toHaveLength(1);
  });

  it('outro evento de pagamento para cobrança já baixada não baixa de novo e alerta duplicidade', async () => {
    const r = await hook(tenantA, tokenA, received(paymentId, amount));
    expect(r.statusCode).toBe(200);
    expect((await db.query('SELECT 1 FROM rental_payouts WHERE charge_id = $1', [chargeId])).rows).toHaveLength(1);
    const n = (await call(await login('owner@a.demo'), 'GET', '/api/notifications')).json().items.map((x: any) => x.message).join(' ');
    expect(n).toMatch(/possível pagamento em duplicidade/);
  });

  it('cobrança desconhecida é ignorada; evento sem pagamento é ignorado; eventos de outro tenant não vazam', async () => {
    expect((await hook(tenantA, tokenA, received('pay_inexistente', 10))).statusCode).toBe(200);
    expect((await hook(tenantA, tokenA, { id: 'evt_sem_pay', event: 'PAYMENT_RECEIVED' })).statusCode).toBe(200);
    const evs = (await call(await login('owner@a.demo'), 'GET', '/api/payments/events')).json().items;
    expect(evs.filter((e: any) => e.status === 'ignored').length).toBeGreaterThanOrEqual(2);
    const evsB = (await call(await login('owner@b.demo'), 'GET', '/api/payments/events')).json().items;
    expect(evsB).toHaveLength(0);
  });

  it('o mesmo pagamento no tenant B não é afetado por evento do tenant A', async () => {
    const b = await login('owner@b.demo');
    const tenantB = await tenantOf('owner@b.demo');
    const tokB = (await call(b, 'POST', '/api/payments/account/webhook-token')).json().webhookToken;
    const r = await hook(tenantB, tokB, received(paymentId, amount)); // id do pagamento do tenant A, enviado ao webhook de B
    expect(r.statusCode).toBe(200);
    const ev = (await call(b, 'GET', '/api/payments/events')).json().items[0];
    expect(ev.status).toBe('ignored'); // não existe cobrança com esse id em B
  });

  it('evento gravado e não processado (queda após persistir) é concluído pelo reprocessamento', async () => {
    const t = await login('owner@a.demo');
    const fresh = (await charges(t)).find((x) => x.renter_name === 'Felipe Nunes' && x.status === 'open')!;
    expect(fresh, 'precisa existir cobrança aberta do Felipe').toBeTruthy();
    expect((await call(t, 'POST', `/api/charges/${fresh.id}/issue`)).statusCode).toBe(200); // emite, ou confirma que já estava emitida
    const gid = (await db.query<any>(`SELECT gateway_id, amount_cents FROM rental_charges WHERE id = $1`, [fresh.id])).rows[0];
    const ev = received(gid.gateway_id, Number(gid.amount_cents) / 100);
    await db.query(`INSERT INTO payment_events (tenant_id, provider, event_id, event, payment_id, payload, status) VALUES ($1,'asaas',$2,$3,$4,$5,'pending')`,
      [tenantA, ev.id, ev.event, gid.gateway_id, JSON.stringify(ev)]);
    expect((await db.query<any>(`SELECT status FROM rental_charges WHERE id = $1`, [fresh.id])).rows[0].status).toBe('open');
    const r = await call(t, 'POST', '/api/payments/events/retry');
    expect(r.json().retried).toBeGreaterThanOrEqual(1);
    expect((await db.query<any>(`SELECT status FROM rental_charges WHERE id = $1`, [fresh.id])).rows[0].status).toBe('paid');
    expect((await db.query<any>(`SELECT status FROM payment_events WHERE event_id = $1`, [ev.id])).rows[0].status).toBe('processed');
  });
});

describe('reajuste e encerramento com cobranças emitidas', () => {
  it('reajuste marca a cobrança emitida como desatualizada e a reemissão cancela a antiga', async () => {
    const t = await login('manager@a.demo');
    const issued = (await db.query<any>(
      `SELECT ch.id, ch.contract_id, ch.gateway_id FROM rental_charges ch JOIN rental_contracts c ON c.id = ch.contract_id JOIN contacts r ON r.id = c.renter_id
        WHERE r.name = 'Gustavo Reis' AND ch.status = 'open' AND ch.gateway_id IS NOT NULL AND ch.due_date > (now() AT TIME ZONE 'America/Sao_Paulo')::date LIMIT 1`)).rows[0];
    expect(issued, 'precisa existir cobrança futura emitida de Gustavo').toBeTruthy();
    const adj = await call(t, 'POST', `/api/rentals/${issued.contract_id}/adjust`, { percentBps: 450, indexName: 'IGPM' });
    expect(adj.statusCode).toBe(200);
    const stale = (await db.query<any>(`SELECT gateway_stale, amount_cents FROM rental_charges WHERE id = $1`, [issued.id])).rows[0];
    expect(stale.gateway_stale).toBe(true);
    const dels = asaas.count('DELETE', /^\/payments\//);
    expect((await call(t, 'POST', `/api/charges/${issued.id}/issue`)).statusCode).toBe(200);
    expect(asaas.count('DELETE', /^\/payments\//)).toBe(dels + 1); // a antiga foi cancelada
    const now = (await db.query<any>(`SELECT gateway_id, gateway_stale FROM rental_charges WHERE id = $1`, [issued.id])).rows[0];
    expect(now.gateway_id).not.toBe(issued.gateway_id);
    expect(now.gateway_stale).toBe(false);
    const created = [...asaas.payments.values()].find((p) => p.id === now.gateway_id);
    expect(created.value).toBe(Number(stale.amount_cents) / 100); // valor reajustado
  });

  it('encerrar contrato cancela no provedor; se falhar, avisa a equipe', async () => {
    const t = await login('owner@a.demo');
    const target = (await call(t, 'GET', '/api/rentals')).json().items.find((c: any) => c.renter_name === 'Larissa Duarte' && c.status === 'active');
    const open = (await db.query<any>(`SELECT id, gateway_id FROM rental_charges WHERE contract_id = $1 AND status = 'open' AND gateway_id IS NOT NULL AND due_date > (now() AT TIME ZONE 'America/Sao_Paulo')::date`, [target.id])).rows;
    if (!open.length) { // garante ao menos uma cobrança futura emitida
      const c = (await db.query<any>(`SELECT id FROM rental_charges WHERE contract_id = $1 AND status = 'open' AND due_date > (now() AT TIME ZONE 'America/Sao_Paulo')::date LIMIT 1`, [target.id])).rows[0];
      await call(t, 'POST', `/api/charges/${c.id}/issue`);
    }
    asaas.failNext(/DELETE \/payments\//, 'http500', 50);
    const r = await call(t, 'POST', `/api/rentals/${target.id}/terminate`);
    expect(r.statusCode).toBe(200);
    expect(r.json().gatewayFailed).toBeGreaterThan(0);
    const st = (await db.query<any>(`SELECT gateway_status FROM rental_charges WHERE contract_id = $1 AND status = 'canceled' AND gateway_id IS NOT NULL`, [target.id])).rows;
    expect(st.every((x: any) => x.gateway_status === 'cancel_failed')).toBe(true);
    const n = (await call(t, 'GET', '/api/notifications')).json().items.map((x: any) => x.message).join(' ');
    expect(n).toMatch(/não puderam ser canceladas no provedor/);
  });
});

describe('isolamento e desconexão', () => {
  it('tenant B não emite cobrança do tenant A e não vê a conta de A', async () => {
    const a = await login('owner@a.demo');
    const b = await login('owner@b.demo');
    const aCharge = (await charges(a)).find((c) => c.status === 'open');
    expect((await call(b, 'POST', `/api/charges/${aCharge.id}/issue`)).statusCode).toBe(404);
    const accA = (await call(a, 'GET', '/api/payments/account')).json();
    const accB = (await call(b, 'GET', '/api/payments/account')).json();
    expect(accA.webhookUrl).not.toBe(accB.webhookUrl);
  });

  it('desconectar remove a conta; depois disso o webhook antigo deixa de valer', async () => {
    const a = await login('owner@a.demo');
    const tid = await tenantOf('owner@a.demo');
    const tok = (await call(a, 'POST', '/api/payments/account/webhook-token')).json().webhookToken;
    expect((await hook(tid, tok, { id: 'evt_antes', event: 'PAYMENT_OVERDUE', payment: { id: 'x' } })).statusCode).toBe(200);
    expect((await call(a, 'DELETE', '/api/payments/account')).statusCode).toBe(200);
    expect((await hook(tid, tok, { id: 'evt_depois', event: 'PAYMENT_OVERDUE', payment: { id: 'x' } })).statusCode).toBe(401);
    expect((await call(a, 'DELETE', '/api/payments/account')).statusCode).toBe(404);
    expect((await call(a, 'POST', `/api/charges/${(await charges(a))[0].id}/issue`)).statusCode).toBe(409);
  });
});
