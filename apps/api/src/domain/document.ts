/** Validação de CPF e CNPJ pelos dígitos verificadores. Recebe com ou sem máscara; devolve só dígitos ou null. */
export const digitsOnly = (s: string) => s.replace(/\D/g, '');

function cpfOk(d: string): boolean {
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const dv = ((sum * 10) % 11) % 10;
    if (dv !== Number(d[len])) return false;
  }
  return true;
}

function cnpjOk(d: string): boolean {
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  for (const len of [12, 13]) {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * weights[i];
    const r = sum % 11;
    if ((r < 2 ? 0 : 11 - r) !== Number(d[len])) return false;
  }
  return true;
}

export function normalizeDocument(input: string): string | null {
  const d = digitsOnly(input);
  return cpfOk(d) || cnpjOk(d) ? d : null;
}

/** Mascara para exibição: só os 2 últimos dígitos aparecem. */
export const maskDocument = (last2: string | null) => (last2 ? `***${last2}` : null);
