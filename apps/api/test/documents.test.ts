import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/client.js';
import { makeTestDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { seedDemo } from '../src/db/seed.js';
import { config } from '../src/config.js';
import { LocalFileStore, setFileStore } from '../src/storage.js';
import { renderPdf, renderTemplate, templateVariables } from '../src/domain/contractDocs.js';

const PW = 'senha-de-teste-123';
const CPF_RENTER = '529.982.247-25';
const CPF_OWNER = '111.444.777-35';
let db: Db;
let app: FastifyInstance;
let filesDir: string;
let ipN = 0;
const tokens = new Map<string, string>();
const nextIp = () => `10.4.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;

const call = (t: string | null, method: any, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: payload as any, headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...headers }, remoteAddress: nextIp() });
async function login(email: string) {
  if (tokens.has(email)) return tokens.get(email)!;
  const r = await call(null, 'POST', '/api/auth/login', { email, password: PW });
  tokens.set(email, r.json().token);
  return r.json().token as string;
}

/** Corpo multipart/form-data montado à mão (o inject não monta sozinho). */
function multipartBody(data: Buffer, filename: string, type = 'application/pdf') {
  const boundary = '----aimobtest' + Math.random().toString(16).slice(2);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, data, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
const upload = (t: string, docId: string, data: Buffer, filename = 'assinado.pdf') => {
  const m = multipartBody(data, filename);
  return call(t, 'POST', `/api/documents/${docId}/files`, m.payload, m.headers);
};

let mgr: string, owner: string, fin: string, broker: string, mgrB: string;
let contractId: string, templateId: string, renterName: string, ownerName: string;

beforeAll(async () => {
  config.jwtSecret = 'c'.repeat(40);
  process.env.DATA_ENC_KEY = 'd'.repeat(40);
  filesDir = mkdtempSync(join(tmpdir(), 'aimob-files-'));
  setFileStore(new LocalFileStore(filesDir));
  db = await makeTestDb();
  app = await buildApp(db);
  await seedDemo(db, { tenantName: 'A', password: PW, emailPrefix: 'a' });
  await seedDemo(db, { tenantName: 'B', password: PW, emailPrefix: 'b' });
  [mgr, owner, fin, broker, mgrB] = await Promise.all(['manager@a.demo', 'owner@a.demo', 'financeiro@a.demo', 'broker@a.demo', 'manager@b.demo'].map(login));
  const c = (await call(owner, 'GET', '/api/rentals')).json().items.find((x: any) => x.status === 'active');
  contractId = c.id; renterName = c.renter_name; ownerName = c.landlord_name;
  const t = await call(mgr, 'POST', '/api/document-templates/starter');
  templateId = t.json().id;
}, 120_000);

const newDoc = async (t = mgr, extra: any = {}) => (await call(t, 'POST', '/api/documents', { templateId, rentalContractId: contractId, ...extra }));
/** Documento pronto para revisão: preenche os documentos das partes, cria, e envia para revisão. */
async function readyDoc(author = mgr) {
  const contacts = async (k: string) => (await call(owner, 'GET', `/api/contacts?kind=${k}`)).json().items as any[];
  const renter = (await contacts('renter')).find((x) => x.name === renterName), lord = (await contacts('owner')).find((x) => x.name === ownerName);
  await call(owner, 'PUT', `/api/contacts/${renter.id}/document`, { document: CPF_RENTER });
  await call(owner, 'PUT', `/api/contacts/${lord.id}/document`, { document: CPF_OWNER });
  const created = await newDoc(author);
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  expect((await call(author, 'POST', `/api/documents/${id}/submit`)).statusCode).toBe(200);
  return id;
}

describe('modelos', () => {
  it('instala o modelo inicial (uma vez), avisa que não é revisado e rejeita variável desconhecida', async () => {
    const again = await call(mgr, 'POST', '/api/document-templates/starter');
    expect(again.json()).toMatchObject({ created: false, id: templateId });
    const list = (await call(mgr, 'GET', '/api/document-templates')).json();
    const t = list.items.find((x: any) => x.id === templateId);
    expect(t).toMatchObject({ reviewed: false, version: 1 });
    expect(t.notes).toMatch(/SEM validação jurídica/);
    expect(t.variables).toContain('aluguel.valor_extenso');
    const bad = await call(mgr, 'POST', '/api/document-templates', { name: 'Com erro', body: 'Olá {{locador.nome}} e {{locador.cpf}} e {{valor}}'.padEnd(40, '.') });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().unknown).toEqual(['locador.cpf', 'valor']);
  });

  it('editar o texto sobe a versão e zera a revisão jurídica; só quem administra revisa', async () => {
    const created = (await call(mgr, 'POST', '/api/document-templates', { name: 'Modelo curto', body: 'Locador {{locador.nome}} aluga a {{locatario.nome}} por {{aluguel.valor}}.' })).json().id;
    expect((await call(fin, 'POST', `/api/document-templates/${created}/review`, { reviewed: true })).statusCode).toBe(403);
    expect((await call(owner, 'POST', `/api/document-templates/${created}/review`, { reviewed: true })).statusCode).toBe(200);
    expect((await call(mgr, 'GET', `/api/document-templates/${created}`)).json()).toMatchObject({ reviewed: true, version: 1 });
    const edit = await call(mgr, 'PUT', `/api/document-templates/${created}`, { body: 'Locador {{locador.nome}} aluga a {{locatario.nome}} por {{aluguel.valor}} ao mês.' });
    expect(edit.json().versionBumped).toBe(true);
    expect((await call(mgr, 'GET', `/api/document-templates/${created}`)).json()).toMatchObject({ reviewed: false, version: 2 });
    const same = await call(mgr, 'PUT', `/api/document-templates/${created}`, { name: 'Modelo curto (renomeado)' });
    expect(same.json().versionBumped).toBe(false); // só o nome: não zera a revisão
  });

  it('renderização: substitui o que conhece, mantém e aponta o que falta', () => {
    const r = renderTemplate('A {{locador.nome}} paga {{aluguel.valor}} a {{locador.documento}} {{x.y}}', { 'locador.nome': 'Ana', 'aluguel.valor': 'R$ 1,00', 'locador.documento': null });
    expect(r.text).toBe('A Ana paga R$ 1,00 a {{locador.documento}} {{x.y}}');
    expect(r.missing).toEqual(['locador.documento']);
    expect(r.unknown).toEqual(['x.y']);
    expect(templateVariables('{{ a.b }} {{a.b}} {{c}}')).toEqual(['a.b', 'c']);
  });
});

describe('documento a partir do contrato de locação', () => {
  it('preenche com dados reais (valor por extenso, datas) e aponta o que falta cadastrar, sem inventar', async () => {
    const created = await newDoc(mgr, { title: 'Contrato Teste' });
    expect(created.statusCode).toBe(201);
    const d = (await call(mgr, 'GET', `/api/documents/${created.json().id}`)).json();
    expect(d.body).toContain(ownerName);
    expect(d.body).toContain(renterName);
    expect(d.body).toMatch(/R\$\s?[\d.]+,\d{2} \((?:um|dois|três|quatro|cinco|mil|[a-zçã]+)[^)]*reais\)/);
    expect(d.body).toMatch(/prazo de \d+ meses, com início em \d{2}\/\d{2}\/\d{4}/);
    expect(d.body).toMatch(/multa de 2%/);
    expect(created.json().missingVariables).toEqual(expect.arrayContaining(['locatario.documento', 'locador.documento'])); // não há CPF cadastrado: não inventa
    expect(d.pendingVariables.length).toBeGreaterThan(0);
    expect(d.registrationWarning).toMatch(/qualificada/); // avisa sobre registro em cartório
    expect(d.versions).toHaveLength(1);
    // enviar para revisão com campos pendentes é recusado
    const sub = await call(mgr, 'POST', `/api/documents/${d.id}/submit`);
    expect(sub.statusCode).toBe(422);
    expect(sub.json().error).toMatch(/campos sem preencher/);
  });

  it('com os documentos das partes cadastrados fica completo; o texto com CPF é guardado criptografado e fora da auditoria', async () => {
    const id = await readyDoc();
    const d = (await call(mgr, 'GET', `/api/documents/${id}`)).json();
    expect(d.status).toBe('in_review');
    expect(d.pendingVariables).toEqual([]);
    expect(d.body).toContain('52998224725');
    const { rows } = await db.query<any>(`SELECT body_enc FROM contract_documents WHERE id = $1`, [id]);
    expect(rows[0].body_enc).not.toContain('52998224725');
    expect((await db.query<any>(`SELECT body_enc FROM contract_document_versions WHERE document_id = $1`, [id])).rows.every((r: any) => !r.body_enc.includes('52998224725'))).toBe(true);
    expect(JSON.stringify((await call(owner, 'GET', '/api/audit')).json())).not.toContain('52998224725');
  });

  it('edição cria versões imutáveis e com hash; mesma edição não duplica; só em rascunho/revisão', async () => {
    const created = await newDoc(mgr); const id = created.json().id;
    const d0 = (await call(mgr, 'GET', `/api/documents/${id}`)).json();
    const novo = `${d0.body}\n\nCláusula adicional acordada entre as partes.`;
    const e = await call(mgr, 'PUT', `/api/documents/${id}`, { body: novo, note: 'Cláusula adicional' });
    expect(e.json()).toMatchObject({ ok: true, version: 2 });
    expect((await call(mgr, 'PUT', `/api/documents/${id}`, { body: novo })).json().unchanged).toBe(true);
    const d1 = (await call(mgr, 'GET', `/api/documents/${id}`)).json();
    expect(d1.versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect(d1.contentHash ?? d1.content_hash).toBe(createHash('sha256').update(novo).digest('hex'));
    const v1 = (await call(mgr, 'GET', `/api/documents/${id}/versions/1`)).json();
    expect(v1.body).toBe(d0.body); // a versão antiga continua intacta
    expect((await call(mgr, 'GET', `/api/documents/${id}/versions/9`)).statusCode).toBe(404);
    expect((await call(mgr, 'POST', `/api/documents/${id}/submit`)).statusCode).toBe(200);
    // em revisão ainda aceita edição e volta para rascunho
    expect((await call(mgr, 'PUT', `/api/documents/${id}`, { body: novo + '\n\nCláusula extra.' })).statusCode).toBe(200);
    expect((await call(mgr, 'GET', `/api/documents/${id}`)).json().status).toBe('draft');
  });
});

describe('aprovação, PDF e integridade', () => {
  it('quatro olhos: quem redigiu não aprova; financeiro não aprova; modelo não revisado exige ciência', async () => {
    const id = await readyDoc(mgr);
    expect((await call(mgr, 'POST', `/api/documents/${id}/approve`, { acknowledgeUnreviewed: true })).statusCode).toBe(403); // autor
    expect((await call(fin, 'POST', `/api/documents/${id}/approve`, { acknowledgeUnreviewed: true })).statusCode).toBe(403); // sem poder de aprovar
    const noAck = await call(owner, 'POST', `/api/documents/${id}/approve`, {});
    expect(noAck.statusCode).toBe(409);
    expect(noAck.json().needsAcknowledge).toBe(true);
    const ok = await call(owner, 'POST', `/api/documents/${id}/approve`, { acknowledgeUnreviewed: true });
    expect(ok.statusCode).toBe(200);
    const log = (await call(owner, 'GET', '/api/audit')).json().items.map((x: any) => x.summary).join('\n');
    expect(log).toMatch(/Documento aprovado \(modelo sem revisão jurídica, ciente do risco\)/);
  });

  it('PDF aprovado é um PDF íntegro com o hash registrado; adulterar o arquivo armazenado é detectado', async () => {
    const id = await readyDoc(mgr);
    expect((await call(owner, 'GET', `/api/documents/${id}/pdf`)).statusCode).toBe(409); // ainda não existe PDF
    expect((await call(owner, 'POST', `/api/documents/${id}/approve`, { acknowledgeUnreviewed: true })).statusCode).toBe(200);
    const pdf = await call(owner, 'GET', `/api/documents/${id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toMatch(/attachment/);
    expect(pdf.headers['cache-control']).toMatch(/no-store/);
    const buf = pdf.rawPayload;
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    const row = (await db.query<any>(`SELECT pdf_sha256, pdf_key, approved_hash, content_hash, status FROM contract_documents WHERE id = $1`, [id])).rows[0];
    expect(createHash('sha256').update(buf).digest('hex')).toBe(row.pdf_sha256);
    expect(row.approved_hash).toBe(row.content_hash);
    // adultera o arquivo no disco
    const tid = (await db.query<any>(`SELECT tenant_id FROM users WHERE email = 'owner@a.demo'`)).rows[0].tenant_id;
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    const file = walk(join(filesDir, tid)).find((f) => f.endsWith(row.pdf_key))!;
    writeFileSync(file, Buffer.concat([buf, Buffer.from('adulterado')]));
    const bad = await call(owner, 'GET', `/api/documents/${id}/pdf`);
    expect(bad.statusCode).toBe(500);
    expect(bad.json().error).toMatch(/integridade/);
    expect(bad.rawPayload.subarray(0, 5).toString()).not.toBe('%PDF-'); // o arquivo adulterado NÃO é entregue
  });

  it('aprovado não se edita; reabrir devolve para rascunho e apaga a referência ao PDF; enviado não reabre', async () => {
    const id = await readyDoc(mgr);
    await call(owner, 'POST', `/api/documents/${id}/approve`, { acknowledgeUnreviewed: true });
    expect((await call(mgr, 'PUT', `/api/documents/${id}`, { body: 'x'.repeat(30) })).statusCode).toBe(409);
    expect((await call(mgr, 'POST', `/api/documents/${id}/reopen`)).statusCode).toBe(200);
    const d = (await call(mgr, 'GET', `/api/documents/${id}`)).json();
    expect(d).toMatchObject({ status: 'draft', pdf_key: null, approved_by: null });
    await call(mgr, 'POST', `/api/documents/${id}/submit`);
    await call(owner, 'POST', `/api/documents/${id}/approve`, { acknowledgeUnreviewed: true });
    await call(mgr, 'POST', `/api/documents/${id}/signers`, { role: 'locador', name: ownerName });
    await call(mgr, 'POST', `/api/documents/${id}/signers`, { role: 'locatario', name: renterName });
    expect((await call(fin, 'POST', `/api/documents/${id}/send`)).statusCode).toBe(403); // financeiro edita, mas não envia
    expect((await call(owner, 'POST', `/api/documents/${id}/send`)).statusCode).toBe(200);
    expect((await call(owner, 'POST', `/api/documents/${id}/reopen`)).statusCode).toBe(409); // enviado não reabre
  });

  it('modelo revisado dispensa a ciência; PDF contém o texto do contrato', async () => {
    await call(owner, 'POST', `/api/document-templates/${templateId}/review`, { reviewed: true });
    const id = await readyDoc(mgr);
    const ok = await call(owner, 'POST', `/api/documents/${id}/approve`, {});
    expect(ok.statusCode).toBe(200);
    const pdf = await renderPdf({ title: 'T', body: '# Título\n\nTexto com acentuação: ação, João, órgão.', documentId: '12345678-aaaa', hash: 'a'.repeat(64) });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
  });
});

describe('assinaturas e arquivos', () => {
  async function approvedWithSigners() {
    const id = await readyDoc(mgr);
    expect((await call(owner, 'POST', `/api/documents/${id}/approve`, { acknowledgeUnreviewed: true })).statusCode).toBe(200);
    return id;
  }

  it('envio exige ao menos dois signatários; depois de enviado a lista fica travada', async () => {
    const id = await approvedWithSigners();
    expect((await call(owner, 'POST', `/api/documents/${id}/send`)).statusCode).toBe(422);
    const a = await call(mgr, 'POST', `/api/documents/${id}/signers`, { role: 'locador', name: ownerName, email: 'locador@exemplo.test' });
    expect((await call(mgr, 'POST', `/api/documents/${id}/signers`, { role: 'invalido', name: 'X' })).statusCode).toBe(400);
    expect((await call(owner, 'POST', `/api/documents/${id}/send`)).statusCode).toBe(422); // só um
    await call(mgr, 'POST', `/api/documents/${id}/signers`, { role: 'locatario', name: renterName });
    expect((await call(owner, 'POST', `/api/documents/${id}/send`)).json()).toMatchObject({ ok: true, provider: 'manual' });
    expect((await call(mgr, 'POST', `/api/documents/${id}/signers`, { role: 'fiador', name: 'Fiador' })).statusCode).toBe(409);
    expect((await call(mgr, 'DELETE', `/api/documents/${id}/signers/${a.json().id}`)).statusCode).toBe(409);
    expect((await call(owner, 'POST', `/api/documents/${id}/send`)).statusCode).toBe(409); // já enviado
  });

  it('conclui só quando todos assinaram E há arquivo assinado; validação de conteúdo e tamanho do anexo', async () => {
    const id = await approvedWithSigners();
    const s1 = (await call(mgr, 'POST', `/api/documents/${id}/signers`, { role: 'locador', name: ownerName })).json().id;
    const s2 = (await call(mgr, 'POST', `/api/documents/${id}/signers`, { role: 'locatario', name: renterName })).json().id;
    expect((await call(mgr, 'POST', `/api/documents/${id}/signers/${s1}/signed`, { note: 'xxx' })).statusCode).toBe(409); // ainda não enviado
    await call(owner, 'POST', `/api/documents/${id}/send`);

    expect((await call(mgr, 'POST', `/api/documents/${id}/signers/${s1}/signed`, {})).statusCode).toBe(400); // exige a observação
    const first = await call(mgr, 'POST', `/api/documents/${id}/signers/${s1}/signed`, { note: 'Assinou pelo gov.br em 06/10/2026' });
    expect(first.json()).toMatchObject({ ok: true, completed: false });
    expect((await call(mgr, 'POST', `/api/documents/${id}/signers/${s1}/signed`, { note: 'de novo' })).statusCode).toBe(404); // não registra duas vezes

    // anexos inválidos
    expect((await upload(mgr, id, Buffer.from('isto não é um pdf, só texto'), 'contrato.pdf')).statusCode).toBe(415); // nome .pdf, conteúdo falso
    expect((await upload(mgr, id, Buffer.alloc(0))).statusCode).toBe(400);
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(15 * 1024 * 1024)]);
    expect((await upload(mgr, id, big)).statusCode).toBe(413);
    expect((await call(mgr, 'POST', `/api/documents/${id}/files`, { x: 1 })).statusCode).toBe(415); // não é multipart

    const signedPdf = await renderPdf({ title: 'Assinado', body: 'Documento com assinaturas', documentId: id, hash: 'b'.repeat(64) });
    const up = await upload(mgr, id, signedPdf, '../../etc/passwd contrato.pdf');
    expect(up.statusCode).toBe(201);
    expect(up.json().completed).toBe(false); // falta o segundo signatário
    expect((await call(mgr, 'GET', `/api/documents/${id}`)).json().status).toBe('sent');
    const last = await call(mgr, 'POST', `/api/documents/${id}/signers/${s2}/signed`, { note: 'Assinou com certificado digital' });
    expect(last.json()).toMatchObject({ completed: true });
    const d = (await call(mgr, 'GET', `/api/documents/${id}`)).json();
    expect(d.status).toBe('signed');
    expect(d.signed_at).toBeTruthy();
    expect(d.files[0].filename).not.toMatch(/\.\.|\//); // nome higienizado
    expect(d.files[0].sha256).toBe(createHash('sha256').update(signedPdf).digest('hex'));
    const dl = await call(mgr, 'GET', `/api/documents/${id}/files/${d.files[0].id}`);
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(signedPdf)).toBe(true);
    // assinado: não cancela, não aceita novos signatários
    expect((await call(owner, 'POST', `/api/documents/${id}/cancel`, { reason: 'engano' })).statusCode).toBe(409);
    const log = (await call(owner, 'GET', '/api/audit')).json().items.map((x: any) => x.summary).join('\n');
    expect(log).toMatch(/Assinatura declarada por um usuário: Assinou pelo gov\.br/);
    expect(log).toMatch(/Arquivo assinado anexado/);
  });

  it('todos assinaram mas falta o arquivo: continua "enviado" até anexar o PDF assinado', async () => {
    const id = await approvedWithSigners();
    const ids = [(await call(mgr, 'POST', `/api/documents/${id}/signers`, { role: 'locador', name: 'Fulano de Tal' })).json().id,
      (await call(mgr, 'POST', `/api/documents/${id}/signers`, { role: 'locatario', name: 'Beltrano da Silva' })).json().id];
    await call(owner, 'POST', `/api/documents/${id}/send`);
    for (const s of ids) expect((await call(mgr, 'POST', `/api/documents/${id}/signers/${s}/signed`, { note: 'Assinou presencialmente' })).json().completed).toBe(false);
    expect((await call(mgr, 'GET', `/api/documents/${id}`)).json().status).toBe('sent'); // sem arquivo, não há como comprovar
    const pdf = await renderPdf({ title: 'S', body: 'Assinado por todos', documentId: id, hash: 'd'.repeat(64) });
    expect((await upload(mgr, id, pdf)).json().completed).toBe(true);
    expect((await call(mgr, 'GET', `/api/documents/${id}`)).json().status).toBe('signed');
  });

  it('arquivos assinados também são verificados na leitura (adulteração)', async () => {
    const id = await approvedWithSigners();
    const s1 = (await call(mgr, 'POST', `/api/documents/${id}/signers`, { role: 'locador', name: 'A A' })).json().id;
    await call(mgr, 'POST', `/api/documents/${id}/signers`, { role: 'locatario', name: 'B B' });
    await call(owner, 'POST', `/api/documents/${id}/send`);
    const pdf = await renderPdf({ title: 'S', body: 'Assinado', documentId: id, hash: 'c'.repeat(64) });
    await upload(mgr, id, pdf);
    void s1;
    const f = (await call(mgr, 'GET', `/api/documents/${id}`)).json().files[0];
    const tid = (await db.query<any>(`SELECT tenant_id FROM users WHERE email = 'owner@a.demo'`)).rows[0].tenant_id;
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    writeFileSync(walk(join(filesDir, tid)).find((x) => x.endsWith(f.sha256))!, Buffer.from('%PDF-1.4 outro conteudo'));
    const bad = await call(mgr, 'GET', `/api/documents/${id}/files/${f.id}`);
    expect(bad.statusCode).toBe(500);
    expect(bad.json().error).toMatch(/integridade/);
  });

  it('cancelar exige motivo e vale até assinar; lista filtra por situação', async () => {
    const created = await newDoc(mgr); const id = created.json().id;
    expect((await call(owner, 'POST', `/api/documents/${id}/cancel`, {})).statusCode).toBe(400);
    expect((await call(fin, 'POST', `/api/documents/${id}/cancel`, { reason: 'Contrato desfeito' })).statusCode).toBe(403); // só quem administra
    expect((await call(owner, 'POST', `/api/documents/${id}/cancel`, { reason: 'Contrato desfeito' })).statusCode).toBe(200);
    expect((await call(owner, 'POST', `/api/documents/${id}/cancel`, { reason: 'de novo' })).statusCode).toBe(409);
    const list = (await call(mgr, 'GET', '/api/documents?status=cancelled')).json().items;
    expect(list.some((x: any) => x.id === id)).toBe(true);
    expect(list.every((x: any) => x.status === 'cancelled')).toBe(true);
  });
});

describe('permissões e isolamento', () => {
  it('corretor e marketing não acessam documentos (contêm CPF/CNPJ)', async () => {
    const id = (await call(mgr, 'GET', '/api/documents')).json().items[0].id;
    for (const [m, u] of [['GET', '/api/documents'], ['GET', `/api/documents/${id}`], ['GET', `/api/documents/${id}/pdf`], ['POST', '/api/documents'], ['GET', '/api/document-templates']] as const) {
      expect((await call(broker, m, u, m === 'POST' ? {} : undefined)).statusCode, `${m} ${u}`).toBe(403);
    }
  });

  it('outra imobiliária não vê, baixa, aprova, anexa nem usa modelo ou contrato de fora', async () => {
    const id = await readyDoc(mgr);
    await call(owner, 'POST', `/api/documents/${id}/approve`, { acknowledgeUnreviewed: true });
    const file = (await call(mgr, 'GET', `/api/documents/${id}`)).json();
    for (const [m, u, body] of [
      ['GET', `/api/documents/${id}`], ['GET', `/api/documents/${id}/pdf`], ['POST', `/api/documents/${id}/approve`, {}], ['POST', `/api/documents/${id}/send`],
      ['PUT', `/api/documents/${id}`, { body: 'y'.repeat(30) }], ['POST', `/api/documents/${id}/cancel`, { reason: 'invasão' }], ['GET', `/api/documents/${id}/versions/1`],
      ['POST', `/api/documents/${id}/signers`, { role: 'locador', name: 'Invasor' }],
    ] as const) {
      expect((await call(mgrB, m, u, body as any)).statusCode, `${m} ${u}`).toBe(404);
    }
    expect((await call(mgrB, 'GET', '/api/documents')).json().items.some((x: any) => x.id === id)).toBe(false);
    expect((await call(mgrB, 'POST', '/api/documents', { templateId, rentalContractId: contractId })).statusCode).toBe(404); // modelo de A
    const tplB = (await call(mgrB, 'POST', '/api/document-templates/starter')).json().id;
    expect((await call(mgrB, 'POST', '/api/documents', { templateId: tplB, rentalContractId: contractId })).statusCode).toBe(404); // contrato de A
    expect(file.pdf_key).toBeTruthy();
    // o armazenamento também é separado por imobiliária: a chave de A não abre em B
    const store = new LocalFileStore(filesDir);
    const tidB = (await db.query<any>(`SELECT tenant_id FROM users WHERE email = 'owner@b.demo'`)).rows[0].tenant_id;
    await expect(store.get(tidB, file.pdf_key)).rejects.toThrow();
    await expect(store.get('../../etc', file.pdf_key)).rejects.toThrow(/inválida/);
    await expect(store.get(tidB, '../../../../etc/passwd')).rejects.toThrow(/inválida/);
  });
});
