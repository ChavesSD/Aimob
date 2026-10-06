import { z } from 'zod';
import type { Db } from '../db/client.js';
import { scoped } from '../db/client.js';
import { assignLead, pickBroker, withTenantLock } from './distribution.js';

export const TRIGGERS = ['lead.created', 'lead.stage_changed', 'visit.completed', 'lead.idle'] as const;
export type Trigger = (typeof TRIGGERS)[number];

const FIELDS = ['source', 'score', 'budget_cents', 'stage_position', 'hours_idle', 'has_owner', 'outcome'] as const;
export const conditionSchema = z.object({
  field: z.enum(FIELDS),
  op: z.enum(['=', '!=', '>', '>=', '<', '<=']),
  value: z.union([z.string().max(60), z.number(), z.boolean()]),
});
// Lista fechada de ações: nenhuma envia mensagem externa nem altera valores financeiros ou contratos.
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create_task'), title: z.string().min(3).max(140), dueInHours: z.number().min(0).max(24 * 30) }),
  z.object({ type: z.literal('notify_managers'), message: z.string().min(3).max(200) }),
  z.object({ type: z.literal('assign_round_robin') }),
]);
export const ruleSchema = z.object({
  name: z.string().min(3).max(120),
  trigger: z.enum(TRIGGERS),
  conditions: z.array(conditionSchema).max(8).default([]),
  actions: z.array(actionSchema).min(1).max(5),
  autonomy: z.enum(['automatic', 'assisted']).default('automatic'),
});
export type Condition = z.infer<typeof conditionSchema>;
export type Action = z.infer<typeof actionSchema>;
export type RuleInput = z.infer<typeof ruleSchema>;

/** Modelos prontos: a gestão ativa com um clique. Única fonte (API e tela leem daqui). */
export const TEMPLATES: (RuleInput & { id: string; description: string })[] = [
  { id: 'retorno-portal', name: 'Lead de portal com bom score: retorno em 1h', trigger: 'lead.created', autonomy: 'automatic',
    description: 'Cria uma tarefa para o corretor responsável retornar o contato em até 1 hora.',
    conditions: [{ field: 'source', op: '=', value: 'portal' }, { field: 'score', op: '>=', value: 40 }],
    actions: [{ type: 'create_task', title: 'Retornar contato do lead de portal (até 1h)', dueInHours: 1 }] },
  { id: 'rodizio-canal', name: 'Lead sem responsável: distribuir por rodízio', trigger: 'lead.created', autonomy: 'automatic',
    description: 'Se o lead chega sem corretor, atribui automaticamente ao próximo da fila.',
    conditions: [{ field: 'has_owner', op: '=', value: false }],
    actions: [{ type: 'assign_round_robin' }] },
  { id: 'lead-parado-72h', name: 'Lead parado há 72h: follow-up e aviso à gestão', trigger: 'lead.idle', autonomy: 'automatic',
    description: 'Evita lead esquecido: cria tarefa de follow-up e avisa gerentes.',
    conditions: [{ field: 'hours_idle', op: '>=', value: 72 }],
    actions: [{ type: 'create_task', title: 'Fazer follow-up: lead sem contato há 72h', dueInHours: 4 }, { type: 'notify_managers', message: 'Há lead sem contato há mais de 72 horas.' }] },
  { id: 'pos-visita', name: 'Visita realizada: follow-up em 24h', trigger: 'visit.completed', autonomy: 'automatic',
    description: 'Após registrar o resultado da visita, agenda o follow-up para o dia seguinte.',
    conditions: [{ field: 'outcome', op: '!=', value: 'nao_compareceu' }],
    actions: [{ type: 'create_task', title: 'Follow-up pós-visita', dueInHours: 24 }] },
  { id: 'alto-valor', name: 'Negociação de alto valor: gestão acompanha', trigger: 'lead.stage_changed', autonomy: 'assisted',
    description: 'Quando uma oportunidade acima de R$ 1 milhão chega à proposta, prepara o aviso à gestão e espera aprovação.',
    conditions: [{ field: 'stage_position', op: '>=', value: 5 }, { field: 'budget_cents', op: '>=', value: 100_000_000 }],
    actions: [{ type: 'notify_managers', message: 'Oportunidade de alto valor avançou para a proposta.' }] },
];

interface Facts { source: string; score: number; budget_cents: number; stage_position: number; hours_idle: number; has_owner: boolean; outcome: string }

export function evaluate(conditions: Condition[], facts: Partial<Facts>): boolean {
  return conditions.every((c) => {
    const actual = facts[c.field];
    if (actual === undefined || actual === null) return false; // fato indisponível nunca satisfaz condição
    const a = actual as string | number | boolean, v = c.value;
    switch (c.op) {
      case '=': return a === v;
      case '!=': return a !== v;
      case '>': return a > v;
      case '>=': return a >= v;
      case '<': return a < v;
      case '<=': return a <= v;
    }
  });
}

async function loadFacts(db: Db, tid: string, leadId: string) {
  const [l] = await scoped(db, tid).rows<any>(
    `SELECT source, score, coalesce(budget_cents, 0) budget_cents, stage_position, owner_id,
            extract(epoch FROM (now() - coalesce(last_contact_at, created_at))) / 3600 AS hours_idle,
            coalesce(last_contact_at, created_at) AS idle_since
       FROM leads WHERE tenant_id = $1 AND id = $2 AND status = 'open'`, [leadId]);
  if (!l) return null;
  return { owner: l.owner_id as string | null, idleSince: new Date(l.idle_since).toISOString(),
    facts: { source: l.source, score: l.score, budget_cents: Number(l.budget_cents), stage_position: l.stage_position,
      hours_idle: Number(l.hours_idle), has_owner: !!l.owner_id } as Partial<Facts> };
}

async function managerIds(db: Db, tid: string): Promise<string[]> {
  return (await scoped(db, tid).rows<{ id: string }>(
    `SELECT id FROM users WHERE tenant_id = $1 AND active AND role IN ('owner','manager')`)).map((r) => r.id);
}

/** Executa as ações de uma regra para um lead. Retorna um resumo legível para o log. */
export async function executeActions(db: Db, tid: string, actions: Action[], leadId: string): Promise<string> {
  const s = scoped(db, tid);
  const done: string[] = [];
  for (const a of actions) {
    if (a.type === 'create_task') {
      const [lead] = await s.rows<{ owner_id: string | null }>(`SELECT owner_id FROM leads WHERE tenant_id = $1 AND id = $2`, [leadId]);
      const assignee = lead?.owner_id ?? (await managerIds(db, tid))[0] ?? null;
      await s.rows(
        `INSERT INTO tasks (tenant_id, lead_id, assignee_id, title, due_at, source) VALUES ($1,$2,$3,$4, now() + ($5 || ' hours')::interval, 'automation')`,
        [leadId, assignee, a.title, String(a.dueInHours)]);
      done.push(`tarefa criada: "${a.title}"`);
    } else if (a.type === 'notify_managers') {
      for (const uid of await managerIds(db, tid)) {
        // Agrupa avisos idênticos ainda não lidos em um só (com contador) para não bombardear a gestão.
        const merged = await s.rows(
          `UPDATE notifications SET count = count + 1, created_at = now() WHERE tenant_id = $1 AND user_id = $2 AND message = $3 AND read_at IS NULL RETURNING id`,
          [uid, a.message]);
        if (!merged.length) {
          await s.rows(`INSERT INTO notifications (tenant_id, user_id, message, href) VALUES ($1,$2,$3,$4)`, [uid, a.message, '/crm']);
        }
      }
      done.push('gestores notificados');
    } else if (a.type === 'assign_round_robin') {
      const n = await withTenantLock(tid, async () => {
        const [cur] = await s.rows<{ owner_id: string | null }>(`SELECT owner_id FROM leads WHERE tenant_id = $1 AND id = $2`, [leadId]);
        if (cur?.owner_id) return 'já tinha responsável';
        const b = await pickBroker(db, tid);
        if (!b) return 'nenhum corretor disponível';
        await assignLead(db, tid, leadId, b);
        return 'atribuído por rodízio';
      });
      done.push(n);
    }
  }
  return done.join('; ');
}

/**
 * Dispara as regras ativas de um gatilho para um lead. Nunca lança: falha de automação não pode derrubar a operação.
 * Idempotente: (regra, lead, dedupe_key) é único, então o mesmo evento não executa duas vezes.
 */
export async function fireTrigger(db: Db, tid: string, trigger: Trigger, leadId: string, extra: { dedupe?: string; outcome?: string } = {}) {
  try {
    const rules = await scoped(db, tid).rows<any>(
      `SELECT id, conditions, actions, autonomy FROM automation_rules WHERE tenant_id = $1 AND enabled AND trigger = $2`, [trigger]);
    if (!rules.length) return;
    const ctx = await loadFacts(db, tid, leadId);
    if (!ctx) return;
    const facts = { ...ctx.facts, ...(extra.outcome ? { outcome: extra.outcome } : {}) };
    const key = extra.dedupe ?? (trigger === 'lead.idle' ? `idle:${ctx.idleSince}` : trigger);
    for (const r of rules) {
      if (!evaluate(r.conditions, facts)) continue;
      const status = r.autonomy === 'automatic' ? 'executing' : 'pending_approval';
      const ins = await scoped(db, tid).rows(
        `INSERT INTO automation_runs (tenant_id, rule_id, lead_id, dedupe_key, status) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (rule_id, lead_id, dedupe_key) DO NOTHING RETURNING id`, [r.id, leadId, key, status]);
      if (!ins.length) continue;
      if (r.autonomy !== 'automatic') continue;
      try {
        const detail = await executeActions(db, tid, r.actions, leadId);
        await scoped(db, tid).rows(`UPDATE automation_runs SET status = 'executed', detail = $2 WHERE tenant_id = $1 AND id = $3 RETURNING id`, [detail, ins[0].id]);
      } catch (e: any) {
        await scoped(db, tid).rows(`UPDATE automation_runs SET status = 'failed', detail = $2 WHERE tenant_id = $1 AND id = $3 RETURNING id`, [String(e.message).slice(0, 300), ins[0].id]);
      }
    }
  } catch (e) {
    console.error('automation: falha ao disparar', trigger, e);
  }
}

/** Gatilho por tempo: varre leads abertos de tenants com regras lead.idle ativas. */
export async function sweepIdle(db: Db, onlyTenant?: string): Promise<number> {
  const { rows: tenants } = await db.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM automation_rules WHERE enabled AND trigger = 'lead.idle' ${onlyTenant ? 'AND tenant_id = $1' : ''}`,
    onlyTenant ? [onlyTenant] : []);
  let fired = 0;
  for (const { tenant_id } of tenants) {
    const leads = await scoped(db, tenant_id).rows<{ id: string }>(
      `SELECT id FROM leads WHERE tenant_id = $1 AND status = 'open' AND coalesce(last_contact_at, created_at) < now() - interval '1 hour' LIMIT 1000`);
    for (const l of leads) { await fireTrigger(db, tenant_id, 'lead.idle', l.id); fired++; }
  }
  return fired;
}
