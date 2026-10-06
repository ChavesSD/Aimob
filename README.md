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
npm test                                  # testes da API
```

Usuários demo (senha = `SEED_PASSWORD`): `owner@exemplo.demo`, `manager@exemplo.demo`, `broker@exemplo.demo`, `corretor2@exemplo.demo`, `corretor3@exemplo.demo`.

## O que existe hoje

CRM com score explicável, pipeline kanban, imóveis com saúde e vida do imóvel, agenda de visitas (conflito de horário e feedback),
distribuição de leads (rodízio ou manual), automações quando → se → então (ações internas, com aprovação opcional),
tarefas e avisos agrupados, painel "o que precisa da sua atenção", auditoria legível, permissões por perfil, isolamento por tenant,
landing com diagnóstico (consentimento LGPD, honeypot, rate limit) e leitura via `GET /api/platform/diagnosticos`
(header `x-platform-token`, variável `PLATFORM_ADMIN_TOKEN`).

## O que NÃO existe (não prometer em material comercial)

Locação, financeiro, cobrança, repasses, contratos e assinatura, WhatsApp, IA, portais imobiliários, portal do proprietário/inquilino,
app mobile, importação de dados, billing do SaaS e painel Admin SaaS. Pesquisa de mercado e legislação em `docs/research/PESQUISA-INICIAL.md`
(vários pontos ali estão marcados como incertos e exigem validação jurídica).

## Pendências conhecidas

- **Landing/SEO:** a página está com `noindex`. Ao definir o domínio: remover `noindex`, incluir `canonical`, `og:url`, `sitemap.xml` e `robots.txt`.
- **Produção:** trocar PGlite por PostgreSQL real (o SQL já é compatível); o lock de distribuição é por instância (ver `domain/distribution.ts`);
  a varredura de leads parados roda em `setInterval` dentro da API (migrar para fila quando houver mais de uma instância).
- **Segurança:** MFA, rotação de segredos, CSP da landing e backup/restore ainda não implementados.
- **Pipelines:** etapas fixas no código; personalização por tenant (`pipeline_stages`) ainda não usada.
- **Tabelas grandes:** `GET /api/leads` ordena por score com limite; falta paginação completa e colunas configuráveis.
