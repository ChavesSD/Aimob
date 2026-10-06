import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/client.js';
import { makeTestDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { seedDemo } from '../src/db/seed.js';
import { base32Decode, base32Encode, hotp, stepAt, verifyTotp } from '../src/domain/totp.js';
import { config, productionProblems } from '../src/config.js';

const PW = 'senha-de-teste-123';
let db: Db;
let app: FastifyInstance;
let ipN = 0;
const nextIp = () => `10.9.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`; // cada chamada com IP próprio: o rate limit é por IP

const call = (method: any, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: payload as any, headers, remoteAddress: nextIp() });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const codeNow = (secretB32: string, offset = 0) => hotp(base32Decode(secretB32), stepAt(Date.now()) + offset);

async function login(email: string) {
  const r = await call('POST', '/api/auth/login', { email, password: PW });
  return r.json();
}

/** Ativa o MFA para o usuário e devolve segredo e códigos de recuperação. */
async function enroll(email: string) {
  const { token } = await login(email);
  const setup = (await call('POST', '/api/auth/mfa/setup', {}, bearer(token))).json();
  const en = await call('POST', '/api/auth/mfa/enable', { code: codeNow(setup.secret) }, bearer(token));
  expect(en.statusCode).toBe(200);
  return { secret: setup.secret as string, recovery: en.json().recoveryCodes as string[], token };
}

beforeAll(async () => {
  config.jwtSecret = 'm'.repeat(40);
  process.env.MFA_ENC_KEY = 'k'.repeat(40);
  db = await makeTestDb();
  app = await buildApp(db);
  await seedDemo(db, { tenantName: 'A', password: PW, emailPrefix: 'a' });
}, 120_000);

describe('TOTP (RFC 6238)', () => {
  const secret = Buffer.from('12345678901234567890');
  it('reproduz os vetores de teste oficiais (SHA-1, 8 dígitos)', () => {
    const vectors: [number, string][] = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']];
    for (const [t, expected] of vectors) expect(hotp(secret, Math.floor(t / 30), 8)).toBe(expected);
  });
  it('base32 faz ida e volta e rejeita lixo', () => {
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(() => base32Decode('1!?')).toThrow();
  });
  it('aceita 1 passo de tolerância, recusa 2, e formato inválido', () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    expect(verifyTotp(secret, hotp(secret, step), now)).toBe(step);
    expect(verifyTotp(secret, hotp(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, hotp(secret, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, hotp(secret, step + 2), now)).toBeNull();
    expect(verifyTotp(secret, hotp(secret, step - 2), now)).toBeNull();
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 456']) expect(verifyTotp(secret, bad, now)).toBeNull();
  });
});

describe('fluxo de login com MFA', () => {
  it('ativação exige código válido; segredo fica criptografado no banco', async () => {
    const { token } = await login('manager@a.demo');
    expect((await call('POST', '/api/auth/mfa/enable', { code: '123456' }, bearer(token))).statusCode).toBe(400); // antes do setup
    const setup = (await call('POST', '/api/auth/mfa/setup', {}, bearer(token))).json();
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(setup.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const wrong = codeNow(setup.secret) === '000000' ? '111111' : '000000';
    expect((await call('POST', '/api/auth/mfa/enable', { code: wrong }, bearer(token))).statusCode).toBe(400);
    const { rows } = await db.query<any>(`SELECT mfa_secret_enc, mfa_enabled FROM users WHERE email = 'manager@a.demo'`);
    expect(rows[0].mfa_enabled).toBe(false);
    expect(rows[0].mfa_secret_enc).not.toContain(setup.secret); // nunca em claro
    const ok = await call('POST', '/api/auth/mfa/enable', { code: codeNow(setup.secret) }, bearer(token));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().recoveryCodes).toHaveLength(8);
    expect((await call('POST', '/api/auth/mfa/setup', {}, bearer(token))).statusCode).toBe(409); // já ativo
    const stored = await db.query<any>(`SELECT code_hash FROM mfa_recovery_codes`);
    expect(stored.rows.some((r: any) => ok.json().recoveryCodes.includes(r.code_hash))).toBe(false); // só hashes
  });

  it('com MFA ativo, a senha sozinha não gera sessão; o token intermediário não vale como sessão', async () => {
    const r = await login('manager@a.demo');
    expect(r.mfaRequired).toBe(true);
    expect(r.token).toBeUndefined();
    expect((await call('GET', '/api/dashboard', undefined, bearer(r.mfaToken))).statusCode).toBe(401);
    expect((await call('GET', '/api/me', undefined, bearer(r.mfaToken))).statusCode).toBe(401);
  });

  it('código correto abre a sessão; mesmo código não pode ser reutilizado', async () => {
    const { secret } = await (async () => {
      const row = await db.query<any>(`SELECT 1`); void row;
      return { secret: '' };
    })();
    void secret;
    const e = await enroll('broker@a.demo');
    const l1 = await login('broker@a.demo');
    const code = codeNow(e.secret, 1); // passo seguinte, dentro da tolerância
    const v1 = await call('POST', '/api/auth/mfa/verify', { mfaToken: l1.mfaToken, code });
    expect(v1.statusCode).toBe(200);
    expect((await call('GET', '/api/me', undefined, bearer(v1.json().token))).json().mfaEnabled).toBe(true);
    const l2 = await login('broker@a.demo');
    const replay = await call('POST', '/api/auth/mfa/verify', { mfaToken: l2.mfaToken, code });
    expect(replay.statusCode).toBe(401); // mesmo passo: reuso recusado
    const older = await call('POST', '/api/auth/mfa/verify', { mfaToken: l2.mfaToken, code: codeNow(e.secret, 0) });
    expect(older.statusCode).toBe(401); // passo anterior ao já usado também
  });

  it('requisições simultâneas com o mesmo código: só uma passa', async () => {
    const e = await enroll('finance@a.demo'.replace('finance', 'financeiro'));
    const logins = await Promise.all([login('financeiro@a.demo'), login('financeiro@a.demo'), login('financeiro@a.demo'), login('financeiro@a.demo')]);
    const code = codeNow(e.secret, 1);
    const results = await Promise.all(logins.map((l) => call('POST', '/api/auth/mfa/verify', { mfaToken: l.mfaToken, code })));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });

  it('código de recuperação funciona uma única vez', async () => {
    const e = await enroll('corretor2@a.demo');
    const rc = e.recovery[0];
    const l1 = await login('corretor2@a.demo');
    const ok = await call('POST', '/api/auth/mfa/verify', { mfaToken: l1.mfaToken, recoveryCode: rc.toLowerCase() }); // aceita minúsculas
    expect(ok.statusCode).toBe(200);
    const l2 = await login('corretor2@a.demo');
    expect((await call('POST', '/api/auth/mfa/verify', { mfaToken: l2.mfaToken, recoveryCode: rc })).statusCode).toBe(401);
    expect((await call('POST', '/api/auth/mfa/verify', { mfaToken: l2.mfaToken, recoveryCode: e.recovery[1] })).statusCode).toBe(200);
  });

  it('bloqueia após 5 erros, mesmo com o código certo, e registra na auditoria', async () => {
    const e = await enroll('corretor3@a.demo');
    const l = await login('corretor3@a.demo');
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/api/auth/mfa/verify', { mfaToken: l.mfaToken, code: '000000' });
      expect(r.statusCode).toBe(401);
    }
    const locked = await call('POST', '/api/auth/mfa/verify', { mfaToken: l.mfaToken, code: codeNow(e.secret, 1) });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toMatch(/15 minutos/);
    const { rows } = await db.query<any>(`SELECT count(*)::int n FROM audit_log WHERE action = 'auth.mfa_failed'`);
    expect(rows[0].n).toBeGreaterThanOrEqual(5);
    // passado o bloqueio, volta a funcionar
    await db.query(`UPDATE users SET mfa_locked_until = now() - interval '1 minute' WHERE email = 'corretor3@a.demo'`);
    expect((await call('POST', '/api/auth/mfa/verify', { mfaToken: l.mfaToken, code: codeNow(e.secret, 1) })).statusCode).toBe(200);
  });

  it('desativar exige senha e segundo fator; depois o login volta a ser direto', async () => {
    const e = await enroll('owner@a.demo');
    const t = e.token;
    const code = () => codeNow(e.secret, 1);
    expect((await call('POST', '/api/auth/mfa/disable', { password: 'errada', code: code() }, bearer(t))).statusCode).toBe(401);
    expect((await call('POST', '/api/auth/mfa/disable', { password: PW, code: '000000' }, bearer(t))).statusCode).toBe(401);
    expect((await call('POST', '/api/auth/mfa/disable', { password: PW }, bearer(t))).statusCode).toBe(400); // sem fator
    const off = await call('POST', '/api/auth/mfa/disable', { password: PW, code: code() }, bearer(t));
    expect(off.statusCode).toBe(200);
    const r = await login('owner@a.demo');
    expect(r.token).toBeTruthy();
    expect(r.mfaRequired).toBeUndefined();
    const { rows } = await db.query<any>(`SELECT mfa_secret_enc FROM users WHERE email = 'owner@a.demo'`);
    expect(rows[0].mfa_secret_enc).toBeNull();
  });

  it('usuário desativado não conclui o login mesmo com token MFA válido; e-mail inexistente segue 401', async () => {
    const e = await enroll('manager@a.demo').catch(() => null); // já ativo: ok falhar
    void e;
    const l = await login('manager@a.demo');
    await db.query(`UPDATE users SET active = false WHERE email = 'manager@a.demo'`);
    const r = await call('POST', '/api/auth/mfa/verify', { mfaToken: l.mfaToken, code: '123456' });
    expect(r.statusCode).toBe(401);
    expect((await call('POST', '/api/auth/login', { email: 'ninguem@a.demo', password: PW })).statusCode).toBe(401);
    await db.query(`UPDATE users SET active = true WHERE email = 'manager@a.demo'`);
  });

  it('token adulterado ou de outro propósito é recusado', async () => {
    expect((await call('POST', '/api/auth/mfa/verify', { mfaToken: 'x'.repeat(30), code: '123456' })).statusCode).toBe(401);
    const { token } = await login('financeiro@a.demo').then((r) => ({ token: r.token as string | undefined }));
    void token;
    const sess = await db.query<any>(`SELECT id FROM users WHERE email = 'broker@a.demo'`);
    const { signToken } = await import('../src/auth.js');
    const sessionToken = await signToken({ sub: sess.rows[0].id, tid: 'x', role: 'broker' });
    // um token de sessão não serve como token MFA
    expect((await call('POST', '/api/auth/mfa/verify', { mfaToken: sessionToken, code: '123456' })).statusCode).toBe(401);
  });
});

describe('configuração de produção', () => {
  const good = { DATABASE_URL: 'postgres://u:p@h/db', JWT_SECRET: 'j'.repeat(40), IP_HASH_SALT: 'sal-aleatorio-bem-longo-123', CORS_ORIGIN: 'https://app.exemplo.com.br', MFA_ENC_KEY: 'k'.repeat(40), TRUST_PROXY: 'true' };
  it('aceita configuração completa', () => expect(productionProblems(good as any)).toEqual([]));
  it('recusa cada item ausente ou inseguro', () => {
    for (const k of Object.keys(good)) {
      const env: any = { ...good }; delete env[k];
      expect(productionProblems(env).length, `sem ${k}`).toBe(1);
    }
    expect(productionProblems({ ...good, IP_HASH_SALT: 'troque-este-sal' } as any)).toHaveLength(1);
    expect(productionProblems({ ...good, JWT_SECRET: 'curto' } as any)).toHaveLength(1);
    expect(productionProblems({ ...good, TRUST_PROXY: 'talvez' } as any)).toHaveLength(1);
  });
  it('/ready confere o banco e /health responde sem depender dele', async () => {
    expect((await call('GET', '/health')).statusCode).toBe(200);
    expect((await call('GET', '/ready')).statusCode).toBe(200);
  });
});
