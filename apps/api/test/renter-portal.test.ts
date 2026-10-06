import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/client.js';
import { makeTestDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { seedDemo } from '../src/db/seed.js';
import { config } from '../src/config.js';
import { lateCharges } from '../src/domain/money.js';
import { LocalFileStore, setFileStore } from '../src/storage.js';
import { renderPdf } from '../src/domain/contractDocs.js';

const PW = 'senha-de-teste-123';
const NEW_PW = 'Inquilina#2026Forte';
let db: Db;
let app: FastifyInstance;
let filesDir: string;
let ipN = 0;
const tokens = new Map<string, string>();
const nextIp = () => `10.8.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;
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

async function onboard(staff: string, kind: 'owner' | 'renter', name: string, email: string) {
  const inv = await call(staff, 'POST', '/api/portal/invites', { contactId: await contactId(staff, kind, name), email });
  expect(inv.statusCode).toBe(201);
  expect((await call(null, 'POST', '/api/auth/accept-invite', { token: tokenFromUrl(inv.json().inviteUrl), password: NEW_PW })).statusCode).toBe(200);
  return login(email, NEW_PW);
}

let mgr: string, mgrB: string, larissa: string, helena: string;
let tenantA: string, larissaContact: string;

beforeAll(async () => {
  config.jwtSecret = 'r'.repeat(40);
  process.env.DATA_ENC_KEY = 'd'.repeat(40);
  filesDir = mkdtempSync(join(tmpdir(), 'aimob-renter-'));
  setFileStore(new LocalFileStore(filesDir));
  db = await makeTestDb();
  app = await buildApp(db);
  await seedDemo(db, { tenantName: 'A', password: PW, emailPrefix: 'a' });
  await seedDemo(db, { tenantName: 'B', password: PW, emailPrefix: 'b' });
  mgr = await login('manager@a.demo'); mgrB = await login('manager@b.demo');
  tenantA = (await db.query<any>(`SELECT tenant_id FROM users WHERE email = 'owner@a.demo'`)).rows[0].tenant_id;
  larissa = await onboard(mgr, 'renter', 'Larissa Duarte', 'larissa@inquilina.example');
  helena = await onboard(mgr, 'owner', 'Helena Prado', 'helena@proprietaria.example');
  larissaContact = await contactId(mgr, 'renter', 'Larissa Duarte');
}, 120_000);

describe('convite de inquilino', () => {
  it('o convite identifica o tipo de contato: inquilino vira papel "renter"; lead e inexistente são recusados', async () => {
    const u = (await db.query<any>(`SELECT role, active, contact_id FROM users WHERE email = 'larissa@inquilina.example'`)).rows[0];
    expect(u).toMatchObject({ role: 'renter', active: true, contact_id: larissaContact });
    const lead = (await db.query<any>(`SELECT id FROM contacts WHERE tenant_id = $1 AND kind = 'lead' LIMIT 1`, [tenantA])).rows[0].id;
    expect((await call(mgr, 'POST', '/api/portal/invites', { contactId: lead, email: 'lead@x.example' })).statusCode).toBe(404);
    expect((await call(mgr, 'POST', '/api/portal/invites', { contactId: '00000000-0000-0000-0000-000000000000', email: 'x@y.example' })).statusCode).toBe(404);
    const renters = (await call(mgr, 'GET', '/api/portal/access?kind=renter')).json().items;
    expect(renters.find((r: any) => r.name === 'Larissa Duarte')).toMatchObject({ hasUser: true, accepted: true });
    expect(renters.some((r: any) => r.name === 'Helena Prado')).toBe(false);
    const owners = (await call(mgr, 'GET', '/api/portal/access')).json().items; // padrão: proprietários
    expect(owners.some((r: any) => r.name === 'Larissa Duarte')).toBe(false);
    expect((await call(mgr, 'GET', '/api/portal/access?kind=outro')).statusCode).toBe(400);
  });
});

describe('o inquilino vê só o contrato dele', () => {
  it('resumo: contrato, próxima cobrança e atraso batem com o banco', async () => {
    const s = (await call(larissa, 'GET', '/api/renter/summary')).json();
    const rows = (await db.query<any>(`SELECT id, rent_cents FROM rental_contracts WHERE renter_id = $1`, [larissaContact])).rows;
    expect(s.contracts.map((c: any) => c.id).sort()).toEqual(rows.map((r: any) => r.id).sort());
    expect(s.contracts[0]).toMatchObject({ rentCents: Number(rows[0].rent_cents), property: { title: expect.any(String) } });
    const od = (await db.query<any>(
      `SELECT count(*)::int n, coalesce(sum(ch.amount_cents),0)::bigint t FROM rental_charges ch JOIN rental_contracts c ON c.id = ch.contract_id
        WHERE c.renter_id = $1 AND ch.status = 'open' AND ch.due_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date`, [larissaContact])).rows[0];
    expect(s.overdue).toEqual({ count: od.n, principalCents: Number(od.t) });
    expect(s.overdue.count).toBeGreaterThan(0); // o seed deixa uma cobrança dela em atraso
    expect(s.nextCharge).toMatchObject({ competence: expect.any(String), amountCents: expect.any(Number) });
    const todayIso = (await db.query<any>(`SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date,'YYYY-MM-DD') d`)).rows[0].d;
    expect(s.nextCharge.dueOn >= todayIso).toBe(true); // "próximo vencimento" nunca é uma data passada (o atraso aparece à parte)
  });

  it('cobranças: só as do contrato dele, sem canceladas; pagas mostram o valor realmente pago; atraso traz estimativa correta', async () => {
    const items = (await call(larissa, 'GET', '/api/renter/charges')).json().items;
    const mine = (await db.query<any>(`SELECT ch.id FROM rental_charges ch JOIN rental_contracts c ON c.id = ch.contract_id WHERE c.renter_id = $1 AND ch.status <> 'canceled'`, [larissaContact])).rows.map((r: any) => r.id);
    expect(items.map((i: any) => i.id).sort()).toEqual(mine.sort());
    expect(items.length).toBeGreaterThan(2);

    const paid = items.find((i: any) => i.status === 'paid');
    expect(paid.paidCents).toBeGreaterThanOrEqual(paid.amountCents);
    expect(paid.lateEstimate).toBeNull();

    const late = items.find((i: any) => i.status === 'overdue');
    const expectedDays = Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(late.dueOn)) / 86_400_000);
    expect(Math.abs(late.lateEstimate.daysLate - expectedDays)).toBeLessThanOrEqual(1); // fuso: a conta do banco usa o dia de São Paulo
    const calc = lateCharges(late.amountCents, late.lateEstimate.daysLate, { lateFeeBps: 200, interestBpsMonth: 100 });
    expect(late.lateEstimate).toMatchObject({ lateFeeCents: calc.lateFeeCents, interestCents: calc.interestCents, totalCents: calc.totalCents });
    expect(items.every((i: any) => i.status !== 'canceled')).toBe(true);

    // cobrança cancelada do contrato dele não aparece
    const one = mine[0];
    const original = (await db.query<any>(`SELECT status FROM rental_charges WHERE id = $1`, [one])).rows[0].status;
    await db.query(`UPDATE rental_charges SET status = 'canceled' WHERE id = $1`, [one]);
    const after = (await call(larissa, 'GET', '/api/renter/charges')).json().items;
    expect(after.some((i: any) => i.id === one)).toBe(false);
    await db.query(`UPDATE rental_charges SET status = $2 WHERE id = $1`, [one, original]); // devolve exatamente como estava
  });

  it('opções de pagamento só aparecem para cobranças em aberto, emitidas e atualizadas', async () => {
    const items = (await call(larissa, 'GET', '/api/renter/charges')).json().items;
    expect(items.every((i: any) => i.payment === null)).toBe(true); // nada emitido ainda
    const open = items.find((i: any) => i.status === 'open' || i.status === 'overdue');
    await db.query(`UPDATE rental_charges SET gateway_id = 'pay_teste_1', gateway_url = 'https://pagamento.example/i/1', gateway_boleto_url = 'https://pagamento.example/b/1', gateway_pix_payload = '000201pix' WHERE id = $1`, [open.id]);
    const withPay = (await call(larissa, 'GET', '/api/renter/charges')).json().items.find((i: any) => i.id === open.id);
    expect(withPay.payment).toEqual({ url: 'https://pagamento.example/i/1', boletoUrl: 'https://pagamento.example/b/1', pixPayload: '000201pix' });
    await db.query(`UPDATE rental_charges SET gateway_stale = true WHERE id = $1`, [open.id]); // reajuste: o boleto antigo cobraria o valor errado
    expect((await call(larissa, 'GET', '/api/renter/charges')).json().items.find((i: any) => i.id === open.id).payment).toBeNull();
    const paidId = items.find((i: any) => i.status === 'paid').id;
    await db.query(`UPDATE rental_charges SET gateway_id = 'pay_teste_2', gateway_url = 'https://pagamento.example/i/2' WHERE id = $1`, [paidId]);
    expect((await call(larissa, 'GET', '/api/renter/charges')).json().items.find((i: any) => i.id === paidId).payment).toBeNull(); // paga: sem link
  });

  it('minimização: nada do proprietário, de repasses, de taxa, de outros inquilinos nem de gateway', async () => {
    const all = JSON.stringify([(await call(larissa, 'GET', '/api/renter/summary')).json(), (await call(larissa, 'GET', '/api/renter/charges')).json(), (await call(larissa, 'GET', '/api/renter/documents')).json()]);
    const landlord = (await db.query<any>(`SELECT l.name FROM rental_contracts c JOIN contacts l ON l.id = c.landlord_id WHERE c.renter_id = $1`, [larissaContact])).rows[0].name;
    expect(all).not.toContain(landlord);
    for (const other of ['Gustavo Reis', 'Felipe Nunes', 'Marcos Teles', 'Helena Prado']) expect(all).not.toContain(other);
    expect(all).not.toMatch(/payout|repasse|admin_fee|taxa|document_enc|cpf|cnpj|phone|email|gateway_id|webhook|reconcil/i);
  });
});

describe('negar por padrão', () => {
  it('inquilino é barrado em TODA rota fora do portal dele; proprietário e inquilino não acessam o portal um do outro', async () => {
    const allowed = [/^\/api\/me$/, /^\/api\/auth\/mfa\/(setup|enable|disable)$/, /^\/api\/renter\//];
    const zero = '00000000-0000-0000-0000-000000000000';
    const routes = app.registeredRoutes.filter((r) => r.url.startsWith('/api/') && !r.public && !['HEAD', 'OPTIONS'].includes(r.method));
    const leaked: string[] = [];
    for (const r of routes) {
      if (allowed.some((a) => a.test(r.url))) continue;
      const res = await call(larissa, r.method as any, r.url.replace(/:[A-Za-z]+/g, zero), ['POST', 'PUT', 'PATCH'].includes(r.method) ? {} : undefined);
      if (res.statusCode !== 403) leaked.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(leaked).toEqual([]);
    for (const url of ['/api/renter/summary', '/api/renter/charges', '/api/renter/documents', `/api/renter/documents/${zero}/pdf`]) expect((await call(helena, 'GET', url)).statusCode, `proprietário em ${url}`).toBe(403);
    for (const url of ['/api/portal/summary', '/api/portal/properties', '/api/portal/payouts', '/api/portal/statement.csv']) expect((await call(larissa, 'GET', url)).statusCode, `inquilino em ${url}`).toBe(403);
    for (const email of ['owner@a.demo', 'financeiro@a.demo', 'broker@a.demo']) {
      expect((await call(await login(email), 'GET', '/api/renter/summary')).statusCode, email).toBe(403); // equipe também não usa o portal do inquilino
    }
  });

  it('a exigência de MFA nunca vale para o inquilino', async () => {
    await db.query(`INSERT INTO tenant_settings (tenant_id, mfa_policy) VALUES ($1, 'staff') ON CONFLICT (tenant_id) DO UPDATE SET mfa_policy = 'staff'`, [tenantA]);
    expect((await call(larissa, 'GET', '/api/renter/summary')).statusCode).toBe(200);
    expect((await call(await login('broker@a.demo'), 'GET', '/api/leads')).json().code).toBe('mfa_setup_required'); // a equipe, sim
    await db.query(`UPDATE tenant_settings SET mfa_policy = 'off' WHERE tenant_id = $1`, [tenantA]);
  });
});

describe('contrato em PDF', () => {
  let sentId: string, signedId: string, otherId: string, draftId: string, signedFileId: string, earlyFileId: string, signedPdf: Buffer;

  beforeAll(async () => {
    const store = new LocalFileStore(filesDir);
    const mine = (await db.query<any>(`SELECT id FROM rental_contracts WHERE renter_id = $1 LIMIT 1`, [larissaContact])).rows[0].id;
    const other = (await db.query<any>(`SELECT c.id FROM rental_contracts c WHERE c.tenant_id = $1 AND c.renter_id <> $2 LIMIT 1`, [tenantA, larissaContact])).rows[0].id;
    const mk = async (contract: string, title: string, status: string, withPdf: boolean) => {
      const pdf = await renderPdf({ title, body: `# ${title}\n\nTexto do contrato`, documentId: '00000000-1111', hash: 'a'.repeat(64) });
      const put = withPdf ? await store.put(tenantA, pdf) : null;
      const r = await db.query<any>(
        `INSERT INTO contract_documents (tenant_id, rental_contract_id, title, status, body_enc, content_hash, pdf_key, pdf_sha256, signed_at) VALUES ($1,$2,$3,$4,'x','h',$5,$6, CASE WHEN $4 = 'signed' THEN now() END) RETURNING id`,
        [tenantA, contract, title, status, put?.key ?? null, put?.sha256 ?? null]);
      return { id: r.rows[0].id as string, pdf };
    };
    sentId = (await mk(mine, 'Contrato enviado', 'sent', true)).id;
    draftId = (await mk(mine, 'Rascunho interno', 'draft', true)).id;
    otherId = (await mk(other, 'Contrato de outro inquilino', 'signed', true)).id;
    const signed = await mk(mine, 'Contrato assinado', 'signed', true);
    signedId = signed.id;
    signedPdf = await renderPdf({ title: 'Assinado', body: 'Documento assinado pelas partes', documentId: signedId, hash: 'b'.repeat(64) });
    const put = await store.put(tenantA, signedPdf);
    // arquivo anexado a um documento que ainda NÃO está assinado (coleta em andamento): o inquilino não pode baixá-lo
    const early = await store.put(tenantA, await renderPdf({ title: 'Parcial', body: 'Assinatura parcial', documentId: sentId, hash: 'c'.repeat(64) }));
    earlyFileId = (await db.query<any>(`INSERT INTO contract_files (tenant_id, document_id, kind, filename, mime, size, sha256, storage_key) VALUES ($1,$2,'signed','parcial.pdf','application/pdf',$3,$4,$5) RETURNING id`,
      [tenantA, sentId, early.size, early.sha256, early.key])).rows[0].id;
    signedFileId = (await db.query<any>(`INSERT INTO contract_files (tenant_id, document_id, kind, filename, mime, size, sha256, storage_key) VALUES ($1,$2,'signed','contrato-assinado.pdf','application/pdf',$3,$4,$5) RETURNING id`,
      [tenantA, signedId, put.size, put.sha256, put.key])).rows[0].id;
  });

  it('lista só contratos dele já enviados ou assinados; rascunho e documento de outro inquilino ficam invisíveis', async () => {
    const items = (await call(larissa, 'GET', '/api/renter/documents')).json().items;
    expect(items.map((d: any) => d.id).sort()).toEqual([sentId, signedId].sort());
    expect(items.find((d: any) => d.id === sentId)).toMatchObject({ status: 'sent', hasPdf: true, files: [] });
    expect(items.find((d: any) => d.id === signedId).files).toHaveLength(1);
  });

  it('baixa o PDF e o arquivo assinado do próprio contrato, com auditoria; o resto devolve 404', async () => {
    const pdf = await call(larissa, 'GET', `/api/renter/documents/${sentId}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['cache-control']).toMatch(/no-store/);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const f = await call(larissa, 'GET', `/api/renter/documents/${signedId}/files/${signedFileId}`);
    expect(f.statusCode).toBe(200);
    expect(f.rawPayload.equals(signedPdf)).toBe(true);
    for (const url of [`/api/renter/documents/${draftId}/pdf`, `/api/renter/documents/${otherId}/pdf`, `/api/renter/documents/${sentId}/files/${earlyFileId}`, `/api/renter/documents/${sentId}/files/${signedFileId}`, `/api/renter/documents/${signedId}/files/${'0'.repeat(8)}-0000-0000-0000-000000000000`]) {
      expect((await call(larissa, 'GET', url)).statusCode, url).toBe(404);
    }
    const log = (await call(mgr, 'GET', '/api/audit')).json().items.map((x: any) => x.summary).join('\n');
    expect(log).toMatch(/Inquilino baixou o PDF do contrato/);
    expect(log).toMatch(/Inquilino baixou o contrato assinado/);
  });

  it('arquivo adulterado no disco não é entregue; documento de outra imobiliária não existe para ele', async () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    const key = (await db.query<any>(`SELECT storage_key FROM contract_files WHERE id = $1`, [signedFileId])).rows[0].storage_key;
    writeFileSync(walk(join(filesDir, tenantA)).find((p) => p.endsWith(key))!, Buffer.from('%PDF-1.4 adulterado'));
    const bad = await call(larissa, 'GET', `/api/renter/documents/${signedId}/files/${signedFileId}`);
    expect(bad.statusCode).toBe(500);
    expect(bad.json().error).toMatch(/integridade/);
    // um inquilino da outra imobiliária tem o próprio portal e nunca vê o documento desta
    const renterB = await onboard(mgrB, 'renter', 'Larissa Duarte', 'larissa@b-inquilina.example');
    expect((await call(renterB, 'GET', `/api/renter/documents/${signedId}/pdf`)).statusCode).toBe(404);
    const itemsB = (await call(renterB, 'GET', '/api/renter/charges')).json().items;
    const bIds = (await db.query<any>(`SELECT ch.id FROM rental_charges ch JOIN rental_contracts c ON c.id = ch.contract_id WHERE c.tenant_id <> $1`, [tenantA])).rows.map((r: any) => r.id);
    expect(itemsB.every((i: any) => bIds.includes(i.id))).toBe(true);
  });
});

describe('revogação', () => {
  it('revogar derruba o acesso do inquilino na hora', async () => {
    expect((await call(larissa, 'GET', '/api/renter/summary')).statusCode).toBe(200);
    expect((await call(mgr, 'DELETE', `/api/portal/access/${larissaContact}`)).statusCode).toBe(200);
    expect((await call(larissa, 'GET', '/api/renter/summary')).statusCode).toBe(401);
    expect((await call(null, 'POST', '/api/auth/login', { email: 'larissa@inquilina.example', password: NEW_PW })).statusCode).toBe(401);
  });
});
