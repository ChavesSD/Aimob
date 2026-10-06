# Arquitetura

## Visão geral

Monorepo npm com três apps:

| App | Tecnologia | Papel |
|---|---|---|
| `apps/api` | Node 24, TypeScript, Fastify, `zod`, `jose` | API, regras de negócio, jobs leves |
| `apps/web` | React 19, Vite, React Router | produto (equipe) e portais (proprietário e inquilino) |
| `apps/landing` | HTML/CSS/JS estático (Vite só para servir e empacotar) | página comercial e diagnóstico |

Banco: **PostgreSQL** em produção (`DATABASE_URL`); **PGlite** (Postgres em WebAssembly, em disco) em desenvolvimento, atrás da mesma interface (`src/db/client.ts`).
O SQL é o mesmo nos dois, e **a suíte inteira roda nos dois** (`npm test` e `npm run test:pg`, este contra um PostgreSQL 18 real e descartável, sem Docker).
Isso já pegou defeitos que o PGlite escondia (por exemplo, `now()` é o início da transação no Postgres).

## Organização da API (`apps/api/src`)

| Pasta | Conteúdo |
|---|---|
| `app.ts`, `server.ts`, `config.ts` | montagem do Fastify, subida, configuração e validação de produção |
| `auth.ts`, `permissions.ts`, `guard.ts`, `audit.ts` | sessão (JWT), papéis e permissões, guarda por rota, auditoria |
| `routes/` | HTTP: `rentals`, `payments`, `documents`, `portal`, `renterPortal`, `mfa`, `automation`, `public` (o restante do CRM está em `app.ts`) |
| `domain/` | regras puras ou de domínio: `scoring`, `money`, `rentalService`, `distribution`, `automation`, `contractDocs`, `extenso`, `totp`, `crypto`, `notify`... |
| `payments/` | interface de provedor (`provider.ts`), cliente Asaas (`asaas.ts`) e serviço (`service.ts`) |
| `db/` | cliente, migrações versionadas, seed, backup/restauração |
| `storage.ts` | armazenamento de arquivos (PDFs) fora do banco, endereçado por hash |
| `test/` | testes (Vitest) e o duplo de teste do Asaas (`fakeAsaas.ts`) |

## Isolamento entre imobiliárias (tenants)

- Toda tabela de negócio tem `tenant_id`. O acesso a dados passa por `scoped(db, tenantId)`, que **recusa** SQL sem `tenant_id = $1`.
- Rotas de portal e de documentos filtram também por posse (contato do proprietário ou do inquilino).
- Testes de isolamento existem em cada módulo (ids de outra imobiliária devolvem 404; tokens de outra imobiliária não valem).
- Exceções deliberadas e comentadas: o webhook global de pagamentos descobre a imobiliária pelo pagamento (`tenantForEvent`), e jobs internos varrem todas as imobiliárias.

## Perfis e permissões

`owner` (diretoria), `manager` (gerência), `finance`, `broker`, `marketing`, e dois perfis **externos**: `landlord` (proprietário) e `renter` (inquilino).
Permissão por módulo e ação (`permissions.ts`). O papel é lido do banco a cada requisição (rebaixar vale na hora).
**Negar por padrão** é verificado por testes que percorrem todas as rotas registradas e exigem 403 para os perfis externos fora do portal deles.

## Autenticação e sessão

Senhas com scrypt; JWT de 8 h com **época de sessão** (revogar aumenta a época e invalida tokens antigos); MFA TOTP com segredo criptografado, anti-reuso atômico,
códigos de recuperação e bloqueio por tentativas; política de MFA por imobiliária (restringe quem deve ter e ainda não tem). Detalhes em [OPERACAO.md](OPERACAO.md).

## Dados sensíveis

CPF/CNPJ, chaves de API de gateways e o texto dos contratos são criptografados em repouso (AES-256-GCM, `DATA_ENC_KEY`). Segredos do MFA usam chave própria (`MFA_ENC_KEY`).
Respostas de API, auditoria e logs nunca trazem esses valores (há testes para isso). IP em formulários públicos é guardado só como hash.

## Dinheiro

Centavos inteiros e percentuais em basis points; nunca ponto flutuante. Multa única, juros simples pro rata e taxa de administração são configuráveis por contrato.
Baixa e repasse acontecem na mesma transação. Geração de cobranças é idempotente (`UNIQUE contrato + competência`). Metodologia padrão documentada em `domain/money.ts`.

## Concorrência e consistência

- Distribuição de leads, reserva de emissão de cobrança, criação de subconta e consumo de convites usam travas do próprio banco (advisory lock ou `UPDATE` condicional), válidas para várias instâncias.
- Eventos de pagamento são gravados **antes** de processar (idempotência pelo id do evento) e reprocessados se ficarem pendentes.
- Mutações: para as proteções críticas, os testes foram validados removendo a proteção e conferindo que o teste falha.

## Migrações

Versionadas em `src/db/migrations.ts`, aplicadas uma vez, em transação, com lock consultivo (`schema_migrations`). Nunca edite uma migração já publicada: crie a próxima.
Todo novo conjunto de tabelas precisa entrar em `BACKUP_TABLES` (um teste falha se alguma ficar de fora).

## Integrações

Provedores ficam atrás de interfaces (hoje `PaymentProvider`; a de assinatura eletrônica está descrita em [ASSINATURA.md](ASSINATURA.md)). Falha de integração não derruba a operação:
timeout, repetição só para falhas transitórias, mensagens humanas e reservas liberadas.

## Decisões e limites conhecidos

- PDFs ficam em disco (`FILES_DIR`); em vários servidores, trocar `FileStore` por armazenamento de objetos.
- Jobs periódicos rodam dentro da API (`setInterval`); com várias instâncias migrar para fila.
- O Asaas é implementado a partir da documentação e do código do Aidate, **sem validação contra a API real**.
