import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Chave de criptografia dos segredos TOTP em repouso. Em produção, MFA_ENC_KEY é obrigatória e distinta do JWT_SECRET. */
function key(): Buffer {
  const k = process.env.MFA_ENC_KEY || (process.env.NODE_ENV === 'production' ? '' : process.env.JWT_SECRET ?? '');
  if (k.length < 32) throw new Error('MFA_ENC_KEY ausente ou curta (mínimo 32 caracteres)');
  return createHash('sha256').update(k).digest();
}

export function encryptSecret(plain: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decryptSecret(enc: string): Buffer {
  const raw = Buffer.from(enc, 'base64');
  const d = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

export const hashCode = (code: string) => createHash('sha256').update(code.replace(/[\s-]/g, '').toUpperCase()).digest('hex');

/** 8 códigos de recuperação de uso único, no formato XXXXX-XXXXX. Só o hash é guardado. */
export function newRecoveryCodes(n = 8): { plain: string[]; hashes: string[] } {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem caracteres ambíguos (0/O, 1/I)
  const plain = Array.from({ length: n }, () => {
    const b = randomBytes(10);
    const s = Array.from(b, (x) => alphabet[x % alphabet.length]).join('');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  return { plain, hashes: plain.map(hashCode) };
}
