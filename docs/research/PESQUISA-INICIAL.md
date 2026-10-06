# Pesquisa inicial — SaaS imobiliário multi-tenant (Aimob)

Data de consulta de todas as fontes: **2026-10-05**.
Legenda: **[CONFIRMADO]** = visto em fonte oficial/primária nesta pesquisa; **[SECUNDÁRIO]** = visto só em blog/agregador/notícia; **[INCERTO]** = não verificado ou fontes conflitantes. Nada aqui é aconselhamento jurídico/tributário: validar com advogado e contador antes de implementar regras.

---

## 1. Concorrentes

### 1.1 Brasil (Kenlo, Superlógica Imobi, Jetimob, Vista/Loft, Tecimob, Imobzi, inGaia)

Fontes: comparativos [b2bstack (Jetimob x Kenlo)](https://www.b2bstack.com.br/compare/jetimob-vs-kenlo), [b2bstack (Superlógica x Kenlo)](https://www.b2bstack.com.br/compare/superlogica-imobiliarias-vs-kenlo), [b2bstack (Tecimob x Kenlo)](https://www.b2bstack.com.br/compare/tecimob-vs-kenlo), [Capterra Imobzi](https://www.capterra.com/p/217051/Imobzi/reviews/), [Capterra Jetimob](https://www.capterra.com/p/219114/Jetimob/alternatives/), [Imobzi — integração Canal Pro](https://help.imobzi.com/pt-br/article/como-integrar-com-o-canal-pro-grupo-olx-xo0pih/). **[SECUNDÁRIO]**: não foi possível ler os sites oficiais de preço/funcionalidade de cada um nesta rodada. Vista e Loft não retornaram dados úteis **[INCERTO]**.

| Player | Posicionamento (segundo as fontes) | Observações |
|---|---|---|
| Kenlo (inclui inGaia/iValue) | Suíte ampla: CRM, locação, assinatura digital, gestão de contratos, site, app mobile | inGaia/i-Value aparece sob a marca Kenlo no Reclame Aqui |
| Superlógica Imobiliárias | Gestão completa, do cadastro de imóveis à geração de DIMOB; forte em administração de locação | Perfil "ERP" |
| Jetimob | Locação, relacionamento com clientes, funil de vendas | Avaliado positivamente em reviews isolados |
| Tecimob | CRM integrado + site da imobiliária | Foco em corretor/imobiliária pequena |
| Imobzi | CRM + gestão; a partir de R$ 129/mês (b2bstack, pode estar defasado); suporte por e-mail/chat/telefone | Integra com Canal Pro (Grupo OLX) |
| Vista, Loft | **[INCERTO]** | Reavaliar com fontes oficiais |

**Commodity (esperado de qualquer concorrente):** cadastro de imóveis e fotos, site/vitrine, CRM com funil, integração com portais via XML, agenda, contratos com assinatura digital, boleto/Pix de aluguel, repasse a proprietário, DIMOB, app mobile.

**Diferenciais possíveis (onde há espaço):** IA de atendimento/qualificação com rastreabilidade e transparência (ver seção 2), WhatsApp oficial nativo e conversacional, onboarding rápido com migração automática de base, UX moderna, preço transparente, API aberta/webhooks, financeiro de locação sem planilha (conciliação Pix automática, split de repasse), portal do proprietário/inquilino.

**Principais reclamações públicas (padrões):**
- Suporte ineficiente/difícil de contatar; IA/bot como barreira ao suporte humano: [Reclame Aqui — Kenlo](https://www.reclameaqui.com.br/ingaia-i-value/dificuldade-em-salvar-fotos-de-imoveis-no-website-e-suporte-ineficiente-da-kenlo_wLeSjKXjvgPQIX6S/).
- Cobrança indevida e boletos duplicados após migração: [Reclame Aqui — Kenlo](https://www.reclameaqui.com.br/ingaia-i-value/descaso-e-negligencia-apos-decisao-de-migracao-boletos-duplicados-cobrancas-indevidas-e-dificuldade-de-contato-com-a-kenlo_sgGie4El0EGxC1hN/).
- Falhas recorrentes e suporte sem solução na Superlógica (cerca de 1.031 reclamações ativas segundo a página): [caso](https://www.reclameaqui.com.br/superlogica/falhas-recorrentes-no-sistema-superlogica-e-suporte-sem-solucao_vTku95Oh2PrpdW0y/), [lista](https://www.reclameaqui.com.br/empresa/superlogica/lista-reclamacoes/).
- Bugs e instabilidade/sistema fora do ar (relato de usuário que saiu da Kenlo/inGaia), via b2bstack.
- Jetimob/Tecimob/Imobzi: não foram encontradas páginas de reclamação específicas **[INCERTO]**; ler o Reclame Aqui diretamente antes de decidir o posicionamento.

### 1.2 Internacionais (Buildium, Yardi)

Fontes: [Capterra Yardi Breeze](https://capterra.com/p/164741/Yardi-Breeze/reviews/), [rfp.wiki Buildium x Yardi Breeze](https://www.rfp.wiki/specialty-industries/real-estate-property/buildium/yardi-breeze) **[SECUNDÁRIO]**.
- Notas: Buildium 4,5 (Capterra, cerca de 2.207 avaliações) e 4,4 (G2); Yardi Breeze 4,3 (Capterra) e 4,1 (G2).
- Commodity: contabilidade de aluguel, portal do inquilino, manutenção, relatórios.
- Reclamações sobre Yardi Breeze: gestão de inquilinos engessada, bugs frequentes e correção lenta após updates, suporte lento, relatórios avançados e personalização limitados.
- Lição: são centrados em locação anglo-saxã; não resolvem DIMOB, boleto/Pix, índices IGP-M nem portais BR. São referência de UX e de funcionalidade (portal do inquilino, manutenção), não concorrentes diretos.

---

## 2. COFECI e uso de IA/agentes de IA

- **Resolução COFECI nº 1.551/2025** (14/08/2025, DOU 15/08/2025; 148 artigos): institui o Sistema de Transações Imobiliárias Digitais (PITDs e ACGIs). Texto: [PDF COFECI](https://intranet.cofeci.gov.br/arquivos/legislacao/resolucao_1551_2025.pdf) (PDF não legível pela ferramenta; conteúdo lido via [LegisWeb](https://www.legisweb.com.br/legislacao/?id=482265)) **[SECUNDÁRIO]**.
- **Art. 49 (Agentes de IA, "AIA"), segundo o LegisWeb:** permite usar AIA como ferramenta auxiliar; AIA vinculado tecnicamente a um único corretor/pessoa jurídica inscrita; deve **identificar-se como agente de IA**, informar **nome completo e CRECI do responsável**, oferecer **mecanismo visível para atendimento humano** (a interação é suspensa quando solicitado); atos do AIA são **considerados praticados pelo corretor/PJ**; **vedado** em avaliação de imóveis, consultoria personalizada, firmar propostas em nome das partes e atos privativos indelegáveis; **registro completo e auditável de todas as interações por no mínimo 5 anos**; conformidade com LGPD. O COFECI pode editar atos adicionais sobre IA.
- **Status crítico:** a 21ª Vara Federal Cível, em ação do ONR, **declarou nula a Res. 1.551/2025** (competência do COFECI limitada à disciplina ética e técnica da profissão; não pode criar regime de transações digitais/tokenização): [IRIB boletim](https://www.irib.org.br/?p=158515). Cabe recurso; situação do recurso **[INCERTO]**. Notas técnicas críticas: [IRIB/CPRI](https://ribmg.org.br/irib-emite-nota-tecnica-sobre-resolucao-cofeci-n-1-551-2025/).
- Conclusão: **não há norma COFECI vigente e incontroversa específica sobre IA** (verificar o recurso). O art. 49 serve como **benchmark de boas práticas** que provavelmente reaparecerá. A responsabilidade ética do corretor permanece (Lei 6.530/78 e Código de Ética; **[INCERTO: não verificados nesta pesquisa]**).
- O COFECI debate IA em convenção nacional ([Foco Nacional, 05/2026](https://www.foconacional.com.br/2026/05/convencao-nacional-do-sistema-cofeci.html)) **[SECUNDÁRIO]**.

---

## 3. DIMOB (Receita Federal)

- Página oficial: [gov.br/receitafederal — Dimob](https://www.gov.br/receitafederal/pt-br/assuntos/orientacao-tributaria/declaracoes-e-demonstrativos/dimob) (seções: Orientações Gerais, Especificações Técnicas, PGD, Perguntas e Respostas; a página indicava última atualização em 27/06/2023; as subpáginas não foram lidas).
- Base normativa: IN RFB 1.115/2010 ([COAD](https://www.coad.com.br/files/trib/html/pesquisa/ir/em31755.htm)) com alterações, inclusive a **IN RFB 2.218/2024** ([IBET](https://www.ibet.com.br/in-2-218-2024-declaracao-de-informacoes-sobre-atividades-imobiliarias-dimob/)) **[SECUNDÁRIO]**. O que exatamente a 2.218/2024 mudou **[INCERTO]**.
- **Quem entrega:** pessoas jurídicas que comercializam imóveis próprios (construídos/loteados/incorporados), **intermedeiam compra, venda ou locação**, ou sublocam; PJ constituída para construção, administração, locação ou venda de bens próprios, de condôminos ou de sócios. Ou seja: imobiliárias e administradoras. Corretor autônomo PF fora do escopo direto **[INCERTO]**.
- **Prazo:** último dia útil de fevereiro do ano seguinte ao ano-base. Dimob 2026 (ano-base 2025): **27/02/2026, 20h** ([Gera Contratos](https://geracontratos.com.br/recursos/como-declarar-dimob-2026), [Meu Contador Online](https://www.meucontadoronline.com.br/blog/dimob-2026-2/)) **[SECUNDÁRIO]**. Próximo: Dimob 2027 (ano-base 2026), fevereiro de 2027; confirmar a data na RFB.
- **Entrega:** exclusivamente pela internet, via programa gerador (PGD Dimob) com certificado digital/e-CAC. O layout do arquivo de importação está em "Especificações Técnicas" (não lido; implementar a partir do documento oficial) **[INCERTO]**.
- **Dados exigidos (resumo geral):** por contrato, CPF/CNPJ de locador e locatário, valores de aluguel recebidos por mês, comissão/intermediação, dados do imóvel, datas do contrato **[INCERTO: lista exata no layout]**.
- **Multas:** fontes conflitantes. Uma cita R$ 5.000 por mês e 5% (mínimo R$ 100); outra cita R$ 500/R$ 1.500 por mês e 3% após a IN 2.218/2024 **[INCERTO: conferir o art. 57 da MP 2.158-35/2001 e a IN vigente]**.
- **Reforma tributária (IBS/CBS):** 2026 é ano de teste ([Decreto 12.955/2026 e Res. CGIBS 6/2026, de 30/04/2026](https://amdjus.com.br/receita-federal-e-comite-do-ibs-divulgam-mudancas-significativas-para-empresas-a-partir-de-2026/)). Impacto direto no layout da Dimob **não encontrado [INCERTO]**; acompanhar.

---

## 4. Assinatura eletrônica

- **MP 2.200-2/2001:** institui a ICP-Brasil e dá presunção de validade a documentos assinados com certificado ICP-Brasil; admite outros meios de comprovação desde que aceitos pelas partes (art. 10, §2º). **[SECUNDÁRIO]**; o texto de lei não carregou, verificar em planalto.gov.br.
- **Lei 14.063/2020** ([Planalto](https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2020/lei/l14063.htm); acesso falhou; resumo via [Conjur](https://www.conjur.com.br/2023-nov-14/mattos-hailer-novidades-sobre-assinatura-eletronica/) e [Barbieri](https://barbieriadvogados.com/assinatura-eletronica-validade-juridica/)):
  - **Simples:** identifica o signatário e associa dados; baixo risco.
  - **Avançada:** vinculada de forma unívoca ao signatário, sob seu controle exclusivo, detecta alterações posteriores; pode usar certificados não ICP-Brasil ou outros meios aceitos pelas partes.
  - **Qualificada:** certificado ICP-Brasil (MP 2.200-2); maior presunção de autenticidade.
  - A lei foca nas relações com entes públicos; entre particulares vale a liberdade de forma, com ônus probatório maior para assinatura simples.
- **ITI:** autoridade raiz da ICP-Brasil, credencia as ACs. Ver [Certforum ITI](https://certforum.iti.gov.br/wp-content/uploads/apresentacoes/20-09/Alexandre-Apresentacao-Certforum-2023.pdf).
- **Aplicação imobiliária:** para contratos de locação e de intermediação, assinatura avançada com trilha de auditoria (IP, timestamp, hash, validação de identidade) costuma ser a escolha prática. Atos que vão a registro (escritura, compra e venda) têm forma própria (tabelionato/ICP/ONR). Eficácia executiva do contrato (testemunhas, CPC art. 784) **[INCERTO: confirmar com advogado]**.

---

## 5. LGPD / ANPD para imobiliárias

Referências: Lei 13.709/2018 e guias ANPD (não lidos integralmente; ver [Guia de segurança para agentes de pequeno porte](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/anonimizado___guia_orientat-_seg_da_inf_p_atpp.pdf), 04/10/2021, não vinculante). A regulamentação de ATPP dispensa o encarregado (DPO) de pequeno porte, exceto alto risco **[SECUNDÁRIO]**. O restante é conhecimento geral **[INCERTO: validar com jurídico]**.
- **Papéis:** a imobiliária cliente é **controladora**; o SaaS é **operador** (contrato de tratamento/DPA); para os dados dos usuários da própria plataforma, o SaaS é controlador.
- **Bases legais típicas (art. 7º):** execução de contrato/procedimentos preliminares (cadastro de locatário/proprietário), obrigação legal (Dimob, fiscal), exercício regular de direitos (cobrança, processos), legítimo interesse (prospecção não invasiva, com teste de balanceamento), consentimento (marketing por WhatsApp/e-mail, cookies). Análise de crédito/fiador exige cuidado.
- **Dados sensíveis/documentos:** RG, CPF, comprovante de renda; selfie/biometria é dado sensível (art. 11).
- **Retenção:** eliminar ao fim da finalidade, salvo obrigação legal (fiscal/contábil geralmente 5 anos; prescrição civil; logs de IA 5 anos se a Res. 1.551 prevalecer). Definir política por tipo de dado.
- **Direitos do titular (art. 18):** confirmação, acesso, correção, anonimização/bloqueio/eliminação, portabilidade, informação sobre compartilhamento, revogação de consentimento. Prazos regulamentados pela ANPD **[INCERTO]**.
- **Incidentes:** comunicação à ANPD e aos titulares (regulamento da ANPD de 2024; prazo de 3 dias úteis) **[INCERTO]**.
- **Decisões automatizadas/IA:** art. 20 dá direito a revisão e a informações claras sobre os critérios.

---

## 6. WhatsApp Business Platform (Cloud API)

- [Meta: Pricing](https://developers.facebook.com/docs/whatsapp/pricing) **[CONFIRMADO]**:
  - Cobrança **por mensagem entregue** desde 01/07/2025; só **templates** são cobrados; categorias: **marketing** (sempre cobrada), **utility**, **authentication**. Mensagens não-template dentro da janela são gratuitas.
  - **Janela de atendimento (CSW) de 24h** após mensagem do usuário: texto livre e templates utility gratuitos. **Free Entry Point:** 72h gratuitas após Click-to-WhatsApp/CTA de página.
  - Faixas de volume reduzem utility/authentication, agregadas por portfólio e mensais.
  - **Brasil:** cobrança em **BRL** a partir de 01/07/2026; todas as WABAs brasileiras devem migrar para BRL até **30/06/2027**, sob risco de suspensão.
- Valores (blogs) **[SECUNDÁRIO]**: USD 0,0625 marketing; USD 0,0068 utility/authentication; em BRL, R$ 0,3217 marketing e R$ 0,035 utility/auth ([MessageCentral](https://www.messagecentral.com/blog/whatsapp-business-api-pricing-brazil), [Whautomate](https://whautomate.com/whatsapp-business-api-pricing-brazil)). **Conferir o rate card oficial da Meta antes de precificar.**
- **Templates:** revisão automática + manual; utility/auth em minutos, marketing até 24h (às vezes 48h); webhook de status de template ([Meta: template review](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-review/)). A Meta pode recategorizar o template.
- **Opt-in:** consentimento claro e explícito para mensagens iniciadas pela empresa; guardar prova (data, canal, texto). Política da Meta; a LGPD reforça.
- **Arquitetura:** Cloud API hospedada pela Meta; webhooks para mensagens e status; cada tenant precisa de WABA + número verificado (Embedded Signup via Tech Provider é o caminho usual em multi-tenant) **[INCERTO]**; limites de envio por tier de qualidade **[INCERTO]**.
- Evitar automação por números não oficiais (WhatsApp Web/bibliotecas não oficiais): viola os termos e há risco de banimento.

---

## 7. Pagamentos BR

**Asaas** ([docs](https://docs.asaas.com/docs/comece-aqui)) **[CONFIRMADO via docs]**
- Todo recebimento (Pix, boleto, cartão, transferência) é uma "cobrança"; ciclo de eventos `PAYMENT_CREATED` -> `PAYMENT_CONFIRMED` -> `PAYMENT_RECEIVED`, mais estornos e chargeback ([eventos](https://docs.asaas.com/docs/webhook-para-cobrancas)). Cartão: 32 dias até RECEIVED. A doc recomenda idempotência e tolerar novos campos no payload. Detalhes de authToken e de fila pausada após falhas **[INCERTO]**; ler a doc.
- **Split** ([FAQ](https://docs.asaas.com/docs/faq-do-split)): destinatários precisam de conta Asaas (`walletId`); percentual calculado sobre o **valor líquido** (`netValue`); permite misturar fixo e percentual; sem limite de destinatários; executado automaticamente ao receber (não agenda); estorno reverte os splits; excesso gera `PAYMENT_SPLIT_DIVERGENCE_BLOCK` (2 dias úteis para corrigir); confirmação via `PAYMENT_SPLIT_DONE`.
- Bom encaixe para repasse ao proprietário (cada proprietário com wallet/subconta) **[verificar KYC e custos]**.

**Stripe** ([Pix](https://docs.stripe.com/payments/pix), [Boleto](https://docs.stripe.com/payments/boleto)) **[CONFIRMADO via docs, resumo]**
- Pix com suporte a Connect, Pix Automático (recorrência), reembolso parcial; boleto com confirmação em 1 dia útil e repasse em 2 dias úteis; IOF de 3,5% em Pix com conta estrangeira, repassado ao cliente por padrão. Exige conta Stripe Brasil; Connect para muitos proprietários é mais complexo **[INCERTO: tarifas]**.

**Outros** (não pesquisados) **[INCERTO]:** Iugu, Pagar.me, Mercado Pago, EFI, PagBrasil, API Pix direta de bancos. Usar camada "gateway adapter".

Regras de produto: reconciliar por webhook + job periódico de consulta (webhook não garante entrega); idempotência por id de evento/pagamento; cobrança Pix com vencimento para aluguel; boleto híbrido com Pix **[INCERTO]**.

---

## 8. Integração com portais (Grupo OLX: ZAP, Viva Real, OLX; Imovelweb; Chaves na Mão)

- **Portal de desenvolvedores do Grupo OLX:** [Integração via Feeds](https://developers.grupozap.com/feeds/integration.html), [Formatos XML](https://developers.grupozap.com/feeds/xml-formats/) **[CONFIRMADO]**.
  - A imobiliária publica uma **URL com XML** (feed) e o portal coleta; processamento **a cada 12h (2x/dia)**, horário variável; relatório de importação por e-mail, **webhook** ou painel do **Canal Pro**; existe validador de XML.
  - **Formato oficial: VRSync** (Header, Listing, Details). O formato "ZAP" legado está em manutenção; a doc diz que **formatos diferentes de VRSync foram desligados em outubro/2024**. Formatos não são atrelados a portais (o mesmo VRSync serve ZAP e Viva Real).
  - **Canal Pro** usa uma URL única de CRM para receber leads de ZAP, Viva Real e OLX ([Imobzi](https://help.imobzi.com/pt-br/article/como-integrar-com-o-canal-pro-grupo-olx-xo0pih/)); integradores precisam estar cadastrados. APIs oficiais (ex.: Lead Manager) aparecem em fontes secundárias **[INCERTO: documentação e acesso]**.
- **Imovelweb / Chaves na Mão:** formato e processo **não verificados** nesta pesquisa **[INCERTO]**. Pesquisar a doc de cada portal antes de estimar.
- O manual antigo [manual.vivareal.com](http://manual.vivareal.com/) não carregou e provavelmente está obsoleto frente ao portal grupozap.
- **Implicações:** gerar feed VRSync por tenant (URL estável com token), cache e regeneração incremental; fotos com URLs públicas estáveis; código de referência único por imóvel; tipos/subtipos conforme a tabela do VRSync; receber leads por endpoint de CRM e deduplicar.

---

## 9. Reajuste de aluguel e Lei do Inquilinato (8.245/91)

Texto oficial: [Planalto, Lei 8.245](https://www.planalto.gov.br/ccivil_03/leis/l8245.htm) (carregamento falhou; resumo via [TJBA PDF](https://www.tjba.jus.br/portal/wp-content/uploads/2020/09/Lei-8.245-91-Lei-do-Inquilinato.pdf) e [ModeloInicial](https://modeloinicial.com.br/lei/L-8245-1991/aluguel-@___I_I_III)). Itens a seguir: **[SECUNDÁRIO]** + conhecimento geral; validar com advogado.
- **Art. 17:** aluguel livremente convencionado; **proibida** a estipulação em moeda estrangeira e a vinculação à variação cambial ou ao salário mínimo. Em locação residencial, observar os critérios de reajuste da legislação específica.
- **Art. 18:** as partes podem fixar novo valor e inserir/alterar cláusula de reajuste.
- **Periodicidade:** reajuste no mínimo **anual** (Lei 10.192/2001) **[INCERTO: conferir artigo]**.
- **Art. 4º:** multa por devolução antecipada **proporcional** ao tempo cumprido; sem previsão, fixada judicialmente. O locador não pode retomar o imóvel durante o prazo.
- **Garantias (art. 37-38):** apenas **uma modalidade** por contrato (caução, fiança, seguro-fiança, cessão fiduciária de quotas); caução em dinheiro limitada a 3 meses de aluguel.
- **Mora e despejo (art. 62):** falta de pagamento autoriza ação de despejo, com possibilidade de purgar a mora.
- **Multa moratória e juros:** são contratuais. Multa de 10% é a prática comum; o limite de 2% do CDC é discutido e em geral não aplicado a locação. Juros de mora de 1% a.m. é o padrão contratual. Houve mudança legal em 2024 na taxa legal de juros (Lei 14.905/2024) **[INCERTO]**. O sistema deve **parametrizar** multa, juros, tolerância e correção por contrato, sem apresentar um padrão como "lei".
- **Índices:** IGP-M (FGV) é o mais usado, porém volátil (alto em 2020-21); IPCA (IBGE) cresce como alternativa; também INPC, IGP-DI e IVAR (FGV, específico para aluguel residencial). IGP-M acumulado em 12 meses: **2,16% (ago/2026), 2,76% (jul/2026), 3,16% (jun/2026)** ([QuintoAndar](https://www.quintoandar.com.br/guias/?p=2288936)) **[SECUNDÁRIO]**. Fontes primárias: [FGV IBRE](https://portalibre.fgv.br/) e [IBGE SIDRA](https://sidra.ibge.gov.br/).
- **Produto:** reajuste no aniversário do contrato, pelo índice acumulado dos 12 meses anteriores definido em cláusula; permitir teto/negociação manual; histórico auditável.

---

## 10. Decisões recomendadas para o produto

1. **Posicionamento:** suíte única para imobiliária pequena e média (CRM + imóveis + locação + financeiro + WhatsApp + IA), atacando as dores públicas recorrentes: suporte humano acessível, cobrança transparente, estabilidade e migração sem dor. Competir em confiabilidade e experiência, não em número de módulos.
2. **IA:** adotar desde o dia 1 as diretrizes do art. 49 da Res. 1.551 como política de produto, mesmo com a norma anulada em 1ª instância: identificação como IA, nome/CRECI do responsável, botão visível "falar com humano" que suspende a IA, logs auditáveis por **no mínimo 5 anos**, IA que **não** avalia imóveis, não faz consultoria personalizada e não firma propostas. Acompanhar o recurso e novos atos do COFECI.
3. **Multi-tenant e LGPD:** cliente como controlador e plataforma como operador; oferecer DPA, registro de consentimento por canal e finalidade, exportação/eliminação por titular, retenção configurável, trilha de acesso e criptografia de documentos. Evitar guardar dado sensível sem necessidade.
4. **WhatsApp:** somente Cloud API oficial (Embedded Signup por tenant); repassar custo por tenant (billing em BRL; planejar migração até 30/06/2027); priorizar a janela de 24h e templates utility (cobrança, lembrete, vencimento); marketing só com opt-in registrado; fila e rate-limit por tenant; webhooks idempotentes.
5. **Pagamentos:** começar com **Asaas** (Pix/boleto, split por wallet para repasse, webhooks) atrás de interface de gateway trocável; Stripe como opção para a assinatura do próprio SaaS/cartão. Conciliação por webhook + job de verificação; idempotência; ledger interno de dupla entrada.
6. **DIMOB:** gerar o arquivo a partir do ledger de locação/comissão do tenant, com validação e prévia; basear o layout no documento "Especificações Técnicas" da RFB (obter e versionar); alerta de prazo (último dia útil de fevereiro). Não prometer cálculo de multa sem confirmação.
7. **Assinatura eletrônica:** MVP com assinatura **avançada** (própria ou integrada a provedor) com trilha de auditoria (hash, IP, timestamp, validação de identidade); suportar ICP-Brasil (qualificada) quando exigido; orientar que atos de registro seguem regras próprias.
8. **Portais:** implementar **feed VRSync** por tenant (URL com token), validar com o validador oficial, receber relatório de importação via webhook; receber leads pelo endpoint de CRM do Canal Pro; cadastrar-se como integrador. Imovelweb e Chaves na Mão na fase 2, após ler a doc.
9. **Reajuste/cobrança:** índices como entidade versionada (IGP-M, IPCA, INPC, IVAR, IGP-DI) com atualização por fonte oficial (FGV/IBGE) e override manual; multa, juros e correção **parametrizáveis por contrato**, com validação que veda moeda estrangeira e vínculo ao salário mínimo (art. 17), multa de rescisão proporcional (art. 4º) e garantia única (art. 37). Revisão por advogado antes do GA.
10. **Pendências de pesquisa:** (a) ler o layout Dimob e a IN 2.218/2024; (b) status do recurso da Res. 1.551; (c) docs de Imovelweb/Chaves na Mão e do Canal Pro/Lead API; (d) rate card oficial da Meta em BRL e Embedded Signup; (e) preços reais dos concorrentes e Reclame Aqui de Jetimob/Tecimob/Imobzi; (f) parecer jurídico sobre multa, juros e assinatura em contrato de locação; (g) tarifas Asaas/Stripe/EFI; (h) Pix Automático para aluguel recorrente.
