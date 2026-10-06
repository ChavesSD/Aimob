import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { scoped } from '../db/client.js';
import { audit } from '../audit.js';
import { guard } from '../guard.js';
import { platformAsaas } from '../config.js';
import { normalizeDocument, maskDocument } from '../domain/document.js';
import { today } from '../domain/rentalService.js';
import { AsaasProvider } from '../payments/asaas.js';
import { GatewayError } from '../payments/provider.js';
import {
  companyMissing, getProvider, issueCharge, loadCompany, persistEvent, processEvent, provisionAccount, providerTuning, regenerateWebhookToken,
  retryPendingEvents, saveAccount, saveCompany, tenantForEvent, verifyWebhookToken, type IncomingEvent,
} from '../payments/service.js';

const uuid = z.string().uuid();

function gatewayReply(reply: FastifyReply, e: unknown) {
  if (!(e instanceof GatewayError)) throw e;
  const status = e.code === 'auth' ? 502 : e.code === 'validation' ? 422 : 503;
  return reply.code(status).send({ error: e.message, code: e.code });
}

const issueErrors = {
  not_found: [404, 'Cobrança não encontrada.'],
  not_open: [409, 'Só é possível emitir pagamento para cobranças em aberto.'],
  document_required: [422, 'Cadastre o CPF ou CNPJ do inquilino antes de emitir o pagamento.'],
  in_progress: [409, 'Já existe uma emissão em andamento para esta cobrança. Aguarde alguns instantes.'],
} as const;

const webhookUrl = (tenantId: string) => `${process.env.PUBLIC_API_URL ?? ''}/api/webhooks/asaas/${tenantId}`;

const eventSchema = z.object({
  id: z.string().min(1).max(200), event: z.string().min(1).max(80),
  payment: z.object({ id: z.string().max(100).optional(), value: z.number().optional(), status: z.string().max(40).optional(),
    paymentDate: z.string().max(20).nullable().optional(), externalReference: z.string().max(100).nullable().optional() }).passthrough().optional(),
}).passthrough();

export function registerPaymentRoutes(app: FastifyInstance, db: Db, fetchImpl?: typeof fetch) {
  // ---- Conta do provedor ----
  app.get('/api/payments/account', { preHandler: guard('finance', 'admin') }, async (req) => {
    const tid = req.session!.tid;
    const [a] = await scoped(db, tid).rows<{ mode: string; status: string; environment: string }>(`SELECT mode, status, environment FROM payment_accounts WHERE tenant_id = $1`);
    const company = await loadCompany(db, tid);
    return {
      connected: a?.status === 'active', provisioning: a?.status === 'provisioning', mode: a?.mode ?? null, environment: a?.environment ?? null,
      platformAvailable: !!platformAsaas(),
      company: company ? { name: company.name, documentMask: maskDocument(company.documentLast2), email: company.email } : null,
      companyMissing: companyMissing(company),
      // O webhook por imobiliária só existe no modo "chave própria"; no modo plataforma o webhook é global e não aparece aqui.
      webhookUrl: a?.mode === 'own_key' ? webhookUrl(tid) : null, publicUrlConfigured: !!process.env.PUBLIC_API_URL,
    };
  });

  // ---- Dados da empresa (necessários para criar a subconta) ----
  app.put('/api/payments/company', { preHandler: guard('finance', 'admin') }, async (req, reply) => {
    const b = z.object({
      name: z.string().trim().min(2).max(160), document: z.string().transform((v, ctx) => { const d = normalizeDocument(v); if (!d) ctx.addIssue({ code: 'custom', message: 'CPF ou CNPJ inválido.' }); return d as string; }),
      email: z.string().trim().email().max(160), phone: z.string().max(30).optional(),
      birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      monthlyRevenueCents: z.number().int().positive().max(100_000_000_00),
      street: z.string().max(160).optional(), number: z.string().max(20).optional(), complement: z.string().max(80).optional(),
      neighborhood: z.string().max(100).optional(), cep: z.string().max(12).optional(),
    }).parse(req.body);
    await saveCompany(db, req.session!.tid, b);
    await audit(db, req, { action: 'payments.company', resource: 'tenant_company', summary: 'Dados da empresa para a conta de recebimento atualizados' }); // sem CPF/CNPJ no log
    return { ok: true, missing: companyMissing(await loadCompany(db, req.session!.tid)) };
  });

  // ---- Criação da subconta (modo plataforma, como no Aidate) ----
  app.post('/api/payments/account/provision', { preHandler: guard('finance', 'admin'), config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const r = await provisionAccount(db, req.session!.tid, fetchImpl);
      if (!r.ok) {
        if (r.error === 'platform_unavailable') return reply.code(409).send({ error: 'A conta principal de pagamentos da plataforma não está configurada. Fale com o suporte.' });
        if (r.error === 'company_missing') return reply.code(422).send({ error: `Complete os dados da empresa: ${r.missing.join(', ')}.`, missing: r.missing });
        if (r.error === 'in_progress') return reply.code(409).send({ error: 'A criação da conta de recebimento já está em andamento. Aguarde alguns instantes.' });
        return reply.code(409).send({ error: 'Esta imobiliária já tem conta de recebimento conectada.' });
      }
      await audit(db, req, { action: 'payments.provision', resource: 'payment_account', summary: 'Conta de recebimento (subconta) criada' });
      return { ok: true };
    } catch (e) { return gatewayReply(reply, e); }
  });

  app.put('/api/payments/account', { preHandler: guard('finance', 'admin'), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ environment: z.enum(['sandbox', 'production']), apiKey: z.string().trim().min(20).max(300) }).parse(req.body);
    try { await new AsaasProvider({ apiKey: b.apiKey, environment: b.environment, fetchImpl, ...providerTuning }).testConnection(); }
    catch (e) { return gatewayReply(reply, e); }
    const { webhookToken } = await saveAccount(db, req.session!.tid, b);
    // A chave nunca entra na auditoria nem volta nas respostas.
    await audit(db, req, { action: 'payments.connect', resource: 'payment_account', after: { environment: b.environment }, summary: `Conta de pagamentos conectada (${b.environment})` });
    return { ok: true, webhookUrl: webhookUrl(req.session!.tid), webhookToken };
  });

  app.post('/api/payments/account/webhook-token', { preHandler: guard('finance', 'admin') }, async (req, reply) => {
    const token = await regenerateWebhookToken(db, req.session!.tid);
    if (!token) return reply.code(404).send({ error: 'Conecte a conta de pagamentos primeiro.' });
    await audit(db, req, { action: 'payments.webhook_token', resource: 'payment_account', summary: 'Token do webhook de pagamentos regenerado' });
    return { webhookUrl: webhookUrl(req.session!.tid), webhookToken: token };
  });

  app.delete('/api/payments/account', { preHandler: guard('finance', 'admin') }, async (req, reply) => {
    const rows = await scoped(db, req.session!.tid).rows(`DELETE FROM payment_accounts WHERE tenant_id = $1 RETURNING tenant_id`);
    if (!rows.length) return reply.code(404).send({ error: 'Nenhuma conta de pagamentos conectada.' });
    await audit(db, req, { action: 'payments.disconnect', resource: 'payment_account', summary: 'Conta de pagamentos desconectada' });
    return { ok: true };
  });

  // ---- Emissão ----
  app.post('/api/charges/:id/issue', { preHandler: guard('finance', 'edit') }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const provider = await getProvider(db, req.session!.tid, fetchImpl);
    if (!provider) return reply.code(409).send({ error: 'Conecte a conta de pagamentos antes de emitir Pix ou boleto.' });
    try {
      const r = await issueCharge(db, req.session!.tid, id, provider);
      if (!r.ok) return reply.code(issueErrors[r.error][0]).send({ error: issueErrors[r.error][1] });
      if (!r.alreadyIssued) await audit(db, req, { action: 'charge.issue', resource: 'charge', resourceId: id, summary: 'Pix/boleto emitido para a cobrança' });
      return { ok: true, alreadyIssued: r.alreadyIssued };
    } catch (e) { return gatewayReply(reply, e); }
  });

  app.post('/api/charges/issue-batch', { preHandler: guard('finance', 'edit'), config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ daysAhead: z.number().int().min(0).max(60).default(15) }).parse(req.body ?? {});
    const provider = await getProvider(db, req.session!.tid, fetchImpl);
    if (!provider) return reply.code(409).send({ error: 'Conecte a conta de pagamentos antes de emitir Pix ou boleto.' });
    const now = await today(db);
    const limit = new Date(Date.parse(`${now}T00:00:00Z`) + b.daysAhead * 86_400_000).toISOString().slice(0, 10);
    const todo = await scoped(db, req.session!.tid).rows<{ id: string }>(
      `SELECT id FROM rental_charges WHERE tenant_id = $1 AND status = 'open' AND (gateway_id IS NULL OR gateway_stale) AND due_date <= $2::date ORDER BY due_date LIMIT 100`, [limit]);
    const out = { issued: 0, skippedNoDocument: 0, inProgress: 0, failed: [] as { id: string; message: string }[], stopped: false };
    for (const c of todo) {
      try {
        const r = await issueCharge(db, req.session!.tid, c.id, provider);
        if (r.ok) out.issued += r.alreadyIssued ? 0 : 1;
        else if (r.error === 'document_required') out.skippedNoDocument++;
        else if (r.error === 'in_progress') out.inProgress++;
      } catch (e) {
        if (!(e instanceof GatewayError)) throw e;
        out.failed.push({ id: c.id, message: e.message });
        if (e.code === 'auth') { out.stopped = true; break; } // chave inválida: insistir só gera erro em cadeia
      }
    }
    await audit(db, req, { action: 'charge.issue_batch', resource: 'charge', after: out, summary: `Emissão em lote: ${out.issued} emitida(s), ${out.skippedNoDocument} sem CPF/CNPJ, ${out.failed.length} com falha` });
    return { ...out, considered: todo.length };
  });

  // ---- Eventos ----
  app.get('/api/payments/events', { preHandler: guard('finance', 'view') }, async (req) => {
    const items = await scoped(db, req.session!.tid).rows(
      `SELECT id, event, payment_id, status, detail, attempts, received_at, processed_at FROM payment_events WHERE tenant_id = $1 ORDER BY received_at DESC LIMIT 100`);
    return { items };
  });

  app.post('/api/payments/events/retry', { preHandler: guard('finance', 'admin') }, async (req) => ({ retried: await retryPendingEvents(db, req.session!.tid) }));

  // ---- Webhook GLOBAL da plataforma (mesmo esquema do Aidate: um endereço, um token, ASAAS_WEBHOOK_TOKEN) ----
  const sha = (v: string) => createHash('sha256').update(v).digest();
  app.get('/api/webhooks/asaas', { config: { public: true } }, async () => ({ ok: true }));
  app.post('/api/webhooks/asaas', { config: { public: true, rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const expected = platformAsaas()?.webhookToken ?? '';
    const given = String(req.headers['asaas-access-token'] ?? '').trim();
    if (expected.length < 32 || !given || !timingSafeEqual(sha(expected), sha(given))) return reply.code(401).send({ error: 'Não autorizado.' });
    const ev = eventSchema.parse(req.body) as IncomingEvent;
    // A conta Asaas pode ser compartilhada com outros sistemas: evento que não é de uma cobrança do Aimob é reconhecido e descartado.
    const tid = await tenantForEvent(db, ev);
    if (!tid) return { ok: true, ignored: true };
    const rowId = await persistEvent(db, tid, ev, req.body);
    if (!rowId) return { ok: true, duplicate: true };
    await processEvent(db, tid, rowId);
    return { ok: true };
  });

  // ---- Webhook do Asaas (público; autenticado pelo token do header asaas-access-token) ----
  app.post('/api/webhooks/asaas/:tenantId', { config: { public: true, rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const tid = uuid.safeParse((req.params as any).tenantId);
    const token = String(req.headers['asaas-access-token'] ?? '');
    // Mesma resposta para imobiliária inexistente e token errado: não revela quais imobiliárias existem.
    if (!tid.success || !token || !(await verifyWebhookToken(db, tid.data, token))) return reply.code(401).send({ error: 'Não autorizado.' });
    const ev = eventSchema.parse(req.body);
    // Persistir antes de responder 200 (entrega "ao menos uma vez"): se o processamento falhar, o evento fica salvo e é reprocessado.
    const rowId = await persistEvent(db, tid.data, ev, req.body);
    if (!rowId) return { ok: true, duplicate: true };
    await processEvent(db, tid.data, rowId);
    return { ok: true };
  });
}
