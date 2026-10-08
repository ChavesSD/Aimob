# Aimob (nome provisório)

Plataforma de gestão imobiliária multi-tenant: CRM, imóveis, locação e financeiro, contratos, portais do proprietário e do inquilino.
Projeto **separado do Aidate**. O nome é provisório e fica em um só lugar por app: `apps/api/src/config.ts`, `apps/web/src/brand.ts` e `apps/landing/main.js` (+ textos do `index.html`).

## Rodar em desenvolvimento

```bash
npm install                                  # só na primeira vez
cp apps/api/.env.example apps/api/.env       # preencha JWT_SECRET e SEED_PASSWORD
npm run seed -w @aimob/api                   # só na primeira vez: imobiliária demo (marcada como demonstração)
npm run dev                                  # sobe API, produto e landing juntos (Ctrl+C encerra tudo)
```

| O quê | Endereço |
|---|---|
| Produto (`apps/web`) | http://localhost:5273 (se ocupada, o Vite usa a próxima e avisa no log) |
| Landing (`apps/landing`) | http://localhost:5275 |
| API (`apps/api`) | http://127.0.0.1:3100 (`/health` e `/ready`) |

Usuários demo (senha = `SEED_PASSWORD`): `owner@`, `manager@`, `financeiro@`, `broker@`, `corretor2@` e `corretor3@` com final `exemplo.demo`.
Os dados demo começam com a exigência de MFA **desligada**; para demonstrá-la: `SEED_MFA_POLICY=admins npm run seed -w @aimob/api`.
Para zerar os dados locais: pare tudo, apague `apps/api/data` e rode o `seed` de novo (afeta só o Aimob).

```bash
npm test                                     # testes da API no PGlite (rápido)
npm run test:pg -w @aimob/api                # a mesma suíte contra um PostgreSQL real descartável (sem Docker)
npm run mock:asaas -w @aimob/api             # Asaas simulado para desenvolver pagamentos (ver docs/PAGAMENTOS.md)
```

Estado atual: **194 testes**, todos passando nos dois bancos. Estrutura e decisões técnicas em [docs/ARQUITETURA.md](docs/ARQUITETURA.md).

## O que existe hoje

**Comercial:** CRM com score de lead explicável, pipeline em kanban, distribuição de leads (rodízio ou manual), agenda de visitas (conflito de horário e feedback que realimenta o score),
imóveis com saúde do anúncio e "vida do imóvel", automações quando → se → então (ações internas, com aprovação opcional), tarefas e avisos agrupados,
painel "o que precisa da sua atenção" (cada alerta com uma ação).

**Locação e financeiro:** contratos, cobranças geradas de forma idempotente, baixa com multa e juros, inadimplência, repasses com taxa de administração,
reajuste anual (percentual informado pela gestão), encerramento de contrato. Dinheiro sempre em centavos inteiros; regras por contrato.

**Pagamentos:** boleto com Pix pelo Asaas no mesmo modelo do Aidate (conta principal da plataforma + subconta por imobiliária + split de 100%), webhook global autenticado,
baixa automática conservadora (valor divergente vai para revisão). **Não validado contra o Asaas real**: ver [docs/PAGAMENTOS.md](docs/PAGAMENTOS.md).

**Contratos em documento:** modelos com variáveis, valor por extenso, versões imutáveis com hash, aprovação em duas pessoas, PDF com verificação de integridade,
coleta de assinaturas em **modo manual** (o sistema não assina por ninguém). Ver [docs/ASSINATURA.md](docs/ASSINATURA.md).

**Portais (convite de uso único):** proprietário (somente leitura: imóveis, interesse recebido, aluguéis, repasses, extrato CSV, chamados de manutenção dos imóveis dele) e
inquilino (cobranças com estimativa de atraso e opções de pagamento, contrato em PDF, chamados de manutenção com conversa com a imobiliária; a equipe trata, responde e pode escrever notas internas que o inquilino nunca vê).

**Segurança e operação:** isolamento por imobiliária, permissões por perfil (diretoria, gerência, financeiro, corretor, marketing, proprietário, inquilino) com negação por padrão,
auditoria legível, MFA TOTP obrigatório por política, PostgreSQL com migrações, backup e restauração criptografados. Ver [docs/OPERACAO.md](docs/OPERACAO.md).

**Landing:** diagnóstico com consentimento LGPD, honeypot e rate limit; métricas anônimas; leitura dos leads via `GET /api/platform/diagnosticos` (header `x-platform-token`, variável `PLATFORM_ADMIN_TOKEN`).

## O que NÃO existe (não prometer em material comercial)

Integração com provedor de assinatura eletrônica; cartão e conciliação bancária; repasse automático ao proprietário (continua registro manual: nada é transferido pelo sistema);
busca automática de índices (IGP-M/IPCA); DIMOB e fiscal; WhatsApp; IA; publicação em portais imobiliários; documentos nos portais (só contrato em PDF para o inquilino); anexos e orçamentos nos chamados de manutenção;
envio automático de convites por e-mail/WhatsApp; app mobile; importação de dados; billing do SaaS e painel Admin SaaS.
Pesquisa de mercado e legislação em [docs/research/PESQUISA-INICIAL.md](docs/research/PESQUISA-INICIAL.md) (vários pontos marcados como incertos; exigem validação jurídica).

## Documentação

| Documento | Para quê |
|---|---|
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md) | estrutura do código, dados, segurança, decisões técnicas |
| [docs/OPERACAO.md](docs/OPERACAO.md) | variáveis, banco, backup/restauração, RPO/RTO, autenticação, checklist de produção |
| [docs/PAGAMENTOS.md](docs/PAGAMENTOS.md) | Asaas (modelo do Aidate), garantias, o que está confirmado e o que não |
| [docs/ASSINATURA.md](docs/ASSINATURA.md) | contratos em documento, achados legais, o que falta |
| [docs/PROXIMOS-PASSOS.md](docs/PROXIMOS-PASSOS.md) | onde paramos e candidatos para a próxima etapa |
| [docs/research/PESQUISA-INICIAL.md](docs/research/PESQUISA-INICIAL.md) | pesquisa de mercado e legislação (com marcação de incertezas) |

## Pendências conhecidas

- **Landing/SEO:** a página está com `noindex`. Ao definir o domínio: remover `noindex` e incluir `canonical`, `og:url`, `sitemap.xml` e `robots.txt`.
- **Produção:** a varredura de leads parados e o reprocessamento de eventos de pagamento rodam em `setInterval` dentro da API; com várias instâncias o trabalho se repete (idempotente, mas desperdiça): migrar para fila/agendador.
- **Segurança:** faltam rotação de segredos, CSP validada em servidor real e monitoramento de erros.
- **Arquivos de contratos (PDFs):** ficam em `FILES_DIR` e **não entram no backup lógico do banco**; precisam de backup próprio.
- **Pipelines:** etapas fixas no código; personalização por imobiliária (`pipeline_stages`) ainda não usada.
- **Tabelas grandes:** `GET /api/leads` ordena por score com limite; falta paginação completa e colunas configuráveis.
