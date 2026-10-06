// Valor por extenso em português do Brasil (contratos costumam repetir o valor em números e por extenso).
const U = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const T = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const C = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

/** 1..999 */
function ate999(n: number): string {
  if (n === 100) return 'cem';
  const c = Math.floor(n / 100), r = n % 100;
  const parts: string[] = [];
  if (c) parts.push(C[c]);
  if (r) {
    if (r < 20) parts.push(U[r]);
    else { const t = Math.floor(r / 10), u = r % 10; parts.push(T[t] + (u ? ` e ${U[u]}` : '')); }
  }
  return parts.join(' e ');
}

/** Inteiro de 0 a 999.999.999.999 */
export function inteiroPorExtenso(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999_999_999) throw new RangeError('Valor fora do limite para escrever por extenso');
  if (n === 0) return 'zero';
  const bi = Math.floor(n / 1_000_000_000), mi = Math.floor((n % 1_000_000_000) / 1_000_000), mil = Math.floor((n % 1_000_000) / 1000), resto = n % 1000;
  const groups: string[] = [];
  if (bi) groups.push(`${bi === 1 ? 'um' : ate999(bi)} ${bi === 1 ? 'bilhão' : 'bilhões'}`);
  if (mi) groups.push(`${mi === 1 ? 'um' : ate999(mi)} ${mi === 1 ? 'milhão' : 'milhões'}`);
  if (mil) groups.push(mil === 1 ? 'mil' : `${ate999(mil)} mil`);
  if (resto) groups.push(ate999(resto));
  // "e" antes do último grupo quando ele é menor que 100 ou centena redonda ("mil e duzentos"); senão, apenas espaço.
  let out = groups[0];
  for (let i = 1; i < groups.length; i++) {
    const last = i === groups.length - 1;
    const v = [bi, mi, mil, resto].filter(Boolean)[i];
    out += last && (v < 100 || v % 100 === 0) ? ` e ${groups[i]}` : ` ${groups[i]}`;
  }
  return out;
}

/** Centavos -> "dois mil e duzentos reais", "um real e um centavo", "um milhão de reais". */
export function reaisPorExtenso(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError('Valor inválido');
  const reais = Math.floor(cents / 100), cent = cents % 100;
  const partes: string[] = [];
  if (reais > 0) {
    const de = reais % 1_000_000 === 0 ? ' de' : '';
    partes.push(`${inteiroPorExtenso(reais)}${de} ${reais === 1 ? 'real' : 'reais'}`);
  }
  if (cent > 0) partes.push(`${inteiroPorExtenso(cent)} ${cent === 1 ? 'centavo' : 'centavos'}`);
  return partes.length ? partes.join(' e ') : 'zero reais';
}
