export interface PropertyFacts {
  photos: number; description: string; priceCents: number; area: number | null;
  neighborhood: string; daysOnMarket: number; leads: number; visits: number;
}

export function propertyHealth(p: PropertyFacts): { score: number; issues: string[]; diagnosis: string } {
  let score = 100;
  const issues: string[] = [];
  const hit = (pts: number, msg: string) => { score -= pts; issues.push(msg); };
  if (p.photos < 5) hit(p.photos === 0 ? 30 : 15, `apenas ${p.photos} foto(s); o ideal é 5 ou mais`);
  if (p.description.trim().length < 80) hit(15, 'descrição curta ou ausente');
  if (!p.priceCents) hit(25, 'sem preço');
  if (!p.area) hit(8, 'sem metragem');
  if (!p.neighborhood) hit(8, 'sem bairro');
  if (p.daysOnMarket > 90 && p.visits === 0) hit(20, `${p.daysOnMarket} dias no mercado sem visitas`);
  else if (p.leads > 5 && p.visits === 0) hit(12, 'recebe contatos mas não converte em visitas');
  score = Math.max(0, score);
  const diagnosis = issues.length ? `Principal ponto de atenção: ${issues[0]}.` : 'Cadastro completo e sem alertas.';
  return { score, issues, diagnosis };
}
