export const PAINS = [
  'leads_perdidos', 'follow_up', 'planilhas', 'visitas', 'distribuicao', 'financeiro', 'transparencia_proprietario', 'relatorios',
] as const;
export type Pain = (typeof PAINS)[number];

// "available": o produto já resolve hoje. Dores sem disponibilidade são ditas como roadmap, nunca como entrega.
const PAIN_INFO: Record<Pain, { insight: string; available: boolean; how: string }> = {
  leads_perdidos: { available: true, insight: 'recuperação de leads que ficam sem resposta',
    how: 'O painel mostra quantos leads estão sem primeiro atendimento e quanto dinheiro está em oportunidades sem próxima ação.' },
  follow_up: { available: true, insight: 'follow-up e acompanhamento de visitas',
    how: 'Automações criam a tarefa de follow-up depois da visita e quando um lead fica parado, e o score explica quem priorizar.' },
  planilhas: { available: true, insight: 'tirar a operação das planilhas',
    how: 'Leads, imóveis, visitas e tarefas ficam em um só lugar, com histórico e auditoria de quem mudou o quê.' },
  visitas: { available: true, insight: 'agenda e resultado das visitas',
    how: 'A agenda bloqueia conflito de horário e o resultado da visita realimenta o score do lead.' },
  distribuicao: { available: true, insight: 'distribuição justa de leads entre corretores',
    how: 'Rodízio automático entre corretores ativos, com opção de atribuição manual pela gestão.' },
  financeiro: { available: false, insight: 'financeiro, cobrança e repasses',
    how: 'Locação, cobrança e repasses estão no roadmap e ainda não fazem parte do produto.' },
  transparencia_proprietario: { available: false, insight: 'transparência para o proprietário do imóvel',
    how: 'O portal do proprietário está no roadmap e ainda não está disponível.' },
  relatorios: { available: true, insight: 'visão da operação em tempo real',
    how: 'O painel inicial resume leads, visitas e o que precisa de atenção, cada alerta com uma ação.' },
};

export function buildDiagnosis(pains: Pain[], opts: { sells: boolean; rents: boolean }): string {
  if (!pains.length) {
    return 'Obrigado pelas respostas. Sem uma dor principal marcada, o melhor ponto de partida é medir o tempo de primeiro atendimento e quantos leads ficam sem próxima ação.';
  }
  const [main, ...rest] = pains;
  const m = PAIN_INFO[main];
  const parts = [`Sua maior oportunidade parece estar em ${m.insight}. ${m.how}`];
  const avail = rest.filter((p) => PAIN_INFO[p].available).map((p) => PAIN_INFO[p].insight);
  if (avail.length) parts.push(`Também já podemos ajudar em: ${avail.join('; ')}.`);
  const road = [main, ...rest].filter((p) => !PAIN_INFO[p].available).map((p) => PAIN_INFO[p].insight);
  if (road.length) parts.push(`Em desenvolvimento (ainda indisponível): ${road.join('; ')}.`);
  if (opts.rents && !opts.sells) parts.push('Como seu foco é locação, vale saber que o produto hoje cobre melhor a parte comercial (leads, visitas, pipeline); a gestão de contratos e cobrança de locação ainda está no roadmap.');
  return parts.join(' ');
}
