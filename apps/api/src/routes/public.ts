import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { PAINS, buildDiagnosis } from '../domain/diagnosis.js';

const utm = z.object({
  source: z.string().max(80).optional(), medium: z.string().max(80).optional(), campaign: z.string().max(120).optional(),
  term: z.string().max(120).optional(), content: z.string().max(120).optional(),
}).default({});

const diagnosticSchema = z.object({
  name: z.string().trim().min(2).max(120),
  company: z.string().trim().min(2).max(160),
  phone: z.string().transform((v) => v.replace(/\D/g, '')).refine((v) => v.length >= 10 && v.length <= 13, 'Telefone inválido'),
  email: z.string().trim().email().max(160),
  brokers: z.enum(['1-5', '6-15', '16-50', '51+']).optional(),
  properties: z.enum(['0-50', '51-200', '201-1000', '1000+']).optional(),
  sells: z.boolean().default(false),
  rents: z.boolean().default(false),
  currentSystem: z.string().trim().max(120).optional(),
  pains: z.array(z.enum(PAINS)).max(8).default([]),
  consent: z.literal(true, { message: 'É necessário aceitar o tratamento dos dados para receber o diagnóstico.' }),
  website: z.string().max(200).optional(), // honeypot: humanos não preenchem
  utm, page: z.string().max(200).optional(), device: z.enum(['mobile', 'tablet', 'desktop']).optional(),
});

const eventSchema = z.object({
  sessionId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  event: z.enum(['pageview', 'cta_click', 'scroll_50', 'scroll_90', 'form_start', 'form_submit', 'form_abandon', 'demo_view']),
  detail: z.string().max(120).optional(), utm, page: z.string().max(200).optional(),
  device: z.enum(['mobile', 'tablet', 'desktop']).optional(),
});

/** IP nunca é guardado em claro: hash com sal do ambiente, só para detectar abuso. */
const ipHash = (ip: string) => createHash('sha256').update(`${process.env.IP_HASH_SALT ?? 'dev-salt'}:${ip}`).digest('hex').slice(0, 32);

export function registerPublicRoutes(app: FastifyInstance, db: Db) {
  // Leitura dos diagnósticos captados pela landing. Não é uma rota de tenant: exige o token de plataforma
  // (PLATFORM_ADMIN_TOKEN, mínimo 24 caracteres). Sem o token configurado a rota fica desligada.
  app.get('/api/platform/diagnosticos', { config: { public: true, rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const expected = process.env.PLATFORM_ADMIN_TOKEN ?? '';
    const given = String(req.headers['x-platform-token'] ?? '');
    const a = createHash('sha256').update(expected).digest();
    const b = createHash('sha256').update(given).digest();
    if (expected.length < 24 || !timingSafeEqual(a, b)) return reply.code(404).send({ error: 'Não encontrado.' });
    const { rows } = await db.query(
      `SELECT id, name, company, phone, email, brokers, properties, sells, rents, current_system, pains, diagnosis, utm, page, device, created_at
         FROM diagnostics ORDER BY created_at DESC LIMIT 200`);
    return { items: rows };
  });

  app.post('/api/public/diagnostico', { config: { public: true, rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req, reply) => {
    const b = diagnosticSchema.parse(req.body);
    if (b.website) return { ok: true }; // bot: responde sucesso sem gravar
    const diagnosis = buildDiagnosis(b.pains, { sells: b.sells, rents: b.rents });
    await db.query(
      `INSERT INTO diagnostics (name, company, phone, email, brokers, properties, sells, rents, current_system, pains, diagnosis, consent_at, utm, page, device, ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), $12,$13,$14,$15)`,
      [b.name, b.company, b.phone, b.email.toLowerCase(), b.brokers ?? null, b.properties ?? null, b.sells, b.rents, b.currentSystem ?? null,
        JSON.stringify(b.pains), diagnosis, JSON.stringify(b.utm), b.page ?? null, b.device ?? null, ipHash(req.ip)]);
    return reply.code(201).send({ ok: true, diagnosis });
  });

  app.post('/api/public/evento', { config: { public: true, rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const e = eventSchema.parse(req.body);
    await db.query(
      `INSERT INTO landing_events (session_id, event, detail, utm, page, device) VALUES ($1,$2,$3,$4,$5,$6)`,
      [e.sessionId, e.event, e.detail ?? null, JSON.stringify(e.utm), e.page ?? null, e.device ?? null]);
    return reply.code(204).send();
  });
}
