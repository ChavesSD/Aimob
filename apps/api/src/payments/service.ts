import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client.js';
import { scoped } from '../db/client.js';
import { auditSystem } from '../audit.js';
import { decryptText, encryptText } from '../domain/crypto.js';
import { notifyUsers, staffIds } from '../domain/notify.js';
import { payCharge, today } from '../domain/rentalService.js';
import { AsaasProvider } from './asaas.js';
import { GatewayError, type PaymentProvider } from './provider.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// ---------- Conta do provedor (uma por imobiliária) ----------

export interface Account { environment: 'sandbox' | 'production'; apiKey: string }

export async function loadAccount(db: Db, tenantId: string): Promise<Account | null> {
  const [r] = await scoped(db, tenantId).rows<{ environment: 'sandbox' | 'production'; api_key_enc: string }>(
    `SELECT environment, api_key_enc FROM payment_accounts WHERE tenant_id = $1`);
  return r ? { environment: r.environment, apiKey: decryptText(r.api_key_enc) } : null;
}

/** Ajuste de comportamento do cliente HTTP; só os testes alteram (pausas entre tentativas = 0). */
export const providerTuning: { backoffMs?: number[]; timeoutMs?: number } = {};

export async function getProvider(db: Db, tenantId: string, fetchImpl?: typeof fetch): Promise<PaymentProvider | null> {
  const a = await loadAccount(db, tenantId);
  return a ? new AsaasProvider({ apiKey: a.apiKey, environment: a.environment, fetchImpl, ...providerTuning }) : null;
}

/** Token do webhook: aleatório, mostrado uma única vez; só o hash fica guardado. 40 caracteres (Asaas exige 32 a 255). */
export const newWebhookToken = () => randomBytes(30).toString('base64url');

export async function saveAccount(db: Db, tenantId: string, input: { apiKey: string; environment: 'sandbox' | 'production' }): Promise<{ webhookToken: string }> {
  const token = newWebhookToken();
  await db.query(
    `INSERT INTO payment_accounts (tenant_id, environment, api_key_enc, webhook_token_hash) VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id) DO UPDATE SET environment = $2, api_key_enc = $3, webhook_token_hash = $4, updated_at = now()`,
    [tenantId, input.environment, encryptText(input.apiKey), sha(token)]);
  return { webhookToken: token };
}

export async function regenerateWebhookToken(db: Db, tenantId: string): Promise<string | null> {
  const token = newWebhookToken();
  const rows = await scoped(db, tenantId).rows(`UPDATE payment_accounts SET webhook_token_hash = $2, updated_at = now() WHERE tenant_id = $1 RETURNING tenant_id`, [sha(token)]);
  return rows.length ? token : null;
}

export async function verifyWebhookToken(db: Db, tenantId: string, given: string): Promise<boolean> {
  const [r] = await scoped(db, tenantId).rows<{ webhook_token_hash: string }>(`SELECT webhook_token_hash FROM payment_accounts WHERE tenant_id = $1`);
  // Compara sempre, mesmo sem conta, para não revelar por tempo se a imobiliária existe.
  const expected = Buffer.from(r?.webhook_token_hash ?? sha('inexistente'));
  const actual = Buffer.from(sha(given));
  return !!r && expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ---------- Emissão ----------

export type IssueResult =
  | { ok: true; alreadyIssued: boolean }
  | { ok: false; error: 'not_found' | 'not_open' | 'document_required' | 'in_progress' };

/**
 * Emite Pix/boleto para uma cobrança. Seguro contra clique duplo e contra repetição:
 *  - reserva a cobrança no banco antes de chamar o provedor (duas requisições simultâneas não emitem duas vezes);
 *  - a reserva expira em 2 min, então uma queda no meio não trava a cobrança;
 *  - o provedor é consultado por externalReference antes de criar de novo (ver AsaasProvider).
 */
export async function issueCharge(db: Db, tenantId: string, chargeId: string, provider: PaymentProvider): Promise<IssueResult> {
  const s = scoped(db, tenantId);
  const claimed = await s.rows<any>(
    `UPDATE rental_charges SET gateway_claimed_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'open' AND (gateway_id IS NULL OR gateway_stale)
        AND (gateway_claimed_at IS NULL OR gateway_claimed_at < now() - interval '2 minutes')
      RETURNING gateway_id`, [chargeId]);
  if (!claimed.length) {
    const [c] = await s.rows<any>(`SELECT status, gateway_id, gateway_stale, gateway_claimed_at FROM rental_charges WHERE tenant_id = $1 AND id = $2`, [chargeId]);
    if (!c) return { ok: false, error: 'not_found' };
    if (c.status !== 'open') return { ok: false, error: 'not_open' };
    if (c.gateway_id && !c.gateway_stale) return { ok: true, alreadyIssued: true };
    return { ok: false, error: 'in_progress' };
  }
  const release = () => s.rows(`UPDATE rental_charges SET gateway_claimed_at = NULL WHERE tenant_id = $1 AND id = $2 RETURNING id`, [chargeId]);
  try {
    const [ch] = await s.rows<any>(
      `SELECT ch.amount_cents, ch.competence, to_char(ch.due_date,'YYYY-MM-DD') due_date, c.late_fee_bps, c.interest_bps_month,
              r.id renter_id, r.name renter_name, r.email renter_email, r.phone renter_phone, r.document_enc, r.gateway_customer_id, p.title property_title
         FROM rental_charges ch JOIN rental_contracts c ON c.id = ch.contract_id AND c.tenant_id = ch.tenant_id
         JOIN contacts r ON r.id = c.renter_id AND r.tenant_id = ch.tenant_id JOIN properties p ON p.id = c.property_id AND p.tenant_id = ch.tenant_id
        WHERE ch.tenant_id = $1 AND ch.id = $2`, [chargeId]);
    if (!ch.document_enc) { await release(); return { ok: false, error: 'document_required' }; }

    // Cobrança reemitida (valor mudou depois do reajuste): cancela a antiga no provedor antes de criar a nova.
    const oldId = claimed[0].gateway_id as string | null;
    if (oldId) {
      try { await provider.cancelPayment(oldId); }
      catch (e) { if (!(e instanceof GatewayError) || e.code !== 'validation') throw e; /* já cancelada/inexistente */ }
    }

    let customerId: string | null = ch.gateway_customer_id;
    if (!customerId) {
      customerId = (await provider.ensureCustomer({
        name: ch.renter_name, document: decryptText(ch.document_enc), email: ch.renter_email ?? undefined,
        phone: ch.renter_phone ?? undefined, externalReference: ch.renter_id,
      })).id;
      await s.rows(`UPDATE contacts SET gateway_customer_id = $2 WHERE tenant_id = $1 AND id = $3 RETURNING id`, [customerId, ch.renter_id]);
    }

    const pay = await provider.createPayment({
      customerId, valueCents: Number(ch.amount_cents), dueDate: ch.due_date, externalReference: chargeId,
      description: `Aluguel ${ch.competence} - ${ch.property_title}`.slice(0, 200), fineBps: ch.late_fee_bps, interestBpsMonth: ch.interest_bps_month,
    });
    const pix = await provider.getPixQr(pay.id).catch(() => null); // Pix é opcional: não derruba a emissão
    await s.rows(
      `UPDATE rental_charges SET gateway_id = $2, gateway_status = $3, gateway_url = $4, gateway_boleto_url = $5, gateway_pix_payload = $6,
              gateway_stale = false, gateway_claimed_at = NULL, reconciliation = NULL
        WHERE tenant_id = $1 AND id = $7 RETURNING id`,
      [pay.id, pay.status, pay.invoiceUrl ?? null, pay.bankSlipUrl ?? null, pix?.payload ?? null, chargeId]);
    return { ok: true, alreadyIssued: false };
  } catch (e) {
    await release().catch(() => undefined);
    throw e;
  }
}

/** Cancela no provedor as cobranças emitidas que deixaram de valer (contrato encerrado). Melhor esforço, com aviso em caso de falha. */
export async function cancelGatewayPayments(db: Db, tenantId: string, chargeIds: string[], provider: PaymentProvider | null) {
  if (!chargeIds.length) return { cancelled: 0, failed: 0 };
  const s = scoped(db, tenantId);
  const rows = await s.rows<{ id: string; gateway_id: string }>(
    `SELECT id, gateway_id FROM rental_charges WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND gateway_id IS NOT NULL`, [chargeIds]);
  let cancelled = 0, failed = 0;
  for (const r of rows) {
    try {
      if (!provider) throw new GatewayError('unavailable', 'Sem conta de pagamentos conectada.');
      await provider.cancelPayment(r.gateway_id);
      await s.rows(`UPDATE rental_charges SET gateway_status = 'CANCELED' WHERE tenant_id = $1 AND id = $2 RETURNING id`, [r.id]);
      cancelled++;
    } catch {
      failed++;
      await s.rows(`UPDATE rental_charges SET gateway_status = 'cancel_failed' WHERE tenant_id = $1 AND id = $2 RETURNING id`, [r.id]);
    }
  }
  if (failed) await notifyUsers(db, tenantId, await staffIds(db, tenantId), `${failed} cobrança(s) emitida(s) não puderam ser canceladas no provedor de pagamentos. Cancele manualmente para o inquilino não pagar um boleto inválido.`, '/locacao?aba=cobrancas');
  return { cancelled, failed };
}

// ---------- Webhooks ----------

export interface IncomingEvent { id: string; event: string; payment?: { id?: string; value?: number; status?: string; paymentDate?: string | null; externalReference?: string | null } }

/** Grava o evento (idempotente pelo id do provedor). Retorna o id interno, ou null se já havia sido recebido. */
export async function persistEvent(db: Db, tenantId: string, ev: IncomingEvent, raw: unknown): Promise<string | null> {
  const r = await scoped(db, tenantId).rows<{ id: string }>(
    `INSERT INTO payment_events (tenant_id, provider, event_id, event, payment_id, payload) VALUES ($1,'asaas',$2,$3,$4,$5)
     ON CONFLICT (tenant_id, provider, event_id) DO NOTHING RETURNING id`,
    [ev.id, ev.event, ev.payment?.id ?? null, JSON.stringify(raw)]);
  return r[0]?.id ?? null;
}

type Outcome = { status: 'processed' | 'ignored' | 'needs_review'; detail: string };

/**
 * Processa um evento já gravado. Política conservadora com dinheiro:
 *  - só PAYMENT_RECEIVED (dinheiro de fato recebido) dá baixa; PAYMENT_CONFIRMED sozinho não;
 *  - se o valor do provedor difere do valor da cobrança no sistema, NÃO dá baixa: manda para revisão;
 *  - evento de uma cobrança já baixada (manual ou anterior) nunca baixa de novo e avisa possível pagamento em duplicidade.
 */
export async function processEvent(db: Db, tenantId: string, eventRowId: string): Promise<string> {
  const s = scoped(db, tenantId);
  const [row] = await s.rows<{ payload: IncomingEvent; status: string }>(`SELECT payload, status FROM payment_events WHERE tenant_id = $1 AND id = $2`, [eventRowId]);
  if (!row) return 'missing';
  if (row.status === 'processed' || row.status === 'ignored') return row.status;
  await s.rows(`UPDATE payment_events SET attempts = attempts + 1 WHERE tenant_id = $1 AND id = $2 RETURNING id`, [eventRowId]);

  let out: Outcome;
  try { out = await apply(db, tenantId, row.payload); }
  catch (e: any) {
    await s.rows(`UPDATE payment_events SET status = 'failed', detail = $2 WHERE tenant_id = $1 AND id = $3 RETURNING id`, [String(e?.message ?? e).slice(0, 300), eventRowId]);
    return 'failed';
  }
  await s.rows(`UPDATE payment_events SET status = $2, detail = $3, processed_at = now() WHERE tenant_id = $1 AND id = $4 RETURNING id`, [out.status, out.detail, eventRowId]);
  return out.status;
}

async function apply(db: Db, tenantId: string, ev: IncomingEvent): Promise<Outcome> {
  const s = scoped(db, tenantId);
  const p = ev.payment;
  if (!p?.id) return { status: 'ignored', detail: 'evento sem cobrança' };
  let [ch] = await s.rows<any>(`SELECT id, status, amount_cents, gateway_id FROM rental_charges WHERE tenant_id = $1 AND gateway_id = $2`, [p.id]);
  if (!ch && p.externalReference) {
    // Corrida rara: o webhook chegou antes de gravarmos o id do provedor. A referência externa é o id da cobrança.
    [ch] = await s.rows<any>(`SELECT id, status, amount_cents, gateway_id FROM rental_charges WHERE tenant_id = $1 AND id::text = $2`, [p.externalReference]).catch(() => []);
  }
  if (!ch) return { status: 'ignored', detail: 'cobrança não encontrada nesta imobiliária' };
  const staff = () => staffIds(db, tenantId);
  const link = '/locacao?aba=cobrancas';

  switch (ev.event) {
    case 'PAYMENT_RECEIVED': {
      if (ch.status !== 'open') {
        await notifyUsers(db, tenantId, await staff(), 'Pagamento recebido no provedor para uma cobrança que já estava baixada: possível pagamento em duplicidade. Confira e, se necessário, estorne.', link);
        return { status: 'needs_review', detail: 'cobrança já baixada; possível pagamento em duplicidade' };
      }
      const gatewayCents = Math.round(Number(p.value) * 100);
      if (!Number.isFinite(gatewayCents) || gatewayCents !== Number(ch.amount_cents)) {
        await s.rows(`UPDATE rental_charges SET reconciliation = 'divergent', gateway_status = 'RECEIVED' WHERE tenant_id = $1 AND id = $2 RETURNING id`, [ch.id]);
        await notifyUsers(db, tenantId, await staff(), `Pagamento recebido com valor diferente do cobrado (${Number.isFinite(gatewayCents) ? brl(gatewayCents) : 'valor ausente'} no provedor, ${brl(Number(ch.amount_cents))} no sistema). Confira antes de dar baixa.`, link);
        return { status: 'needs_review', detail: `valor divergente: provedor ${gatewayCents}, sistema ${ch.amount_cents}` };
      }
      const now = await today(db);
      const paidOn = p.paymentDate && /^\d{4}-\d{2}-\d{2}$/.test(p.paymentDate) ? (p.paymentDate > now ? now : p.paymentDate) : now;
      const r = await payCharge(db, tenantId, ch.id, { paidOn });
      if (!r.ok) return { status: 'ignored', detail: `baixa não aplicada: ${r.error}` };
      await s.rows(`UPDATE rental_charges SET gateway_status = 'RECEIVED', reconciliation = 'ok' WHERE tenant_id = $1 AND id = $2 RETURNING id`, [ch.id]);
      await auditSystem(db, tenantId, { action: 'charge.pay', resource: 'charge', resourceId: ch.id, after: r,
        summary: `Cobrança baixada automaticamente pelo provedor de pagamentos: ${brl(r.totalCents)} recebidos${r.daysLate ? ` (${r.daysLate} dia(s) de atraso)` : ''}` });
      return { status: 'processed', detail: `baixa automática de ${brl(r.totalCents)}` };
    }
    case 'PAYMENT_OVERDUE': case 'PAYMENT_CONFIRMED': case 'PAYMENT_UPDATED': case 'PAYMENT_CREATED': {
      await s.rows(`UPDATE rental_charges SET gateway_status = $2 WHERE tenant_id = $1 AND id = $3 AND status = 'open' RETURNING id`, [p.status ?? ev.event, ch.id]);
      return { status: 'processed', detail: `status do provedor: ${p.status ?? ev.event}` };
    }
    case 'PAYMENT_DELETED': case 'PAYMENT_REFUNDED': case 'PAYMENT_PARTIALLY_REFUNDED': case 'PAYMENT_CHARGEBACK_REQUESTED': case 'PAYMENT_CHARGEBACK_DISPUTE': {
      await s.rows(`UPDATE rental_charges SET gateway_status = $2 WHERE tenant_id = $1 AND id = $3 RETURNING id`, [p.status ?? ev.event, ch.id]);
      await notifyUsers(db, tenantId, await staff(), `O provedor de pagamentos informou ${ev.event.replace('PAYMENT_', '').toLowerCase().replace(/_/g, ' ')} em uma cobrança. Revise a cobrança e o repasse.`, link);
      return { status: 'needs_review', detail: ev.event };
    }
    default:
      return { status: 'ignored', detail: `evento não tratado: ${ev.event}` };
  }
}

/** Reprocessa eventos gravados que ainda não foram concluídos (falhas transitórias). Chamado por rotina e por rota manual. */
export async function retryPendingEvents(db: Db, tenantId?: string): Promise<number> {
  const { rows } = await db.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM payment_events WHERE status IN ('pending','failed') AND attempts < 10 ${tenantId ? 'AND tenant_id = $1' : ''} ORDER BY received_at LIMIT 200`,
    tenantId ? [tenantId] : []);
  for (const e of rows) await processEvent(db, e.tenant_id, e.id);
  return rows.length;
}
