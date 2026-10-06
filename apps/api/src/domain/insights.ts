import type { Db } from '../db/client.js';
import { scoped } from '../db/client.js';
import { can } from '../permissions.js';

export interface Insight {
  id: string;
  severity: 'alta' | 'media' | 'baixa';
  title: string;
  count: number;
  amountCents?: number;
  action: { label: string; href: string };
}

/** "O que precisa da sua atenção?" — cada alerta carrega uma ação. */
export async function attentionInsights(db: Db, tenantId: string, role = 'owner'): Promise<Insight[]> {
  const q = scoped(db, tenantId);
  const out: Insight[] = [];
  const money = (v: string | null) => (v ? Number(v) : undefined);
  const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // Alertas de locação/financeiro só para quem tem permissão de ver esses módulos.
  if (can(role, 'finance', 'view')) {
    const [od] = await q.rows<{ n: number; total: string | null }>(
      `SELECT count(*)::int n, sum(amount_cents) total FROM rental_charges
        WHERE tenant_id = $1 AND status = 'open' AND due_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date`);
    if (od.n) out.push({
      id: 'cobrancas-vencidas', severity: 'alta', count: od.n, amountCents: money(od.total),
      title: `${od.n} cobrança(s) de aluguel vencida(s)${od.total ? ` (${brl(Number(od.total))} em principal)` : ''}`,
      action: { label: 'Ver inadimplência', href: '/locacao?aba=inadimplencia' },
    });
    const [po] = await q.rows<{ n: number; total: string | null }>(
      `SELECT count(*)::int n, sum(net_cents) total FROM rental_payouts WHERE tenant_id = $1 AND status = 'pending'`);
    if (po.n) out.push({
      id: 'repasses-pendentes', severity: 'media', count: po.n, amountCents: money(po.total),
      title: `${po.n} repasse(s) a proprietários aguardando pagamento`,
      action: { label: 'Fazer repasses', href: '/locacao?aba=repasses' },
    });
  }
  if (can(role, 'rentals', 'view')) {
    const [adj] = await q.rows<{ n: number }>(
      `SELECT count(*)::int n FROM rental_contracts c WHERE c.tenant_id = $1 AND c.status = 'active'
          AND (coalesce((SELECT max(applied_on) FROM rental_adjustments a WHERE a.tenant_id = c.tenant_id AND a.contract_id = c.id), c.start_date) + interval '1 year')::date
              <= (now() AT TIME ZONE 'America/Sao_Paulo')::date + 60`);
    if (adj.n) out.push({
      id: 'reajustes-pendentes', severity: 'media', count: adj.n,
      title: `${adj.n} contrato(s) com reajuste anual próximo ou pendente`,
      action: { label: 'Aplicar reajustes', href: '/locacao?aba=reajustes' },
    });
  }

  const [unassigned] = await q.rows<{ n: number }>(
    `SELECT count(*)::int n FROM leads WHERE tenant_id = $1 AND status = 'open' AND owner_id IS NULL`);
  if (unassigned.n) out.push({
    id: 'leads-sem-responsavel', severity: 'alta', count: unassigned.n,
    title: `${unassigned.n} lead(s) sem corretor responsável`,
    action: { label: 'Atribuir corretor', href: '/crm?filtro=sem-responsavel' },
  });

  const [noReply] =await q.rows<{ n: number }>(
    `SELECT count(*)::int n FROM leads WHERE tenant_id = $1 AND status = 'open'
       AND first_response_at IS NULL AND created_at < now() - interval '1 hour'`);
  if (noReply.n) out.push({
    id: 'leads-sem-atendimento', severity: 'alta', count: noReply.n,
    title: `${noReply.n} lead(s) sem primeiro atendimento há mais de 1h`,
    action: { label: 'Atender agora', href: '/crm?filtro=sem-atendimento' },
  });

  const [stale] = await q.rows<{ n: number; total: string | null }>(
    `SELECT count(*)::int n, sum(budget_cents) total FROM leads WHERE tenant_id = $1 AND status = 'open'
       AND first_response_at IS NOT NULL AND coalesce(last_contact_at, created_at) < now() - interval '3 days'`);
  if (stale.n) out.push({
    id: 'negociacoes-paradas', severity: 'alta', count: stale.n, amountCents: money(stale.total),
    title: `${stale.n} oportunidade(s) sem contato há mais de 3 dias`,
    action: { label: 'Fazer follow-up', href: '/crm?filtro=paradas' },
  });

  const [noNext] = await q.rows<{ n: number; total: string | null }>(
    `SELECT count(*)::int n, sum(budget_cents) total FROM leads
      WHERE tenant_id = $1 AND status = 'open' AND next_action_at IS NULL`);
  if (noNext.n) out.push({
    id: 'sem-proxima-acao', severity: 'media', count: noNext.n, amountCents: money(noNext.total),
    title: `${noNext.n} oportunidade(s) sem próxima ação definida`,
    action: { label: 'Definir próximos passos', href: '/crm?filtro=sem-proxima-acao' },
  });

  const [lowPhotos] = await q.rows<{ n: number }>(
    `SELECT count(*)::int n FROM properties
      WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'active' AND photos < 5`);
  if (lowPhotos.n) out.push({
    id: 'imoveis-poucas-fotos', severity: 'baixa', count: lowPhotos.n,
    title: `${lowPhotos.n} imóvel(is) ativo(s) com menos de 5 fotos`,
    action: { label: 'Corrigir anúncios', href: '/imoveis?filtro=poucas-fotos' },
  });

  const [visitsNoFb] = await q.rows<{ n: number }>(
    `SELECT count(*)::int n FROM visits
      WHERE tenant_id = $1 AND status = 'scheduled' AND scheduled_at < now() - interval '1 day'`);
  if (visitsNoFb.n) out.push({
    id: 'visitas-sem-retorno', severity: 'media', count: visitsNoFb.n,
    title: `${visitsNoFb.n} visita(s) passadas sem registro de resultado`,
    action: { label: 'Registrar feedback', href: '/agenda?filtro=sem-feedback' },
  });

  const order = { alta: 0, media: 1, baixa: 2 } as const;
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}
