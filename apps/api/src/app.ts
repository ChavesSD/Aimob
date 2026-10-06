import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import type { Db } from './db/client.js';
import { scoped } from './db/client.js';
import { hashPassword, signMfaToken, signToken, verifyPassword, verifyToken } from './auth.js';
import { registerMfaRoutes } from './routes/mfa.js';

const DUMMY_HASH = hashPassword('senha-fictícia-para-igualar-o-tempo-de-resposta');
import { audit } from './audit.js';
import { guard } from './guard.js';
import { registerAutomationRoutes } from './routes/automation.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerRentalRoutes } from './routes/rentals.js';
import { registerPortalRoutes } from './routes/portal.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerPaymentRoutes } from './routes/payments.js';
import { fireTrigger } from './domain/automation.js';
import { scoreLead } from './domain/scoring.js';
import { propertyHealth } from './domain/propertyHealth.js';
import { attentionInsights } from './domain/insights.js';
import { brand } from './config.js';
import { PIPELINES } from './domain/pipeline.js';
import { rescoreLead } from './domain/leadService.js';
import { assignLead, assignRoundRobin, distributeUnassigned, getMode, setMode } from './domain/distribution.js';

const uuid = z.string().uuid();

// Mesmos critérios dos alertas do dashboard (domain/insights.ts). Fragmentos fixos, nunca vindos do cliente.
const LEAD_FILTERS: Record<string, string> = {
  'sem-atendimento': " AND l.first_response_at IS NULL AND l.created_at < now() - interval '1 hour'",
  'paradas': " AND l.first_response_at IS NOT NULL AND coalesce(l.last_contact_at, l.created_at) < now() - interval '3 days'",
  'sem-proxima-acao': ' AND l.next_action_at IS NULL',
  'sem-responsavel': ' AND l.owner_id IS NULL',
};

export async function buildApp(db: Db, opts: { trustProxy?: boolean; logger?: boolean; fetchImpl?: typeof fetch } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_000_000, trustProxy: opts.trustProxy ?? false });
  // Inventário das rotas registradas (usado por um teste que garante que perfis externos são barrados em tudo que não é do portal).
  const registeredRoutes: { method: string; url: string; public: boolean }[] = [];
  app.decorate('registeredRoutes', registeredRoutes);
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) registeredRoutes.push({ method: String(m), url: r.url, public: !!(r.config as { public?: boolean } | undefined)?.public });
  });
  await app.register(helmet);
  await app.register(cors, { origin: process.env.CORS_ORIGIN?.split(',') ?? false });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof z.ZodError) {
      // Regras com mensagem própria (ex.: CPF inválido) viram o erro principal; as demais mantêm o texto genérico.
      const custom = err.issues.find((i) => i.code === 'custom');
      return reply.code(400).send({ error: custom?.message ?? 'Dados inválidos', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    console.error(err);
    return reply.code(500).send({ error: 'Não conseguimos concluir esta ação agora. Tente novamente em instantes.' });
  });

  // Liveness: o processo responde. Readiness: o banco também (usado pelo balanceador).
  app.get('/health', async () => ({ ok: true, brand: brand.name }));
  app.get('/ready', async (_req, reply) => {
    try { await db.query('SELECT 1'); return { ok: true }; }
    catch { return reply.code(503).send({ ok: false, error: 'Banco de dados indisponível.' }); }
  });

  // ---- Autenticação ----
  app.post('/api/auth/login', { config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const { rows } = await db.query<any>(
      'SELECT id, tenant_id, role, password_hash, active, name, mfa_enabled FROM users WHERE lower(email) = lower($1)', [body.email]);
    const u = rows[0];
    // Compara sempre (hash fictício quando o usuário não existe) para não vazar existência por tempo.
    const ok = verifyPassword(body.password, u ? u.password_hash : DUMMY_HASH) && !!u;
    if (!u || !ok || !u.active) return reply.code(401).send({ error: 'E-mail ou senha incorretos.' });
    if (u.mfa_enabled) {
      // Senha correta, mas falta o segundo fator: devolve só um token curto que serve apenas para /api/auth/mfa/verify.
      return { mfaRequired: true, mfaToken: await signMfaToken(u.id) };
    }
    const token = await signToken({ sub: u.id, tid: u.tenant_id, role: u.role });
    req.session = { sub: u.id, tid: u.tenant_id, role: u.role };
    await audit(db, req, { action: 'auth.login', resource: 'user', resourceId: u.id });
    return { token, user: { id: u.id, name: u.name, role: u.role } };
  });

  // ---- Autenticação obrigatória + helpers de permissão para tudo em /api (exceto login) ----
  app.addHook('preHandler', async (req, reply) => {
    // Só rotas marcadas explicitamente com config.public escapam da autenticação; nada de decidir pela URL.
    if ((req.routeOptions?.config as { public?: boolean } | undefined)?.public) return;
    if (!req.url.startsWith('/api/')) return;
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return reply.code(401).send({ error: 'Sessão necessária.' });
    try {
      req.session = await verifyToken(h.slice(7));
    } catch {
      return reply.code(401).send({ error: 'Sessão expirada. Entre novamente.' });
    }
    // Usuário desativado perde acesso imediatamente, mesmo com token válido.
    // O papel vem sempre do banco (não do token): rebaixar um usuário vale imediatamente.
    const { rows } = await db.query<{ role: string }>('SELECT role FROM users WHERE id = $1 AND tenant_id = $2 AND active', [req.session.sub, req.session.tid]);
    if (!rows.length) return reply.code(401).send({ error: 'Acesso desativado.' });
    req.session.role = rows[0].role;
  });

  // ---- Imóveis ----
  const propertyInput = z.object({
    code: z.string().min(1).max(30), type: z.string().min(1), purpose: z.enum(['venda', 'aluguel', 'ambos']),
    title: z.string().min(3).max(200), description: z.string().max(5000).default(''),
    neighborhood: z.string().max(100).default(''), city: z.string().max(100).default(''),
    bedrooms: z.number().int().min(0).default(0), parking: z.number().int().min(0).default(0),
    areaM2: z.number().positive().nullable().default(null), priceCents: z.number().int().min(0).default(0),
    photos: z.number().int().min(0).default(0),
  });

  app.get('/api/properties', { preHandler: guard('properties', 'view') }, async (req) => {
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25), search: z.string().max(100).optional(), filtro: z.enum(['poucas-fotos']).optional() }).parse(req.query);
    const s = scoped(db, req.session!.tid);
    const extra = q.filtro === 'poucas-fotos' ? ' AND photos < 5' : '';
    const like = `%${q.search ?? ''}%`;
    const items = await s.rows(
      `SELECT id, code, type, purpose, title, neighborhood, city, bedrooms, price_cents, photos, status FROM properties
        WHERE tenant_id = $1 AND deleted_at IS NULL AND (title ILIKE $2 OR code ILIKE $2 OR neighborhood ILIKE $2)${extra}
        ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [like, q.limit, (q.page - 1) * q.limit]);
    const [{ total }] = await s.rows<{ total: number }>(
      `SELECT count(*)::int total FROM properties WHERE tenant_id = $1 AND deleted_at IS NULL AND (title ILIKE $2 OR code ILIKE $2 OR neighborhood ILIKE $2)${extra}`, [like]);
    return { items, total, page: q.page, limit: q.limit };
  });

  app.post('/api/properties', { preHandler: guard('properties', 'create') }, async (req, reply) => {
    const b = propertyInput.parse(req.body);
    const s = scoped(db, req.session!.tid);
    try {
      const [p] = await s.rows(
        `INSERT INTO properties (tenant_id, code, type, purpose, title, description, neighborhood, city, bedrooms, parking, area_m2, price_cents, photos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, code, title`,
        [b.code, b.type, b.purpose, b.title, b.description, b.neighborhood, b.city, b.bedrooms, b.parking, b.areaM2, b.priceCents, b.photos]);
      await s.rows(`INSERT INTO property_events (tenant_id, property_id, kind, summary, actor_id) VALUES ($1,$2,'captacao',$3,$4)`,
        [p.id, `Imóvel ${b.code} cadastrado`, req.session!.sub]);
      await audit(db, req, { action: 'property.create', resource: 'property', resourceId: p.id, after: b });
      return reply.code(201).send(p);
    } catch (e: any) {
      if (/unique/i.test(e.message)) return reply.code(409).send({ error: `Já existe um imóvel com o código ${b.code}.` });
      throw e;
    }
  });

  app.patch('/api/properties/:id', { preHandler: guard('properties', 'edit') }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ priceCents: z.number().int().min(0), }).parse(req.body);
    const s = scoped(db, req.session!.tid);
    const [cur] = await s.rows<{ price_cents: string; code: string }>(
      `SELECT price_cents, code FROM properties WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [id]);
    if (!cur) return reply.code(404).send({ error: 'Imóvel não encontrado.' });
    await s.rows(`UPDATE properties SET price_cents = $2, updated_at = now() WHERE tenant_id = $1 AND id = $3 RETURNING id`, [b.priceCents, id]);
    const fmt = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const summary = `Preço alterado de ${fmt(Number(cur.price_cents))} para ${fmt(b.priceCents)}`;
    await s.rows(`INSERT INTO property_events (tenant_id, property_id, kind, summary, actor_id) VALUES ($1,$2,'preco',$3,$4)`, [id, summary, req.session!.sub]);
    await audit(db, req, { action: 'property.price', resource: 'property', resourceId: id, before: { priceCents: Number(cur.price_cents) }, after: b, summary });
    return { ok: true, summary };
  });

  app.get('/api/properties/:id', { preHandler: guard('properties', 'view') }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const s = scoped(db, req.session!.tid);
    const [p] = await s.rows<any>(`SELECT * FROM properties WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [id]);
    if (!p) return reply.code(404).send({ error: 'Imóvel não encontrado.' });
    const [c] = await s.rows<{ leads: number; visits: number }>(
      `SELECT (SELECT count(*)::int FROM leads WHERE tenant_id = $1 AND property_id = $2) leads,
              (SELECT count(*)::int FROM visits WHERE tenant_id = $1 AND property_id = $2) visits`, [id]);
    const days = Math.floor((Date.now() - new Date(p.created_at).getTime()) / 86_400_000);
    const health = propertyHealth({ photos: p.photos, description: p.description, priceCents: Number(p.price_cents),
      area: p.area_m2 ? Number(p.area_m2) : null, neighborhood: p.neighborhood, daysOnMarket: days, leads: c.leads, visits: c.visits });
    const timeline = await s.rows(`SELECT kind, summary, created_at FROM property_events WHERE tenant_id = $1 AND property_id = $2 ORDER BY created_at DESC LIMIT 100`, [id]);
    return { property: p, health, timeline, stats: c };
  });

  // ---- Leads / CRM ----
  app.get('/api/leads', { preHandler: guard('leads', 'view') }, async (req) => {
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25), filtro: z.enum(['sem-atendimento', 'paradas', 'sem-proxima-acao', 'sem-responsavel']).optional() }).parse(req.query);
    const s = scoped(db, req.session!.tid);
    const extra = LEAD_FILTERS[q.filtro ?? ''] ?? '';
    const items = await s.rows(
      `SELECT l.id, c.name, c.phone, l.source, l.pipeline, l.stage_position, l.score, l.score_reasons, l.status, l.budget_cents, l.created_at,
              l.owner_id, u.name AS owner_name
         FROM leads l JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id
         LEFT JOIN users u ON u.id = l.owner_id AND u.tenant_id = l.tenant_id
        WHERE l.tenant_id = $1 AND l.status = 'open'${extra} ORDER BY l.score DESC, l.created_at DESC LIMIT $2 OFFSET $3`, [q.limit, (q.page - 1) * q.limit]);
    return { items, page: q.page, limit: q.limit };
  });

  app.post('/api/leads', { preHandler: guard('leads', 'create') }, async (req, reply) => {
    const b = z.object({
      name: z.string().min(2).max(120), phone: z.string().max(30).optional(), email: z.string().email().optional(),
      source: z.enum(['manual', 'site', 'portal', 'whatsapp', 'indicacao']).default('manual'),
      budgetCents: z.number().int().positive().optional(), propertyId: uuid.optional(),
    }).parse(req.body);
    const s = scoped(db, req.session!.tid);
    if (b.propertyId) {
      const own = await s.rows(`SELECT 1 FROM properties WHERE tenant_id = $1 AND id = $2`, [b.propertyId]);
      if (!own.length) return reply.code(404).send({ error: 'Imóvel não encontrado.' });
    }
    const { score, reasons } = scoreLead({ source: b.source, hasBudget: !!b.budgetCents, hasPhone: !!b.phone,
      hasPropertyInterest: !!b.propertyId, hoursSinceCreated: 0, hoursSinceLastContact: null, visits: 0, stagePosition: 0 });
    const [contact] = await s.rows(`INSERT INTO contacts (tenant_id, name, phone, email) VALUES ($1,$2,$3,$4) RETURNING id`, [b.name, b.phone ?? null, b.email ?? null]);
    const [lead] = await s.rows(
      `INSERT INTO leads (tenant_id, contact_id, source, budget_cents, property_id, score, score_reasons, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, score`,
      [contact.id, b.source, b.budgetCents ?? null, b.propertyId ?? null, score, JSON.stringify(reasons), req.session!.sub]);
    // Lead cadastrado à mão fica com quem cadastrou; lead de canal (site/portal/whatsapp/indicação) segue a regra da imobiliária.
    let ownerNote = '';
    if (b.source !== 'manual' && (await getMode(db, req.session!.tid)) === 'roundrobin') {
      if (await assignRoundRobin(db, req.session!.tid, lead.id)) ownerNote = ' e distribuído por rodízio';
    }
    await audit(db, req, { action: 'lead.create', resource: 'lead', resourceId: lead.id, summary: `Lead ${b.name} criado (${b.source})${ownerNote}` });
    await fireTrigger(db, req.session!.tid, 'lead.created', lead.id);
    return reply.code(201).send({ ...lead, reasons });
  });

  // ---- Equipe e distribuição de leads ----
  app.get('/api/team', { preHandler: guard('users', 'view') }, async (req) => {
    const s = scoped(db, req.session!.tid);
    const items = await s.rows(
      `SELECT u.id, u.name, u.role, u.accepts_leads,
              (SELECT count(*)::int FROM leads l WHERE l.tenant_id = u.tenant_id AND l.owner_id = u.id AND l.status = 'open') open_leads
         FROM users u WHERE u.tenant_id = $1 AND u.active ORDER BY u.name`);
    return { items, distributionMode: await getMode(db, req.session!.tid) };
  });

  app.put('/api/settings/distribution', { preHandler: guard('users', 'admin') }, async (req) => {
    const b = z.object({ mode: z.enum(['manual', 'roundrobin']) }).parse(req.body);
    const before = await getMode(db, req.session!.tid);
    await setMode(db, req.session!.tid, b.mode);
    await audit(db, req, { action: 'settings.distribution', resource: 'tenant', before: { mode: before }, after: b,
      summary: `Distribuição de leads alterada de "${before}" para "${b.mode}"` });
    return { ok: true, mode: b.mode };
  });

  app.put('/api/team/:id/accepts-leads', { preHandler: guard('users', 'admin') }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ acceptsLeads: z.boolean() }).parse(req.body);
    const rows = await scoped(db, req.session!.tid).rows(
      `UPDATE users SET accepts_leads = $2 WHERE tenant_id = $1 AND id = $3 RETURNING id`, [b.acceptsLeads, id]);
    if (!rows.length) return reply.code(404).send({ error: 'Usuário não encontrado.' });
    await audit(db, req, { action: 'user.accepts_leads', resource: 'user', resourceId: id, after: b });
    return { ok: true };
  });

  app.post('/api/leads/:id/assign', { preHandler: guard('leads', 'admin') }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ ownerId: uuid }).parse(req.body);
    const s = scoped(db, req.session!.tid);
    const [owner] = await s.rows<{ name: string }>(`SELECT name FROM users WHERE tenant_id = $1 AND id = $2 AND active`, [b.ownerId]);
    if (!owner) return reply.code(404).send({ error: 'Corretor não encontrado.' });
    if (!(await assignLead(db, req.session!.tid, id, b.ownerId))) return reply.code(404).send({ error: 'Lead não encontrado.' });
    await audit(db, req, { action: 'lead.assign', resource: 'lead', resourceId: id, after: b, summary: `Lead atribuído a ${owner.name}` });
    return { ok: true, ownerName: owner.name };
  });

  app.post('/api/leads/distribute', { preHandler: guard('leads', 'admin') }, async (req, reply) => {
    const r = await distributeUnassigned(db, req.session!.tid);
    if (r.pending > 0 && r.distributed === 0) {
      return reply.code(409).send({ error: 'Nenhum corretor ativo está recebendo leads. Ative ao menos um na equipe.' });
    }
    await audit(db, req, { action: 'lead.distribute', resource: 'lead', after: r, summary: `${r.distributed} lead(s) distribuído(s) por rodízio` });
    return r;
  });

  app.post('/api/leads/:id/contact', { preHandler: guard('leads', 'edit') }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const s = scoped(db, req.session!.tid);
    const rows = await s.rows(
      `UPDATE leads SET last_contact_at = now(), first_response_at = coalesce(first_response_at, now()), updated_at = now()
        WHERE tenant_id = $1 AND id = $2 RETURNING id`, [id]);
    if (!rows.length) return reply.code(404).send({ error: 'Lead não encontrado.' });
    await audit(db, req, { action: 'lead.contact', resource: 'lead', resourceId: id });
    return { ok: true };
  });

  // ---- Visitas / Agenda ----
  app.get('/api/visits', { preHandler: guard('visits', 'view') }, async (req) => {
    const q = z.object({ filtro: z.enum(['proximas', 'sem-feedback']).optional() }).parse(req.query);
    const s = scoped(db, req.session!.tid);
    const where = q.filtro === 'sem-feedback'
      ? "AND v.status = 'scheduled' AND v.scheduled_at < now() - interval '1 day'"
      : q.filtro === 'proximas' ? "AND v.status = 'scheduled' AND v.scheduled_at >= now()" : '';
    const items = await s.rows(
      `SELECT v.id, v.scheduled_at, v.status, v.outcome, v.feedback, c.name AS lead_name, p.title AS property_title, p.code AS property_code, u.name AS broker_name
         FROM visits v JOIN leads l ON l.id = v.lead_id AND l.tenant_id = v.tenant_id
         JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = v.tenant_id
         JOIN properties p ON p.id = v.property_id AND p.tenant_id = v.tenant_id
         LEFT JOIN users u ON u.id = v.broker_id
        WHERE v.tenant_id = $1 ${where} ORDER BY v.scheduled_at ${q.filtro === 'sem-feedback' ? 'ASC' : 'DESC'} LIMIT 200`);
    return { items };
  });

  app.post('/api/visits', { preHandler: guard('visits', 'create') }, async (req, reply) => {
    const b = z.object({ leadId: uuid, propertyId: uuid, scheduledAt: z.string().datetime({ offset: true }) }).parse(req.body);
    const when = new Date(b.scheduledAt);
    if (when.getTime() < Date.now() - 5 * 60_000) return reply.code(400).send({ error: 'Escolha um horário futuro para a visita.' });
    const s = scoped(db, req.session!.tid);
    const [lead] = await s.rows<any>(`SELECT id, pipeline FROM leads WHERE tenant_id = $1 AND id = $2 AND status = 'open'`, [b.leadId]);
    const [prop] = await s.rows<any>(`SELECT id FROM properties WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [b.propertyId]);
    if (!lead || !prop) return reply.code(404).send({ error: 'Lead ou imóvel não encontrado.' });
    const broker = req.session!.sub;
    const [clash] = await s.rows<any>(
      `SELECT scheduled_at FROM visits WHERE tenant_id = $1 AND broker_id = $2 AND status = 'scheduled'
          AND scheduled_at > $3::timestamptz - interval '1 hour' AND scheduled_at < $3::timestamptz + interval '1 hour' LIMIT 1`, [broker, when.toISOString()]);
    if (clash) return reply.code(409).send({ error: 'Você já tem uma visita marcada em horário próximo (intervalo mínimo de 1 hora).' });
    const [v] = await s.rows(
      `INSERT INTO visits (tenant_id, lead_id, property_id, broker_id, scheduled_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [b.leadId, b.propertyId, broker, when.toISOString()]);
    const visitStage = PIPELINES[lead.pipeline]?.indexOf('Visita') ?? 0;
    await s.rows(`UPDATE leads SET stage_position = greatest(stage_position, $2), next_action_at = $3, updated_at = now() WHERE tenant_id = $1 AND id = $4 RETURNING id`,
      [Math.max(visitStage, 0), when.toISOString(), b.leadId]);
    await s.rows(`INSERT INTO property_events (tenant_id, property_id, kind, summary, actor_id) VALUES ($1,$2,'visita',$3,$4)`,
      [b.propertyId, `Visita agendada para ${when.toLocaleString('pt-BR')}`, broker]);
    await rescoreLead(db, req.session!.tid, b.leadId);
    await audit(db, req, { action: 'visit.create', resource: 'visit', resourceId: v.id, after: b });
    return reply.code(201).send(v);
  });

  app.post('/api/visits/:id/feedback', { preHandler: guard('visits', 'edit') }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const b = z.object({
      outcome: z.enum(['gostou', 'interessado', 'nao_gostou', 'nao_compareceu']),
      notes: z.string().max(1000).default(''),
      nextActionAt: z.string().datetime({ offset: true }).optional(),
    }).parse(req.body);
    const s = scoped(db, req.session!.tid);
    const [v] = await s.rows<any>(`SELECT id, lead_id, property_id, status FROM visits WHERE tenant_id = $1 AND id = $2`, [id]);
    if (!v) return reply.code(404).send({ error: 'Visita não encontrada.' });
    if (v.status !== 'scheduled') return reply.code(409).send({ error: 'O resultado desta visita já foi registrado.' });
    const status = b.outcome === 'nao_compareceu' ? 'no_show' : 'completed';
    await s.rows(`UPDATE visits SET status = $2, outcome = $3, feedback = $4 WHERE tenant_id = $1 AND id = $5 RETURNING id`, [status, b.outcome, b.notes, id]);
    if (status === 'completed') {
      await s.rows(`UPDATE leads SET last_contact_at = now(), first_response_at = coalesce(first_response_at, now()), next_action_at = $2, updated_at = now() WHERE tenant_id = $1 AND id = $3 RETURNING id`,
        [b.nextActionAt ?? null, v.lead_id]);
    } else {
      await s.rows(`UPDATE leads SET next_action_at = $2, updated_at = now() WHERE tenant_id = $1 AND id = $3 RETURNING id`, [b.nextActionAt ?? null, v.lead_id]);
    }
    const label = { gostou: 'cliente gostou', interessado: 'cliente interessado', nao_gostou: 'cliente não gostou', nao_compareceu: 'cliente não compareceu' }[b.outcome];
    await s.rows(`INSERT INTO property_events (tenant_id, property_id, kind, summary, actor_id) VALUES ($1,$2,'visita',$3,$4)`,
      [v.property_id, `Visita realizada: ${label}${b.notes ? ` — ${b.notes}` : ''}`, req.session!.sub]);
    const r = await rescoreLead(db, req.session!.tid, v.lead_id);
    await audit(db, req, { action: 'visit.feedback', resource: 'visit', resourceId: id, after: b, summary: `Visita: ${label}` });
    await fireTrigger(db, req.session!.tid, 'visit.completed', v.lead_id, { dedupe: `visit:${id}`, outcome: b.outcome });
    return { ok: true, score: r?.score };
  });

  // ---- Pipeline (kanban) ----
  app.get('/api/pipeline/:name', { preHandler: guard('leads', 'view') }, async (req, reply) => {
    const name = String((req.params as any).name);
    const stages = PIPELINES[name];
    if (!stages) return reply.code(404).send({ error: 'Pipeline não encontrado.' });
    const s = scoped(db, req.session!.tid);
    const leads = await s.rows<any>(
      `SELECT l.id, c.name, l.stage_position, l.score, l.budget_cents FROM leads l JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id
        WHERE l.tenant_id = $1 AND l.status = 'open' AND l.pipeline = $2 ORDER BY l.score DESC LIMIT 500`, [name]);
    return { stages: stages.map((label, position) => ({ position, label, leads: leads.filter((l) => l.stage_position === position) })) };
  });

  app.post('/api/leads/:id/stage', { preHandler: guard('leads', 'edit') }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ position: z.number().int().min(0) }).parse(req.body);
    const s = scoped(db, req.session!.tid);
    const [l] = await s.rows<any>(`SELECT pipeline, stage_position FROM leads WHERE tenant_id = $1 AND id = $2 AND status = 'open'`, [id]);
    if (!l) return reply.code(404).send({ error: 'Lead não encontrado.' });
    const stages = PIPELINES[l.pipeline] ?? [];
    if (b.position >= stages.length) return reply.code(400).send({ error: 'Etapa inválida.' });
    const closing = b.position === stages.length - 1;
    await s.rows(`UPDATE leads SET stage_position = $2, status = $3, updated_at = now() WHERE tenant_id = $1 AND id = $4 RETURNING id`, [b.position, closing ? 'won' : 'open', id]);
    await rescoreLead(db, req.session!.tid, id);
    await audit(db, req, {
      action: 'lead.stage', resource: 'lead', resourceId: id, before: { stage: stages[l.stage_position] }, after: { stage: stages[b.position] },
      summary: `Etapa alterada de "${stages[l.stage_position]}" para "${stages[b.position]}"`,
    });
    await fireTrigger(db, req.session!.tid, 'lead.stage_changed', id, { dedupe: `stage:${b.position}` });
    return { ok: true, stage: stages[b.position], won: closing };
  });

  // ---- Dashboard ----
  app.get('/api/dashboard', { preHandler: guard('dashboard', 'view') }, async (req) => {
    const tid = req.session!.tid;
    const s = scoped(db, tid);
    const [k] = await s.rows<any>(
      `SELECT (SELECT count(*)::int FROM leads WHERE tenant_id = $1 AND status = 'open') open_leads,
              (SELECT count(*)::int FROM leads WHERE tenant_id = $1 AND status = 'open' AND score >= 55) hot_leads,
              (SELECT count(*)::int FROM properties WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'active') active_properties,
              (SELECT count(*)::int FROM visits WHERE tenant_id = $1 AND status = 'scheduled' AND scheduled_at >= now()) upcoming_visits,
              (SELECT coalesce(sum(budget_cents),0) FROM leads WHERE tenant_id = $1 AND status = 'open') pipeline_cents,
              (SELECT avg(extract(epoch FROM (first_response_at - created_at))/60) FROM leads WHERE tenant_id = $1 AND first_response_at IS NOT NULL) avg_first_response_min`);
    const attention = await attentionInsights(db, tid, req.session!.role);
    return {
      kpis: { openLeads: k.open_leads, hotLeads: k.hot_leads, activeProperties: k.active_properties, upcomingVisits: k.upcoming_visits,
        pipelineCents: Number(k.pipeline_cents), avgFirstResponseMin: k.avg_first_response_min === null ? null : Math.round(Number(k.avg_first_response_min)) },
      attention,
    };
  });

  app.get('/api/audit', { preHandler: guard('audit', 'view') }, async (req) => {
    const s = scoped(db, req.session!.tid);
    return { items: await s.rows(`SELECT action, resource, resource_id, summary, ip, actor_id, created_at FROM audit_log WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`) };
  });

  registerMfaRoutes(app, db);
  registerAutomationRoutes(app, db);
  registerPublicRoutes(app, db);
  registerRentalRoutes(app, db, opts.fetchImpl);
  registerPortalRoutes(app, db);
  registerDocumentRoutes(app, db);
  registerPaymentRoutes(app, db, opts.fetchImpl);

  return app;
}
