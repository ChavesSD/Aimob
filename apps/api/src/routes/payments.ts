import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { scoped } from '../db/client.js';
import { audit } from '../audit.js';
import { guard } from '../guard.js';
import { today } from '../domain/rentalService.js';
import { AsaasProvider } from '../payments/asaas.js';
import { GatewayError } from '../payments/provider.js';
import {
  getProvider, issueCharge, providerTuning, persistEvent, processEvent, regenerateWebhookToken, retryPendingEvents, saveAccount, verifyWebhookToken,
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

export function registerPaymentRoutes(app: FastifyInstance, db: Db, fetchImpl?: typeof fetch) {
  // ---- Conta do provedor ----
  app.get('/api/payments/account', { preHandler: guard('finance', 'admin') }, async (req) => {
    const [a] = await scoped(db, req.session!.tid).rows<{ environment: string }>(`SELECT environment FROM payment_accounts WHERE tenant_id = $1`);
    return { connected: !!a, provider: 'asaas', environment: a?.environment ?? null, webhookUrl: webhookUrl(req.session!.tid), publicUrlConfigured: !!process.env.PUBLIC_API_URL };
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

  // ---- Webhook do Asaas (público; autenticado pelo token do header asaas-access-token) ----
  app.post('/api/webhooks/asaas/:tenantId', { config: { public: true, rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const tid = uuid.safeParse((req.params as any).tenantId);
    const token = String(req.headers['asaas-access-token'] ?? '');
    // Mesma resposta para imobiliária inexistente e token errado: não revela quais imobiliárias existem.
    if (!tid.success || !token || !(await verifyWebhookToken(db, tid.data, token))) return reply.code(401).send({ error: 'Não autorizado.' });
    const ev = z.object({
      id: z.string().min(1).max(200), event: z.string().min(1).max(80),
      payment: z.object({ id: z.string().max(100).optional(), value: z.number().optional(), status: z.string().max(40).optional(),
        paymentDate: z.string().max(20).nullable().optional(), externalReference: z.string().max(100).nullable().optional() }).passthrough().optional(),
    }).passthrough().parse(req.body);
    // Persistir antes de responder 200 (entrega "ao menos uma vez"): se o processamento falhar, o evento fica salvo e é reprocessado.
    const rowId = await persistEvent(db, tid.data, ev, req.body);
    if (!rowId) return { ok: true, duplicate: true };
    await processEvent(db, tid.data, rowId);
    return { ok: true };
  });
}
