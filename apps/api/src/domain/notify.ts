import type { Queryable } from '../db/client.js';
import { scoped } from '../db/client.js';

/** Ids dos usuários ativos que recebem avisos de gestão/financeiro. */
export async function staffIds(db: Queryable, tenantId: string, roles = ['owner', 'manager', 'finance']): Promise<string[]> {
  return (await scoped(db, tenantId).rows<{ id: string }>(
    `SELECT id FROM users WHERE tenant_id = $1 AND active AND role = ANY($2::text[])`, [roles])).map((r) => r.id);
}

/**
 * Avisa usuários. Avisos idênticos ainda não lidos são agrupados (contador) para não bombardear a equipe.
 */
export async function notifyUsers(db: Queryable, tenantId: string, userIds: string[], message: string, href: string) {
  const s = scoped(db, tenantId);
  for (const uid of userIds) {
    const merged = await s.rows(
      `UPDATE notifications SET count = count + 1, created_at = now() WHERE tenant_id = $1 AND user_id = $2 AND message = $3 AND read_at IS NULL RETURNING id`,
      [uid, message]);
    if (!merged.length) await s.rows(`INSERT INTO notifications (tenant_id, user_id, message, href) VALUES ($1,$2,$3,$4)`, [uid, message, href]);
  }
}
