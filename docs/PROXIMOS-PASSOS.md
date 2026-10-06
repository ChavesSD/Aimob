# Onde paramos (05/10/2026)

Último commit: `579ed62` (Pix/boleto via Asaas). Suíte: 113 testes passando em PGlite e em PostgreSQL 18 real (`npm test` e `npm run test:pg -w @aimob/api`).

## Pronto
Fundação multi-tenant, CRM/pipeline/agenda, imóveis, distribuição de leads, automações, locação e financeiro (manual), PostgreSQL + migrações, backup/restore criptografado, MFA, Pix/boleto via Asaas (testado só com duplo de teste), landing com diagnóstico.

## Bloqueio externo
Validar pagamentos no **sandbox real do Asaas** (precisa de uma chave de sandbox). Roteiro e pontos em aberto em `docs/PAGAMENTOS.md`:
1. formato de multa/juros em `POST /payments`;
2. valor pago em atraso no webhook;
3. `PAYMENT_CONFIRMED` x `PAYMENT_RECEIVED` no boleto.

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
