// Dinheiro sempre em centavos inteiros; percentuais em basis points (100 bps = 1%). Nunca float.
// Metodologia PADRÃO e configurável por contrato; valores de multa/juros/taxa devem ser validados pela imobiliária/jurídico.

const DAY_MS = 86_400_000;

/** Dias de atraso entre duas datas ISO (YYYY-MM-DD). Zero se pago em dia ou antes. */
export function daysLate(dueIso: string, paidIso: string): number {
  const d = (Date.parse(`${paidIso}T00:00:00Z`) - Date.parse(`${dueIso}T00:00:00Z`)) / DAY_MS;
  return d > 0 ? Math.round(d) : 0;
}

export interface LateTerms { lateFeeBps: number; interestBpsMonth: number }

/** Multa fixa única sobre o principal + juros simples pro rata die (mês de 30 dias). */
export function lateCharges(principalCents: number, days: number, t: LateTerms) {
  if (days <= 0) return { lateFeeCents: 0, interestCents: 0, totalCents: principalCents };
  const lateFeeCents = Math.round((principalCents * t.lateFeeBps) / 10_000);
  const interestCents = Math.round((principalCents * t.interestBpsMonth * days) / (10_000 * 30));
  return { lateFeeCents, interestCents, totalCents: principalCents + lateFeeCents + interestCents };
}

/** Repasse: taxa de administração incide sobre o principal; multa e juros pagos vão integralmente ao proprietário. */
export function payoutSplit(principalCents: number, lateFeeCents: number, interestCents: number, adminFeeBps: number) {
  const adminFeeCents = Math.round((principalCents * adminFeeBps) / 10_000);
  const grossCents = principalCents + lateFeeCents + interestCents;
  return { grossCents, adminFeeCents, netCents: grossCents - adminFeeCents };
}

export function applyAdjustment(rentCents: number, percentBps: number): number {
  return Math.round((rentCents * (10_000 + percentBps)) / 10_000);
}

/** Competências (YYYY-MM) entre duas datas ISO, inclusive; due_day limitado a 1..28 para existir em todo mês. */
export function dueDateFor(competence: string, dueDay: number): string {
  return `${competence}-${String(dueDay).padStart(2, '0')}`;
}

export function monthsBetween(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  let [y, m] = startIso.split('-').map(Number);
  const [ey, em] = endIso.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

export function addYearsIso(iso: string, years: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${y + years}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
