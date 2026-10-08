import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { scoped } from '../db/client.js';
import { audit } from '../audit.js';
import { guard } from '../guard.js';
import { notifyUsers, staffIds } from '../domain/notify.js';

const uuid = z.string().uuid();
const CATEGORIES = ['hydraulic', 'electrical', 'structural', 'appliance', 'other'] as const;
const URGENCIES = ['low', 'normal', 'urgent'] as const;
const STATUSES = ['open', 'in_progress', 'waiting_tenant', 'resolved', 'canceled'] as const;
const ACTIVE = ['open', 'in_progress', 'waiting_tenant'];
const MAX_ACTIVE_PER_RENTER = 10; // freio contra spam e erro de script; o portal é externo
const text = (max: number) => z.string().trim().min(1).max(max);

/** Imóveis do proprietário: vinculados a ele diretamente ou por contrato. $1 = tenant, $2 = contato do proprietário. */
const OWNED = `(p.owner_contact_id = $2 OR EXISTS (SELECT 1 FROM rental_contracts oc WHERE oc.tenant_id = p.tenant_id AND oc.property_id = p.id AND oc.landlord_id = $2))`;

async function linkedContact(db: Db, req: FastifyRequest, reply: FastifyReply, role: 'renter' | 'landlord'): Promise<string | null> {
  const { rows } = await db.query<{ contact_id: string | null }>(`SELECT contact_id FROM users WHERE id = $1 AND tenant_id = $2 AND active AND role = $3`, [req.session!.sub, req.session!.tid, role]);
  const id = rows[0]?.contact_id ?? null;
  if (!id) reply.code(403).send({ error: 'Seu acesso ao portal não está vinculado a um cadastro.' });
  return id;
}

const shape = (r: any) => ({
  id: r.id, title: r.title, description: r.description, category: r.category, urgency: r.urgency, status: r.status,
  property: { title: r.property_title, code: r.property_code }, createdAt: r.created_at, updatedAt: r.updated_at, resolvedAt: r.resolved_at,
});
const BASE = `SELECT m.id, m.title, m.description, m.category, m.urgency, m.status, m.created_at, m.updated_at, m.resolved_at, p.title property_title, p.code property_code
                FROM maintenance_requests m JOIN properties p ON p.id = m.property_id AND p.tenant_id = m.tenant_id`;

/**
 * Chamados de manutenção. O inquilino abre e conversa (só no contrato dele); a equipe trata e pode escrever notas internas;
 * o proprietário só acompanha (sem a conversa e sem identificar o inquilino). Nota interna nunca sai da equipe.
 */
export function registerMaintenanceRoutes(app: FastifyInstance, db: Db) {
  const guardRenterView = guard('renter_portal', 'view');
  const guardRenterCreate = guard('renter_portal', 'create');

  async function ownRequest(req: FastifyRequest, reply: FastifyReply, id: string) {
    const cid = await linkedContact(db, req, reply, 'renter'); if (!cid) return null;
    const [r] = await scoped(db, req.session!.tid).rows<any>(`${BASE} WHERE m.tenant_id = $1 AND m.id = $2 AND m.requester_contact_id = $3`, [id, cid]);
    if (!r) { reply.code(404).send({ error: 'Chamado não encontrado.' }); return null; }
    return r;
  }

  async function notifyStaff(tid: string, message: string, id: string) {
    await notifyUsers(db, tid, await staffIds(db, tid, ['owner', 'manager']), message, `/locacao?aba=chamados&chamado=${id}`);
  }

  /** Aviso dentro do portal para o usuário do inquilino (quando já aceitou o convite). Sem canal externo: e-mail/WhatsApp ainda não existem. */
  async function notifyRenter(tid: string, contactId: string, message: string) {
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM users WHERE tenant_id = $1 AND contact_id = $2 AND role = 'renter' AND active`, [tid, contactId]);
    await notifyUsers(db, tid, rows.map((r) => r.id), message, '/inquilino/chamados');
  }

  // ================= Inquilino =================
  app.get('/api/renter/notifications', { preHandler: guardRenterView }, async (req) => {
    const rows = await scoped(db, req.session!.tid).rows<any>(
      `SELECT id, message, read_at, created_at, count FROM notifications WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 30`, [req.session!.sub]);
    return { unread: rows.filter((r) => !r.read_at).length, items: rows.map((r) => ({ id: r.id, message: r.message, read: !!r.read_at, at: r.created_at, count: r.count })) };
  });

  app.post('/api/renter/notifications/read', { preHandler: guardRenterView }, async (req) => {
    const done = await scoped(db, req.session!.tid).rows(`UPDATE notifications SET read_at = now() WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL RETURNING id`, [req.session!.sub]);
    return { marked: done.length };
  });

  app.get('/api/renter/maintenance', { preHandler: guardRenterView }, async (req, reply) => {
    const cid = await linkedContact(db, req, reply, 'renter'); if (!cid) return;
    const rows = await scoped(db, req.session!.tid).rows<any>(`${BASE} WHERE m.tenant_id = $1 AND m.requester_contact_id = $2 ORDER BY m.created_at DESC LIMIT 100`, [cid]);
    return { items: rows.map(shape) };
  });

  app.post('/api/renter/maintenance', { preHandler: guardRenterCreate, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const cid = await linkedContact(db, req, reply, 'renter'); if (!cid) return;
    const b = z.object({
      contractId: uuid, title: text(120), description: text(2000),
      category: z.enum(CATEGORIES).default('other'), urgency: z.enum(URGENCIES).default('normal'),
    }).parse(req.body);
    const tid = req.session!.tid;
    const s = scoped(db, tid);
    const [c] = await s.rows<{ id: string; property_id: string }>(`SELECT id, property_id FROM rental_contracts WHERE tenant_id = $1 AND id = $2 AND renter_id = $3 AND status = 'active'`, [b.contractId, cid]);
    if (!c) return reply.code(404).send({ error: 'Contrato ativo não encontrado.' });
    const [{ n }] = await s.rows<{ n: number }>(`SELECT count(*)::int n FROM maintenance_requests WHERE tenant_id = $1 AND requester_contact_id = $2 AND status = ANY($3::text[])`, [cid, ACTIVE]);
    if (n >= MAX_ACTIVE_PER_RENTER) return reply.code(429).send({ error: `Você já tem ${MAX_ACTIVE_PER_RENTER} chamados em andamento. Aguarde a imobiliária resolver alguns antes de abrir outro.` });
    const [r] = await s.rows<{ id: string }>(
      `INSERT INTO maintenance_requests (tenant_id, contract_id, property_id, requester_contact_id, title, description, category, urgency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [c.id, c.property_id, cid, b.title, b.description, b.category, b.urgency]);
    await audit(db, req, { action: 'maintenance.create', resource: 'maintenance', resourceId: r.id, summary: `Inquilino abriu o chamado "${b.title}"` });
    await notifyStaff(tid, b.urgency === 'urgent' ? `Chamado URGENTE de manutenção: ${b.title}` : `Novo chamado de manutenção: ${b.title}`, r.id);
    return reply.code(201).send({ id: r.id });
  });

  app.get('/api/renter/maintenance/:id', { preHandler: guardRenterView }, async (req, reply) => {
    const r = await ownRequest(req, reply, uuid.parse((req.params as any).id)); if (!r) return;
    const messages = await scoped(db, req.session!.tid).rows<any>(
      `SELECT id, author_kind, body, created_at FROM maintenance_messages WHERE tenant_id = $1 AND request_id = $2 AND NOT internal ORDER BY created_at`, [r.id]);
    return { ...shape(r), messages: messages.map((m) => ({ id: m.id, from: m.author_kind, body: m.body, at: m.created_at })) };
  });

  app.post('/api/renter/maintenance/:id/messages', { preHandler: guardRenterCreate, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const r = await ownRequest(req, reply, uuid.parse((req.params as any).id)); if (!r) return;
    const b = z.object({ body: text(2000) }).parse(req.body);
    const tid = req.session!.tid;
    // Atômico: só grava a mensagem se o chamado ainda está em andamento (não escreve em chamado já encerrado).
    const upd = await scoped(db, tid).rows(
      `UPDATE maintenance_requests SET updated_at = now(), status = CASE WHEN status = 'waiting_tenant' THEN 'in_progress' ELSE status END
        WHERE tenant_id = $1 AND id = $2 AND status = ANY($3::text[]) RETURNING id`, [r.id, ACTIVE]);
    if (!upd.length) return reply.code(409).send({ error: 'Este chamado já foi encerrado. Abra um novo se o problema continua.' });
    await scoped(db, tid).rows(`INSERT INTO maintenance_messages (tenant_id, request_id, author_kind, author_user_id, body) VALUES ($1,$2,'renter',$3,$4)`, [r.id, req.session!.sub, b.body]);
    await notifyStaff(tid, `Nova mensagem do inquilino no chamado: ${r.title}`, r.id);
    return reply.code(201).send({ ok: true });
  });

  app.post('/api/renter/maintenance/:id/cancel', { preHandler: guardRenterCreate }, async (req, reply) => {
    const r = await ownRequest(req, reply, uuid.parse((req.params as any).id)); if (!r) return;
    const done = await scoped(db, req.session!.tid).rows(
      `UPDATE maintenance_requests SET status = 'canceled', updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = ANY($3::text[]) RETURNING id`, [r.id, ACTIVE]);
    if (!done.length) return reply.code(409).send({ error: 'Este chamado já foi encerrado.' });
    await audit(db, req, { action: 'maintenance.cancel', resource: 'maintenance', resourceId: r.id, summary: `Inquilino cancelou o chamado "${r.title}"` });
    return { ok: true };
  });

  // ================= Proprietário (somente acompanhamento) =================
  app.get('/api/portal/maintenance', { preHandler: guard('portal', 'view') }, async (req, reply) => {
    const cid = await linkedContact(db, req, reply, 'landlord'); if (!cid) return;
    const rows = await scoped(db, req.session!.tid).rows<any>(
      `${BASE} WHERE m.tenant_id = $1 AND ${OWNED} AND m.status <> 'canceled' ORDER BY m.created_at DESC LIMIT 100`, [cid]);
    // Sem a conversa e sem identificar o inquilino: o proprietário vê o que acontece com o imóvel dele.
    return { items: rows.map(shape) };
  });

  // ================= Equipe =================
  app.get('/api/maintenance', { preHandler: guard('rentals', 'view') }, async (req) => {
    const q = z.object({ status: z.enum(STATUSES).optional(), active: z.enum(['1']).optional() }).parse(req.query);
    const rows = await scoped(db, req.session!.tid).rows<any>(
      `SELECT m.id, m.title, m.category, m.urgency, m.status, m.created_at, m.updated_at, p.title property_title, p.code property_code, c.name renter_name,
              (SELECT count(*)::int FROM maintenance_messages x WHERE x.tenant_id = m.tenant_id AND x.request_id = m.id) messages
         FROM maintenance_requests m JOIN properties p ON p.id = m.property_id AND p.tenant_id = m.tenant_id JOIN contacts c ON c.id = m.requester_contact_id AND c.tenant_id = m.tenant_id
        WHERE m.tenant_id = $1 AND ($2::text IS NULL OR m.status = $2) AND ($3::text IS NULL OR m.status = ANY($4::text[]))
        ORDER BY (m.urgency = 'urgent' AND m.status = ANY($4::text[])) DESC, m.created_at DESC LIMIT 200`,
      [q.status ?? null, q.active ?? null, ACTIVE]);
    return { items: rows.map((r) => ({ id: r.id, title: r.title, category: r.category, urgency: r.urgency, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
      property: { title: r.property_title, code: r.property_code }, renterName: r.renter_name, messages: r.messages })) };
  });

  app.get('/api/maintenance/:id', { preHandler: guard('rentals', 'view') }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const s = scoped(db, req.session!.tid);
    const [r] = await s.rows<any>(
      `SELECT m.id, m.title, m.description, m.category, m.urgency, m.status, m.created_at, m.updated_at, m.resolved_at, p.title property_title, p.code property_code, c.name renter_name
         FROM maintenance_requests m JOIN properties p ON p.id = m.property_id AND p.tenant_id = m.tenant_id JOIN contacts c ON c.id = m.requester_contact_id AND c.tenant_id = m.tenant_id
        WHERE m.tenant_id = $1 AND m.id = $2`, [id]);
    if (!r) return reply.code(404).send({ error: 'Chamado não encontrado.' });
    const messages = await s.rows<any>(`SELECT id, author_kind, body, internal, created_at FROM maintenance_messages WHERE tenant_id = $1 AND request_id = $2 ORDER BY created_at`, [id]);
    return { ...shape(r), renterName: r.renter_name, messages: messages.map((m) => ({ id: m.id, from: m.author_kind, body: m.body, internal: m.internal, at: m.created_at })) };
  });

  app.patch('/api/maintenance/:id', { preHandler: guard('rentals', 'edit') }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ status: z.enum(['open', 'in_progress', 'waiting_tenant', 'resolved']) }).parse(req.body);
    // Chamado cancelado pelo inquilino não é reaberto pela equipe (abre-se outro).
    const [before] = await scoped(db, req.session!.tid).rows<{ status: string }>(`SELECT status FROM maintenance_requests WHERE tenant_id = $1 AND id = $2`, [id]);
    const done = await scoped(db, req.session!.tid).rows<any>(
      `UPDATE maintenance_requests SET status = $2, updated_at = now(), resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE NULL END
        WHERE tenant_id = $1 AND id = $3 AND status <> 'canceled' RETURNING id, title, status, requester_contact_id`, [b.status, id]);
    if (!done.length) return reply.code(404).send({ error: 'Chamado não encontrado ou já cancelado.' });
    await audit(db, req, { action: 'maintenance.status', resource: 'maintenance', resourceId: id, after: { status: b.status }, summary: `Chamado "${done[0].title}" alterado para ${b.status}` });
    if (before?.status !== b.status) {
      const text: Record<string, string> = { open: 'foi reaberto', in_progress: 'está em andamento', waiting_tenant: 'aguarda uma resposta sua', resolved: 'foi resolvido' };
      await notifyRenter(req.session!.tid, done[0].requester_contact_id, `Seu chamado "${done[0].title}" ${text[b.status]}.`);
    }
    return { ok: true, status: done[0].status };
  });

  app.post('/api/maintenance/:id/messages', { preHandler: guard('rentals', 'edit') }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ body: text(2000), internal: z.boolean().default(false) }).parse(req.body);
    const s = scoped(db, req.session!.tid);
    const [r] = await s.rows<{ id: string; status: string; title: string; requester_contact_id: string }>(`SELECT id, status, title, requester_contact_id FROM maintenance_requests WHERE tenant_id = $1 AND id = $2`, [id]);
    if (!r) return reply.code(404).send({ error: 'Chamado não encontrado.' });
    if (!b.internal && r.status === 'canceled') return reply.code(409).send({ error: 'O inquilino cancelou este chamado.' });
    await s.rows(`INSERT INTO maintenance_messages (tenant_id, request_id, author_kind, author_user_id, body, internal) VALUES ($1,$2,'staff',$3,$4,$5)`, [id, req.session!.sub, b.body, b.internal]);
    await s.rows(`UPDATE maintenance_requests SET updated_at = now() WHERE tenant_id = $1 AND id = $2`, [id]);
    await audit(db, req, { action: b.internal ? 'maintenance.note' : 'maintenance.reply', resource: 'maintenance', resourceId: id, summary: b.internal ? 'Nota interna em chamado' : 'Resposta ao inquilino em chamado' });
    if (!b.internal) await notifyRenter(req.session!.tid, r.requester_contact_id, `A imobiliária respondeu ao seu chamado "${r.title}".`);
    return reply.code(201).send({ ok: true });
  });
}
