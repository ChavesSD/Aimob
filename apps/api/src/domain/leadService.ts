import type { Db } from '../db/client.js';
import { scoped } from '../db/client.js';
import { scoreLead } from './scoring.js';

/** Recalcula e persiste o score de um lead com os sinais atuais. */
export async function rescoreLead(db: Db, tenantId: string, leadId: string) {
  const q = scoped(db, tenantId);
  const [l] = await q.rows<any>(
    `SELECT l.source, l.budget_cents, l.property_id, l.stage_position, l.created_at, l.last_contact_at, c.phone,
            (SELECT count(*)::int FROM visits v WHERE v.tenant_id = l.tenant_id AND v.lead_id = l.id AND v.status IN ('scheduled','completed')) visits
       FROM leads l JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1 AND l.id = $2`, [leadId]);
  if (!l) return null;
  const h = (d: string | null) => (d ? (Date.now() - new Date(d).getTime()) / 3_600_000 : null);
  const r = scoreLead({
    source: l.source, hasBudget: !!l.budget_cents, hasPhone: !!l.phone, hasPropertyInterest: !!l.property_id,
    hoursSinceCreated: h(l.created_at)!, hoursSinceLastContact: h(l.last_contact_at), visits: l.visits, stagePosition: l.stage_position,
  });
  await q.rows(`UPDATE leads SET score = $2, score_reasons = $3, updated_at = now() WHERE tenant_id = $1 AND id = $4 RETURNING id`,
    [r.score, JSON.stringify(r.reasons), leadId]);
  return r;
}
