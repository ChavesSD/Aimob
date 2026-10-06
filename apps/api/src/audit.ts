import type { FastifyRequest } from 'fastify';
import type { Db } from './db/client.js';

export interface AuditEntry {
  action: string; resource?: string; resourceId?: string; before?: unknown; after?: unknown; summary?: string;
}

/** Registro de ação do próprio sistema (webhook, rotina automática): sem usuário nem IP. */
export async function auditSystem(db: Db, tenantId: string, e: AuditEntry) {
  await db.query(
    `INSERT INTO audit_log (tenant_id, actor_id, ip, action, resource, resource_id, before, after, summary)
     VALUES ($1,NULL,NULL,$2,$3,$4,$5,$6,$7)`,
    [tenantId, e.action, e.resource ?? null, e.resourceId ?? null,
      e.before ? JSON.stringify(e.before) : null, e.after ? JSON.stringify(e.after) : null, e.summary ?? null],
  );
}

export async function audit(db: Db, req: FastifyRequest, e: AuditEntry) {
  await db.query(
    `INSERT INTO audit_log (tenant_id, actor_id, ip, action, resource, resource_id, before, after, summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [req.session?.tid ?? null, req.session?.sub ?? null, req.ip, e.action, e.resource ?? null, e.resourceId ?? null,
      e.before ? JSON.stringify(e.before) : null, e.after ? JSON.stringify(e.after) : null, e.summary ?? null],
  );
}
