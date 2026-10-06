import type { FastifyRequest } from 'fastify';
import type { Db } from './db/client.js';

export interface AuditEntry {
  action: string; resource?: string; resourceId?: string; before?: unknown; after?: unknown; summary?: string;
}

export async function audit(db: Db, req: FastifyRequest, e: AuditEntry) {
  await db.query(
    `INSERT INTO audit_log (tenant_id, actor_id, ip, action, resource, resource_id, before, after, summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [req.session?.tid ?? null, req.session?.sub ?? null, req.ip, e.action, e.resource ?? null, e.resourceId ?? null,
      e.before ? JSON.stringify(e.before) : null, e.after ? JSON.stringify(e.after) : null, e.summary ?? null],
  );
}
