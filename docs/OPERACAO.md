# Operação e produção

Este documento separa o que **foi verificado por teste automatizado** do que é **recomendação** a validar no seu ambiente.

## Banco de dados

| Ambiente | Banco | Observação |
|---|---|---|
| Desenvolvimento | PGlite (Postgres em WebAssembly, arquivo local) | padrão quando `DATABASE_URL` não existe |
| Produção | PostgreSQL 14+ via `DATABASE_URL` | a API **recusa subir** em produção sem `DATABASE_URL` |

Verificado: a suíte completa (`npm test` e `npm run test:pg`) passa nos dois bancos. O `test:pg` sobe um PostgreSQL 18 real e descartável (binários oficiais via `embedded-postgres`, sem Docker) e usa um schema novo por arquivo de teste.
Isso já revelou um bug que o PGlite escondia (`now()` no Postgres é o início da transação; o rodízio usa `clock_timestamp()`).

Migrações: versionadas em `src/db/migrations.ts`, aplicadas uma única vez e em transação, com lock consultivo (várias instâncias subindo juntas não aplicam a mesma duas vezes). Nunca edite uma migração publicada: crie a próxima.

Concorrência: a distribuição de leads usa `pg_advisory_xact_lock` por imobiliária, válido para várias instâncias e conexões (há teste de concorrência real e verificação de que ele falha sem o lock).

## Variáveis de ambiente (produção)

A API valida tudo isto na subida (`productionProblems` em `src/config.ts`) e sai com erro explicando o que falta.

| Variável | Para quê |
|---|---|
| `NODE_ENV=production` | ativa as verificações |
| `DATABASE_URL` | PostgreSQL |
| `JWT_SECRET` (≥ 32) | assinatura das sessões |
| `MFA_ENC_KEY` (≥ 32, diferente do JWT) | criptografia dos segredos TOTP em repouso |
| `DATA_ENC_KEY` (≥ 32) | criptografia de CPF/CNPJ e chaves de API de gateways em repouso |
| `PUBLIC_API_URL` (https) | endereço público da API, usado no webhook de pagamentos (ver `docs/PAGAMENTOS.md`) |
| `ASAAS_API_KEY`, `ASAAS_API_URL`, `ASAAS_USER_AGENT`, `ASAAS_WEBHOOK_TOKEN` (≥ 32) | conta principal do Asaas (mesmos nomes do Aidate); com a chave definida, o token do webhook passa a ser obrigatório em produção |
| `FILES_DIR` | pasta dos PDFs de contratos (padrão `./data/files`); **fora do backup lógico**: inclua no backup do servidor |
| `BACKUP_ENC_KEY` (≥ 32) | criptografia dos arquivos de backup |
| `IP_HASH_SALT` (≥ 16, não-exemplo) | hash de IP nos formulários públicos |
| `CORS_ORIGIN` | origens permitidas do front |
| `TRUST_PROXY` = `true` ou `false` | decisão explícita; atrás de balanceador use `true`, senão o rate limit enxerga o IP do proxy |
| `PLATFORM_ADMIN_TOKEN` (≥ 24) | leitura dos diagnósticos da landing; sem ele a rota fica desligada |
| `HOST`, `PORT` | endereço de escuta |

Guarde segredos em um gerenciador de segredos, nunca no repositório. Perder `MFA_ENC_KEY` invalida os segundos fatores cadastrados; perder `DATA_ENC_KEY` torna ilegíveis CPF/CNPJ e chaves de gateway (será preciso recadastrar); perder `BACKUP_ENC_KEY` torna os backups ilegíveis. Faça cópia segura de ambas, separada dos backups.

Saúde: `GET /health` (processo vivo) e `GET /ready` (processo + banco), este último para o balanceador. A API trata `SIGTERM`: para de aceitar, conclui as requisições e fecha o banco.

## Backup e restauração

Dois níveis, que se complementam:

1. **Backup físico do provedor (recomendado como base):** snapshots + arquivamento de WAL (PITR) do PostgreSQL gerenciado. É ele que dá RPO baixo. Configure no provedor.
2. **Backup lógico do Aimob (`npm run backup`):** exporta todas as tabelas de um único snapshot consistente, em arquivo **criptografado** (AES-256-GCM, chave derivada por scrypt) com checksum. Serve para migrar de provedor, restaurar uma imobiliária em ambiente de teste e como segunda cópia independente.

```bash
BACKUP_ENC_KEY=... npm run backup -w @aimob/api                       # cria ./backups/aimob-<data>.bak e já verifica
BACKUP_ENC_KEY=... npx tsx src/db/backup-cli.ts verify <arquivo>       # confere integridade sem restaurar
BACKUP_ENC_KEY=... npm run restore -w @aimob/api -- <arquivo>          # restaura em banco VAZIO
```

Verificado por teste (nos dois bancos): ida e volta reproduz os dados (dinheiro, jsonb, datas, uuid e hashes de senha); o arquivo não contém texto legível; chave errada, arquivo adulterado e conteúdo alterado são recusados; restaurar em banco com dados é recusado; falha no meio da restauração desfaz tudo; o teste também garante que **nenhuma tabela nova fique de fora** do backup (se alguém criar uma tabela e esquecer de listá-la em `BACKUP_TABLES`, os testes falham).

**Arquivos de contratos (PDFs)** não entram nesse backup lógico: ficam em `FILES_DIR` e precisam do próprio backup (ver `docs/ASSINATURA.md`).

Limites conhecidos: o backup lógico carrega cada tabela em memória (adequado a milhares de imóveis e centenas de milhares de registros; para volumes muito maiores use o backup físico). Com PGlite em disco, pare a API antes de rodar o CLI.

### Metas recomendadas (a validar com o seu negócio)

Estes números são **recomendações**, não medições:

- **RPO** (perda máxima de dados): até **15 minutos** com PITR ativo; até 24 h se só houver o backup lógico diário.
- **RTO** (tempo para voltar): até **2 horas**. O tempo real depende do volume: meça restaurando um backup de produção em ambiente de teste.
- **Retenção:** diários por 30 dias, mensais por 12 meses (ajuste a exigências legais de guarda; valide com o jurídico).
- **Teste de restauração:** mensal. Backup que nunca foi restaurado não é backup.

## Autenticação

- Senhas com scrypt; login com tempo de resposta igual para e-mail inexistente; limite de 10 tentativas/min por IP.
- MFA TOTP (RFC 6238, validado com os vetores oficiais): segredo criptografado em repouso, códigos de uso único, 8 códigos de recuperação (só o hash é guardado), bloqueio de 15 min após 5 erros, desativação exige senha **e** código.
- O papel do usuário é sempre lido do banco; usuário desativado perde acesso na hora.
- Ainda **não** há política que *obrigue* MFA por papel nem rotação automática de segredos.

## Cabeçalhos e CSP (a validar em staging)

A API envia cabeçalhos via `@fastify/helmet`. Para os fronts estáticos (produto e landing) sugere-se servir com, no mínimo:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline';
  img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
```

**Não testado em servidor real.** O produto usa estilos inline em atributos (por isso `style-src-attr`) e imagem `data:` para o QR code do MFA. Valide com o build de produção e o console do navegador antes de ativar em modo bloqueante.

## Lista de verificação antes de ir ao ar

- [ ] PostgreSQL gerenciado com PITR e alertas de espaço/conexões
- [ ] Variáveis acima configuradas e a API sobe sem erros de configuração
- [ ] `/ready` ligado ao balanceador; HTTPS obrigatório; `TRUST_PROXY=true`
- [ ] Backup lógico agendado + restauração testada em ambiente de teste com dados reais
- [ ] Segredos guardados com cópia segura (`MFA_ENC_KEY`, `DATA_ENC_KEY`, `BACKUP_ENC_KEY`, `JWT_SECRET`)
- [ ] Pagamentos: roteiro de validação no sandbox do Asaas concluído (`docs/PAGAMENTOS.md`) antes de usar chave de produção
- [ ] MFA ativado para todos os usuários `owner`/`manager`
- [ ] Domínio definido; landing sem `noindex`, com canonical/sitemap/robots
- [ ] Política de privacidade e termos revisados pelo jurídico (LGPD)
- [ ] Monitoramento de erros e de latência (ainda não implementado)
