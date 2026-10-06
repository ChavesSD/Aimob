# Onde paramos (06/10/2026)

Suíte: **180 testes** passando em PGlite e em PostgreSQL 18 real (`npm test` e `npm run test:pg -w @aimob/api`). Rodar tudo localmente: `npm run dev` (ver README).

## Pronto
Fundação multi-tenant; CRM, pipeline, agenda de visitas, imóveis, distribuição de leads, automações; locação e financeiro; PostgreSQL com migrações, backup e restauração criptografados;
MFA obrigatório por política (padrão: diretoria, gerência e financeiro) com redefinição por colega e revogação de sessões; boleto com Pix pelo Asaas no modelo do Aidate
(conta principal + subconta + split + webhook global); contratos em documento (modelos, versões, aprovação, PDF com hash, assinatura registrada manualmente);
portal do proprietário e portal do inquilino; landing com diagnóstico.

## Decisões pendentes (suas)
1. **Provedor de assinatura eletrônica e nível de assinatura** (qualificada/ICP-Brasil se for registrar em cartório): critérios em [ASSINATURA.md](ASSINATURA.md).
2. **Ativar o Asaas em produção:** definir `ASAAS_API_KEY` e `ASAAS_WEBHOOK_TOKEN`, cadastrar o webhook no painel do Asaas e confirmar que Marketplace/Subcontas está habilitado na conta principal.
   Pontos ainda não confirmados (tarifas com split, multa/juros, valor pago em atraso, `CONFIRMED` x `RECEIVED`) em [PAGAMENTOS.md](PAGAMENTOS.md). Decisão anterior: não validar em sandbox agora.
3. Domínio e hospedagem (liberam SEO da landing, `PUBLIC_API_URL` e o webhook).

## Candidatos para a próxima etapa
1. Integração com o provedor de assinatura (depende da decisão 1).
2. Chamados de manutenção e documentos nos portais (proprietário e inquilino).
3. Produção: monitoramento de erros, CSP validada em servidor real, rotação de segredos, jobs em fila.
4. Envio automático de convites e avisos (e-mail/WhatsApp com a API oficial).
5. IA com regras de segurança, publicação em portais imobiliários, importação de dados, Admin SaaS e billing.

## Ambiente local
- `npm run dev` sobe API (`:3100`), produto (`:5273`) e landing (`:5275`). Asaas simulado opcional: `npm run mock:asaas -w @aimob/api` (`:4010`).
- `apps/api/.env` não vai para o git. Para usar o Asaas simulado: `ASAAS_API_KEY=$aact_dev_chave_simulada_0000000000`, `ASAAS_API_URL=http://127.0.0.1:4010/v3`, `ASAAS_WEBHOOK_TOKEN` (32+ caracteres) e `PUBLIC_API_URL=http://127.0.0.1:3100`.
  Para falar com o Asaas real, use a chave real e a URL padrão (nunca copie a chave para o repositório).
- Senha dos usuários demo: `SEED_PASSWORD` em `apps/api/.env`.
