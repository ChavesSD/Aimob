import type { Db, Queryable } from '../db/client.js';
import { scoped } from '../db/client.js';

export type DistributionMode = 'manual' | 'roundrobin';

export async function getMode(db: Queryable, tenantId: string): Promise<DistributionMode> {
  const [r] = await scoped(db, tenantId).rows<{ distribution_mode: DistributionMode }>(
    `SELECT distribution_mode FROM tenant_settings WHERE tenant_id = $1`);
  return r?.distribution_mode ?? 'manual';
}

export async function setMode(db: Queryable, tenantId: string, mode: DistributionMode) {
  await db.query(
    `INSERT INTO tenant_settings (tenant_id, distribution_mode) VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET distribution_mode = $2, updated_at = now()`, [tenantId, mode]);
}

/** Rodízio: quem recebeu há mais tempo (ou nunca) vai primeiro; empate resolve por menos leads abertos. */
export async function pickBroker(db: Queryable, tenantId: string): Promise<string | null> {
  const [r] = await scoped(db, tenantId).rows<{ id: string }>(
    `SELECT u.id FROM users u
      WHERE u.tenant_id = $1 AND u.active AND u.accepts_leads AND u.role = 'broker'
      ORDER BY (SELECT max(l.assigned_at) FROM leads l WHERE l.tenant_id = u.tenant_id AND l.owner_id = u.id) ASC NULLS FIRST,
               (SELECT count(*) FROM leads l WHERE l.tenant_id = u.tenant_id AND l.owner_id = u.id AND l.status = 'open') ASC,
               u.id
      LIMIT 1`);
  return r?.id ?? null;
}

export async function assignLead(db: Queryable, tenantId: string, leadId: string, ownerId: string | null) {
  const rows = await scoped(db, tenantId).rows(
    `UPDATE leads SET owner_id = $2, assigned_at = CASE WHEN $2::uuid IS NULL THEN NULL ELSE clock_timestamp() END, updated_at = now()
      WHERE tenant_id = $1 AND id = $3 RETURNING id`, [ownerId, leadId]);
  return rows.length > 0;
}

/**
 * Escolhe e atribui o próximo corretor numa única transação protegida por lock consultivo do banco.
 * Vale para várias instâncias da API e várias conexões: leads simultâneos nunca escolhem o mesmo corretor.
 * Retorna o corretor escolhido, ou null se não houve atribuição (sem corretor disponível, ou já tinha dono).
 */
export function assignRoundRobin(db: Db, tenantId: string, leadId: string, opts: { onlyIfUnassigned?: boolean } = {}): Promise<string | null> {
  return db.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`lead-distribution:${tenantId}`]);
    if (opts.onlyIfUnassigned) {
      const [cur] = await scoped(tx, tenantId).rows<{ owner_id: string | null }>(`SELECT owner_id FROM leads WHERE tenant_id = $1 AND id = $2`, [leadId]);
      if (!cur || cur.owner_id) return null;
    }
    const broker = await pickBroker(tx, tenantId);
    if (!broker) return null;
    await assignLead(tx, tenantId, leadId, broker);
    return broker;
  });
}

/** Atribui todos os leads abertos sem responsável. Retorna quantos foram distribuídos e para quem. */
export async function distributeUnassigned(db: Db, tenantId: string) {
  const leads = await scoped(db, tenantId).rows<{ id: string }>(
    `SELECT id FROM leads WHERE tenant_id = $1 AND status = 'open' AND owner_id IS NULL ORDER BY created_at`);
  const perBroker: Record<string, number> = {};
  for (const l of leads) {
    const b = await assignRoundRobin(db, tenantId, l.id, { onlyIfUnassigned: true });
    if (!b) continue;
    perBroker[b] = (perBroker[b] ?? 0) + 1;
  }
  return { distributed: Object.values(perBroker).reduce((a, n) => a + n, 0), pending: leads.length, perBroker };
}
