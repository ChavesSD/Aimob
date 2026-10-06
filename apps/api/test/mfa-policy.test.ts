import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/client.js';
import { makeTestDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { seedDemo } from '../src/db/seed.js';
import { config } from '../src/config.js';
import { base32Decode, hotp, stepAt } from '../src/domain/totp.js';
import { hashPassword } from '../src/auth.js';
import { MFA_SETUP_ROUTES, mfaRequiredFor } from '../src/routes/mfa.js';

const PW = 'senha-de-teste-123';
let db: Db;
let app: FastifyInstance;
let ipN = 0;
const nextIp = () => `10.6.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;
const call = (t: string | null, method: any, url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as any, headers: t ? { authorization: `Bearer ${t}` } : {}, remoteAddress: nextIp() });
const codeFor = (secret: string, offset = 0) => hotp(base32Decode(secret), stepAt(Date.now()) + offset);

const loginRaw = (email: string) => call(null, 'POST', '/api/auth/login', { email, password: PW });
/** Token de quem ainda NÃO tem MFA (login direto). */
const tokenOf = async (email: string) => (await loginRaw(email)).json().token as string;

const secrets = new Map<string, string>();
/** Entra sem MFA, cadastra o MFA e guarda o segredo (para gerar códigos depois). */
async function enrollUser(email: string) {
  const token = await tokenOf(email);
  const setup = (await call(token, 'POST', '/api/auth/mfa/setup')).json();
  expect((await call(token, 'POST', '/api/auth/mfa/enable', { code: codeFor(setup.secret) })).statusCode, `cadastro de ${email}`).toBe(200);
  secrets.set(email, setup.secret);
}
/** Login completo de quem já tem MFA (usa o passo seguinte para não reaproveitar o código do cadastro). */
async function fullLogin(email: string, offset = 1) {
  const first = (await loginRaw(email)).json();
  expect(first.mfaRequired, `${email} deveria pedir o código`).toBe(true);
  const v = await call(null, 'POST', '/api/auth/mfa/verify', { mfaToken: first.mfaToken, code: codeFor(secrets.get(email)!, offset) });
  expect(v.statusCode).toBe(200);
  return v.json().token as string;
}
const idOf = async (email: string) => (await db.query<any>(`SELECT id FROM users WHERE email = $1`, [email])).rows[0].id as string;

beforeAll(async () => {
  config.jwtSecret = 'p'.repeat(40);
  process.env.DATA_ENC_KEY = 'd'.repeat(40);
  process.env.MFA_ENC_KEY = 'k'.repeat(40);
  db = await makeTestDb();
  app = await buildApp(db);
  await seedDemo(db, { tenantName: 'A', password: PW, emailPrefix: 'a', mfaPolicy: 'admins' }); // exige MFA da gestão
  await seedDemo(db, { tenantName: 'B', password: PW, emailPrefix: 'b', mfaPolicy: 'off' });
}, 120_000);

describe('regra de quem precisa de MFA', () => {
  it('por política e por papel', () => {
    for (const r of ['owner', 'manager', 'finance']) expect(mfaRequiredFor('admins', r)).toBe(true);
    for (const r of ['broker', 'marketing', 'landlord']) expect(mfaRequiredFor('admins', r)).toBe(false);
    for (const r of ['owner', 'manager', 'finance', 'broker', 'marketing']) expect(mfaRequiredFor('staff', r)).toBe(true);
    expect(mfaRequiredFor('staff', 'landlord')).toBe(false); // usuário externo nunca é obrigado
    for (const r of ['owner', 'manager', 'broker']) expect(mfaRequiredFor('off', r)).toBe(false);
    expect([...MFA_SETUP_ROUTES].sort()).toEqual(['/api/auth/mfa/enable', '/api/auth/mfa/setup', '/api/me']);
  });
});

describe('exigência com política "admins"', () => {
  it('quem deve ter MFA e não tem só alcança a configuração; o resto é barrado com código claro', async () => {
    const t = await tokenOf('manager@a.demo');
    for (const [m, u] of [['GET', '/api/dashboard'], ['GET', '/api/leads'], ['GET', '/api/properties'], ['GET', '/api/rentals'], ['GET', '/api/audit'], ['POST', '/api/leads'], ['GET', '/api/team'], ['GET', '/api/payments/account']] as const) {
      const r = await call(t, m, u, m === 'POST' ? {} : undefined);
      expect(r.statusCode, `${m} ${u}`).toBe(403);
      expect(r.json().code, `${m} ${u}`).toBe('mfa_setup_required');
    }
    const me = await call(t, 'GET', '/api/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ mfaEnabled: false, mfaRequired: true, mfaPolicy: 'admins' });
    expect((await call(t, 'POST', '/api/auth/mfa/setup')).statusCode).toBe(200);
  });

  it('depois de ativar o MFA a restrição some; corretor não era exigido; diretoria e financeiro também ficam restritos', async () => {
    const t = await tokenOf('manager@a.demo');
    await enrollUser('manager@a.demo');
    expect((await call(t, 'GET', '/api/dashboard')).statusCode).toBe(200); // o mesmo token: a regra é avaliada a cada chamada
    expect((await call(await tokenOf('broker@a.demo'), 'GET', '/api/leads')).statusCode).toBe(200);
    for (const e of ['owner@a.demo', 'financeiro@a.demo']) expect((await call(await tokenOf(e), 'GET', '/api/dashboard')).statusCode, e).toBe(403);
  });

  it('rotas públicas não são afetadas', async () => {
    expect((await call(null, 'POST', '/api/public/evento', { sessionId: 'sessao-teste-1', event: 'pageview' })).statusCode).toBe(204);
    expect((await call(null, 'GET', '/api/webhooks/asaas')).statusCode).toBe(200);
  });
});

describe('quem pode mudar a regra', () => {
  it('só a diretoria, e só com o próprio MFA ativo; valor inválido recusado; vale na hora; auditado', async () => {
    const ownerB = await tokenOf('owner@b.demo'); // tenant B: política desligada, dono ainda sem MFA
    const blocked = await call(ownerB, 'PUT', '/api/settings/mfa-policy', { policy: 'admins' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toMatch(/Ative a sua própria verificação/);
    await enrollUser('owner@b.demo');
    expect((await call(ownerB, 'PUT', '/api/settings/mfa-policy', { policy: 'tudo' })).statusCode).toBe(400);
    const mgrB = await tokenOf('manager@b.demo');
    expect((await call(mgrB, 'GET', '/api/settings/mfa-policy')).json().policy).toBe('off'); // o gerente pode ver
    expect((await call(mgrB, 'PUT', '/api/settings/mfa-policy', { policy: 'off' })).statusCode).toBe(403); // mas não alterar
    expect((await call(ownerB, 'PUT', '/api/settings/mfa-policy', { policy: 'admins' })).json()).toMatchObject({ ok: true, policy: 'admins' });
    expect((await call(mgrB, 'GET', '/api/dashboard')).json().code).toBe('mfa_setup_required'); // passou a valer na hora
    const log = (await call(ownerB, 'GET', '/api/audit')).json().items.map((x: any) => x.summary).join('\n');
    expect(log).toMatch(/alterada de "ninguém" para "diretoria, gerência e financeiro"/);
    await call(ownerB, 'PUT', '/api/settings/mfa-policy', { policy: 'staff' }); // endurece para toda a equipe
    expect((await call(await tokenOf('broker@b.demo'), 'GET', '/api/leads')).json().code).toBe('mfa_setup_required');
  });

  it('o proprietário (usuário externo) nunca é obrigado, nem na política "staff"', async () => {
    const tid = (await db.query<any>(`SELECT tenant_id FROM users WHERE email = 'owner@b.demo'`)).rows[0].tenant_id;
    const cid = (await db.query<any>(`SELECT id FROM contacts WHERE tenant_id = $1 AND kind = 'owner' LIMIT 1`, [tid])).rows[0].id;
    await db.query(`INSERT INTO users (tenant_id, email, name, role, password_hash, contact_id) VALUES ($1,'dono@b.example','Dono','landlord',$2,$3)`, [tid, hashPassword(PW), cid]);
    expect((await call(await tokenOf('dono@b.example'), 'GET', '/api/portal/summary')).statusCode).toBe(200);
  });
});

describe('redefinição do MFA de um colega', () => {
  it('derruba as sessões antigas, apaga códigos e segredo, e exige novo cadastro; o novo login funciona', async () => {
    await enrollUser('owner@a.demo');
    const owner = await fullLogin('owner@a.demo');
    const managerOld = await fullLogin('manager@a.demo');
    expect((await call(managerOld, 'GET', '/api/dashboard')).statusCode).toBe(200);
    const mgrId = await idOf('manager@a.demo');

    expect((await call(owner, 'POST', `/api/team/${await idOf('owner@a.demo')}/mfa-reset`)).statusCode).toBe(400); // não redefine a si mesmo por aqui
    expect((await call(owner, 'POST', `/api/team/${mgrId}/mfa-reset`)).statusCode).toBe(200);

    const row = (await db.query<any>(`SELECT mfa_enabled, mfa_secret_enc, session_epoch FROM users WHERE id = $1`, [mgrId])).rows[0];
    expect(row).toMatchObject({ mfa_enabled: false, mfa_secret_enc: null, session_epoch: 1 });
    expect((await db.query<any>(`SELECT 1 FROM mfa_recovery_codes WHERE user_id = $1`, [mgrId])).rows).toHaveLength(0);
    expect((await call(managerOld, 'GET', '/api/dashboard')).statusCode).toBe(401); // a sessão que ele tinha caiu

    const fresh = await tokenOf('manager@a.demo'); // já não pede código, mas a política exige cadastrar de novo
    expect((await call(fresh, 'GET', '/api/dashboard')).json().code).toBe('mfa_setup_required');
    await enrollUser('manager@a.demo');
    expect((await call(fresh, 'GET', '/api/dashboard')).statusCode).toBe(200);
    const log = (await call(owner, 'GET', '/api/audit')).json().items.map((x: any) => x.summary).join('\n');
    expect(log).toMatch(/Verificação em duas etapas de .* redefinida; sessões anteriores encerradas/);
  });

  it('token emitido antes da revogação deixa de valer; o token novo emitido logo depois vale (sem janela de rejeição)', async () => {
    const before = await tokenOf('broker@a.demo');
    expect((await call(before, 'GET', '/api/leads')).statusCode).toBe(200);
    await db.query(`UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1`, [await idOf('broker@a.demo')]);
    const old = await call(before, 'GET', '/api/leads');
    expect(old.statusCode).toBe(401);
    expect(old.json().error).toMatch(/encerrada por segurança/);
    expect((await call(await tokenOf('broker@a.demo'), 'GET', '/api/leads')).statusCode).toBe(200); // mesmo segundo
  });

  it('exige o MFA de quem redefine; só a diretoria; uma imobiliária não alcança usuários de outra', async () => {
    // gerente (sem poder de administrar usuários)
    const mgr = await fullLogin('manager@a.demo');
    expect((await call(mgr, 'POST', `/api/team/${await idOf('manager@a.demo')}/mfa-reset`)).statusCode).toBe(403);
    // diretoria de B com MFA: não enxerga usuário de A
    const ownerB = await fullLogin('owner@b.demo');
    expect((await call(ownerB, 'POST', `/api/team/${await idOf('manager@a.demo')}/mfa-reset`)).statusCode).toBe(404);
    // diretoria de B SEM MFA (desligado à força): precisa ativar o seu antes de redefinir o de outros
    await call(ownerB, 'PUT', '/api/settings/mfa-policy', { policy: 'off' });
    await db.query(`UPDATE users SET mfa_enabled = false WHERE email = 'owner@b.demo'`);
    const noMfa = await tokenOf('owner@b.demo');
    const r = await call(noMfa, 'POST', `/api/team/${await idOf('broker@b.demo')}/mfa-reset`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/Ative a sua própria verificação/);
  });
});
