export interface LeadSignals {
  source: string;
  hasBudget: boolean;
  hasPhone: boolean;
  hasPropertyInterest: boolean;
  hoursSinceCreated: number;
  hoursSinceLastContact: number | null;
  visits: number;
  stagePosition: number;
}

export type Heat = 'frio' | 'morno' | 'quente' | 'muito_quente';

const SOURCE_POINTS: Record<string, number> = { indicacao: 20, portal: 12, site: 12, whatsapp: 15, manual: 6 };

/** Pontuação explicável: cada componente gera um motivo legível. */
export function scoreLead(s: LeadSignals): { score: number; heat: Heat; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const add = (pts: number, why: string) => { score += pts; reasons.push(`+${pts} ${why}`); };

  add(SOURCE_POINTS[s.source] ?? 6, `origem: ${s.source}`);
  if (s.hasBudget) add(15, 'informou faixa de preço');
  if (s.hasPhone) add(8, 'telefone disponível');
  if (s.hasPropertyInterest) add(15, 'demonstrou interesse em imóvel específico');
  if (s.visits > 0) add(Math.min(25, 15 + (s.visits - 1) * 5), `${s.visits} visita(s) realizada(s) ou agendada(s)`);
  if (s.stagePosition > 0) add(Math.min(15, s.stagePosition * 3), 'avanço no funil');
  if (s.hoursSinceLastContact !== null && s.hoursSinceLastContact <= 48) add(8, 'contato recente');
  if (s.hoursSinceLastContact === null && s.hoursSinceCreated > 24) {
    score -= 15; reasons.push('-15 sem nenhum contato há mais de 24h');
  }
  if (s.hoursSinceLastContact !== null && s.hoursSinceLastContact > 24 * 14) {
    score -= 15; reasons.push('-15 sem contato há mais de 14 dias');
  }

  score = Math.max(0, Math.min(100, score));
  const heat: Heat = score >= 75 ? 'muito_quente' : score >= 55 ? 'quente' : score >= 30 ? 'morno' : 'frio';
  return { score, heat, reasons };
}
