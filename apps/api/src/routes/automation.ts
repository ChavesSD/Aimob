import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { scoped } from '../db/client.js';
import { audit } from '../audit.js';
import { guard } from '../guard.js';
import { TEMPLATES, executeActions, ruleSchema, sweepIdle } from '../domain/automation.js';

const uuid = z.string().uuid();

export function registerAutomationRoutes(app: FastifyInstance, db: Db) {
  // ---- Regras ----
  app.get('/api/automations', { preHandler: guard('leads', 'admin') }, async (req) => {
    const s = scoped(db, req.session!.tid);
    const rules = await s.rows(`SELECT id, name, trigger, conditions, actions, autonomy, enabled, created_at FROM automation_rules WHERE tenant_id = $1 ORDER BY created_at DESC`);
    const runs = await s.rows(
      `SELECT r.id, r.status, r.detail, r.created_at, a.name AS rule_name, c.name AS lead_name
         FROM automation_runs r JOIN automation_rules a ON a.id = r.rule_id AND a.tenant_id = r.tenant_id
         LEFT JOIN leads l ON l.id = r.lead_id AND l.tenant_id = r.tenant_id
         LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1 ORDER BY r.created_at DESC LIMIT 50`);
    return { rules, runs, templates: TEMPLATES };
  });

  app.post('/api/automations', { preHandler: guard('leads', 'admin') }, async (req, reply) => {
    const body = z.object({ templateId: z.string().optional() }).passthrough().parse(req.body);
    const tpl = body.templateId ? TEMPLATES.find((t) => t.id === body.templateId) : undefined;
    if (body.templateId && !tpl) return reply.code(404).send({ error: 'Modelo não encontrado.' });
    const input = ruleSchema.parse(tpl ?? req.body);
    const s = scoped(db, req.session!.tid);
    const [r] = await s.rows(
      `INSERT INTO automation_rules (tenant_id, name, trigger, conditions, actions, autonomy, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.name, input.trigger, JSON.stringify(input.conditions), JSON.stringify(input.actions), input.autonomy, req.session!.sub]);
    await audit(db, req, { action: 'automation.create', resource: 'automation', resourceId: r.id, after: input, summary: `Automação "${input.name}" criada` });
    return reply.code(201).send(r);
  });

  app.patch('/api/automations/:id', { preHandler: guard('leads', 'admin') }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ enabled: z.boolean() }).parse(req.body);
    const [r] = await scoped(db, req.session!.tid).rows<{ name: string }>(
      `UPDATE automation_rules SET enabled = $2 WHERE tenant_id = $1 AND id = $3 RETURNING name`, [b.enabled, id]);
    if (!r) return reply.code(404).send({ error: 'Automação não encontrada.' });
    await audit(db, req, { action: 'automation.toggle', resource: 'automation', resourceId: id, after: b, summary: `Automação "${r.name}" ${b.enabled ? 'ligada' : 'desligada'}` });
    return { ok: true };
  });

  app.post('/api/automations/sweep', { preHandler: guard('leads', 'admin') }, async (req) => {
    return { checked: await sweepIdle(db, req.session!.tid) };
  });

  // ---- Aprovações (autonomia "assistida") ----
  for (const decision of ['approve', 'reject'] as const) {
    app.post(`/api/automation-runs/:id/${decision}`, { preHandler: guard('leads', 'admin') }, async (req, reply) => {
      const id = uuid.parse((req.params as any).id);
      const s = scoped(db, req.session!.tid);
      const [run] = await s.rows<any>(
        `SELECT r.id, r.lead_id, r.status, a.actions, a.name FROM automation_runs r JOIN automation_rules a ON a.id = r.rule_id AND a.tenant_id = r.tenant_id
          WHERE r.tenant_id = $1 AND r.id = $2`, [id]);
      if (!run) return reply.code(404).send({ error: 'Execução não encontrada.' });
      if (run.status !== 'pending_approval') return reply.code(409).send({ error: 'Esta execução já foi decidida.' });
      let status = 'rejected', detail = 'rejeitada pela gestão';
      if (decision === 'approve') {
        try { detail = await executeActions(db, req.session!.tid, run.actions, run.lead_id); status = 'executed'; }
        catch (e: any) { status = 'failed'; detail = String(e.message).slice(0, 300); }
      }
      await s.rows(`UPDATE automation_runs SET status = $2, detail = $3, decided_by = $4 WHERE tenant_id = $1 AND id = $5 RETURNING id`,
        [status, detail, req.session!.sub, id]);
      await audit(db, req, { action: `automation.${decision}`, resource: 'automation_run', resourceId: id, summary: `Execução de "${run.name}" ${decision === 'approve' ? 'aprovada' : 'rejeitada'}` });
      return { ok: true, status, detail };
    });
  }

  // ---- Tarefas e notificações ----
  app.get('/api/tasks', { preHandler: guard('leads', 'view') }, async (req) => {
    const q = z.object({ escopo: z.enum(['minhas', 'todas']).default('minhas') }).parse(req.query);
    const s = scoped(db, req.session!.tid);
    const all = q.escopo === 'todas' && ['owner', 'manager'].includes(req.session!.role);
    const items = await s.rows(
      `SELECT t.id, t.title, t.due_at, t.status, t.source, c.name AS lead_name, u.name AS assignee_name
         FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id AND l.tenant_id = t.tenant_id
         LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = t.tenant_id
         LEFT JOIN users u ON u.id = t.assignee_id AND u.tenant_id = t.tenant_id
        WHERE t.tenant_id = $1 AND t.status = 'open' ${all ? '' : 'AND t.assignee_id = $2'} ORDER BY t.due_at NULLS LAST LIMIT 200`,
      all ? [] : [req.session!.sub]);
    return { items };
  });

  app.post('/api/tasks/:id/complete', { preHandler: guard('leads', 'edit') }, async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const mine = ['owner', 'manager'].includes(req.session!.role) ? '' : 'AND assignee_id = $3';
    const rows = await scoped(db, req.session!.tid).rows(
      `UPDATE tasks SET status = 'done', completed_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'open' ${mine} RETURNING id`,
      mine ? [id, req.session!.sub] : [id]);
    if (!rows.length) return reply.code(404).send({ error: 'Tarefa não encontrada.' });
    return { ok: true };
  });

  app.get('/api/notifications', { preHandler: guard('dashboard', 'view') }, async (req) => {
    const items = await scoped(db, req.session!.tid).rows(
      `SELECT id, message, href, read_at, created_at, count FROM notifications WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 50`, [req.session!.sub]);
    return { items, unread: items.filter((n: any) => !n.read_at).reduce((sum: number, n: any) => sum + n.count, 0) };
  });

  app.post('/api/notifications/read', { preHandler: guard('dashboard', 'view') }, async (req) => {
    await scoped(db, req.session!.tid).rows(
      `UPDATE notifications SET read_at = now() WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL RETURNING id`, [req.session!.sub]);
    return { ok: true };
  });
}
