import type { Db } from '../db/client.js';
import { scoped } from '../db/client.js';
import { addYearsIso, applyAdjustment, daysLate, dueDateFor, lateCharges, monthsBetween, payoutSplit } from './money.js';

export const TZ = 'America/Sao_Paulo';

/** "Hoje" no fuso da imobiliária (não no do servidor), como YYYY-MM-DD. */
export async function today(db: Db): Promise<string> {
  const { rows } = await db.query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') d`);
  return rows[0].d;
}

const nextMonth = (c: string) => {
  const [y, m] = c.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

/**
 * Gera cobranças futuras de um contrato, de forma idempotente (UNIQUE contract+competência).
 * Começa na competência seguinte à última existente, ou no mês atual/início do contrato. Nunca inventa dívida do passado.
 */
export async function generateCharges(db: Db, tenantId: string, contractId: string, monthsAhead: number): Promise<number> {
  const q = scoped(db, tenantId);
  const [c] = await q.rows<any>(
    `SELECT rent_cents, due_day, to_char(start_date,'YYYY-MM-DD') start_date, to_char(end_date,'YYYY-MM-DD') end_date, status
       FROM rental_contracts WHERE tenant_id = $1 AND id = $2`, [contractId]);
  if (!c || c.status !== 'active') return 0;
  const now = await today(db);
  const curMonth = now.slice(0, 7);
  const [last] = await q.rows<{ competence: string }>(
    `SELECT max(competence) competence FROM rental_charges WHERE tenant_id = $1 AND contract_id = $2`, [contractId]);
  const startMonth = last?.competence ? nextMonth(last.competence) : (c.start_date.slice(0, 7) > curMonth ? c.start_date.slice(0, 7) : curMonth);
  let target = curMonth;
  for (let i = 0; i < monthsAhead; i++) target = nextMonth(target);
  const endMonth = c.end_date.slice(0, 7);
  const upTo = target < endMonth ? target : endMonth;
  let created = 0;
  for (const comp of monthsBetween(`${startMonth}-01`, `${upTo}-01`)) {
    const r = await q.rows(
      `INSERT INTO rental_charges (tenant_id, contract_id, competence, due_date, amount_cents)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (contract_id, competence) DO NOTHING RETURNING id`,
      [contractId, comp, dueDateFor(comp, c.due_day), Number(c.rent_cents)]);
    created += r.length;
  }
  return created;
}

export type PayResult =
  | { ok: true; principalCents: number; lateFeeCents: number; interestCents: number; totalCents: number; daysLate: number; payout: { grossCents: number; adminFeeCents: number; netCents: number } }
  | { ok: false; error: 'not_found' | 'already_paid' | 'future_date' };

/** Baixa de cobrança + geração do repasse, em uma única transação (ou tudo ou nada). */
export async function payCharge(db: Db, tenantId: string, chargeId: string, opts: { paidOn?: string; waiveLateFees?: boolean } = {}): Promise<PayResult> {
  const now = await today(db);
  const paidOn = opts.paidOn ?? now;
  if (paidOn > now) return { ok: false, error: 'future_date' };
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<any>(
      `SELECT ch.id, ch.status, ch.amount_cents, to_char(ch.due_date,'YYYY-MM-DD') due_date, c.id contract_id, c.landlord_id,
              c.late_fee_bps, c.interest_bps_month, c.admin_fee_bps
         FROM rental_charges ch JOIN rental_contracts c ON c.id = ch.contract_id AND c.tenant_id = ch.tenant_id
        WHERE ch.tenant_id = $1 AND ch.id = $2 FOR UPDATE OF ch`, [tenantId, chargeId]);
    const ch = rows[0];
    if (!ch) return { ok: false, error: 'not_found' } as const;
    if (ch.status !== 'open') return { ok: false, error: 'already_paid' } as const;
    const principal = Number(ch.amount_cents);
    const days = daysLate(ch.due_date, paidOn);
    const late = opts.waiveLateFees ? { lateFeeCents: 0, interestCents: 0, totalCents: principal }
      : lateCharges(principal, days, { lateFeeBps: ch.late_fee_bps, interestBpsMonth: ch.interest_bps_month });
    await tx.query(
      `UPDATE rental_charges SET status = 'paid', paid_on = $3, paid_principal_cents = $4, late_fee_cents = $5, interest_cents = $6
        WHERE tenant_id = $1 AND id = $2`, [tenantId, chargeId, paidOn, principal, late.lateFeeCents, late.interestCents]);
    const split = payoutSplit(principal, late.lateFeeCents, late.interestCents, ch.admin_fee_bps);
    await tx.query(
      `INSERT INTO rental_payouts (tenant_id, charge_id, contract_id, landlord_id, gross_cents, admin_fee_cents, net_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tenantId, chargeId, ch.contract_id, ch.landlord_id, split.grossCents, split.adminFeeCents, split.netCents]);
    return { ok: true, principalCents: principal, lateFeeCents: late.lateFeeCents, interestCents: late.interestCents, totalCents: late.totalCents,
      daysLate: days, payout: split } as const;
  });
}

/** Data do próximo reajuste: um ano após o último reajuste aplicado (ou após o início). */
export function nextAdjustmentDate(startIso: string, lastAdjustedIso: string | null): string {
  return addYearsIso(lastAdjustedIso ?? startIso, 1);
}

export async function adjustContract(db: Db, tenantId: string, contractId: string, percentBps: number, indexName: string, note: string | null, actorId: string | null) {
  const now = await today(db);
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<any>(
      `SELECT rent_cents, to_char(start_date,'YYYY-MM-DD') start_date, status,
              (SELECT to_char(max(applied_on),'YYYY-MM-DD') FROM rental_adjustments a WHERE a.tenant_id = c.tenant_id AND a.contract_id = c.id) last_adj
         FROM rental_contracts c WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, contractId]);
    const c = rows[0];
    if (!c || c.status !== 'active') return { ok: false, error: 'not_found' } as const;
    const due = nextAdjustmentDate(c.start_date, c.last_adj);
    const windowStart = new Date(Date.parse(`${due}T00:00:00Z`) - 60 * 86_400_000).toISOString().slice(0, 10);
    if (now < windowStart) return { ok: false, error: 'too_early', dueOn: due } as const;
    const previous = Number(c.rent_cents);
    const next = applyAdjustment(previous, percentBps);
    await tx.query(`UPDATE rental_contracts SET rent_cents = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, contractId, next]);
    // Só cobranças ainda não vencidas mudam de valor; o que já venceu mantém o valor original.
    await tx.query(`UPDATE rental_charges SET amount_cents = $3 WHERE tenant_id = $1 AND contract_id = $2 AND status = 'open' AND due_date > $4::date`, [tenantId, contractId, next, now]);
    // Pix/boleto já emitidos com o valor antigo ficam "desatualizados": precisam ser reemitidos antes de cobrar.
    await tx.query(`UPDATE rental_charges SET gateway_stale = true WHERE tenant_id = $1 AND contract_id = $2 AND status = 'open' AND due_date > $3::date AND gateway_id IS NOT NULL`, [tenantId, contractId, now]);
    await tx.query(
      `INSERT INTO rental_adjustments (tenant_id, contract_id, applied_on, previous_cents, new_cents, percent_bps, index_name, note, applied_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [tenantId, contractId, due, previous, next, percentBps, indexName, note, actorId]);
    return { ok: true, previousCents: previous, newCents: next, appliedOn: due } as const;
  });
}
