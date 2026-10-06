import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { scoped } from '../db/client.js';
import { audit } from '../audit.js';
import { guard } from '../guard.js';
import { daysLate, lateCharges } from '../domain/money.js';
import { today } from '../domain/rentalService.js';
import { FileIntegrityError, getFileStore } from '../storage.js';

const uuid = z.string().uuid();
const guardRenter = guard('renter_portal', 'view');

/** Inquilino logado: o contato dele. Sem vínculo, nega. Tudo nesta rota é filtrado por este contato. */
async function renterContact(db: Db, req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const { rows } = await db.query<{ contact_id: string | null }>(`SELECT contact_id FROM users WHERE id = $1 AND tenant_id = $2 AND active AND role = 'renter'`, [req.session!.sub, req.session!.tid]);
  const id = rows[0]?.contact_id ?? null;
  if (!id) reply.code(403).send({ error: 'Seu acesso ao portal não está vinculado a um inquilino.' });
  return id;
}

/**
 * Portal do inquilino: somente leitura e somente o contrato dele. Nunca expõe dados do proprietário (contato, documento, repasses,
 * taxa de administração) nem de outros inquilinos. Mostra o que ele precisa para pagar: valores, situação e as opções de pagamento emitidas.
 */
export function registerRenterPortalRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/renter/summary', { preHandler: guardRenter }, async (req, reply) => {
    const cid = await renterContact(db, req, reply); if (!cid) return;
    const now = await today(db);
    const s = scoped(db, req.session!.tid);
    const contracts = await s.rows<any>(
      `SELECT c.id, c.rent_cents, c.due_day, c.status, to_char(c.start_date,'YYYY-MM-DD') start_date, to_char(c.end_date,'YYYY-MM-DD') end_date,
              p.title property_title, p.code property_code, p.neighborhood, p.city
         FROM rental_contracts c JOIN properties p ON p.id = c.property_id AND p.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1 AND c.renter_id = $2 ORDER BY c.status, c.start_date DESC`, [cid]);
    const [next] = await s.rows<any>(
      `SELECT ch.competence, ch.amount_cents, to_char(ch.due_date,'YYYY-MM-DD') due_date
         FROM rental_charges ch JOIN rental_contracts c ON c.id = ch.contract_id AND c.tenant_id = ch.tenant_id
        WHERE ch.tenant_id = $1 AND c.renter_id = $2 AND ch.status = 'open' AND ch.due_date >= $3::date ORDER BY ch.due_date ASC LIMIT 1`, [cid, now]); // futura: o atraso é mostrado à parte
    const [od] = await s.rows<{ n: number; total: string | null }>(
      `SELECT count(*)::int n, sum(ch.amount_cents) total FROM rental_charges ch JOIN rental_contracts c ON c.id = ch.contract_id AND c.tenant_id = ch.tenant_id
        WHERE ch.tenant_id = $1 AND c.renter_id = $2 AND ch.status = 'open' AND ch.due_date < $3::date`, [cid, now]);
    return {
      contracts: contracts.map((c) => ({ id: c.id, status: c.status, rentCents: Number(c.rent_cents), dueDay: c.due_day, startsOn: c.start_date, endsOn: c.end_date,
        property: { title: c.property_title, code: c.property_code, neighborhood: c.neighborhood, city: c.city } })),
      nextCharge: next ? { competence: next.competence, dueOn: next.due_date, amountCents: Number(next.amount_cents) } : null,
      overdue: { count: od.n, principalCents: Number(od.total ?? 0) },
    };
  });

  app.get('/api/renter/charges', { preHandler: guardRenter }, async (req, reply) => {
    const cid = await renterContact(db, req, reply); if (!cid) return;
    const now = await today(db);
    const rows = await scoped(db, req.session!.tid).rows<any>(
      `SELECT ch.id, ch.competence, ch.amount_cents, ch.status, to_char(ch.due_date,'YYYY-MM-DD') due_date, to_char(ch.paid_on,'YYYY-MM-DD') paid_on,
              ch.paid_principal_cents, ch.late_fee_cents, ch.interest_cents, ch.gateway_id, ch.gateway_stale, ch.gateway_url, ch.gateway_boleto_url, ch.gateway_pix_payload,
              c.late_fee_bps, c.interest_bps_month, p.title property_title
         FROM rental_charges ch JOIN rental_contracts c ON c.id = ch.contract_id AND c.tenant_id = ch.tenant_id
         JOIN properties p ON p.id = c.property_id AND p.tenant_id = ch.tenant_id
        WHERE ch.tenant_id = $1 AND c.renter_id = $2 AND ch.status <> 'canceled' ORDER BY ch.due_date DESC LIMIT 200`, [cid]);
    return {
      items: rows.map((r) => {
        const principal = Number(r.amount_cents);
        const late = r.status === 'open' && r.due_date < now;
        const days = late ? daysLate(r.due_date, now) : 0;
        const est = lateCharges(principal, days, { lateFeeBps: r.late_fee_bps, interestBpsMonth: r.interest_bps_month });
        const payable = r.status === 'open' && r.gateway_id && !r.gateway_stale; // cobrança desatualizada (reajuste) não é oferecida: pagaria o valor errado
        return {
          id: r.id, competence: r.competence, property: r.property_title, dueOn: r.due_date, amountCents: principal, status: late ? 'overdue' : r.status,
          paidOn: r.paid_on, paidCents: r.status === 'paid' ? Number(r.paid_principal_cents) + Number(r.late_fee_cents) + Number(r.interest_cents) : null,
          // Estimativa de atraso: o valor final é o do boleto/Pix emitido ou o informado pela imobiliária.
          lateEstimate: late ? { daysLate: days, lateFeeCents: est.lateFeeCents, interestCents: est.interestCents, totalCents: est.totalCents } : null,
          payment: payable ? { url: r.gateway_url, boletoUrl: r.gateway_boleto_url, pixPayload: r.gateway_pix_payload } : null,
        };
      }),
    };
  });

  // Contrato em PDF: só documentos já enviados para assinatura ou assinados, e só os do contrato dele.
  app.get('/api/renter/documents', { preHandler: guardRenter }, async (req, reply) => {
    const cid = await renterContact(db, req, reply); if (!cid) return;
    const s = scoped(db, req.session!.tid);
    const docs = await s.rows<any>(
      `SELECT d.id, d.title, d.status, d.signed_at, (d.pdf_key IS NOT NULL) AS has_pdf
         FROM contract_documents d JOIN rental_contracts c ON c.id = d.rental_contract_id AND c.tenant_id = d.tenant_id
        WHERE d.tenant_id = $1 AND c.renter_id = $2 AND d.status IN ('sent','signed') ORDER BY d.updated_at DESC`, [cid]);
    const out = [];
    for (const d of docs) {
      const files = d.status === 'signed'
        ? await s.rows(`SELECT id, filename, size FROM contract_files WHERE tenant_id = $1 AND document_id = $2 AND kind = 'signed' ORDER BY created_at`, [d.id]) : [];
      out.push({ id: d.id, title: d.title, status: d.status, signedAt: d.signed_at, hasPdf: d.has_pdf, files });
    }
    return { items: out };
  });

  async function ownDoc(req: FastifyRequest, reply: FastifyReply, id: string) {
    const cid = await renterContact(db, req, reply); if (!cid) return null;
    const [d] = await scoped(db, req.session!.tid).rows<any>(
      `SELECT d.id, d.title, d.status, d.pdf_key FROM contract_documents d JOIN rental_contracts c ON c.id = d.rental_contract_id AND c.tenant_id = d.tenant_id
        WHERE d.tenant_id = $1 AND d.id = $2 AND c.renter_id = $3 AND d.status IN ('sent','signed')`, [id, cid]);
    if (!d) { reply.code(404).send({ error: 'Documento não encontrado.' }); return null; }
    return d as { id: string; title: string; status: string; pdf_key: string | null };
  }

  const send = (reply: FastifyReply, data: Buffer, filename: string) =>
    reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${filename}"`).header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff').send(data);
  const integrity = (reply: FastifyReply, e: unknown) => {
    if (e instanceof FileIntegrityError) return reply.code(500).send({ error: 'Falha de integridade: o arquivo armazenado não confere com o registro. Fale com a imobiliária.' });
    throw e;
  };

  app.get('/api/renter/documents/:id/pdf', { preHandler: guardRenter }, async (req, reply) => {
    const d = await ownDoc(req, reply, uuid.parse((req.params as any).id)); if (!d) return;
    if (!d.pdf_key) return reply.code(404).send({ error: 'Este documento ainda não tem PDF.' });
    try {
      const data = await getFileStore().get(req.session!.tid, d.pdf_key);
      await audit(db, req, { action: 'renter.document_download', resource: 'document', resourceId: d.id, summary: 'Inquilino baixou o PDF do contrato' });
      return send(reply, data, `${d.title.replace(/[^\w\- ]/g, '_').slice(0, 80)}.pdf`);
    } catch (e) { return integrity(reply, e); }
  });

  app.get('/api/renter/documents/:id/files/:fid', { preHandler: guardRenter }, async (req, reply) => {
    const d = await ownDoc(req, reply, uuid.parse((req.params as any).id)); if (!d) return;
    if (d.status !== 'signed') return reply.code(404).send({ error: 'Arquivo não encontrado.' });
    const [f] = await scoped(db, req.session!.tid).rows<any>(`SELECT filename, storage_key FROM contract_files WHERE tenant_id = $1 AND document_id = $2 AND id = $3 AND kind = 'signed'`, [d.id, uuid.parse((req.params as any).fid)]);
    if (!f) return reply.code(404).send({ error: 'Arquivo não encontrado.' });
    try {
      const data = await getFileStore().get(req.session!.tid, f.storage_key);
      await audit(db, req, { action: 'renter.document_download', resource: 'document', resourceId: d.id, summary: 'Inquilino baixou o contrato assinado' });
      return send(reply, data, f.filename);
    } catch (e) { return integrity(reply, e); }
  });
}
