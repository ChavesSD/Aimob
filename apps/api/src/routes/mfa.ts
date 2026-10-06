import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { scoped } from '../db/client.js';
import { audit } from '../audit.js';
import { guard } from '../guard.js';
import { signToken, verifyMfaToken, verifyPassword } from '../auth.js';
import { brand } from '../config.js';
import { decryptSecret, encryptSecret, hashCode, newRecoveryCodes } from '../domain/mfa.js';
import { base32Encode, newSecret, otpauthUrl, verifyTotp } from '../domain/totp.js';

export type MfaPolicy = 'off' | 'admins' | 'staff';
const ADMIN_ROLES = ['owner', 'manager', 'finance'];                                   // mexem com dinheiro e dados sensíveis
const STAFF_ROLES = [...ADMIN_ROLES, 'broker', 'marketing'];                           // toda a equipe da imobiliária (proprietários ficam de fora)
/** Rotas liberadas enquanto o MFA exigido ainda não foi configurado: só o necessário para configurá-lo. */
export const MFA_SETUP_ROUTES = new Set(['/api/me', '/api/auth/mfa/setup', '/api/auth/mfa/enable']);

export function mfaRequiredFor(policy: MfaPolicy, role: string): boolean {
  return policy === 'staff' ? STAFF_ROLES.includes(role) : policy === 'admins' ? ADMIN_ROLES.includes(role) : false;
}

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

interface Row { id: string; tenant_id: string; role: string; name: string; email: string; mfa_secret_enc: string | null; mfa_enabled: boolean; mfa_last_step: number; session_epoch: number; locked: boolean }

const loadUser = async (db: Db, id: string): Promise<Row | undefined> => (await db.query<Row>(
  `SELECT id, tenant_id, role, name, email, mfa_secret_enc, mfa_enabled, mfa_last_step, session_epoch, (mfa_locked_until IS NOT NULL AND mfa_locked_until > now()) AS locked
     FROM users WHERE id = $1 AND active`, [id])).rows[0];

type Check = 'ok' | 'invalid' | 'locked';

/** Confere TOTP (sem reuso do mesmo passo) ou código de recuperação (uso único). Conta falhas e bloqueia. */
async function checkSecondFactor(db: Db, u: Row, input: { code?: string; recoveryCode?: string }): Promise<Check> {
  if (u.locked) return 'locked';
  let ok = false;
  if (input.code && u.mfa_secret_enc) {
    const step = verifyTotp(decryptSecret(u.mfa_secret_enc), input.code);
    if (step !== null) {
      // O UPDATE condicional torna o consumo atômico: duas requisições com o mesmo código não passam as duas.
      const r = await db.query(`UPDATE users SET mfa_last_step = $2 WHERE id = $1 AND mfa_last_step < $2 RETURNING id`, [u.id, step]);
      ok = r.rows.length > 0;
    }
  } else if (input.recoveryCode) {
    const r = await db.query(
      `UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`, [u.id, hashCode(input.recoveryCode)]);
    ok = r.rows.length > 0;
  }
  if (ok) {
    await db.query(`UPDATE users SET mfa_failed = 0, mfa_locked_until = NULL WHERE id = $1`, [u.id]);
    return 'ok';
  }
  await db.query(
    // Ao atingir o limite: bloqueia por LOCK_MINUTES e zera o contador (um único SET por coluna).
    `UPDATE users SET mfa_locked_until = CASE WHEN mfa_failed + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE mfa_locked_until END,
            mfa_failed = CASE WHEN mfa_failed + 1 >= $2 THEN 0 ELSE mfa_failed + 1 END
      WHERE id = $1`, [u.id, MAX_FAILURES, String(LOCK_MINUTES)]);
  return 'invalid';
}

const codeInput = z.object({ code: z.string().regex(/^\d{6}$/).optional(), recoveryCode: z.string().min(8).max(20).optional() })
  .refine((v) => !!v.code !== !!v.recoveryCode, 'Informe o código do aplicativo ou um código de recuperação.');

export function registerMfaRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/me', async (req) => {
    const u = await loadUser(db, req.session!.sub);
    const [st] = await scoped(db, req.session!.tid).rows<{ mfa_policy: MfaPolicy }>(`SELECT mfa_policy FROM tenant_settings WHERE tenant_id = $1`);
    const policy = st?.mfa_policy ?? 'admins';
    return { id: u!.id, name: u!.name, role: u!.role, mfaEnabled: u!.mfa_enabled, mfaPolicy: policy, mfaRequired: mfaRequiredFor(policy, u!.role) };
  });

  // ---- Política de MFA da imobiliária (só a diretoria, e só com o próprio MFA ativo) ----
  app.get('/api/settings/mfa-policy', { preHandler: guard('users', 'view') }, async (req) => {
    const [st] = await scoped(db, req.session!.tid).rows<{ mfa_policy: MfaPolicy }>(`SELECT mfa_policy FROM tenant_settings WHERE tenant_id = $1`);
    return { policy: st?.mfa_policy ?? 'admins' };
  });

  app.put('/api/settings/mfa-policy', { preHandler: guard('users', 'admin') }, async (req, reply) => {
    const b = z.object({ policy: z.enum(['off', 'admins', 'staff']) }).parse(req.body);
    const me = await loadUser(db, req.session!.sub);
    // Quem altera a regra precisa estar protegido: uma sessão sem MFA não pode afrouxar a proteção de todos.
    if (!me!.mfa_enabled) return reply.code(409).send({ error: 'Ative a sua própria verificação em duas etapas antes de alterar esta regra.' });
    const tid = req.session!.tid;
    const [cur] = await scoped(db, tid).rows<{ mfa_policy: MfaPolicy }>(`SELECT mfa_policy FROM tenant_settings WHERE tenant_id = $1`);
    const before = cur?.mfa_policy ?? 'admins';
    await db.query(`INSERT INTO tenant_settings (tenant_id, mfa_policy) VALUES ($1, $2) ON CONFLICT (tenant_id) DO UPDATE SET mfa_policy = $2, updated_at = now()`, [tid, b.policy]);
    const label = { off: 'ninguém', admins: 'diretoria, gerência e financeiro', staff: 'toda a equipe' };
    await audit(db, req, { action: 'settings.mfa_policy', resource: 'tenant', before: { policy: before }, after: b, summary: `Exigência de verificação em duas etapas alterada de "${label[before]}" para "${label[b.policy]}"` });
    return { ok: true, policy: b.policy };
  });

  // ---- Redefinir o MFA de um colega (celular perdido): desativa, apaga códigos e derruba as sessões dele ----
  app.post('/api/team/:id/mfa-reset', { preHandler: guard('users', 'admin'), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const id = z.string().uuid().parse((req.params as any).id);
    const me = await loadUser(db, req.session!.sub);
    if (!me!.mfa_enabled) return reply.code(409).send({ error: 'Ative a sua própria verificação em duas etapas antes de redefinir a de outra pessoa.' });
    if (id === req.session!.sub) return reply.code(400).send({ error: 'Para desativar a sua própria verificação, use a página de Segurança.' });
    const tid = req.session!.tid;
    const target = await scoped(db, tid).rows<{ name: string }>(`SELECT name FROM users WHERE tenant_id = $1 AND id = $2`, [id]);
    if (!target.length) return reply.code(404).send({ error: 'Usuário não encontrado.' });
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_last_step = 0, mfa_failed = 0, mfa_locked_until = NULL, session_epoch = session_epoch + 1 WHERE tenant_id = $1 AND id = $2`, [tid, id]);
      await tx.query(`DELETE FROM mfa_recovery_codes WHERE tenant_id = $1 AND user_id = $2`, [tid, id]);
    });
    await audit(db, req, { action: 'auth.mfa_reset', resource: 'user', resourceId: id, summary: `Verificação em duas etapas de ${target[0].name} redefinida; sessões anteriores encerradas` });
    return { ok: true };
  });

  // Segundo passo do login: troca (token curto + código) por uma sessão completa.
  app.post('/api/auth/mfa/verify', { config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ mfaToken: z.string().min(10) }).and(codeInput).parse(req.body);
    let userId: string;
    try { userId = await verifyMfaToken(b.mfaToken); } catch { return reply.code(401).send({ error: 'Sessão de verificação expirada. Entre novamente.' }); }
    const u = await loadUser(db, userId);
    if (!u || !u.mfa_enabled) return reply.code(401).send({ error: 'Sessão de verificação inválida. Entre novamente.' });
    req.session = { sub: u.id, tid: u.tenant_id, role: u.role };
    const r = await checkSecondFactor(db, u, b);
    if (r === 'locked') return reply.code(429).send({ error: `Muitas tentativas incorretas. Tente novamente em ${LOCK_MINUTES} minutos.` });
    if (r === 'invalid') {
      await audit(db, req, { action: 'auth.mfa_failed', resource: 'user', resourceId: u.id, summary: 'Código de verificação incorreto' });
      return reply.code(401).send({ error: 'Código incorreto. Confira o aplicativo e tente de novo.' });
    }
    await audit(db, req, { action: 'auth.login', resource: 'user', resourceId: u.id, summary: b.recoveryCode ? 'Login com código de recuperação' : 'Login com verificação em duas etapas' });
    return { token: await signToken({ sub: u.id, tid: u.tenant_id, role: u.role, ep: u.session_epoch }), user: { id: u.id, name: u.name, role: u.role } };
  });

  // Passo 1 da ativação: gera o segredo (ainda inativo) e o QR code.
  app.post('/api/auth/mfa/setup', async (req, reply) => {
    const u = await loadUser(db, req.session!.sub);
    if (u!.mfa_enabled) return reply.code(409).send({ error: 'A verificação em duas etapas já está ativa.' });
    const secret = newSecret();
    await db.query(`UPDATE users SET mfa_secret_enc = $2, mfa_last_step = 0 WHERE id = $1`, [u!.id, encryptSecret(secret)]);
    const b32 = base32Encode(secret);
    const url = otpauthUrl(brand.name, u!.email, b32);
    return { secret: b32, otpauthUrl: url, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
  });

  // Passo 2: confirma com um código válido, ativa e entrega os códigos de recuperação (uma única vez).
  app.post('/api/auth/mfa/enable', async (req, reply) => {
    const b = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const u = await loadUser(db, req.session!.sub);
    if (u!.mfa_enabled) return reply.code(409).send({ error: 'A verificação em duas etapas já está ativa.' });
    if (!u!.mfa_secret_enc) return reply.code(400).send({ error: 'Inicie a configuração primeiro.' });
    const check = await checkSecondFactor(db, u!, { code: b.code });
    if (check === 'locked') return reply.code(429).send({ error: `Muitas tentativas incorretas. Tente novamente em ${LOCK_MINUTES} minutos.` });
    if (check !== 'ok') return reply.code(400).send({ error: 'Código incorreto. Confira o aplicativo e tente de novo.' });
    const codes = newRecoveryCodes();
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE users SET mfa_enabled = true WHERE id = $1`, [u!.id]);
      await tx.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [u!.id]);
      for (const h of codes.hashes) await tx.query(`INSERT INTO mfa_recovery_codes (tenant_id, user_id, code_hash) VALUES ($1,$2,$3)`, [u!.tenant_id, u!.id, h]);
    });
    await audit(db, req, { action: 'auth.mfa_enabled', resource: 'user', resourceId: u!.id, summary: 'Verificação em duas etapas ativada' });
    return { ok: true, recoveryCodes: codes.plain };
  });

  // Desativar exige senha E segundo fator: um token roubado sozinho não desliga a proteção.
  app.post('/api/auth/mfa/disable', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ password: z.string().min(1) }).and(codeInput).parse(req.body);
    const u = await loadUser(db, req.session!.sub);
    if (!u!.mfa_enabled) return reply.code(409).send({ error: 'A verificação em duas etapas não está ativa.' });
    const { rows } = await db.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [u!.id]);
    if (!verifyPassword(b.password, rows[0].password_hash)) return reply.code(401).send({ error: 'Senha incorreta.' });
    const check = await checkSecondFactor(db, u!, b);
    if (check === 'locked') return reply.code(429).send({ error: `Muitas tentativas incorretas. Tente novamente em ${LOCK_MINUTES} minutos.` });
    if (check !== 'ok') return reply.code(401).send({ error: 'Código incorreto.' });
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_last_step = 0 WHERE id = $1`, [u!.id]);
      await tx.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [u!.id]);
    });
    await audit(db, req, { action: 'auth.mfa_disabled', resource: 'user', resourceId: u!.id, summary: 'Verificação em duas etapas desativada' });
    return { ok: true };
  });
}
