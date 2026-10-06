import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/client.js';
import { makeTestDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { seedDemo } from '../src/db/seed.js';
import { lateCharges } from '../src/domain/money.js';
import { generateCharges, today } from '../src/domain/rentalService.js';
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
const call = (t: string, method: any, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${t}` }, payload: payload as any });

beforeAll(async () => {
  config.jwtSecret = 'r'.repeat(40);
  db = await makeTestDb();
  app = await buildApp(db);
  await seedDemo(db, { tenantName: 'A', password: PW, emailPrefix: 'a' });
  await seedDemo(db, { tenantName: 'B', password: PW, emailPrefix: 'b' });
}, 60_000);

const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

describe('inadimplência e cálculo de atraso', () => {
  it('lista cobrança vencida com multa e juros iguais ao cálculo oficial', async () => {
    const t = await login('financeiro@a.demo');
    const d = (await call(t, 'GET', '/api/delinquency')).json();
    expect(d.totals.count).toBeGreaterThanOrEqual(1);
    const item = d.items[0];
    expect(item.days_late).toBeGreaterThan(0);
    const expected = lateCharges(item.amount_cents, item.days_late, { lateFeeBps: 200, interestBpsMonth: 100 });
    expect(item.late_fee_cents).toBe(expected.lateFeeCents);
    expect(item.interest_cents).toBe(expected.interestCents);
    expect(item.total_due_cents).toBe(expected.totalCents);
    expect(d.totals.totalCents).toBe(d.items.reduce((a: number, i: any) => a + i.total_due_cents, 0));
  });

  it('alerta de cobranças vencidas aparece no painel só para quem vê financeiro', async () => {
    const owner = await login('owner@a.demo');
    const broker = await login('broker@a.demo');
    const o = (await call(owner, 'GET', '/api/dashboard')).json().attention;
    const b = (await call(broker, 'GET', '/api/dashboard')).json().attention;
    expect(o.some((x: any) => x.id === 'cobrancas-vencidas' && x.action.href.includes('inadimplencia'))).toBe(true);
    expect(b.some((x: any) => x.id === 'cobrancas-vencidas')).toBe(false);
  });
});

describe('baixa de cobrança e repasse', () => {
  it('baixa atrasada calcula multa/juros, gera repasse correto e não baixa duas vezes', async () => {
    const t = await login('financeiro@a.demo');
    const item = (await call(t, 'GET', '/api/delinquency')).json().items[0];
    const r = await call(t, 'POST', `/api/charges/${item.id}/pay`, {});
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.totalCents).toBe(item.total_due_cents);
    expect(b.payout.adminFeeCents).toBe(Math.round(b.principalCents * 0.1)); // 10% do principal
    expect(b.payout.grossCents).toBe(b.principalCents + b.lateFeeCents + b.interestCents);
    expect(b.payout.netCents).toBe(b.payout.grossCents - b.payout.adminFeeCents);
    expect((await call(t, 'POST', `/api/charges/${item.id}/pay`, {})).statusCode).toBe(409);
    const { rows } = await db.query('SELECT 1 FROM rental_payouts WHERE charge_id = $1', [item.id]);
    expect(rows).toHaveLength(1); // exatamente um repasse
    const paid = (await call(t, 'GET', '/api/charges?status=paid')).json().items.find((c: any) => c.id === item.id);
    expect(paid.status).toBe('paid');
    expect(paid.late_fee_cents).toBe(b.lateFeeCents);
  });

  it('recusa data futura e permite dispensar multa e juros, com registro na auditoria', async () => {
    const t = await login('financeiro@a.demo');
    const open = (await call(t, 'GET', '/api/charges?status=open')).json().items[0];
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    expect((await call(t, 'POST', `/api/charges/${open.id}/pay`, { paidOn: future })).statusCode).toBe(400);
    expect((await call(t, 'POST', `/api/charges/${open.id}/pay`, { paidOn: 'ontem' })).statusCode).toBe(400);
    const r = await call(t, 'POST', `/api/charges/${open.id}/pay`, { waiveLateFees: true });
    expect(r.json().lateFeeCents).toBe(0);
    const log = (await call(await login('owner@a.demo'), 'GET', '/api/audit')).json().items.map((x: any) => x.summary ?? '');
    expect(log.some((s: string) => /Cobrança baixada: .* recebidos.*multa e juros dispensados/.test(s))).toBe(true);
  });

  it('repasse pendente é pago uma única vez', async () => {
    const t = await login('financeiro@a.demo');
    const list = (await call(t, 'GET', '/api/payouts?status=pending')).json();
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.totalNetCents).toBe(list.items.reduce((a: number, i: any) => a + i.net_cents, 0));
    const id = list.items[0].id;
    expect((await call(t, 'POST', `/api/payouts/${id}/pay`)).statusCode).toBe(200);
    expect((await call(t, 'POST', `/api/payouts/${id}/pay`)).statusCode).toBe(409);
    expect((await call(t, 'GET', '/api/payouts?status=paid')).json().items.some((i: any) => i.id === id)).toBe(true);
  });
});

describe('contratos', () => {
  const base = async (t: string) => {
    const props = (await call(t, 'GET', '/api/properties?limit=100')).json().items;
    const rentable = props.find((p: any) => p.purpose === 'aluguel' && p.status === 'active');
    const saleOnly = props.find((p: any) => p.purpose === 'venda');
    const owner = (await call(t, 'POST', '/api/contacts', { name: 'Proprietário Novo', kind: 'owner' })).json().id;
    const renter = (await call(t, 'POST', '/api/contacts', { name: 'Inquilino Novo', kind: 'renter' })).json().id;
    return { rentable, saleOnly, owner, renter };
  };
  const input = (propertyId: string, landlordId: string, renterId: string, extra = {}) =>
    ({ propertyId, landlordId, renterId, rentCents: 250_000, dueDay: 10, startDate: '2026-01-10', endDate: '2028-01-10', ...extra });

  it('valida regras do contrato (finalidade, papéis, datas, duplicidade)', async () => {
    const t = await login('owner@a.demo');
    const { saleOnly, owner, renter } = await base(t);
    // imóvel só de venda
    expect((await call(t, 'POST', '/api/rentals', input(saleOnly.id, owner, renter))).statusCode).toBe(400);
    // acha um imóvel de aluguel livre: altera finalidade de um imóvel de venda para 'ambos' via banco (cadastro de edição ainda não existe)
    await db.query(`UPDATE properties SET purpose = 'ambos' WHERE id = $1`, [saleOnly.id]);
    // proprietário e inquilino trocados
    expect((await call(t, 'POST', '/api/rentals', input(saleOnly.id, renter, owner))).statusCode).toBe(404);
    // datas inválidas
    expect((await call(t, 'POST', '/api/rentals', input(saleOnly.id, owner, renter, { endDate: '2025-01-01' }))).statusCode).toBe(400);
    expect((await call(t, 'POST', '/api/rentals', input(saleOnly.id, owner, renter, { dueDay: 31 }))).statusCode).toBe(400);
    expect((await call(t, 'POST', '/api/rentals', input(saleOnly.id, owner, renter, { rentCents: 0 }))).statusCode).toBe(400);
    // válido
    const ok = await call(t, 'POST', '/api/rentals', input(saleOnly.id, owner, renter));
    expect(ok.statusCode).toBe(201);
    // segundo contrato ativo para o mesmo imóvel
    expect((await call(t, 'POST', '/api/rentals', input(saleOnly.id, owner, renter))).statusCode).toBe(409);
    // geração de cobranças é idempotente
    const id = ok.json().id;
    const g1 = (await call(t, 'POST', `/api/rentals/${id}/charges/generate`, { monthsAhead: 4 })).json().created;
    const g2 = (await call(t, 'POST', `/api/rentals/${id}/charges/generate`, { monthsAhead: 4 })).json().created;
    expect(g1).toBeGreaterThanOrEqual(0);
    expect(g2).toBe(0);
    const { rows } = await db.query<any>('SELECT count(*)::int n, count(DISTINCT competence)::int d FROM rental_charges WHERE contract_id = $1', [id]);
    expect(rows[0].n).toBe(rows[0].d); // nenhuma competência duplicada
  });

  it('encerrar contrato cancela cobranças futuras e mantém as vencidas', async () => {
    const t = await login('owner@a.demo');
    const contracts = (await call(t, 'GET', '/api/rentals')).json().items.filter((c: any) => c.status === 'active');
    const target = contracts.find((c: any) => c.renter_name === 'Marcos Teles');
    const before = (await call(t, 'GET', '/api/charges')).json().items.filter((c: any) => c.renter_name === 'Marcos Teles');
    expect(before.some((c: any) => c.status === 'open')).toBe(true);
    const r = await call(t, 'POST', `/api/rentals/${target.id}/terminate`);
    expect(r.statusCode).toBe(200);
    expect((await call(t, 'POST', `/api/rentals/${target.id}/terminate`)).statusCode).toBe(404);
    const tenantId = (await db.query<any>(`SELECT tenant_id FROM rental_contracts WHERE id = $1`, [target.id])).rows[0].tenant_id;
    expect(await generateCharges(db, tenantId, target.id, 3)).toBe(0); // contrato encerrado não gera cobrança
    const now = await today(db);
    const after = (await call(t, 'GET', '/api/charges')).json().items.filter((c: any) => c.renter_name === 'Marcos Teles');
    // nada ainda "a vencer" restou aberto; só pagas ou já vencidas
    expect(after.some((c: any) => c.status === 'open')).toBe(false);
    expect(after.every((c: any) => c.status === 'paid' || c.status === 'overdue' || c.due_date <= now)).toBe(true);
    expect(before.some((c: any) => c.status === 'open' && c.due_date > now)).toBe(true);
    const prop = (await db.query<any>(`SELECT status FROM properties WHERE id = (SELECT property_id FROM rental_contracts WHERE id = $1)`, [target.id])).rows[0];
    expect(prop.status).toBe('active'); // imóvel volta a ficar disponível
    const { rows } = await db.query(`SELECT 1 FROM rental_charges WHERE contract_id = $1 AND status = 'canceled'`, [target.id]);
    expect(rows.length).toBe(r.json().cancelled);
  });
});

describe('reajuste anual', () => {
  it('lista contratos na janela e recusa reajuste antes do prazo', async () => {
    const t = await login('manager@a.demo');
    const due = (await call(t, 'GET', '/api/adjustments/due')).json();
    const names = due.items.map((i: any) => i.renter_name);
    expect(names).toContain('Gustavo Reis'); // contrato com 14 meses
    expect(names).toContain('Felipe Nunes'); // 11 meses: aniversário em ~1 mês
    expect(names).not.toContain('Marcos Teles');
    const early = (await call(t, 'GET', '/api/rentals')).json().items.find((c: any) => c.renter_name === 'Larissa Duarte'); // 6 meses
    const r = await call(t, 'POST', `/api/rentals/${early.id}/adjust`, { percentBps: 450, indexName: 'IGPM' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/60 dias antes do aniversário/);
  });

  it('aplica reajuste: novo valor correto, só cobranças futuras mudam, não repete', async () => {
    const t = await login('manager@a.demo');
    const c = (await call(t, 'GET', '/api/rentals')).json().items.find((x: any) => x.renter_name === 'Gustavo Reis');
    const beforeCharges = (await call(t, 'GET', '/api/charges')).json().items.filter((x: any) => x.renter_name === 'Gustavo Reis');
    const r = await call(t, 'POST', `/api/rentals/${c.id}/adjust`, { percentBps: 450, indexName: 'IGPM', note: 'teste' });
    expect(r.statusCode).toBe(200);
    expect(r.json().newCents).toBe(Math.round(c.rent_cents * 1.045));
    const after = (await call(t, 'GET', '/api/charges')).json().items.filter((x: any) => x.renter_name === 'Gustavo Reis');
    const now = await today(db);
    for (const ch of after) {
      const old = beforeCharges.find((b: any) => b.id === ch.id);
      if (ch.status === 'open' && ch.due_date > now) expect(ch.amount_cents).toBe(r.json().newCents);
      else expect(ch.amount_cents).toBe(old.amount_cents); // vencidas e pagas não mudam
    }
    expect((await call(t, 'POST', `/api/rentals/${c.id}/adjust`, { percentBps: 450, indexName: 'IGPM' })).statusCode).toBe(409);
    const log = (await call(t, 'GET', '/api/audit')).json().items.map((x: any) => x.summary ?? '');
    expect(log.some((s: string) => s.includes(`reajustado de ${brl(c.rent_cents)} para ${brl(r.json().newCents)} (+4.50% IGPM)`))).toBe(true);
  });

  it('percentual fora do limite é recusado', async () => {
    const t = await login('manager@a.demo');
    const c = (await call(t, 'GET', '/api/rentals')).json().items[0];
    for (const bad of [0, -100, 5000, 1.5]) {
      expect((await call(t, 'POST', `/api/rentals/${c.id}/adjust`, { percentBps: bad, indexName: 'IGPM' })).statusCode).toBe(400);
    }
  });
});

describe('permissões e isolamento', () => {
  it('papéis: corretor só vê locação, financeiro não reajusta, marketing fica de fora', async () => {
    const broker = await login('broker@a.demo');
    const fin = await login('financeiro@a.demo');
    const anyContract = (await call(await login('owner@a.demo'), 'GET', '/api/rentals')).json().items[0].id;
    expect((await call(broker, 'GET', '/api/rentals')).statusCode).toBe(200);
    expect((await call(broker, 'GET', '/api/charges')).statusCode).toBe(403);
    expect((await call(broker, 'POST', '/api/rentals', {})).statusCode).toBe(403);
    expect((await call(fin, 'POST', `/api/rentals/${anyContract}/adjust`, { percentBps: 100, indexName: 'IGPM' })).statusCode).toBe(403);
    expect((await call(fin, 'POST', `/api/rentals/${anyContract}/terminate`)).statusCode).toBe(403);
    await db.query(`UPDATE users SET role = 'marketing' WHERE email = 'broker@b.demo'`);
    const mk = await login('broker@b.demo');
    expect((await call(mk, 'GET', '/api/rentals')).statusCode).toBe(403);
    expect((await call(mk, 'GET', '/api/delinquency')).statusCode).toBe(403);
  });

  it('tenant B não vê, baixa, reajusta nem encerra dados do tenant A', async () => {
    const a = await login('owner@a.demo');
    const b = await login('owner@b.demo');
    const aCharge = (await call(a, 'GET', '/api/charges?status=open')).json().items[0];
    const aContract = (await call(a, 'GET', '/api/rentals')).json().items.find((c: any) => c.status === 'active');
    const aPayout = (await call(a, 'GET', '/api/payouts?status=pending')).json().items[0];
    expect((await call(b, 'POST', `/api/charges/${aCharge.id}/pay`, {})).statusCode).toBe(404);
    expect((await call(b, 'POST', `/api/rentals/${aContract.id}/adjust`, { percentBps: 100, indexName: 'IGPM' })).statusCode).toBe(404);
    expect((await call(b, 'POST', `/api/rentals/${aContract.id}/terminate`)).statusCode).toBe(404);
    expect((await call(b, 'POST', `/api/rentals/${aContract.id}/charges/generate`, {})).statusCode).toBe(404);
    expect((await call(b, 'POST', `/api/payouts/${aPayout.id}/pay`)).statusCode).toBe(409);
    const bIds = new Set((await call(b, 'GET', '/api/charges')).json().items.map((c: any) => c.id));
    expect(bIds.has(aCharge.id)).toBe(false);
    // contrato de B com imóvel e partes de A
    const aProp = (await call(a, 'GET', '/api/properties?limit=1')).json().items[0].id;
    const bOwner = (await call(b, 'POST', '/api/contacts', { name: 'Dono B', kind: 'owner' })).json().id;
    const bRenter = (await call(b, 'POST', '/api/contacts', { name: 'Inq B', kind: 'renter' })).json().id;
    const r = await call(b, 'POST', '/api/rentals', { propertyId: aProp, landlordId: bOwner, renterId: bRenter, rentCents: 100_000, dueDay: 5, startDate: '2026-01-05', endDate: '2027-01-05' });
    expect(r.statusCode).toBe(404);
  });
});
