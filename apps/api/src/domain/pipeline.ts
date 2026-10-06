// Etapas padrão. Pipelines personalizáveis por tenant (tabela pipeline_stages) entram numa próxima etapa.
export const PIPELINES: Record<string, string[]> = {
  venda: ['Novo lead', 'Primeiro contato', 'Qualificado', 'Imóveis enviados', 'Visita', 'Proposta', 'Negociação', 'Documentação', 'Contrato', 'Fechado'],
  locacao: ['Lead', 'Qualificado', 'Imóvel enviado', 'Visita', 'Documentação', 'Análise', 'Aprovação', 'Contrato', 'Assinatura', 'Ativo'],
};
