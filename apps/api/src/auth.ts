import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { config, requireJwtSecret } from './config.js';

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltHex, hashHex] = stored.split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

export interface Session { sub: string; tid: string; role: string }

export async function signToken(s: Session): Promise<string> {
  return new SignJWT({ tid: s.tid, role: s.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(s.sub)
    .setIssuedAt()
    .setExpirationTime(`${config.jwtTtlSeconds}s`)
    .sign(requireJwtSecret());
}

export async function verifyToken(token: string): Promise<Session> {
  const { payload } = await jwtVerify(token, requireJwtSecret(), {
    algorithms: ['HS256'],
    requiredClaims: ['exp', 'sub'],
  });
  // Sessão exige tid e papel e nenhum "purpose": o token intermediário do MFA nunca vale como sessão.
  if (payload.purpose || typeof payload.tid !== 'string' || typeof payload.role !== 'string') throw new Error('Token de sessão inválido');
  return { sub: String(payload.sub), tid: payload.tid, role: payload.role };
}

/** Token curto (5 min) emitido depois da senha e antes do código MFA. Só serve para /api/auth/mfa/verify. */
export async function signMfaToken(userId: string): Promise<string> {
  return new SignJWT({ purpose: 'mfa' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(requireJwtSecret());
}

export async function verifyMfaToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, requireJwtSecret(), { algorithms: ['HS256'], requiredClaims: ['exp', 'sub'] });
  if (payload.purpose !== 'mfa') throw new Error('Token MFA inválido');
  return String(payload.sub);
}

const COMMON = ['1234567890', '0123456789', 'senha12345', 'password12', 'qwertyuiop', 'abcdefghij', 'imobiliaria', 'aimob12345'];

/** Política de senha dos usuários externos (proprietários). Devolve o motivo em português, ou null se estiver boa. */
export function passwordProblem(pw: string, email: string): string | null {
  if (pw.length < 10) return 'A senha precisa ter pelo menos 10 caracteres.';
  if (pw.length > 200) return 'A senha é longa demais.';
  const lower = pw.toLowerCase();
  const local = email.split('@')[0].toLowerCase();
  if (lower === email.toLowerCase() || (local.length >= 4 && lower.includes(local))) return 'A senha não pode conter o seu e-mail.';
  if (COMMON.some((c) => lower.includes(c)) || /^(.)\1+$/.test(pw)) return 'Essa senha é fácil de adivinhar. Escolha outra.';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 2) return 'Misture letras e números (ou símbolos) na senha.';
  return null;
}
