import { describe, expect, it } from 'vitest';
import { addYearsIso, applyAdjustment, daysLate, dueDateFor, lateCharges, monthsBetween, payoutSplit } from '../src/domain/money.js';

describe('dinheiro em centavos', () => {
  it('conta dias de atraso e nunca negativo', () => {
    expect(daysLate('2026-03-10', '2026-03-10')).toBe(0);
    expect(daysLate('2026-03-10', '2026-03-05')).toBe(0);
    expect(daysLate('2026-03-10', '2026-03-25')).toBe(15);
    expect(daysLate('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysLate('2025-12-31', '2026-01-02')).toBe(2);
  });

  it('multa única + juros simples pro rata, sem float', () => {
    // R$ 2.000,00; multa 2%; juros 1%/mês; 15 dias
    const r = lateCharges(200_000, 15, { lateFeeBps: 200, interestBpsMonth: 100 });
    expect(r.lateFeeCents).toBe(4_000);
    expect(r.interestCents).toBe(1_000);
    expect(r.totalCents).toBe(205_000);
    expect(lateCharges(200_000, 0, { lateFeeBps: 200, interestBpsMonth: 100 })).toEqual({ lateFeeCents: 0, interestCents: 0, totalCents: 200_000 });
  });

  it('arredonda ao centavo e o total sempre fecha com as partes', () => {
    for (const principal of [123_457, 99_999, 1, 333_333]) {
      for (const days of [1, 7, 31, 100]) {
        const r = lateCharges(principal, days, { lateFeeBps: 200, interestBpsMonth: 100 });
        expect(Number.isInteger(r.lateFeeCents) && Number.isInteger(r.interestCents)).toBe(true);
        expect(r.totalCents).toBe(principal + r.lateFeeCents + r.interestCents);
      }
    }
  });

  it('repasse: taxa sobre o principal, multa/juros integrais ao proprietário', () => {
    const p = payoutSplit(200_000, 4_000, 1_000, 1_000);
    expect(p).toEqual({ grossCents: 205_000, adminFeeCents: 20_000, netCents: 185_000 });
    const noLate = payoutSplit(150_000, 0, 0, 800);
    expect(noLate.adminFeeCents).toBe(12_000);
    expect(noLate.netCents + noLate.adminFeeCents).toBe(noLate.grossCents);
  });

  it('reajuste percentual', () => {
    expect(applyAdjustment(200_000, 450)).toBe(209_000);
    expect(applyAdjustment(200_000, 0)).toBe(200_000);
    expect(applyAdjustment(123_457, 333)).toBe(127_568);
  });

  it('competências, vencimento e aniversário', () => {
    expect(monthsBetween('2025-11-15', '2026-02-10')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(dueDateFor('2026-03', 5)).toBe('2026-03-05');
    expect(addYearsIso('2025-03-10', 1)).toBe('2026-03-10');
  });
});
