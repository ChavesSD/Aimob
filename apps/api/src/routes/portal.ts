import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db, Queryable } from '../db/client.js';
import { scoped } from '../db/client.js';
import { audit, auditSystem } from '../audit.js';
import { hashPassword, passwordProblem } from '../auth.js';
import { guard } from '../guard.js';
import { propertyHealth } from '../domain/propertyHealth.js';

const uuid = z.string().uuid();
const INVITE_DAYS = 7;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ym = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** Imóveis do proprietário: vinculados a ele diretamente ou por contrato de locação. $1 = tenant, $2 = contato do proprietário. */
const OWNED = `(p.owner_contact_id = $2 OR EXISTS (SELECT 1 FROM rental_contracts oc WHERE oc.tenant_id = p.tenant_id AND oc.property_id = p.id AND oc.landlord_id = $2))`;

/** Proprietário logado: o contato dele. Sem vínculo, nega: um usuário "landlord" sem contato não enxerga nada. */
async function ownerContact(db: Db, req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const { rows } = await db.query<{ contact_id: string | null }>(`SELECT contact_id FROM users WHERE id = $1 AND tenant_id = $2 AND active`, [req.session!.sub, req.session!.tid]);
  const id = rows[0]?.contact_id ?? null;
  if (!id) reply.code(403).send({ error: 'Seu acesso ao portal não está vinculado a um proprietário.' });
  return id;
}

const csvCell = (v: unknown) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita injeção de fórmula ao abrir no Excel/Sheets
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const moneyCsv = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');

/**
 * Consome um convite de forma atômica: o UPDATE condicional só afeta o convite se ele ainda estiver livre e válido,
 * então o mesmo link nunca funciona duas vezes, mesmo em requisições simultâneas. Retorna o dono ou null.
 */
export async function consumeInvite(q: Queryable, tokenHash: string): Promise<{ user_id: string; tenant_id: string } | null> {
  const { rows } = await q.query<{ user_id: string; tenant_id: string }>(
    `UPDATE user_invites SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id, tenant_id`, [tokenHash]);
  return rows[0] ?? null;
}

export function registerPortalRoutes(app: FastifyInstance, db: Db) {
  // ================= Gestão do acesso (equipe da imobiliária) =================
  app.get('/api/portal/access', { preHandler: guard('rentals', 'admin') }, async (req) => {
    const items = await scoped(db, req.session!.tid).rows<any>(
      `SELECT c.id, c.name, c.email AS contact_email, u.email AS user_email, u.active AS accepted,
              (SELECT max(expires_at) FROM user_invites i WHERE i.user_id = u.id AND i.used_at IS NULL) AS invite_expires_at,
              (SELECT count(*)::int FROM properties p WHERE p.tenant_id = c.tenant_id AND p.deleted_at IS NULL AND (p.owner_contact_id = c.id
                 OR EXISTS (SELECT 1 FROM rental_contracts oc WHERE oc.tenant_id = p.tenant_id AND oc.property_id = p.id AND oc.landlord_id = c.id))) AS properties
         FROM contacts c LEFT JOIN users u ON u.contact_id = c.id AND u.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1 AND c.kind = 'owner' AND c.deleted_at IS NULL ORDER BY c.name LIMIT 500`);
    return { items: items.map((i) => ({ id: i.id, name: i.name, email: i.user_email ?? i.contact_email ?? null, hasUser: !!i.user_email, accepted: !!i.accepted,
      inviteExpiresAt: i.invite_expires_at, properties: i.properties })) };
  });

  app.post('/api/portal/invites', { preHandler: guard('rentals', 'admin'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ contactId: uuid, email: z.string().trim().email().max(160) }).parse(req.body);
    const tid = req.session!.tid;
    const s = scoped(db, tid);
    const [contact] = await s.rows<{ id: string; name: string }>(`SELECT id, name FROM contacts WHERE tenant_id = $1 AND id = $2 AND kind = 'owner' AND deleted_at IS NULL`, [b.contactId]);
    if (!contact) return reply.code(404).send({ error: 'Proprietário não encontrado.' });
    const email = b.email.toLowerCase();

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
    try {
      await db.transaction(async (tx) => {
        const { rows: existing } = await tx.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE tenant_id = $1 AND contact_id = $2`, [tid, contact.id]);
        let userId = existing[0]?.id;
        if (userId && existing[0].email.toLowerCase() !== email) {
          throw Object.assign(new Error('email_mismatch'), { code: 'email_mismatch' });
        }
        if (!userId) {
          // Senha inicial impossível de adivinhar e usuário inativo: só o convite abre o acesso.
          const r = await tx.query<{ id: string }>(
            `INSERT INTO users (tenant_id, email, name, role, password_hash, active, contact_id) VALUES ($1,$2,$3,'landlord',$4,false,$5) RETURNING id`,
            [tid, email, contact.name, hashPassword(randomBytes(24).toString('hex')), contact.id]);
          userId = r.rows[0].id;
        }
        await tx.query(`UPDATE user_invites SET expires_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]); // um convite válido por vez
        await tx.query(`INSERT INTO user_invites (tenant_id, user_id, token_hash, expires_at, created_by) VALUES ($1,$2,$3,$4,$5)`, [tid, userId, sha(token), expiresAt.toISOString(), req.session!.sub]);
      });
    } catch (e: any) {
      if (e?.code === 'email_mismatch') return reply.code(409).send({ error: 'Este proprietário já tem acesso com outro e-mail. Revogue o acesso antes de convidar com um e-mail diferente.' });
      if (/users_email_key|unique/i.test(String(e?.message))) return reply.code(409).send({ error: 'Este e-mail já está em uso por outro usuário.' });
      throw e;
    }
    await audit(db, req, { action: 'portal.invite', resource: 'contact', resourceId: contact.id, summary: `Convite do portal gerado para o proprietário ${contact.name}` }); // o token nunca vai ao log
    const base = (process.env.APP_URL ?? '').replace(/\/$/, '');
    return reply.code(201).send({ inviteUrl: `${base}/aceitar-convite?token=${token}`, expiresAt: expiresAt.toISOString() });
  });

  app.delete('/api/portal/access/:contactId', { preHandler: guard('rentals', 'admin') }, async (req, reply) => {
    const contactId = uuid.parse((req.params as any).contactId);
    const tid = req.session!.tid;
    const rows = await scoped(db, tid).rows<{ id: string }>(`UPDATE users SET active = false WHERE tenant_id = $1 AND contact_id = $2 AND role = 'landlord' RETURNING id`, [contactId]);
    if (!rows.length) return reply.code(404).send({ error: 'Esse proprietário não tem acesso ao portal.' });
    await scoped(db, tid).rows(`UPDATE user_invites SET expires_at = now() WHERE tenant_id = $1 AND user_id = $2 AND used_at IS NULL RETURNING id`, [rows[0].id]);
    await audit(db, req, { action: 'portal.revoke', resource: 'contact', resourceId: contactId, summary: 'Acesso ao portal do proprietário revogado' });
    return { ok: true };
  });

  // ================= Aceite do convite (público) =================
  app.post('/api/auth/accept-invite', { config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ token: z.string().min(20).max(100), password: z.string().min(1).max(200) }).parse(req.body);
    const invalid = () => reply.code(400).send({ error: 'Convite inválido ou expirado. Peça um novo convite à imobiliária.' });
    const hash = sha(b.token);
    // A política de senha é checada ANTES de gastar o convite: senha fraca não inutiliza o link.
    const { rows: peek } = await db.query<{ email: string }>(
      `SELECT u.email FROM user_invites i JOIN users u ON u.id = i.user_id WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now()`, [hash]);
    if (!peek.length) return invalid();
    const problem = passwordProblem(b.password, peek[0].email);
    if (problem) return reply.code(400).send({ error: problem });
    const done = await db.transaction(async (tx) => {
      const claimed = await consumeInvite(tx, hash);
      if (!claimed) return null;
      await tx.query(`UPDATE users SET password_hash = $2, active = true WHERE id = $1`, [claimed.user_id, hashPassword(b.password)]);
      return claimed;
    });
    if (!done) return invalid();
    await auditSystem(db, done.tenant_id, { action: 'portal.accept', resource: 'user', resourceId: done.user_id, summary: 'Proprietário aceitou o convite e definiu a senha' });
    return { ok: true };
  });

  // ================= Portal do proprietário =================
  app.get('/api/portal/summary', { preHandler: guard('portal', 'view') }, async (req, reply) => {
    const cid = await ownerContact(db, req, reply); if (!cid) return;
    const s = scoped(db, req.session!.tid);
    const [r] = await s.rows<any>(
      `SELECT (SELECT count(*)::int FROM properties p WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND ${OWNED}) AS properties,
              (SELECT count(*)::int FROM rental_contracts c WHERE c.tenant_id = $1 AND c.landlord_id = $2 AND c.status = 'active') AS rented,
              (SELECT coalesce(sum(c.rent_cents),0) FROM rental_contracts c WHERE c.tenant_id = $1 AND c.landlord_id = $2 AND c.status = 'active') AS monthly_rent,
              (SELECT coalesce(sum(po.net_cents),0) FROM rental_payouts po WHERE po.tenant_id = $1 AND po.landlord_id = $2 AND po.status = 'pending') AS payout_pending,
              (SELECT count(*)::int FROM rental_payouts po WHERE po.tenant_id = $1 AND po.landlord_id = $2 AND po.status = 'pending') AS payout_pending_count,
              (SELECT coalesce(sum(po.net_cents),0) FROM rental_payouts po WHERE po.tenant_id = $1 AND po.landlord_id = $2 AND po.status = 'paid' AND po.paid_at > now() - interval '12 months') AS payout_received_12m,
              (SELECT count(*)::int FROM rental_charges ch JOIN rental_contracts c ON c.id = ch.contract_id AND c.tenant_id = ch.tenant_id
                WHERE ch.tenant_id = $1 AND c.landlord_id = $2 AND ch.status = 'open' AND ch.due_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS overdue_count`, [cid]);
    return { properties: r.properties, rentedProperties: r.rented, monthlyRentCents: Number(r.monthly_rent), payoutPendingCents: Number(r.payout_pending),
      payoutPendingCount: r.payout_pending_count, payoutReceived12mCents: Number(r.payout_received_12m), overdueCharges: r.overdue_count };
  });

  app.get('/api/portal/properties', { preHandler: guard('portal', 'view') }, async (req, reply) => {
    const cid = await ownerContact(db, req, reply); if (!cid) return;
    const rows = await scoped(db, req.session!.tid).rows<any>(
      `SELECT p.id, p.code, p.title, p.description, p.neighborhood, p.city, p.purpose, p.status, p.price_cents, p.photos, p.area_m2,
              floor(extract(epoch FROM (now() - p.created_at)) / 86400)::int AS days_on_market,
              (SELECT count(*)::int FROM leads l WHERE l.tenant_id = p.tenant_id AND l.property_id = p.id AND l.created_at > now() - interval '90 days') AS leads_90d,
              (SELECT count(*)::int FROM visits v WHERE v.tenant_id = p.tenant_id AND v.property_id = p.id AND v.status = 'completed' AND v.scheduled_at > now() - interval '90 days') AS visits_done_90d,
              (SELECT count(*)::int FROM visits v WHERE v.tenant_id = p.tenant_id AND v.property_id = p.id AND v.status = 'scheduled' AND v.scheduled_at >= now()) AS visits_upcoming,
              c.rent_cents, c.status AS contract_status, to_char(c.end_date,'YYYY-MM-DD') AS contract_end, r.name AS renter_name
         FROM properties p
         LEFT JOIN rental_contracts c ON c.tenant_id = p.tenant_id AND c.property_id = p.id AND c.status = 'active'
         LEFT JOIN contacts r ON r.id = c.renter_id AND r.tenant_id = p.tenant_id
        WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND ${OWNED} ORDER BY p.code LIMIT 300`, [cid]);
    return { items: rows.map((p) => {
      const health = propertyHealth({ photos: p.photos, description: p.description, priceCents: Number(p.price_cents), area: p.area_m2 ? Number(p.area_m2) : null,
        neighborhood: p.neighborhood, daysOnMarket: p.days_on_market, leads: p.leads_90d, visits: p.visits_done_90d });
      return {
        id: p.id, code: p.code, title: p.title, neighborhood: p.neighborhood, city: p.city, purpose: p.purpose, status: p.status, priceCents: Number(p.price_cents), photos: p.photos,
        daysOnMarket: p.days_on_market, health: { score: health.score, diagnosis: health.diagnosis },
        // Transparência sobre o interesse, sem identificar ninguém: só contagens.
        interest: { contacts90d: p.leads_90d, visitsDone90d: p.visits_done_90d, visitsUpcoming: p.visits_upcoming },
        lease: p.contract_status ? { rentCents: Number(p.rent_cents), endsOn: p.contract_end, renterName: p.renter_name } : null,
      };
    }) };
  });

  app.get('/api/portal/charges', { preHandler: guard('portal', 'view') }, async (req, reply) => {
    const cid = await ownerContact(db, req, reply); if (!cid) return;
    const items = await scoped(db, req.session!.tid).rows<any>(
      `SELECT ch.id, ch.competence, ch.amount_cents, to_char(ch.due_date,'YYYY-MM-DD') AS due_date, to_char(ch.paid_on,'YYYY-MM-DD') AS paid_on, p.title AS property_title,
              CASE WHEN ch.status = 'open' AND ch.due_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN 'overdue' ELSE ch.status END AS status
         FROM rental_charges ch JOIN rental_contracts c ON c.id = ch.contract_id AND c.tenant_id = ch.tenant_id
         JOIN properties p ON p.id = c.property_id AND p.tenant_id = ch.tenant_id
        WHERE ch.tenant_id = $1 AND c.landlord_id = $2 AND ch.status <> 'canceled' ORDER BY ch.due_date DESC LIMIT 200`, [cid]);
    return { items: items.map((i) => ({ ...i, amount_cents: Number(i.amount_cents) })) };
  });

  const payoutRows = async (req: FastifyRequest, cid: string, q: { status?: string; from?: string; to?: string }) => {
    const where: string[] = [];
    const params: unknown[] = [cid];
    if (q.status) { params.push(q.status); where.push(`AND po.status = $${params.length + 1}`); }
    if (q.from) { params.push(q.from); where.push(`AND ch.competence >= $${params.length + 1}`); }
    if (q.to) { params.push(q.to); where.push(`AND ch.competence <= $${params.length + 1}`); }
    return scoped(db, req.session!.tid).rows<any>(
      `SELECT po.id, ch.competence, p.title AS property_title, po.gross_cents, po.admin_fee_cents, po.net_cents, po.status, po.paid_at
         FROM rental_payouts po JOIN rental_charges ch ON ch.id = po.charge_id AND ch.tenant_id = po.tenant_id
         JOIN rental_contracts c ON c.id = po.contract_id AND c.tenant_id = po.tenant_id JOIN properties p ON p.id = c.property_id AND p.tenant_id = po.tenant_id
        WHERE po.tenant_id = $1 AND po.landlord_id = $2 ${where.join(' ')} ORDER BY ch.competence DESC, p.title LIMIT 1000`, params);
  };
  const payoutQuery = z.object({ status: z.enum(['pending', 'paid']).optional(), from: ym.optional(), to: ym.optional() });

  app.get('/api/portal/payouts', { preHandler: guard('portal', 'view') }, async (req, reply) => {
    const cid = await ownerContact(db, req, reply); if (!cid) return;
    const rows = await payoutRows(req, cid, payoutQuery.parse(req.query));
    const items = rows.map((r) => ({ ...r, gross_cents: Number(r.gross_cents), admin_fee_cents: Number(r.admin_fee_cents), net_cents: Number(r.net_cents) }));
    return { items, totals: { grossCents: items.reduce((a, i) => a + i.gross_cents, 0), adminFeeCents: items.reduce((a, i) => a + i.admin_fee_cents, 0), netCents: items.reduce((a, i) => a + i.net_cents, 0) } };
  });

  app.get('/api/portal/statement.csv', { preHandler: guard('portal', 'view'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const cid = await ownerContact(db, req, reply); if (!cid) return;
    const rows = await payoutRows(req, cid, payoutQuery.parse(req.query));
    const head = ['Competência', 'Imóvel', 'Recebido do inquilino (R$)', 'Taxa de administração (R$)', 'Líquido (R$)', 'Situação', 'Data do repasse'];
    const lines = rows.map((r) => [r.competence, r.property_title, moneyCsv(Number(r.gross_cents)), moneyCsv(Number(r.admin_fee_cents)), moneyCsv(Number(r.net_cents)),
      r.status === 'paid' ? 'Repassado' : 'A repassar', r.paid_at ? new Date(r.paid_at).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : ''].map(csvCell).join(';'));
    await audit(db, req, { action: 'portal.export', resource: 'payout', summary: `Extrato exportado (${rows.length} linha(s))` });
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="extrato-repasses.csv"')
      .send('﻿' + [head.join(';'), ...lines].join('\r\n') + '\r\n'); // BOM para o Excel reconhecer acentos
  });
}
