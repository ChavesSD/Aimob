import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Criptografia de dados sensíveis em repouso (chaves de API de gateways, CPF/CNPJ), AES-256-GCM.
 * Chave: DATA_ENC_KEY (obrigatória em produção). Em desenvolvimento cai para MFA_ENC_KEY ou JWT_SECRET.
 * O prefixo no derivador separa esta chave da usada nos segredos do MFA, mesmo se o valor de origem coincidir.
 */
function key(): Buffer {
  const dev = process.env.NODE_ENV === 'production' ? '' : (process.env.MFA_ENC_KEY || process.env.JWT_SECRET || '');
  const k = process.env.DATA_ENC_KEY || dev;
  if (k.length < 32) throw new Error('DATA_ENC_KEY ausente ou curta (mínimo 32 caracteres)');
  return createHash('sha256').update(`aimob:data:${k}`).digest();
}

export function encryptText(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decryptText(enc: string): string {
  const raw = Buffer.from(enc, 'base64');
  const d = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
