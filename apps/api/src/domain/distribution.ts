import type { Db } from '../db/client.js';
import { scoped } from '../db/client.js';

export type DistributionMode = 'manual' | 'roundrobin';

// Serializa a distribuição por tenant dentro desta instância, evitando que dois leads simultâneos
// escolham o mesmo corretor. Com várias instâncias da API, trocar por lock no banco (pg_advisory_xact_lock).
const locks = new Map<string, Promise<unknown>>();
export function withTenantLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(tenantId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(tenantId, next.catch(() => undefined));
  return next;
}

export async function getMode(db: Db, tenantId: string): Promise<DistributionMode> {
  const [r] = await scoped(db, tenantId).rows<{ distribution_mode: DistributionMode }>(
    `SELECT distribution_mode FROM tenant_settings WHERE tenant_id = $1`);
  return r?.distribution_mode ?? 'manual';
}

export async function setMode(db: Db, tenantId: string, mode: DistributionMode) {
  await db.query(
    `INSERT INTO tenant_settings (tenant_id, distribution_mode) VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET distribution_mode = $2, updated_at = now()`, [tenantId, mode]);
}

/** Rodízio: quem recebeu há mais tempo (ou nunca) vai primeiro; empate resolve por menos leads abertos. */
export async function pickBroker(db: Db, tenantId: string): Promise<string | null> {
  const [r] = await scoped(db, tenantId).rows<{ id: string }>(
    `SELECT u.id FROM users u
      WHERE u.tenant_id = $1 AND u.active AND u.accepts_leads AND u.role = 'broker'
      ORDER BY (SELECT max(l.assigned_at) FROM leads l WHERE l.tenant_id = u.tenant_id AND l.owner_id = u.id) ASC NULLS FIRST,
               (SELECT count(*) FROM leads l WHERE l.tenant_id = u.tenant_id AND l.owner_id = u.id AND l.status = 'open') ASC,
               u.id
      LIMIT 1`);
  return r?.id ?? null;
}

export async function assignLead(db: Db, tenantId: string, leadId: string, ownerId: string | null) {
  const rows = await scoped(db, tenantId).rows(
    `UPDATE leads SET owner_id = $2, assigned_at = CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END, updated_at = now()
      WHERE tenant_id = $1 AND id = $3 RETURNING id`, [ownerId, leadId]);
  return rows.length > 0;
}

/** Atribui todos os leads abertos sem responsável. Retorna quantos foram distribuídos e para quem. */
export function distributeUnassigned(db: Db, tenantId: string) {
  return withTenantLock(tenantId, async () => {
    const leads = await scoped(db, tenantId).rows<{ id: string }>(
      `SELECT id FROM leads WHERE tenant_id = $1 AND status = 'open' AND owner_id IS NULL ORDER BY created_at`);
    const perBroker: Record<string, number> = {};
    for (const l of leads) {
      const b = await pickBroker(db, tenantId);
      if (!b) break;
      await assignLead(db, tenantId, l.id, b);
      perBroker[b] = (perBroker[b] ?? 0) + 1;
    }
    return { distributed: Object.values(perBroker).reduce((a, n) => a + n, 0), pending: leads.length, perBroker };
  });
}
