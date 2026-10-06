import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/client.js';
import { makeTestDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { seedDemo } from '../src/db/seed.js';
import { config } from '../src/config.js';
import { passwordProblem } from '../src/auth.js';
import { consumeInvite } from '../src/routes/portal.js';

const PW = 'senha-de-teste-123';
const OWNER_PW = 'Proprietaria#2026';
let db: Db;
let app: FastifyInstance;
let ipN = 0;
const tokens = new Map<string, string>();
const nextIp = () => `10.3.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;

const call = (t: string | null, method: any, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: payload as any, headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...headers }, remoteAddress: nextIp() });

async function login(email: string, password = PW) {
  const key = `${email}|${password}`;
  if (tokens.has(key)) return tokens.get(key)!;
  const r = await call(null, 'POST', '/api/auth/login', { email, password });
  if (r.statusCode === 200) tokens.set(key, r.json().token);
  return r.json().token as string;
}
const tokenFromUrl = (url: string) => new URL(url, 'http://x').searchParams.get('token')!;
const ownerId = async (t: string, name: string) => (await call(t, 'GET', '/api/contacts?kind=owner')).json().items.find((c: any) => c.name === name).id as string;

/** Convida, aceita e devolve o token de sessão do proprietário. */
async function onboard(staffToken: string, name: string, email: string) {
  const inv = await call(staffToken, 'POST', '/api/portal/invites', { contactId: await ownerId(staffToken, name), email });
  expect(inv.statusCode).toBe(201);
  const acc = await call(null, 'POST', '/api/auth/accept-invite', { token: tokenFromUrl(inv.json().inviteUrl), password: OWNER_PW });
  expect(acc.statusCode).toBe(200);
  const t = await login(email, OWNER_PW);
  expect(t).toBeTruthy();
  return t;
}

beforeAll(async () => {
  config.jwtSecret = 'o'.repeat(40);
  process.env.DATA_ENC_KEY = 'd'.repeat(40);
  db = await makeTestDb();
  app = await buildApp(db);
  await seedDemo(db, { tenantName: 'A', password: PW, emailPrefix: 'a' });
  await seedDemo(db, { tenantName: 'B', password: PW, emailPrefix: 'b' });
}, 120_000);

describe('política de senha', () => {
  it('recusa senhas curtas, óbvias, iguais ao e-mail ou de uma só classe', () => {
    const e = 'helena@exemplo.com';
    for (const bad of ['curta1', '1234567890ab', 'helena@exemplo.com', 'xxxxxxxxxxxx', 'senha12345abc', 'somenteletras', '12345678901234']) expect(passwordProblem(bad, e), bad).toBeTruthy();
    expect(passwordProblem('helenaSuperSegura1', e)).toMatch(/e-mail/); // contém o nome do e-mail
    expect(passwordProblem(OWNER_PW, e)).toBeNull();
    expect(passwordProblem('Quatro palavras comuns juntas', e)).toBeNull();
  });
});

describe('convite e aceite', () => {
  it('gera convite de uso único: token só em hash, usuário inativo até aceitar', async () => {
    const mgr = await login('manager@a.demo');
    const id = await ownerId(mgr, 'Helena Prado');
    const inv = await call(mgr, 'POST', '/api/portal/invites', { contactId: id, email: 'Helena@Proprietaria.example' });
    expect(inv.statusCode).toBe(201);
    const token = tokenFromUrl(inv.json().inviteUrl);
    expect(token.length).toBeGreaterThanOrEqual(40);
    const { rows } = await db.query<any>(`SELECT token_hash FROM user_invites`);
    expect(rows.every((r: any) => r.token_hash !== token)).toBe(true);
    expect(JSON.stringify((await call(mgr, 'GET', '/api/audit')).json())).not.toContain(token); // nem na auditoria
    const u = (await db.query<any>(`SELECT role, active, contact_id, email FROM users WHERE email = 'helena@proprietaria.example'`)).rows[0];
    expect(u).toMatchObject({ role: 'landlord', active: false, contact_id: id });
    expect((await call(null, 'POST', '/api/auth/login', { email: 'helena@proprietaria.example', password: 'qualquer-coisa-123' })).statusCode).toBe(401);
    const list = (await call(mgr, 'GET', '/api/portal/access')).json().items.find((i: any) => i.id === id);
    expect(list).toMatchObject({ hasUser: true, accepted: false, properties: expect.any(Number) });
  });

  it('senha fraca não gasta o convite; senha boa ativa o acesso; o link não funciona duas vezes', async () => {
    const mgr = await login('manager@a.demo');
    const id = await ownerId(mgr, 'Helena Prado');
    const token = tokenFromUrl((await call(mgr, 'POST', '/api/portal/invites', { contactId: id, email: 'helena@proprietaria.example' })).json().inviteUrl);
    const weak = await call(null, 'POST', '/api/auth/accept-invite', { token, password: 'curta' });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error).toMatch(/10 caracteres/);
    expect((await call(null, 'POST', '/api/auth/accept-invite', { token, password: 'helena@proprietaria.example' })).statusCode).toBe(400);
    const ok = await call(null, 'POST', '/api/auth/accept-invite', { token, password: OWNER_PW });
    expect(ok.statusCode).toBe(200); // o link ainda valia depois das senhas recusadas
    const again = await call(null, 'POST', '/api/auth/accept-invite', { token, password: 'OutraSenha#2026' });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toMatch(/inválido ou expirado/);
    expect(await login('helena@proprietaria.example', OWNER_PW)).toBeTruthy();
    expect((await call(null, 'POST', '/api/auth/login', { email: 'helena@proprietaria.example', password: 'OutraSenha#2026' })).statusCode).toBe(401);
  });

  it('aceites simultâneos do mesmo link: só um vence; token inválido, expirado e novo convite invalidando o antigo', async () => {
    const mgr = await login('manager@a.demo');
    const id = await ownerId(mgr, 'Otávio Mendes');
    const tk = tokenFromUrl((await call(mgr, 'POST', '/api/portal/invites', { contactId: id, email: 'otavio@proprietario.example' })).json().inviteUrl);
    const rs = await Promise.all([1, 2, 3, 4].map(() => call(null, 'POST', '/api/auth/accept-invite', { token: tk, password: OWNER_PW })));
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);

    expect((await call(null, 'POST', '/api/auth/accept-invite', { token: 'x'.repeat(43), password: OWNER_PW })).statusCode).toBe(400);
    const idS = await ownerId(mgr, 'Sílvia Cardoso');
    const old = tokenFromUrl((await call(mgr, 'POST', '/api/portal/invites', { contactId: idS, email: 'silvia@proprietaria.example' })).json().inviteUrl);
    const neu = tokenFromUrl((await call(mgr, 'POST', '/api/portal/invites', { contactId: idS, email: 'silvia@proprietaria.example' })).json().inviteUrl);
    expect((await call(null, 'POST', '/api/auth/accept-invite', { token: old, password: OWNER_PW })).statusCode).toBe(400); // convite antigo invalidado
    await db.query(`UPDATE user_invites SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`, [(await import('node:crypto')).createHash('sha256').update(neu).digest('hex')]);
    expect((await call(null, 'POST', '/api/auth/accept-invite', { token: neu, password: OWNER_PW })).statusCode).toBe(400); // expirado
  });

  it('e-mail em uso por outro usuário e troca de e-mail sem revogar são recusados; só quem administra convida', async () => {
    const mgr = await login('manager@a.demo');
    const id = await ownerId(mgr, 'Sílvia Cardoso');
    expect((await call(mgr, 'POST', '/api/portal/invites', { contactId: id, email: 'owner@a.demo' })).statusCode).toBe(409);
    expect((await call(mgr, 'POST', '/api/portal/invites', { contactId: id, email: 'outro-email@proprietaria.example' })).statusCode).toBe(409);
    expect((await call(mgr, 'POST', '/api/portal/invites', { contactId: id, email: 'invalido' })).statusCode).toBe(400);
    const broker = await login('broker@a.demo');
    expect((await call(broker, 'POST', '/api/portal/invites', { contactId: id, email: 'x@y.example' })).statusCode).toBe(403);
    expect((await call(broker, 'GET', '/api/portal/access')).statusCode).toBe(403);
  });
});

describe('consumo atômico do convite', () => {
  it('chamadas realmente concorrentes: exatamente uma consome o convite', async () => {
    const tid = (await db.query<any>(`SELECT tenant_id FROM users WHERE email = 'owner@a.demo'`)).rows[0].tenant_id;
    const uid = (await db.query<any>(`SELECT id FROM users WHERE email = 'owner@a.demo'`)).rows[0].id;
    await db.query(`INSERT INTO user_invites (tenant_id, user_id, token_hash, expires_at) VALUES ($1,$2,'hash-concorrente-1', now() + interval '1 day')`, [tid, uid]);
    // cada tentativa segura a transação aberta por um instante para forçar a sobreposição no banco
    const results = await Promise.all(Array.from({ length: 6 }, () => db.transaction(async (tx) => {
      const r = await consumeInvite(tx, 'hash-concorrente-1');
      await new Promise((res) => setTimeout(res, 30));
      return r;
    })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.transaction((tx) => consumeInvite(tx, 'hash-concorrente-1'))).toBeNull();
    await db.query(`INSERT INTO user_invites (tenant_id, user_id, token_hash, expires_at) VALUES ($1,$2,'hash-expirado-1', now() - interval '1 minute')`, [tid, uid]);
    expect(await db.transaction((tx) => consumeInvite(tx, 'hash-expirado-1'))).toBeNull();
  });
});

describe('negar por padrão', () => {
  it('proprietário é barrado em TODA rota que não é do portal (inventário de rotas)', async () => {
    const t = await login('helena@proprietaria.example', OWNER_PW);
    const allowed = [/^\/api\/me$/, /^\/api\/auth\/mfa\/(setup|enable|disable)$/, /^\/api\/portal\/(summary|properties|charges|payouts|statement\.csv)$/];
    const zero = '00000000-0000-0000-0000-000000000000';
    const routes = app.registeredRoutes.filter((r) => r.url.startsWith('/api/') && !r.public && r.method !== 'HEAD' && r.method !== 'OPTIONS');
    expect(routes.length).toBeGreaterThan(60); // o inventário realmente cobre o sistema
    const leaked: string[] = [];
    for (const r of routes) {
      if (allowed.some((a) => a.test(r.url))) continue;
      const url = r.url.replace(/:[A-Za-z]+/g, zero);
      const res = await call(t, r.method as any, url, ['POST', 'PUT', 'PATCH'].includes(r.method) ? {} : undefined);
      if (res.statusCode !== 403) leaked.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(leaked).toEqual([]);
  });

  it('equipe da imobiliária não usa os endpoints do portal do proprietário', async () => {
    for (const email of ['owner@a.demo', 'manager@a.demo', 'financeiro@a.demo', 'broker@a.demo']) {
      const t = await login(email);
      for (const path of ['summary', 'properties', 'charges', 'payouts', 'statement.csv']) {
        expect((await call(t, 'GET', `/api/portal/${path}`)).statusCode, `${email} ${path}`).toBe(403);
      }
    }
  });

  it('usuário "landlord" sem vínculo com um proprietário não enxerga nada', async () => {
    const tid = (await db.query<any>(`SELECT tenant_id FROM users WHERE email = 'owner@a.demo'`)).rows[0].tenant_id;
    const { hashPassword } = await import('../src/auth.js');
    await db.query(`INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES ($1,'orfao@proprietaria.example','Órfão','landlord',$2)`, [tid, hashPassword(OWNER_PW)]);
    const t = await login('orfao@proprietaria.example', OWNER_PW);
    for (const path of ['summary', 'properties', 'charges', 'payouts']) expect((await call(t, 'GET', `/api/portal/${path}`)).statusCode).toBe(403);
  });
});

describe('o proprietário vê só o que é dele', () => {
  let helena: string;
  beforeAll(async () => { helena = await login('helena@proprietaria.example', OWNER_PW); });

  it('imóveis: exatamente os dele (por vínculo direto ou por contrato), nenhum de outro proprietário', async () => {
    const r = (await call(helena, 'GET', '/api/portal/properties')).json();
    const mine = (await db.query<any>(
      `SELECT p.id FROM properties p JOIN contacts c ON c.tenant_id = p.tenant_id WHERE c.name = 'Helena Prado' AND c.tenant_id = (SELECT tenant_id FROM users WHERE email = 'owner@a.demo')
         AND (p.owner_contact_id = c.id OR EXISTS (SELECT 1 FROM rental_contracts rc WHERE rc.property_id = p.id AND rc.landlord_id = c.id))`)).rows.map((x: any) => x.id).sort();
    expect(mine.length).toBeGreaterThan(0);
    expect(r.items.map((i: any) => i.id).sort()).toEqual(mine);
    const others = (await db.query<any>(`SELECT p.id FROM properties p WHERE p.tenant_id = (SELECT tenant_id FROM users WHERE email = 'owner@a.demo') AND p.id <> ALL($1::uuid[])`, [mine])).rows.length;
    expect(others).toBeGreaterThan(30); // há muito imóvel que não é dela, e nenhum aparece
    const item = r.items[0];
    expect(item).toMatchObject({ interest: { contacts90d: expect.any(Number), visitsDone90d: expect.any(Number), visitsUpcoming: expect.any(Number) }, health: { score: expect.any(Number) } });
  });

  it('resumo, repasses, cobranças e extrato batem com o banco e só trazem dados dele', async () => {
    const s = (await call(helena, 'GET', '/api/portal/summary')).json();
    const cid = (await db.query<any>(`SELECT id FROM contacts WHERE name = 'Helena Prado' AND tenant_id = (SELECT tenant_id FROM users WHERE email = 'owner@a.demo')`)).rows[0].id;
    const db1 = (await db.query<any>(`SELECT coalesce(sum(net_cents),0)::bigint n, count(*)::int c FROM rental_payouts WHERE landlord_id = $1 AND status = 'pending'`, [cid])).rows[0];
    expect(s.payoutPendingCents).toBe(Number(db1.n));
    expect(s.payoutPendingCount).toBe(db1.c);
    const rent = (await db.query<any>(`SELECT coalesce(sum(rent_cents),0)::bigint n FROM rental_contracts WHERE landlord_id = $1 AND status = 'active'`, [cid])).rows[0].n;
    expect(s.monthlyRentCents).toBe(Number(rent));

    const po = (await call(helena, 'GET', '/api/portal/payouts')).json();
    expect(po.items.length).toBeGreaterThan(0);
    const ids = po.items.map((i: any) => i.id);
    const foreign = (await db.query<any>(`SELECT 1 FROM rental_payouts WHERE id = ANY($1::uuid[]) AND landlord_id <> $2`, [ids, cid])).rows;
    expect(foreign).toHaveLength(0);
    expect(po.totals.netCents).toBe(po.items.reduce((a: number, i: any) => a + i.net_cents, 0));
    expect(po.items.every((i: any) => i.gross_cents - i.admin_fee_cents === i.net_cents)).toBe(true);
    expect((await call(helena, 'GET', '/api/portal/payouts?status=pending')).json().items.every((i: any) => i.status === 'pending')).toBe(true);
    expect((await call(helena, 'GET', '/api/portal/payouts?from=2020-13')).statusCode).toBe(400); // filtro inválido
    const ch = (await call(helena, 'GET', '/api/portal/charges')).json();
    expect(ch.items.length).toBeGreaterThan(0);
  });

  it('minimização de dados: sem contato, documento ou boleto do inquilino, nem nomes de leads', async () => {
    const all = JSON.stringify([
      (await call(helena, 'GET', '/api/portal/properties')).json(), (await call(helena, 'GET', '/api/portal/charges')).json(),
      (await call(helena, 'GET', '/api/portal/payouts')).json(), (await call(helena, 'GET', '/api/portal/summary')).json(),
    ]);
    expect(all).not.toContain('83988887777');          // telefone dos contatos
    expect(all).not.toMatch(/document|cpf|cnpj|phone|email|gateway|boleto|pix/i);
    const leadNames = (await db.query<any>(`SELECT DISTINCT c.name FROM leads l JOIN contacts c ON c.id = l.contact_id LIMIT 20`)).rows.map((r: any) => r.name);
    for (const n of leadNames) expect(all).not.toContain(n);
  });

  it('extrato em CSV: separador ;, vírgula decimal, BOM, anexo, auditado e protegido contra injeção de fórmula', async () => {
    const tid = (await db.query<any>(`SELECT tenant_id FROM users WHERE email = 'owner@a.demo'`)).rows[0].tenant_id;
    await db.query(`UPDATE properties SET title = '=HYPERLINK("http://mal.example")' WHERE tenant_id = $1 AND owner_contact_id = (SELECT id FROM contacts WHERE name = 'Helena Prado' AND tenant_id = $1) AND id = (SELECT property_id FROM rental_contracts WHERE landlord_id = (SELECT id FROM contacts WHERE name = 'Helena Prado' AND tenant_id = $1) LIMIT 1)`, [tid]);
    const r = await call(helena, 'GET', '/api/portal/statement.csv');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="extrato-repasses\.csv"/);
    expect(r.body.charCodeAt(0)).toBe(0xFEFF);
    const lines = r.body.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('Competência;Imóvel;Recebido do inquilino (R$);Taxa de administração (R$);Líquido (R$);Situação;Data do repasse');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1]).toMatch(/;\d+,\d{2};\d+,\d{2};\d+,\d{2};(A repassar|Repassado);/);
    expect(r.body).toContain("\"'=HYPERLINK(\"\"http://mal.example\"\")\""); // célula neutralizada
    expect(r.body).not.toMatch(/;=HYPERLINK/);
    const log = (await call(await login('manager@a.demo'), 'GET', '/api/audit')).json().items.map((x: any) => x.summary).join('\n');
    expect(log).toMatch(/Extrato exportado \(\d+ linha\(s\)\)/);
  });
});

describe('isolamento entre imobiliárias e revogação', () => {
  it('outra imobiliária não convida nem revoga contatos desta; proprietário de B só vê B', async () => {
    const a = await login('manager@a.demo');
    const b = await login('manager@b.demo');
    const idA = await ownerId(a, 'Helena Prado');
    expect((await call(b, 'POST', '/api/portal/invites', { contactId: idA, email: 'invasor@b.example' })).statusCode).toBe(404);
    expect((await call(b, 'DELETE', `/api/portal/access/${idA}`)).statusCode).toBe(404);
    const helenaB = await onboard(b, 'Helena Prado', 'helena@b-proprietaria.example'); // mesmo nome, outra imobiliária
    const propsB = (await call(helenaB, 'GET', '/api/portal/properties')).json().items.map((i: any) => i.id);
    const tenantB = (await db.query<any>(`SELECT tenant_id FROM users WHERE email = 'owner@b.demo'`)).rows[0].tenant_id;
    const wrong = (await db.query<any>(`SELECT 1 FROM properties WHERE id = ANY($1::uuid[]) AND tenant_id <> $2`, [propsB, tenantB])).rows;
    expect(wrong).toHaveLength(0);
    const helenaA = await login('helena@proprietaria.example', OWNER_PW);
    const propsA = (await call(helenaA, 'GET', '/api/portal/properties')).json().items.map((i: any) => i.id);
    expect(propsA.filter((id: string) => propsB.includes(id))).toEqual([]);
  });

  it('revogar derruba o acesso na hora (mesmo com o token em mãos) e um novo convite reativa', async () => {
    const mgr = await login('manager@a.demo');
    const t = await login('helena@proprietaria.example', OWNER_PW);
    expect((await call(t, 'GET', '/api/portal/summary')).statusCode).toBe(200);
    const id = await ownerId(mgr, 'Helena Prado');
    expect((await call(mgr, 'DELETE', `/api/portal/access/${id}`)).statusCode).toBe(200);
    expect((await call(t, 'GET', '/api/portal/summary')).statusCode).toBe(401);
    expect((await call(null, 'POST', '/api/auth/login', { email: 'helena@proprietaria.example', password: OWNER_PW })).statusCode).toBe(401);
    expect((await call(mgr, 'DELETE', `/api/portal/access/${id}`)).statusCode).toBe(200); // idempotente
    tokens.clear();
    const again = await call(mgr, 'POST', '/api/portal/invites', { contactId: id, email: 'helena@proprietaria.example' });
    expect(again.statusCode).toBe(201);
    expect((await call(null, 'POST', '/api/auth/accept-invite', { token: tokenFromUrl(again.json().inviteUrl), password: 'NovaSenha#Forte2026' })).statusCode).toBe(200);
    expect(await login('helena@proprietaria.example', 'NovaSenha#Forte2026')).toBeTruthy();
    const log = (await call(mgr, 'GET', '/api/audit')).json().items.map((x: any) => x.summary).join('\n');
    expect(log).toMatch(/Acesso ao portal do proprietário revogado/);
    expect(log).toMatch(/aceitou o convite/);
  });
});
