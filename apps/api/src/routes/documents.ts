import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { scoped } from '../db/client.js';
import { audit } from '../audit.js';
import { guard } from '../guard.js';
import { decryptText, encryptText } from '../domain/crypto.js';
import {
  KNOWN_VARIABLES, STARTER_BODY, STARTER_NOTES, contentHash, loadContractVars, renderPdf, renderTemplate, templateVariables, unresolvedTokens,
} from '../domain/contractDocs.js';
import { FileIntegrityError, getFileStore } from '../storage.js';

const uuid = z.string().uuid();
const MAX_FILE = 15 * 1024 * 1024;
const MAX_BODY = 200_000;
const STARTER_NAME = 'Contrato de locação (modelo inicial)';

/** Documentos de contrato contêm CPF/CNPJ: ver e editar exige poder de edição em locação (corretor, só leitura, fica de fora). */
const canWork = guard('rentals', 'edit');
/** Aprovar, enviar, reabrir e cancelar: só quem administra locação. */
const canAdmin = guard('rentals', 'admin');

interface DocRow {
  id: string; status: string; title: string; kind: string; body_enc: string; content_hash: string; current_version: number; created_by: string | null;
  signature_level: string; template_id: string | null; template_version: number | null; template_reviewed: boolean; rental_contract_id: string | null;
  approved_by: string | null; approved_at: string | null; approved_hash: string | null; pdf_key: string | null; pdf_sha256: string | null;
  sent_at: string | null; signed_at: string | null; cancelled_at: string | null; cancel_reason: string | null; created_at: string; updated_at: string;
}

export function registerDocumentRoutes(app: FastifyInstance, db: Db) {
  app.register(multipart, { limits: { fileSize: MAX_FILE, files: 1, fields: 5 } });

  const load = async (tid: string, id: string): Promise<DocRow | undefined> =>
    (await scoped(db, tid).rows<DocRow>(`SELECT * FROM contract_documents WHERE tenant_id = $1 AND id = $2`, [id]))[0];
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'Documento não encontrado.' });
  const wrongStatus = (reply: FastifyReply, msg: string) => reply.code(409).send({ error: msg });

  /** Conclui o documento quando todos assinaram e há ao menos um arquivo assinado anexado. */
  async function completeIfReady(tid: string, docId: string): Promise<boolean> {
    const s = scoped(db, tid);
    const [c] = await s.rows<{ pending: number; total: number; files: number }>(
      `SELECT (SELECT count(*)::int FROM contract_signers WHERE tenant_id = $1 AND document_id = $2 AND status = 'pending') pending,
              (SELECT count(*)::int FROM contract_signers WHERE tenant_id = $1 AND document_id = $2) total,
              (SELECT count(*)::int FROM contract_files WHERE tenant_id = $1 AND document_id = $2 AND kind = 'signed') files`, [docId]);
    if (c.total === 0 || c.pending > 0 || c.files === 0) return false;
    const r = await s.rows(`UPDATE contract_documents SET status = 'signed', signed_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'sent' RETURNING id`, [docId]);
    return r.length > 0;
  }

  // ===================== Modelos =====================
  const templateBody = z.string().min(20).max(MAX_BODY);

  function unknownVars(body: string) {
    return templateVariables(body).filter((v) => !(KNOWN_VARIABLES as readonly string[]).includes(v));
  }

  app.get('/api/document-templates', { preHandler: canWork }, async (req) => {
    const rows = await scoped(db, req.session!.tid).rows<any>(
      `SELECT id, name, kind, notes, version, reviewed, reviewed_at, active, updated_at, body FROM contract_templates WHERE tenant_id = $1 AND active ORDER BY name`);
    return { items: rows.map(({ body, ...t }) => ({ ...t, variables: templateVariables(body) })), knownVariables: KNOWN_VARIABLES };
  });

  app.get('/api/document-templates/:id', { preHandler: canWork }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const [t] = await scoped(db, req.session!.tid).rows<any>(`SELECT * FROM contract_templates WHERE tenant_id = $1 AND id = $2`, [id]);
    if (!t) return reply.code(404).send({ error: 'Modelo não encontrado.' });
    return t;
  });

  app.post('/api/document-templates', { preHandler: canWork }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(3).max(120), kind: z.enum(['locacao', 'administracao', 'autorizacao', 'compra_venda', 'outro']).default('locacao'),
      body: templateBody, notes: z.string().max(500).optional() }).parse(req.body);
    const bad = unknownVars(b.body);
    if (bad.length) return reply.code(422).send({ error: `Variáveis desconhecidas no modelo: ${bad.map((v) => `{{${v}}}`).join(', ')}.`, unknown: bad });
    const [t] = await scoped(db, req.session!.tid).rows<{ id: string }>(
      `INSERT INTO contract_templates (tenant_id, name, kind, body, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [b.name, b.kind, b.body, b.notes ?? null, req.session!.sub]);
    await audit(db, req, { action: 'template.create', resource: 'template', resourceId: t.id, summary: `Modelo de contrato "${b.name}" criado` });
    return reply.code(201).send({ id: t.id });
  });

  app.post('/api/document-templates/starter', { preHandler: canWork }, async (req, reply) => {
    const s = scoped(db, req.session!.tid);
    const [ex] = await s.rows<{ id: string }>(`SELECT id FROM contract_templates WHERE tenant_id = $1 AND name = $2 AND active`, [STARTER_NAME]);
    if (ex) return { id: ex.id, created: false };
    const [t] = await s.rows<{ id: string }>(
      `INSERT INTO contract_templates (tenant_id, name, kind, body, notes, created_by) VALUES ($1,$2,'locacao',$3,$4,$5) RETURNING id`, [STARTER_NAME, STARTER_BODY, STARTER_NOTES, req.session!.sub]);
    await audit(db, req, { action: 'template.create', resource: 'template', resourceId: t.id, summary: 'Modelo inicial de contrato de locação instalado' });
    return reply.code(201).send({ id: t.id, created: true });
  });

  app.put('/api/document-templates/:id', { preHandler: canWork }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ name: z.string().trim().min(3).max(120).optional(), body: templateBody.optional(), notes: z.string().max(500).optional(), active: z.boolean().optional() }).parse(req.body);
    const s = scoped(db, req.session!.tid);
    const [cur] = await s.rows<any>(`SELECT body FROM contract_templates WHERE tenant_id = $1 AND id = $2`, [id]);
    if (!cur) return reply.code(404).send({ error: 'Modelo não encontrado.' });
    if (b.body !== undefined) {
      const bad = unknownVars(b.body);
      if (bad.length) return reply.code(422).send({ error: `Variáveis desconhecidas no modelo: ${bad.map((v) => `{{${v}}}`).join(', ')}.`, unknown: bad });
    }
    const changed = b.body !== undefined && b.body !== cur.body;
    await s.rows(
      `UPDATE contract_templates SET name = coalesce($2, name), body = coalesce($3, body), notes = coalesce($4, notes), active = coalesce($5, active),
              version = version + $6::int, reviewed = CASE WHEN $6::int = 1 THEN false ELSE reviewed END, reviewed_by = CASE WHEN $6::int = 1 THEN NULL ELSE reviewed_by END,
              reviewed_at = CASE WHEN $6::int = 1 THEN NULL ELSE reviewed_at END, updated_at = now() WHERE tenant_id = $1 AND id = $7 RETURNING id`,
      [b.name ?? null, b.body ?? null, b.notes ?? null, b.active ?? null, changed ? 1 : 0, id]);
    await audit(db, req, { action: 'template.update', resource: 'template', resourceId: id, summary: changed ? 'Modelo alterado: nova versão, revisão jurídica zerada' : 'Modelo atualizado' });
    return { ok: true, versionBumped: changed };
  });

  app.post('/api/document-templates/:id/review', { preHandler: canAdmin }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ reviewed: z.boolean() }).parse(req.body);
    const rows = await scoped(db, req.session!.tid).rows(
      `UPDATE contract_templates SET reviewed = $2, reviewed_by = CASE WHEN $2 THEN $3::uuid END, reviewed_at = CASE WHEN $2 THEN now() END WHERE tenant_id = $1 AND id = $4 RETURNING id`,
      [b.reviewed, req.session!.sub, id]);
    if (!rows.length) return reply.code(404).send({ error: 'Modelo não encontrado.' });
    await audit(db, req, { action: 'template.review', resource: 'template', resourceId: id, summary: b.reviewed ? 'Modelo marcado como revisado pelo jurídico' : 'Revisão jurídica do modelo removida' });
    return { ok: true };
  });

  // ===================== Documentos =====================
  app.get('/api/documents', { preHandler: canWork }, async (req) => {
    const q = z.object({ status: z.enum(['draft', 'in_review', 'approved', 'sent', 'signed', 'cancelled']).optional(), contractId: uuid.optional() }).parse(req.query);
    const where: string[] = []; const params: unknown[] = [];
    if (q.status) { params.push(q.status); where.push(`AND d.status = $${params.length + 1}`); }
    if (q.contractId) { params.push(q.contractId); where.push(`AND d.rental_contract_id = $${params.length + 1}`); }
    const items = await scoped(db, req.session!.tid).rows(
      `SELECT d.id, d.title, d.kind, d.status, d.signature_level, d.current_version, d.created_at, d.updated_at, d.rental_contract_id,
              (SELECT count(*)::int FROM contract_signers s WHERE s.tenant_id = d.tenant_id AND s.document_id = d.id) AS signers,
              (SELECT count(*)::int FROM contract_signers s WHERE s.tenant_id = d.tenant_id AND s.document_id = d.id AND s.status = 'signed') AS signed
         FROM contract_documents d WHERE d.tenant_id = $1 ${where.join(' ')} ORDER BY d.updated_at DESC LIMIT 300`, params);
    return { items };
  });

  app.post('/api/documents', { preHandler: canWork }, async (req, reply) => {
    const b = z.object({ templateId: uuid, rentalContractId: uuid.optional(), title: z.string().trim().min(3).max(160).optional(),
      signatureLevel: z.enum(['simples', 'avancada', 'qualificada']).default('avancada') }).parse(req.body);
    const tid = req.session!.tid; const s = scoped(db, tid);
    const [tpl] = await s.rows<any>(`SELECT id, name, kind, body, version, reviewed FROM contract_templates WHERE tenant_id = $1 AND id = $2 AND active`, [b.templateId]);
    if (!tpl) return reply.code(404).send({ error: 'Modelo não encontrado.' });
    let vars = {} as Record<string, string | null>;
    if (b.rentalContractId) {
      const v = await loadContractVars(db, tid, b.rentalContractId);
      if (!v) return reply.code(404).send({ error: 'Contrato de locação não encontrado.' });
      vars = v as Record<string, string | null>;
    }
    const r = renderTemplate(tpl.body, vars);
    const hash = contentHash(r.text);
    const id = await db.transaction(async (tx) => {
      const [d] = await scoped(tx, tid).rows<{ id: string }>(
        `INSERT INTO contract_documents (tenant_id, rental_contract_id, template_id, template_version, template_reviewed, title, kind, body_enc, content_hash, signature_level, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [b.rentalContractId ?? null, tpl.id, tpl.version, tpl.reviewed, b.title ?? tpl.name, tpl.kind, encryptText(r.text), hash, b.signatureLevel, req.session!.sub]);
      await scoped(tx, tid).rows(`INSERT INTO contract_document_versions (tenant_id, document_id, version, body_enc, content_hash, author_id, note) VALUES ($1,$2,1,$3,$4,$5,'Gerado a partir do modelo')`,
        [d.id, encryptText(r.text), hash, req.session!.sub]);
      return d.id;
    });
    await audit(db, req, { action: 'document.create', resource: 'document', resourceId: id, summary: `Documento "${b.title ?? tpl.name}" criado a partir do modelo (versão ${tpl.version})` });
    return reply.code(201).send({ id, pendingVariables: unresolvedTokens(r.text), unknownVariables: r.unknown, missingVariables: r.missing });
  });

  app.get('/api/documents/:id', { preHandler: canWork }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id); const tid = req.session!.tid; const s = scoped(db, tid);
    const d = await load(tid, id); if (!d) return notFound(reply);
    const body = decryptText(d.body_enc);
    const [signers, files, versions] = await Promise.all([
      s.rows(`SELECT id, role, name, email, status, signed_at, evidence FROM contract_signers WHERE tenant_id = $1 AND document_id = $2 ORDER BY position, created_at`, [id]),
      s.rows(`SELECT id, kind, filename, size, sha256, created_at FROM contract_files WHERE tenant_id = $1 AND document_id = $2 ORDER BY created_at`, [id]),
      s.rows(`SELECT version, content_hash, note, created_at, author_id FROM contract_document_versions WHERE tenant_id = $1 AND document_id = $2 ORDER BY version DESC`, [id]),
    ]);
    const { body_enc, ...meta } = d;
    return { ...meta, body, pendingVariables: unresolvedTokens(body), signers, files, versions,
      registrationWarning: d.signature_level !== 'qualificada'
        ? 'Para registrar na matrícula do imóvel (por exemplo, contrato com cláusula de vigência), cartórios podem exigir assinatura eletrônica qualificada (ICP-Brasil). Confirme com o cartório e com seu jurídico.' : null };
  });

  app.put('/api/documents/:id', { preHandler: canWork }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id); const tid = req.session!.tid;
    const b = z.object({ body: z.string().min(20).max(MAX_BODY), note: z.string().max(200).optional() }).parse(req.body);
    const d = await load(tid, id); if (!d) return notFound(reply);
    if (!['draft', 'in_review'].includes(d.status)) return wrongStatus(reply, 'Só é possível editar documentos em rascunho ou em revisão. Para alterar um documento aprovado, reabra-o.');
    const hash = contentHash(b.body);
    if (hash === d.content_hash) return { ok: true, version: d.current_version, unchanged: true };
    const version = d.current_version + 1;
    const ok = await db.transaction(async (tx) => {
      // O UPDATE condicional impede que duas edições simultâneas gravem a mesma versão.
      const r = await scoped(tx, tid).rows(
        `UPDATE contract_documents SET body_enc = $2, content_hash = $3, current_version = $4, status = 'draft', updated_at = now()
          WHERE tenant_id = $1 AND id = $5 AND current_version = $6 AND status IN ('draft','in_review') RETURNING id`, [encryptText(b.body), hash, version, id, d.current_version]);
      if (!r.length) return false;
      await scoped(tx, tid).rows(`INSERT INTO contract_document_versions (tenant_id, document_id, version, body_enc, content_hash, author_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, version, encryptText(b.body), hash, req.session!.sub, b.note ?? null]);
      return true;
    });
    if (!ok) return reply.code(409).send({ error: 'O documento foi alterado por outra pessoa. Recarregue e tente de novo.' });
    await audit(db, req, { action: 'document.edit', resource: 'document', resourceId: id, summary: `Documento editado (versão ${version})` });
    return { ok: true, version, pendingVariables: unresolvedTokens(b.body) };
  });

  app.get('/api/documents/:id/versions/:n', { preHandler: canWork }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id); const n = z.coerce.number().int().min(1).parse((req.params as any).n);
    const [v] = await scoped(db, req.session!.tid).rows<any>(`SELECT version, body_enc, content_hash, note, created_at FROM contract_document_versions WHERE tenant_id = $1 AND document_id = $2 AND version = $3`, [id, n]);
    if (!v) return reply.code(404).send({ error: 'Versão não encontrada.' });
    return { version: v.version, body: decryptText(v.body_enc), contentHash: v.content_hash, note: v.note, createdAt: v.created_at };
  });

  app.post('/api/documents/:id/submit', { preHandler: canWork }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id); const tid = req.session!.tid;
    const d = await load(tid, id); if (!d) return notFound(reply);
    if (d.status !== 'draft') return wrongStatus(reply, 'Só documentos em rascunho podem ser enviados para revisão.');
    const pending = unresolvedTokens(decryptText(d.body_enc));
    if (pending.length) return reply.code(422).send({ error: `O documento ainda tem campos sem preencher: ${pending.map((v) => `{{${v}}}`).join(', ')}. Complete o cadastro ou edite o texto.`, pending });
    const r = await scoped(db, tid).rows(`UPDATE contract_documents SET status = 'in_review', updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'draft' RETURNING id`, [id]);
    if (!r.length) return wrongStatus(reply, 'O documento mudou de situação. Recarregue.');
    await audit(db, req, { action: 'document.submit', resource: 'document', resourceId: id, summary: 'Documento enviado para revisão' });
    return { ok: true };
  });

  app.post('/api/documents/:id/approve', { preHandler: canAdmin }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id); const tid = req.session!.tid;
    const b = z.object({ acknowledgeUnreviewed: z.boolean().default(false) }).parse(req.body ?? {});
    const d = await load(tid, id); if (!d) return notFound(reply);
    if (d.status !== 'in_review') return wrongStatus(reply, 'Só documentos em revisão podem ser aprovados.');
    // Quatro olhos: quem redigiu não aprova sozinho (exceto a diretoria).
    if (d.created_by === req.session!.sub && req.session!.role !== 'owner') return reply.code(403).send({ error: 'Outra pessoa precisa aprovar este documento: quem o redigiu não pode aprová-lo.' });
    if (!d.template_reviewed && !b.acknowledgeUnreviewed) {
      return reply.code(409).send({ error: 'O modelo deste documento não foi revisado pelo jurídico. Confirme que está ciente para aprovar mesmo assim.', needsAcknowledge: true });
    }
    const body = decryptText(d.body_enc);
    const pending = unresolvedTokens(body);
    if (pending.length) return reply.code(422).send({ error: `O documento ainda tem campos sem preencher: ${pending.map((v) => `{{${v}}}`).join(', ')}.`, pending });
    const pdf = await renderPdf({ title: d.title, body, documentId: d.id, hash: d.content_hash });
    const stored = await getFileStore().put(tid, pdf);
    // Só aprova se o texto ainda for exatamente o que foi renderizado (ninguém editou no meio).
    const r = await scoped(db, tid).rows(
      `UPDATE contract_documents SET status = 'approved', approved_by = $2, approved_at = now(), approved_hash = content_hash, pdf_key = $3, pdf_sha256 = $4, updated_at = now()
        WHERE tenant_id = $1 AND id = $5 AND status = 'in_review' AND content_hash = $6 RETURNING id`, [req.session!.sub, stored.key, stored.sha256, id, d.content_hash]);
    if (!r.length) return reply.code(409).send({ error: 'O documento mudou durante a aprovação. Recarregue e revise de novo.' });
    await audit(db, req, { action: 'document.approve', resource: 'document', resourceId: id,
      summary: `Documento aprovado${d.template_reviewed ? '' : ' (modelo sem revisão jurídica, ciente do risco)'}; PDF gerado, integridade ${d.content_hash.slice(0, 12)}…` });
    return { ok: true, pdfSha256: stored.sha256 };
  });

  app.post('/api/documents/:id/reopen', { preHandler: canAdmin }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id); const tid = req.session!.tid;
    const d = await load(tid, id); if (!d) return notFound(reply);
    if (d.status !== 'approved') return wrongStatus(reply, 'Só documentos aprovados (e ainda não enviados) podem ser reabertos. Depois do envio, cancele e gere um novo.');
    const r = await scoped(db, tid).rows(
      `UPDATE contract_documents SET status = 'draft', approved_by = NULL, approved_at = NULL, approved_hash = NULL, pdf_key = NULL, pdf_sha256 = NULL, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND status = 'approved' RETURNING id`, [id]);
    if (!r.length) return wrongStatus(reply, 'O documento mudou de situação. Recarregue.');
    await audit(db, req, { action: 'document.reopen', resource: 'document', resourceId: id, summary: 'Documento aprovado reaberto para edição' });
    return { ok: true };
  });

  // ---- Signatários ----
  const signerBody = z.object({ role: z.enum(['locador', 'locatario', 'fiador', 'testemunha', 'imobiliaria']), name: z.string().trim().min(2).max(160), email: z.string().trim().email().max(160).optional() });

  app.post('/api/documents/:id/signers', { preHandler: canWork }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id); const tid = req.session!.tid; const b = signerBody.parse(req.body);
    const d = await load(tid, id); if (!d) return notFound(reply);
    if (!['draft', 'in_review', 'approved'].includes(d.status)) return wrongStatus(reply, 'Não é possível alterar os signatários depois do envio.');
    const [sg] = await scoped(db, tid).rows<{ id: string }>(
      `INSERT INTO contract_signers (tenant_id, document_id, role, name, email, position) VALUES ($1,$2,$3,$4,$5, (SELECT coalesce(max(position),0)+1 FROM contract_signers WHERE tenant_id = $1 AND document_id = $2)) RETURNING id`,
      [id, b.role, b.name, b.email ?? null]);
    await audit(db, req, { action: 'document.signer_add', resource: 'document', resourceId: id, summary: `Signatário adicionado: ${b.name} (${b.role})` });
    return reply.code(201).send({ id: sg.id });
  });

  app.delete('/api/documents/:id/signers/:sid', { preHandler: canWork }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id); const sid = uuid.parse((req.params as any).sid); const tid = req.session!.tid;
    const d = await load(tid, id); if (!d) return notFound(reply);
    if (!['draft', 'in_review', 'approved'].includes(d.status)) return wrongStatus(reply, 'Não é possível alterar os signatários depois do envio.');
    const r = await scoped(db, tid).rows(`DELETE FROM contract_signers WHERE tenant_id = $1 AND document_id = $2 AND id = $3 RETURNING id`, [id, sid]);
    if (!r.length) return reply.code(404).send({ error: 'Signatário não encontrado.' });
    await audit(db, req, { action: 'document.signer_remove', resource: 'document', resourceId: id, summary: 'Signatário removido' });
    return { ok: true };
  });

  app.post('/api/documents/:id/send', { preHandler: canAdmin }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id); const tid = req.session!.tid;
    const d = await load(tid, id); if (!d) return notFound(reply);
    if (d.status !== 'approved') return wrongStatus(reply, 'Só documentos aprovados podem ser enviados para assinatura.');
    const [c] = await scoped(db, tid).rows<{ n: number }>(`SELECT count(*)::int n FROM contract_signers WHERE tenant_id = $1 AND document_id = $2`, [id]);
    if (c.n < 2) return reply.code(422).send({ error: 'Cadastre ao menos dois signatários (por exemplo, locador e locatário) antes de enviar.' });
    const r = await scoped(db, tid).rows(`UPDATE contract_documents SET status = 'sent', sent_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'approved' RETURNING id`, [id]);
    if (!r.length) return wrongStatus(reply, 'O documento mudou de situação. Recarregue.');
    await audit(db, req, { action: 'document.send', resource: 'document', resourceId: id, summary: 'Documento liberado para coleta de assinaturas (modo manual: assinatura feita fora do Aimob e anexada aqui)' });
    return { ok: true, provider: 'manual' };
  });

  app.post('/api/documents/:id/signers/:sid/signed', { preHandler: canWork }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id); const sid = uuid.parse((req.params as any).sid); const tid = req.session!.tid;
    const b = z.object({ note: z.string().trim().min(3).max(300) }).parse(req.body);
    const d = await load(tid, id); if (!d) return notFound(reply);
    if (d.status !== 'sent') return wrongStatus(reply, 'Só é possível registrar assinaturas de documentos enviados.');
    // O sistema NÃO assina por ninguém: registra a declaração de quem confirmou, com a observação sobre como a assinatura foi feita.
    const r = await scoped(db, tid).rows(
      `UPDATE contract_signers SET status = 'signed', signed_at = now(), declared_by = $2, evidence = $3 WHERE tenant_id = $1 AND document_id = $4 AND id = $5 AND status = 'pending' RETURNING id`,
      [req.session!.sub, b.note, id, sid]);
    if (!r.length) return reply.code(404).send({ error: 'Signatário não encontrado ou já registrado.' });
    await audit(db, req, { action: 'document.signer_signed', resource: 'document', resourceId: id, summary: `Assinatura declarada por um usuário: ${b.note}` });
    const completed = await completeIfReady(tid, id);
    return { ok: true, completed };
  });

  // ---- Arquivos ----
  async function readUpload(req: FastifyRequest, reply: FastifyReply): Promise<{ filename: string; data: Buffer } | null> {
    if (!req.isMultipart()) { reply.code(415).send({ error: 'Envie o arquivo como multipart/form-data.' }); return null; }
    try {
      const part = await req.file();
      if (!part) { reply.code(400).send({ error: 'Nenhum arquivo enviado.' }); return null; }
      const data = await part.toBuffer();
      if (data.length === 0) { reply.code(400).send({ error: 'O arquivo está vazio.' }); return null; }
      // Confere o conteúdo real (assinatura do formato), não o nome nem o tipo informado pelo navegador.
      if (data.subarray(0, 5).toString('latin1') !== '%PDF-') { reply.code(415).send({ error: 'Só arquivos PDF são aceitos.' }); return null; }
      const filename = (part.filename || 'documento.pdf').replace(/[^\w.\- ()]/g, '_').slice(0, 120);
      return { filename, data };
    } catch (e: any) {
      if (e?.code === 'FST_REQ_FILE_TOO_LARGE') { reply.code(413).send({ error: 'O arquivo passa de 15 MB.' }); return null; }
      throw e;
    }
  }

  app.post('/api/documents/:id/files', { preHandler: canWork, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id); const tid = req.session!.tid;
    const d = await load(tid, id); if (!d) return notFound(reply);
    if (d.status !== 'sent') return wrongStatus(reply, 'O arquivo assinado só pode ser anexado a documentos já enviados para assinatura.');
    const up = await readUpload(req, reply); if (!up) return;
    const stored = await getFileStore().put(tid, up.data);
    const [f] = await scoped(db, tid).rows<{ id: string }>(
      `INSERT INTO contract_files (tenant_id, document_id, kind, filename, mime, size, sha256, storage_key, uploaded_by) VALUES ($1,$2,'signed',$3,'application/pdf',$4,$5,$6,$7) RETURNING id`,
      [id, up.filename, stored.size, stored.sha256, stored.key, req.session!.sub]);
    await audit(db, req, { action: 'document.file_add', resource: 'document', resourceId: id, summary: `Arquivo assinado anexado (${up.filename}, SHA-256 ${stored.sha256.slice(0, 12)}…)` });
    const completed = await completeIfReady(tid, id);
    return reply.code(201).send({ id: f.id, sha256: stored.sha256, completed });
  });

  const sendFile = async (reply: FastifyReply, data: Buffer, filename: string) =>
    reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${filename}"`).header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff').send(data);

  app.get('/api/documents/:id/pdf', { preHandler: canWork }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id); const tid = req.session!.tid;
    const d = await load(tid, id); if (!d) return notFound(reply);
    if (!d.pdf_key) return wrongStatus(reply, 'O PDF só existe depois da aprovação do documento.');
    try {
      const data = await getFileStore().get(tid, d.pdf_key);
      await audit(db, req, { action: 'document.download', resource: 'document', resourceId: id, summary: 'PDF do documento baixado' });
      return sendFile(reply, data, `${d.title.replace(/[^\w\- ]/g, '_').slice(0, 80)}.pdf`);
    } catch (e) {
      if (e instanceof FileIntegrityError) return reply.code(500).send({ error: 'Falha de integridade: o PDF armazenado não confere com o hash registrado. Não use este arquivo.' });
      throw e;
    }
  });

  app.get('/api/documents/:id/files/:fid', { preHandler: canWork }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id); const fid = uuid.parse((req.params as any).fid); const tid = req.session!.tid;
    const [f] = await scoped(db, tid).rows<any>(`SELECT filename, storage_key FROM contract_files WHERE tenant_id = $1 AND document_id = $2 AND id = $3`, [id, fid]);
    if (!f) return reply.code(404).send({ error: 'Arquivo não encontrado.' });
    try {
      const data = await getFileStore().get(tid, f.storage_key);
      await audit(db, req, { action: 'document.download', resource: 'document', resourceId: id, summary: `Arquivo assinado baixado (${f.filename})` });
      return sendFile(reply, data, f.filename);
    } catch (e) {
      if (e instanceof FileIntegrityError) return reply.code(500).send({ error: 'Falha de integridade: o arquivo armazenado não confere com o hash registrado. Não use este arquivo.' });
      throw e;
    }
  });

  app.post('/api/documents/:id/cancel', { preHandler: canAdmin }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id); const tid = req.session!.tid;
    const b = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    const r = await scoped(db, tid).rows(
      `UPDATE contract_documents SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2, updated_at = now() WHERE tenant_id = $1 AND id = $3 AND status NOT IN ('signed','cancelled') RETURNING id`, [b.reason, id]);
    if (!r.length) {
      const d = await load(tid, id); if (!d) return notFound(reply);
      return wrongStatus(reply, d.status === 'signed' ? 'Documento assinado não pode ser cancelado. Para encerrar o contrato, use o encerramento de locação.' : 'O documento já está cancelado.');
    }
    await audit(db, req, { action: 'document.cancel', resource: 'document', resourceId: id, summary: `Documento cancelado: ${b.reason}` });
    return { ok: true };
  });
}
