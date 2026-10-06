# Aimob (nome provisório)

Plataforma imobiliária multi-tenant. Projeto separado do Aidate. O nome é provisório e fica em um só lugar por app:
`apps/api/src/config.ts`, `apps/web/src/brand.ts` e `apps/landing/main.js` (+ textos do `index.html`).

## Apps

| App | O que é | Porta dev |
|-----|---------|-----------|
| `apps/api` | API Fastify + TypeScript, PostgreSQL (PGlite em dev) | 3100 |
| `apps/web` | Produto (React + Vite): painel, CRM, pipeline, imóveis, agenda, tarefas, automações | 5273/5274 |
| `apps/landing` | Landing page estática com diagnóstico e métricas anônimas | 5275 |

## Rodar em desenvolvimento

```bash
npm install
cp apps/api/.env.example apps/api/.env   # preencha JWT_SECRET e SEED_PASSWORD
npm run seed -w @aimob/api               # imobiliária demo (marcada como demonstração)
npm run dev -w @aimob/api
npm run dev -w @aimob/web
npm run dev -w @aimob/landing
npm test                                  # testes da API (PGlite, rápido)
npm run test:pg -w @aimob/api             # a mesma suíte contra um PostgreSQL real descartável (sem Docker)
```

Usuários demo (senha = `SEED_PASSWORD`): `owner@exemplo.demo`, `manager@exemplo.demo`, `broker@exemplo.demo`, `corretor2@exemplo.demo`, `corretor3@exemplo.demo`.

## O que existe hoje

Locação e financeiro (contratos, cobranças geradas de forma idempotente, baixa com multa/juros, inadimplência, repasses com taxa de administração, reajuste anual com percentual informado, encerramento de contrato; valores em centavos e regras por contrato),
CRM com score explicável, pipeline kanban, imóveis com saúde e vida do imóvel, agenda de visitas (conflito de horário e feedback),
Boleto com Pix pelo Asaas no mesmo modelo do Aidate (subconta por imobiliária + split) com baixa automática por webhook (**não validado contra o Asaas real**: ver [docs/PAGAMENTOS.md](docs/PAGAMENTOS.md)),
contratos em documento (modelos com variáveis, versões, aprovação em duas pessoas, PDF com hash; assinatura registrada manualmente: ver [docs/ASSINATURA.md](docs/ASSINATURA.md)),
portal do proprietário (convite de uso único, imóveis, aluguéis, repasses e extrato CSV, somente leitura),
distribuição de leads (rodízio ou manual), automações quando → se → então (ações internas, com aprovação opcional),
tarefas e avisos agrupados, painel "o que precisa da sua atenção", auditoria legível, permissões por perfil, isolamento por tenant,
landing com diagnóstico (consentimento LGPD, honeypot, rate limit) e leitura via `GET /api/platform/diagnosticos`
(header `x-platform-token`, variável `PLATFORM_ADMIN_TOKEN`).

## O que NÃO existe (não prometer em material comercial)

Cartão, split de pagamento e conciliação bancária (o repasse ao proprietário continua sendo registro manual; nada é transferido pelo sistema), busca automática de índices (IGP-M/IPCA), DIMOB e fiscal, conciliação bancária, integração com provedor de assinatura eletrônica, WhatsApp, IA, portais imobiliários, portal do inquilino e, no do proprietário, manutenção/chamados/documentos,
app mobile, importação de dados, billing do SaaS e painel Admin SaaS. Pesquisa de mercado e legislação em `docs/research/PESQUISA-INICIAL.md`
(vários pontos ali estão marcados como incertos e exigem validação jurídica).

## Pendências conhecidas

- **Landing/SEO:** a página está com `noindex`. Ao definir o domínio: remover `noindex`, incluir `canonical`, `og:url`, `sitemap.xml` e `robots.txt`.
- **Produção:** guia, variáveis, backup/restore e metas de RPO/RTO em [docs/OPERACAO.md](docs/OPERACAO.md). A varredura de leads parados roda em `setInterval`
  dentro da API; com várias instâncias ela é repetida (idempotente, mas desperdiça trabalho): migrar para fila/agendador.
- **Segurança:** MFA TOTP obrigatório por política (padrão: diretoria, gerência e financeiro; ver `docs/OPERACAO.md`). Faltam rotação de segredos, CSP validada em servidor real e monitoramento de erros.
- **Pipelines:** etapas fixas no código; personalização por tenant (`pipeline_stages`) ainda não usada.
- **Tabelas grandes:** `GET /api/leads` ordena por score com limite; falta paginação completa e colunas configuráveis.
