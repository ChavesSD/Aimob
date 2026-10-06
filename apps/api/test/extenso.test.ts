import { describe, expect, it } from 'vitest';
import { inteiroPorExtenso, reaisPorExtenso } from '../src/domain/extenso.js';

describe('valor por extenso', () => {
  it('escreve valores de aluguel corretamente', () => {
    const casos: [number, string][] = [
      [220000, 'dois mil e duzentos reais'],
      [185000, 'mil oitocentos e cinquenta reais'],
      [250000, 'dois mil e quinhentos reais'],
      [10000, 'cem reais'],
      [15000, 'cento e cinquenta reais'],
      [100, 'um real'],
      [101, 'um real e um centavo'],
      [150, 'um real e cinquenta centavos'],
      [5, 'cinco centavos'],
      [0, 'zero reais'],
      [123456, 'mil duzentos e trinta e quatro reais e cinquenta e seis centavos'],
      [450000, 'quatro mil e quinhentos reais'],
      [310000, 'três mil e cem reais'],
      [100000, 'mil reais'],
      [2100000, 'vinte e um mil reais'],
      [100000000, 'um milhão de reais'],
      [250000000, 'dois milhões e quinhentos mil reais'],
      [234500000, 'dois milhões trezentos e quarenta e cinco mil reais'],
      [200000000, 'dois milhões de reais'],
    ];
    for (const [c, txt] of casos) expect(reaisPorExtenso(c), `${c}`).toBe(txt);
  });

  it('cobre todos os números de 1 a 2000 sem lançar e sem repetir palavras sem sentido', () => {
    for (let i = 1; i <= 2000; i++) {
      const t = inteiroPorExtenso(i);
      expect(t.length).toBeGreaterThan(0);
      expect(t).not.toMatch(/\bum mil\b|\be e\b|  /);
    }
    expect(inteiroPorExtenso(21)).toBe('vinte e um');
    expect(inteiroPorExtenso(999)).toBe('novecentos e noventa e nove');
    expect(inteiroPorExtenso(1000)).toBe('mil');
    expect(inteiroPorExtenso(1001)).toBe('mil e um');
    expect(inteiroPorExtenso(2000)).toBe('dois mil');
  });

  it('recusa valores inválidos', () => {
    expect(() => reaisPorExtenso(-1)).toThrow();
    expect(() => reaisPorExtenso(1.5)).toThrow();
    expect(() => inteiroPorExtenso(1e13)).toThrow();
  });
});
