import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/client.js';
import { makeTestDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { seedDemo } from '../src/db/seed.js';
import { config, normalizeAsaasUrl, platformAsaas, productionProblems } from '../src/config.js';
import { FakeAsaas } from './fakeAsaas.js';
import { providerTuning } from '../src/payments/service.js';

const PW = 'senha-de-teste-123';
const WEBHOOK_TOKEN = 'token-global-do-webhook-com-mais-de-32-caracteres';
const CNPJ = '11.444.777/0001-61';
const CPF = '529.982.247-25';
let db: Db;
let app: FastifyInstance;
let asaas: FakeAsaas;
let ipN = 0;
const tokens = new Map<string, string>();
const nextIp = () => `10.5.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;

async function login(email: string) {
  if (tokens.has(email)) return tokens.get(email)!;
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW }, remoteAddress: nextIp() });
  tokens.set(email, r.json().token);
  return r.json().token as string;
}
const call = (t: string | null, method: any, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: payload as any, headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...headers }, remoteAddress: nextIp() });
const charges = async (t: string) => (await call(t, 'GET', '/api/charges')).json().items as any[];
const renterId = async (t: string, name: string) => (await call(t, 'GET', '/api/contacts?kind=renter')).json().items.find((c: any) => c.name === name).id as string;
const globalHook = (token: string | null, body: unknown) => call(null, 'POST', '/api/webhooks/asaas', body, token ? { 'asaas-access-token': token } : {});
let evSeq = 0;
const received = (paymentId: string, value: number, ref?: string) => ({
  id: `evt_pl_${++evSeq}_${Date.now()}`, event: 'PAYMENT_RECEIVED', payment: { id: paymentId, value, status: 'RECEIVED', paymentDate: null, externalReference: ref ?? null },
});

const company = { name: 'Imobiliária Exemplo Ltda', document: CNPJ, email: 'financeiro@exemplo.com.br', phone: '(83) 99999-0000', monthlyRevenueCents: 5_000_000, street: 'Av. Principal', number: '100', neighborhood: 'Centro', cep: '58000-000' };

beforeAll(async () => {
  config.jwtSecret = 'q'.repeat(40);
  process.env.DATA_ENC_KEY = 'd'.repeat(40);
  asaas = new FakeAsaas('$aact_chave_principal_da_plataforma_0000');
  process.env.ASAAS_API_KEY = asaas.validKey;
  process.env.ASAAS_API_URL = 'https://api-sandbox.asaas.com/v3';
  process.env.ASAAS_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
  delete process.env.ASAAS_USER_AGENT;
  providerTuning.backoffMs = [0, 0];
  db = await makeTestDb();
  app = await buildApp(db, { fetchImpl: asaas.fetch });
  await seedDemo(db, { tenantName: 'A', password: PW, emailPrefix: 'a' });
  await seedDemo(db, { tenantName: 'B', password: PW, emailPrefix: 'b' });
}, 120_000);

describe('configuração igual à do Aidate', () => {
  it('lê ASAAS_API_KEY / ASAAS_API_URL / ASAAS_USER_AGENT / ASAAS_WEBHOOK_TOKEN e normaliza o sandbox antigo', () => {
    expect(platformAsaas({} as any)).toBeNull();
    const p = platformAsaas({ ASAAS_API_KEY: ' $aact_x ', ASAAS_WEBHOOK_TOKEN: 'abc' } as any)!;
    expect(p).toMatchObject({ apiKey: '$aact_x', baseUrl: 'https://api.asaas.com/v3', userAgent: 'Aimob', webhookToken: 'abc' }); // padrão: produção
    expect(normalizeAsaasUrl('https://sandbox.asaas.com/api/v3')).toBe('https://api-sandbox.asaas.com/v3');
    expect(normalizeAsaasUrl('https://sandbox.asaas.com/v3/')).toBe('https://api-sandbox.asaas.com/v3');
    expect(platformAsaas({ ASAAS_API_KEY: 'k', ASAAS_USER_AGENT: 'Intelite' } as any)!.userAgent).toBe('Intelite');
  });
  it('em produção exige o token do webhook quando a conta principal está configurada', () => {
    const base = { DATABASE_URL: 'postgres://u:p@h/db', JWT_SECRET: 'j'.repeat(40), IP_HASH_SALT: 'sal-aleatorio-bem-longo-123', CORS_ORIGIN: 'https://app.x.com', MFA_ENC_KEY: 'k'.repeat(40), DATA_ENC_KEY: 'e'.repeat(40), PUBLIC_API_URL: 'https://api.x.com', TRUST_PROXY: 'true' };
    expect(productionProblems(base as any)).toEqual([]);
    expect(productionProblems({ ...base, ASAAS_API_KEY: '$aact_x' } as any)).toHaveLength(1);
    expect(productionProblems({ ...base, ASAAS_API_KEY: '$aact_x', ASAAS_WEBHOOK_TOKEN: 'w'.repeat(32) } as any)).toEqual([]);
  });
});

describe('dados da empresa e subconta', () => {
  it('sem dados da empresa não cria subconta e informa o que falta', async () => {
    const t = await login('owner@a.demo');
    const acc = (await call(t, 'GET', '/api/payments/account')).json();
    expect(acc).toMatchObject({ connected: false, platformAvailable: true });
    expect(acc.companyMissing).toContain('dados da empresa');
    const r = await call(t, 'POST', '/api/payments/account/provision');
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatch(/Complete os dados da empresa/);
    expect(asaas.count('POST', /^\/accounts$/)).toBe(0);
  });

  it('valida CPF/CNPJ, exige nascimento para CPF e guarda o documento criptografado e mascarado', async () => {
    const t = await login('owner@a.demo');
    const bad = await call(t, 'PUT', '/api/payments/company', { ...company, document: '123.456.789-00' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('CPF ou CNPJ inválido.');
    const pf = await call(t, 'PUT', '/api/payments/company', { ...company, document: CPF });
    expect(pf.json().missing).toEqual(['data de nascimento (obrigatória para CPF)']);
    expect((await call(t, 'POST', '/api/payments/account/provision')).statusCode).toBe(422);
    expect((await call(t, 'PUT', '/api/payments/company', company)).statusCode).toBe(200); // volta para CNPJ
    const { rows } = await db.query<any>(`SELECT document_enc, document_last2 FROM tenant_company`);
    expect(rows[0].document_enc).not.toContain('11444777000161');
    const acc = JSON.stringify((await call(t, 'GET', '/api/payments/account')).json());
    expect(acc).not.toContain('11444777000161');
    expect(acc).toContain('***61');
    expect(JSON.stringify((await call(t, 'GET', '/api/audit')).json())).not.toContain('11444777000161');
    expect((await call(await login('broker@a.demo'), 'PUT', '/api/payments/company', company)).statusCode).toBe(403);
  });

  it('cria a subconta com a chave principal e guarda carteira e chave da subconta sem expô-las', async () => {
    const t = await login('owner@a.demo');
    const r = await call(t, 'POST', '/api/payments/account/provision');
    expect(r.statusCode).toBe(200);
    const post = asaas.calls.find((c) => c.method === 'POST' && c.path === '/accounts')!;
    expect(post.headers['access_token']).toBe(asaas.validKey); // chave PRINCIPAL
    expect(post.headers['user-agent']).toBe('Aimob');
    expect(post.body).toMatchObject({ name: company.name, email: company.email, cpfCnpj: '11444777000161', companyType: 'LIMITED', incomeValue: 50000 });
    expect(post.body.birthDate).toBeUndefined(); // só para CPF
    expect(post.body.postalCode).toBe('58000000');
    const { rows } = await db.query<any>(`SELECT mode, status, wallet_id, gateway_account_id, api_key_enc FROM payment_accounts`);
    expect(rows[0]).toMatchObject({ mode: 'platform_split', status: 'active' });
    expect(rows[0].wallet_id).toMatch(/^wallet_/);
    expect(rows[0].api_key_enc).not.toContain('chave_da_subconta'); // chave da subconta criptografada
    const body = JSON.stringify(r.json()) + JSON.stringify((await call(t, 'GET', '/api/payments/account')).json()) + JSON.stringify((await call(t, 'GET', '/api/audit')).json());
    expect(body).not.toContain('chave_da_subconta');
    expect(body).not.toContain(asaas.validKey);
    expect((await call(t, 'GET', '/api/payments/account')).json()).toMatchObject({ connected: true, mode: 'platform_split', webhookUrl: null });
    // segunda tentativa não cria outra conta
    expect((await call(t, 'POST', '/api/payments/account/provision')).statusCode).toBe(409);
    expect(asaas.count('POST', /^\/accounts$/)).toBe(1);
  });

  it('três requisições simultâneas criam uma única subconta; falha libera nova tentativa sem repetir sozinha', async () => {
    const b = await login('owner@b.demo');
    expect((await call(b, 'PUT', '/api/payments/company', { ...company, name: 'Imobiliária B' })).statusCode).toBe(200);
    const before = asaas.count('POST', /^\/accounts$/);
    asaas.delayMs = 150;
    const rs = await Promise.all([1, 2, 3].map(() => call(b, 'POST', '/api/payments/account/provision')));
    asaas.delayMs = 0;
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(asaas.count('POST', /^\/accounts$/) - before).toBe(1);

    // tenant sem conta, falha do provedor: uma chamada só (sem repetição automática) e a reserva é liberada
    await db.query(`DELETE FROM payment_accounts WHERE tenant_id = (SELECT tenant_id FROM users WHERE email = 'owner@b.demo')`);
    asaas.failNext(/POST \/accounts$/, 'http500', 5);
    const c0 = asaas.count('POST', /^\/accounts$/);
    const down = await call(b, 'POST', '/api/payments/account/provision');
    expect(down.statusCode).toBe(503);
    expect(asaas.count('POST', /^\/accounts$/) - c0).toBe(1); // criar conta é irreversível: não repete sozinho
    asaas.clearFailures();
    expect((await call(b, 'POST', '/api/payments/account/provision')).statusCode).toBe(200);
  });
});

describe('cobrança com split e webhook global', () => {
  let tenantA: string, chargeId: string, paymentId: string, amount: number;

  beforeAll(async () => {
    const t = await login('owner@a.demo');
    tenantA = (await db.query<any>(`SELECT tenant_id FROM users WHERE email = 'owner@a.demo'`)).rows[0].tenant_id;
    await call(t, 'PUT', `/api/contacts/${await renterId(t, 'Larissa Duarte')}/document`, { document: CPF });
  });

  it('emite pela conta principal com split de 100% para a carteira da imobiliária', async () => {
    const t = await login('owner@a.demo');
    const c = (await charges(t)).find((x) => x.renter_name === 'Larissa Duarte' && (x.status === 'overdue' || x.status === 'open'))!;
    const r = await call(t, 'POST', `/api/charges/${c.id}/issue`);
    expect(r.statusCode).toBe(200);
    const post = asaas.calls.filter((x) => x.method === 'POST' && x.path === '/payments').pop()!;
    const wallet = (await db.query<any>(`SELECT wallet_id FROM payment_accounts WHERE tenant_id = $1`, [tenantA])).rows[0].wallet_id;
    expect(post.headers['access_token']).toBe(asaas.validKey);
    expect(post.body.split).toEqual([{ walletId: wallet, percentualValue: 100 }]);
    expect(post.body).toMatchObject({ billingType: 'BOLETO', externalReference: `aimob_charge_${c.id}`, postalService: false });
    chargeId = c.id;
    paymentId = (await db.query<any>(`SELECT gateway_id FROM rental_charges WHERE id = $1`, [c.id])).rows[0].gateway_id;
    amount = c.amount_cents / 100;
    // tenant B cobra para a carteira DELE, nunca a de A
    const b = await login('owner@b.demo');
    await call(b, 'PUT', `/api/contacts/${await renterId(b, 'Larissa Duarte')}/document`, { document: CPF });
    const cb = (await charges(b)).find((x) => x.renter_name === 'Larissa Duarte' && (x.status === 'overdue' || x.status === 'open'))!;
    expect((await call(b, 'POST', `/api/charges/${cb.id}/issue`)).statusCode).toBe(200);
    const postB = asaas.calls.filter((x) => x.method === 'POST' && x.path === '/payments').pop()!;
    expect(postB.body.split[0].walletId).not.toBe(wallet);
  });

  it('webhook global: exige o token da plataforma e ignora o que não é do Aimob (conta compartilhada com o Aidate)', async () => {
    const ev = received(paymentId, amount, `aimob_charge_${chargeId}`);
    for (const tok of [null, 'token-errado-com-mais-de-trinta-e-dois-caracteres', '']) expect((await globalHook(tok, ev)).statusCode).toBe(401);
    const saved = process.env.ASAAS_WEBHOOK_TOKEN;
    process.env.ASAAS_WEBHOOK_TOKEN = ''; // plataforma sem token configurado: nada passa
    expect((await globalHook(WEBHOOK_TOKEN, ev)).statusCode).toBe(401);
    process.env.ASAAS_WEBHOOK_TOKEN = saved;
    expect((await db.query('SELECT 1 FROM payment_events')).rows).toHaveLength(0);

    // eventos de outros sistemas na mesma conta: pagamento desconhecido e referências do Aidate
    for (const foreign of [received('pay_do_aidate_1', 49.9, 'billing_abc123'), received('pay_do_aidate_2', 99, 'plan_change_xyz'), received('pay_do_aidate_3', 10, 'deposit_999'), received('pay_sem_ref', 10)]) {
      const r = await globalHook(WEBHOOK_TOKEN, foreign);
      expect(r.statusCode).toBe(200);
      expect(r.json().ignored).toBe(true);
    }
    expect((await db.query('SELECT 1 FROM payment_events')).rows).toHaveLength(0); // nada gravado
    expect((await db.query<any>(`SELECT status FROM rental_charges WHERE id = $1`, [chargeId])).rows[0].status).toBe('open');
  });

  it('pagamento do Aimob chega pelo webhook global, dá baixa uma única vez e gera repasse', async () => {
    const ev = received(paymentId, amount, `aimob_charge_${chargeId}`);
    expect((await globalHook(WEBHOOK_TOKEN, ev)).statusCode).toBe(200);
    expect((await db.query<any>(`SELECT status, reconciliation FROM rental_charges WHERE id = $1`, [chargeId])).rows[0]).toMatchObject({ status: 'paid', reconciliation: 'ok' });
    expect((await db.query('SELECT 1 FROM rental_payouts WHERE charge_id = $1', [chargeId])).rows).toHaveLength(1);
    expect((await globalHook(WEBHOOK_TOKEN, ev)).json().duplicate).toBe(true);
    expect((await db.query('SELECT 1 FROM rental_payouts WHERE charge_id = $1', [chargeId])).rows).toHaveLength(1);
    const evs = (await call(await login('owner@a.demo'), 'GET', '/api/payments/events')).json().items;
    expect(evs.some((e: any) => e.status === 'processed')).toBe(true);
    expect((await call(await login('owner@b.demo'), 'GET', '/api/payments/events')).json().items).toHaveLength(0); // B não vê eventos de A
  });

  it('identifica a imobiliária pela referência quando o id do provedor ainda não foi gravado', async () => {
    const t = await login('owner@a.demo');
    const c = (await charges(t)).find((x) => x.renter_name === 'Larissa Duarte' && x.status !== 'paid')
      ?? (await charges(t)).find((x) => x.status === 'open' && x.renter_name !== 'Larissa Duarte')!;
    const row = (await db.query<any>(`SELECT id, amount_cents FROM rental_charges WHERE id = $1`, [c.id])).rows[0];
    await db.query(`UPDATE rental_charges SET gateway_id = NULL WHERE id = $1`, [row.id]);
    const ev = received('pay_ainda_nao_gravado', Number(row.amount_cents) / 100, `aimob_charge_${row.id}`);
    expect((await globalHook(WEBHOOK_TOKEN, ev)).statusCode).toBe(200);
    expect((await db.query<any>(`SELECT status FROM rental_charges WHERE id = $1`, [row.id])).rows[0].status).toBe('paid');
  });

  it('o webhook por imobiliária não vale para quem está no modo plataforma', async () => {
    const r = await call(null, 'POST', `/api/webhooks/asaas/${tenantA}`, received('x', 1), { 'asaas-access-token': WEBHOOK_TOKEN });
    expect(r.statusCode).toBe(401);
    expect((await call(await login('owner@a.demo'), 'POST', '/api/payments/account/webhook-token')).statusCode).toBe(404); // sem token por imobiliária
  });

  it('desconectar remove a conta; depois disso não emite', async () => {
    const t = await login('owner@a.demo');
    expect((await call(t, 'DELETE', '/api/payments/account')).statusCode).toBe(200);
    const c = (await charges(t)).find((x) => x.status === 'open' || x.status === 'overdue')!;
    expect((await call(t, 'POST', `/api/charges/${c.id}/issue`)).statusCode).toBe(409);
  });
});
