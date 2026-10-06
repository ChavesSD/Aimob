// Branding provisório centralizado: trocar aqui (ou por env) muda o nome em todo o sistema.
export const brand = {
  name: process.env.BRAND_NAME ?? 'Aimob',
  tagline: 'A imobiliária inteira, finalmente sob controle.',
};

export const config = {
  port: Number(process.env.PORT ?? 3100),
  dataDir: process.env.DATA_DIR ?? './data/pg',
  jwtSecret: process.env.JWT_SECRET ?? '',
  jwtTtlSeconds: 60 * 60 * 8,
};

export function requireJwtSecret(): Uint8Array {
  const s = config.jwtSecret;
  if (s.length < 32) throw new Error('JWT_SECRET ausente ou curto (mínimo 32 caracteres)');
  return new TextEncoder().encode(s);
}
