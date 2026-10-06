// Branding provisório centralizado: trocar aqui (ou por env) muda o nome em todo o sistema.
export const brand = {
  name: process.env.BRAND_NAME ?? 'Aimob',
  tagline: 'A imobiliária inteira, finalmente sob controle.',
};

export const config = {
  port: Number(process.env.PORT ?? 3100),
  /** PostgreSQL em produção (postgres://...). Sem isto, usa PGlite em disco (apenas desenvolvimento). */
  databaseUrl: process.env.DATABASE_URL ?? '',
  dataDir: process.env.DATA_DIR ?? './data/pg',
  jwtSecret: process.env.JWT_SECRET ?? '',
  jwtTtlSeconds: 60 * 60 * 8,
  isProduction: process.env.NODE_ENV === 'production',
  /** Atrás de proxy/balanceador: necessário para que o IP real (rate limit, auditoria) seja o do cliente. */
  trustProxy: process.env.TRUST_PROXY === 'true',
};

export function requireJwtSecret(): Uint8Array {
  const s = config.jwtSecret;
  if (s.length < 32) throw new Error('JWT_SECRET ausente ou curto (mínimo 32 caracteres)');
  return new TextEncoder().encode(s);
}

/**
 * Conta principal do Asaas da plataforma. Mesmos nomes de variáveis do Aidate:
 * ASAAS_API_KEY, ASAAS_API_URL, ASAAS_USER_AGENT, ASAAS_WEBHOOK_TOKEN.
 * Com ela, o Aimob cria uma subconta por imobiliária e cobra com split para a carteira dela.
 */
export interface PlatformAsaas { apiKey: string; baseUrl: string; userAgent: string; webhookToken: string }
export function platformAsaas(env: NodeJS.ProcessEnv = process.env): PlatformAsaas | null {
  const apiKey = (env.ASAAS_API_KEY ?? '').trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: normalizeAsaasUrl(env.ASAAS_API_URL),
    userAgent: (env.ASAAS_USER_AGENT ?? '').trim() || 'Aimob',
    webhookToken: (env.ASAAS_WEBHOOK_TOKEN ?? '').trim(),
  };
}

/** Igual ao Aidate: o padrão é produção; endereços antigos do sandbox são convertidos para o atual. */
export function normalizeAsaasUrl(configured?: string): string {
  let url = (configured ?? '').trim().replace(/\/$/, '') || 'https://api.asaas.com/v3';
  if (/^https?:\/\/sandbox\.asaas\.com\/(api\/)?v3$/i.test(url)) url = 'https://api-sandbox.asaas.com/v3';
  return url;
}

/** Em produção, recusa subir com configuração insegura ou incompleta. Retorna a lista de problemas. */
export function productionProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const p: string[] = [];
  if (!env.DATABASE_URL) p.push('DATABASE_URL ausente: produção exige PostgreSQL (o PGlite é só para desenvolvimento).');
  if ((env.JWT_SECRET ?? '').length < 32) p.push('JWT_SECRET ausente ou com menos de 32 caracteres.');
  if (!env.IP_HASH_SALT || env.IP_HASH_SALT.length < 16 || /troque|dev-salt/i.test(env.IP_HASH_SALT)) p.push('IP_HASH_SALT ausente ou de exemplo.');
  if (!env.CORS_ORIGIN) p.push('CORS_ORIGIN ausente: informe as origens permitidas do front.');
  if (!env.MFA_ENC_KEY || env.MFA_ENC_KEY.length < 32) p.push('MFA_ENC_KEY ausente ou com menos de 32 caracteres.');
  if (!env.DATA_ENC_KEY || env.DATA_ENC_KEY.length < 32) p.push('DATA_ENC_KEY ausente ou com menos de 32 caracteres (protege CPF/CNPJ e chaves de gateway).');
  if (!env.PUBLIC_API_URL || !/^https:\/\//.test(env.PUBLIC_API_URL)) p.push('PUBLIC_API_URL ausente ou sem https:// (necessária para o endereço do webhook de pagamentos).');
  if (env.TRUST_PROXY !== 'true' && env.TRUST_PROXY !== 'false') p.push('TRUST_PROXY deve ser "true" ou "false" (decisão explícita): atrás de balanceador, sem "true" o rate limit enxerga o IP do proxy.');
  if ((env.ASAAS_API_KEY ?? '').trim() && (env.ASAAS_WEBHOOK_TOKEN ?? '').trim().length < 32) p.push('ASAAS_WEBHOOK_TOKEN ausente ou com menos de 32 caracteres (exigência do Asaas; autentica o webhook da plataforma).');
  return p;
}
