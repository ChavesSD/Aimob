import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client.js';
import { scoped } from '../db/client.js';
import { auditSystem } from '../audit.js';
import { decryptText, encryptText } from '../domain/crypto.js';
import { notifyUsers, staffIds } from '../domain/notify.js';
import { payCharge, today } from '../domain/rentalService.js';
import { platformAsaas } from '../config.js';
import { normalizeDocument } from '../domain/document.js';
import { AsaasProvider } from './asaas.js';
import { GatewayError, type PaymentProvider } from './provider.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// ---------- Conta do provedor (uma por imobiliária) ----------

/**
 * Referência externa das cobranças do Aimob no Asaas. O prefixo identifica a origem quando a conta Asaas é compartilhada
 * com outros sistemas (o Aidate só age em referências com prefixos próprios e ignora as demais).
 */
export const REF_PREFIX = 'aimob_charge_';
export const refOf = (chargeId: string) => `${REF_PREFIX}${chargeId}`;
export function chargeIdFromRef(ref?: string | null): string | null {
  if (!ref || !ref.startsWith(REF_PREFIX)) return null;
  const id = ref.slice(REF_PREFIX.length);
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

/** Ajuste de comportamento do cliente HTTP; só os testes alteram (pausas entre tentativas = 0). */
export const providerTuning: { backoffMs?: number[]; timeoutMs?: number } = {};

/**
 * Cliente da conta de recebimento da imobiliária. Dois modos:
 *  - platform_split (padrão, como no Aidate): usa a conta principal da plataforma e cobra com split para a subconta;
 *  - own_key: a imobiliária informa a própria chave de API do Asaas.
 */
export async function getProvider(db: Db, tenantId: string, fetchImpl?: typeof fetch): Promise<PaymentProvider | null> {
  const [a] = await scoped(db, tenantId).rows<any>(`SELECT mode, status, environment, api_key_enc, wallet_id FROM payment_accounts WHERE tenant_id = $1`);
  if (!a || a.status !== 'active') return null;
  const plat = platformAsaas();
  if (a.mode === 'platform_split') {
    if (!plat || !a.wallet_id) return null;
    return new AsaasProvider({ apiKey: plat.apiKey, environment: 'production', baseUrl: plat.baseUrl, userAgent: plat.userAgent, splitWalletId: a.wallet_id, fetchImpl, ...providerTuning });
  }
  if (!a.api_key_enc) return null;
  return new AsaasProvider({ apiKey: decryptText(a.api_key_enc), environment: a.environment, userAgent: plat?.userAgent, fetchImpl, ...providerTuning });
}

/** Token do webhook: aleatório, mostrado uma única vez; só o hash fica guardado. 40 caracteres (Asaas exige 32 a 255). */
export const newWebhookToken = () => randomBytes(30).toString('base64url');

export async function saveAccount(db: Db, tenantId: string, input: { apiKey: string; environment: 'sandbox' | 'production' }): Promise<{ webhookToken: string }> {
  const token = newWebhookToken();
  await db.query(
    `INSERT INTO payment_accounts (tenant_id, mode, status, environment, api_key_enc, webhook_token_hash) VALUES ($1,'own_key','active',$2,$3,$4)
     ON CONFLICT (tenant_id) DO UPDATE SET mode = 'own_key', status = 'active', environment = $2, api_key_enc = $3, webhook_token_hash = $4,
       wallet_id = NULL, gateway_account_id = NULL, updated_at = now()`,
    [tenantId, input.environment, encryptText(input.apiKey), sha(token)]);
  return { webhookToken: token };
}

export async function regenerateWebhookToken(db: Db, tenantId: string): Promise<string | null> {
  const token = newWebhookToken();
  const rows = await scoped(db, tenantId).rows(`UPDATE payment_accounts SET webhook_token_hash = $2, updated_at = now() WHERE tenant_id = $1 AND mode = 'own_key' RETURNING tenant_id`, [sha(token)]);
  return rows.length ? token : null;
}

export async function verifyWebhookToken(db: Db, tenantId: string, given: string): Promise<boolean> {
  const [r] = await scoped(db, tenantId).rows<{ webhook_token_hash: string }>(`SELECT webhook_token_hash FROM payment_accounts WHERE tenant_id = $1 AND mode = 'own_key' AND webhook_token_hash IS NOT NULL`);
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
      customerId, valueCents: Number(ch.amount_cents), dueDate: ch.due_date, externalReference: refOf(chargeId),
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

// ---------- Dados da empresa e conta de recebimento (subconta) ----------

export interface CompanyInput {
  name: string; document: string; email: string; phone?: string; birthDate?: string; monthlyRevenueCents: number;
  street?: string; number?: string; complement?: string; neighborhood?: string; cep?: string;
}

export async function saveCompany(db: Db, tenantId: string, c: CompanyInput) {
  await db.query(
    `INSERT INTO tenant_company (tenant_id, name, document_enc, document_last2, email, phone, birth_date, monthly_revenue_cents, street, number, complement, neighborhood, cep)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (tenant_id) DO UPDATE SET name=$2, document_enc=$3, document_last2=$4, email=$5, phone=$6, birth_date=$7, monthly_revenue_cents=$8,
       street=$9, number=$10, complement=$11, neighborhood=$12, cep=$13, updated_at = now()`,
    [tenantId, c.name, encryptText(c.document), c.document.slice(-2), c.email, c.phone ?? null, c.birthDate ?? null, c.monthlyRevenueCents,
      c.street ?? null, c.number ?? null, c.complement ?? null, c.neighborhood ?? null, c.cep ?? null]);
}

export async function loadCompany(db: Db, tenantId: string): Promise<(CompanyInput & { documentLast2: string }) | null> {
  const [r] = await scoped(db, tenantId).rows<any>(
    `SELECT name, document_enc, document_last2, email, phone, to_char(birth_date,'YYYY-MM-DD') birth_date, monthly_revenue_cents, street, number, complement, neighborhood, cep
       FROM tenant_company WHERE tenant_id = $1`);
  if (!r) return null;
  return { name: r.name, document: decryptText(r.document_enc), documentLast2: r.document_last2, email: r.email, phone: r.phone ?? undefined, birthDate: r.birth_date ?? undefined,
    monthlyRevenueCents: Number(r.monthly_revenue_cents), street: r.street ?? undefined, number: r.number ?? undefined, complement: r.complement ?? undefined,
    neighborhood: r.neighborhood ?? undefined, cep: r.cep ?? undefined };
}

/** Mesmas exigências do Aidate para criar a subconta: CPF/CNPJ, e-mail, faturamento mensal e, para CPF, data de nascimento. */
export function companyMissing(c: CompanyInput | null): string[] {
  if (!c) return ['dados da empresa'];
  const m: string[] = [];
  if (!c.name?.trim()) m.push('nome da empresa');
  if (!normalizeDocument(c.document)) m.push('CPF ou CNPJ válido');
  if (!c.email?.trim()) m.push('e-mail');
  if (!(c.monthlyRevenueCents > 0)) m.push('faturamento mensal');
  if (c.document.replace(/\D/g, '').length === 11 && !c.birthDate) m.push('data de nascimento (obrigatória para CPF)');
  return m;
}

export type ProvisionResult =
  | { ok: true; walletId: string }
  | { ok: false; error: 'platform_unavailable' | 'already_connected' | 'in_progress' }
  | { ok: false; error: 'company_missing'; missing: string[] };

/**
 * Cria a subconta da imobiliária no Asaas (chave principal da plataforma) e guarda a carteira para o split.
 * Criar conta é irreversível e o provedor não tem chave de idempotência: por isso a reserva no banco
 * (uma só criação por imobiliária; duas requisições simultâneas não criam duas contas) e nenhuma repetição automática.
 */
export async function provisionAccount(db: Db, tenantId: string, fetchImpl?: typeof fetch): Promise<ProvisionResult> {
  const plat = platformAsaas();
  if (!plat) return { ok: false, error: 'platform_unavailable' };
  const company = await loadCompany(db, tenantId);
  const missing = companyMissing(company);
  if (missing.length) return { ok: false, error: 'company_missing', missing };

  const env = /sandbox/i.test(plat.baseUrl) ? 'sandbox' : 'production';
  const claimed = await db.query(
    `INSERT INTO payment_accounts (tenant_id, mode, status, environment) VALUES ($1,'platform_split','provisioning',$2)
     ON CONFLICT (tenant_id) DO UPDATE SET updated_at = now()
       WHERE payment_accounts.mode = 'platform_split' AND payment_accounts.status = 'provisioning' AND payment_accounts.updated_at < now() - interval '5 minutes'
     RETURNING tenant_id`, [tenantId, env]);
  if (!claimed.rows.length) {
    const [cur] = await scoped(db, tenantId).rows<{ status: string }>(`SELECT status FROM payment_accounts WHERE tenant_id = $1`);
    return { ok: false, error: cur?.status === 'provisioning' ? 'in_progress' : 'already_connected' };
  }
  try {
    const c = company!;
    const sub = await new AsaasProvider({ apiKey: plat.apiKey, environment: env, baseUrl: plat.baseUrl, userAgent: plat.userAgent, fetchImpl, ...providerTuning })
      .createSubAccount({ name: c.name, email: c.email, document: normalizeDocument(c.document)!, birthDate: c.birthDate, monthlyRevenueCents: c.monthlyRevenueCents,
        phone: c.phone?.replace(/\D/g, ''), street: c.street, number: c.number, complement: c.complement, neighborhood: c.neighborhood, cep: c.cep?.replace(/\D/g, '') });
    await scoped(db, tenantId).rows(
      `UPDATE payment_accounts SET status = 'active', wallet_id = $2, gateway_account_id = $3, api_key_enc = $4, updated_at = now() WHERE tenant_id = $1 RETURNING tenant_id`,
      [sub.walletId, sub.id, sub.apiKey ? encryptText(sub.apiKey) : null]);
    return { ok: true, walletId: sub.walletId };
  } catch (e) {
    // Libera a reserva para uma nova tentativa (a conta não foi criada, ou o erro foi definitivo).
    await scoped(db, tenantId).rows(`DELETE FROM payment_accounts WHERE tenant_id = $1 AND status = 'provisioning' RETURNING tenant_id`).catch(() => undefined);
    throw e;
  }
}

/**
 * Descobre a imobiliária dona de um evento do webhook GLOBAL (conta compartilhada). Consulta transversal de propósito:
 * é a única forma de saber de quem é o pagamento. Eventos de outros sistemas (ex.: Aidate) não casam e são ignorados.
 */
export async function tenantForEvent(db: Db, ev: IncomingEvent): Promise<string | null> {
  const p = ev.payment;
  if (!p?.id) return null;
  const byId = await db.query<{ tenant_id: string }>(`SELECT tenant_id FROM rental_charges WHERE gateway_id = $1 LIMIT 2`, [p.id]);
  if (byId.rows.length === 1) return byId.rows[0].tenant_id;
  const ref = chargeIdFromRef(p.externalReference);
  if (!ref) return null;
  const byRef = await db.query<{ tenant_id: string }>(`SELECT tenant_id FROM rental_charges WHERE id::text = $1`, [ref]);
  return byRef.rows[0]?.tenant_id ?? null;
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
  const fromRef = chargeIdFromRef(p.externalReference);
  if (!ch && fromRef) {
    // Corrida rara: o webhook chegou antes de gravarmos o id do provedor. A referência externa carrega o id da cobrança.
    [ch] = await s.rows<any>(`SELECT id, status, amount_cents, gateway_id FROM rental_charges WHERE tenant_id = $1 AND id::text = $2`, [fromRef]);
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
