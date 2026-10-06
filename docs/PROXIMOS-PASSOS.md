# Onde paramos (06/10/2026)

Suíte: 125 testes passando em PGlite e em PostgreSQL 18 real (`npm test` e `npm run test:pg -w @aimob/api`).

## Pronto
Fundação multi-tenant, CRM/pipeline/agenda, imóveis, distribuição de leads, automações, locação e financeiro (manual), PostgreSQL + migrações, backup/restore criptografado, MFA, Pix/boleto via Asaas (testado só com duplo de teste), landing com diagnóstico.

## Pagamentos
Alinhados ao modelo do Aidate (conta principal + subconta + split + webhook global). Decisão do usuário: não validar em sandbox agora. Pontos em aberto (tarifas com split, multa/juros, valor pago em atraso, `CONFIRMED` x `RECEIVED`) em `docs/PAGAMENTOS.md`.
Para ativar em produção: definir `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN` (e cadastrar o webhook no Asaas), habilitar Marketplace/Subcontas na conta principal.

## Candidatos para a próxima sessão
1. **Portal do proprietário**: extrato, recebimentos, repasses, leads/visitas do imóvel.
2. **Contratos em documento + assinatura eletrônica** (pesquisar Lei 14.063 e provedores antes).
3. **Obrigar MFA** para `owner`/`manager`; rotação de segredos.
4. **Produção**: monitoramento de erros, CSP validada em servidor real, migrar a varredura de leads parados para fila.
5. WhatsApp (API oficial), IA com regras de segurança, portais imobiliários, importação de dados, Admin SaaS e billing.

## Ambiente local
- API `:3100`, produto `:5274` (ou 5273), landing `:5275`; Asaas simulado `:4010` (`npm run mock:asaas -w @aimob/api`).
- `apps/api/.env` (ignorado pelo git) hoje aponta `ASAAS_BASE_URL` para o simulado: remova essa linha para falar com o Asaas real.
- Senha dos usuários demo: `SEED_PASSWORD` em `apps/api/.env`.
