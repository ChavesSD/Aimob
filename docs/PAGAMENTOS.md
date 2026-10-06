# Pagamentos (Asaas)

Emissão de boleto com Pix para as cobranças de aluguel e baixa automática quando o pagamento é recebido.

> **Estado:** implementado e testado contra um *duplo de teste* do Asaas, construído a partir da documentação oficial **e do código do Aidate**.
> Não foi validado contra o Asaas real (a decisão desta etapa foi não passar pelo sandbox). O Aidate também registra, no próprio código, que a
> parte de Marketplace/Subcontas/Split não foi testada ponta a ponta em sandbox: as duas integrações compartilham esse risco.

## Modelo (igual ao do Aidate)

1. **Conta principal da plataforma**, configurada por ambiente com os **mesmos nomes de variáveis do Aidate**:
   `ASAAS_API_KEY`, `ASAAS_API_URL` (padrão `https://api.asaas.com/v3`; endereços antigos do sandbox são convertidos), `ASAAS_USER_AGENT` (padrão `Aimob`) e `ASAAS_WEBHOOK_TOKEN`.
2. **Uma subconta por imobiliária**, criada automaticamente com a chave principal (`POST /v3/accounts`). A imobiliária não precisa se cadastrar no Asaas.
   A carteira (`walletId`) fica guardada; a chave da subconta (entregue uma única vez) fica criptografada.
3. As cobranças são criadas na conta principal com **split de 100% (`percentualValue`) para a carteira da imobiliária**, `billingType: BOLETO` (traz o Pix, sem cartão) e `postalService: false`.
4. **Um webhook global** (`POST /api/webhooks/asaas`, header `asaas-access-token` = `ASAAS_WEBHOOK_TOKEN`) avisa os pagamentos. O sistema descobre a imobiliária pelo id do pagamento ou pela
   referência externa `aimob_charge_<id da cobrança>`.

Alternativa avançada: a imobiliária que já tem conta no Asaas pode informar a **própria chave de API** (modo `own_key`, com webhook e token próprios por imobiliária).

Pré-requisitos do lado do Asaas (iguais aos do Aidate): Marketplace/Subcontas habilitado na conta principal pelo suporte do Asaas; webhook da plataforma cadastrado no painel (ou via `POST /v3/webhooks`) apontando para
`<PUBLIC_API_URL>/api/webhooks/asaas`, com o mesmo token de `ASAAS_WEBHOOK_TOKEN`, evento de cobranças. A documentação do Asaas permite **até 10 webhooks por conta**, então Aimob e Aidate podem ter cada um o seu.

## Compartilhar a conta Asaas com o Aidate

É seguro, por desenho:
- As cobranças do Aimob usam o prefixo `aimob_charge_`. O Aidate só age em referências com prefixos próprios (`plan_change_`, `billing_`, `autochg_`, `manual_`, `deposit_`, nomes de plano) e ignora as demais (verificado lendo `billingPaymentApply.js`).
- O Aimob, por sua vez, **reconhece e descarta** eventos que não são de cobranças dele (testado com referências `billing_*`, `plan_change_*`, `deposit_*` e pagamentos desconhecidos).
- Cada sistema usa **o seu** webhook, com URL e token diferentes.

Pontos de atenção: as tarifas do Asaas e o saldo da conta principal são compartilhados (o split transfere o valor para a subconta); confirme com o Asaas **quem arca com as tarifas** de cobranças com split.

## Fluxo para a imobiliária

**Pagamentos** → dados da empresa (CNPJ/CPF, e-mail, faturamento mensal e, para CPF, data de nascimento: as mesmas exigências do Aidate) → **Criar conta de recebimento** (uma vez) →
em **Locação → Cobranças**, "Gerar Pix/boleto" (ou o lote dos próximos N dias) → o inquilino paga → o sistema dá baixa e gera o repasse.
O CPF/CNPJ do inquilino é obrigatório para emitir (exigência do Asaas); é validado, guardado criptografado e exibido mascarado.
O Asaas pode pedir envio de documentos da subconta para liberar saques.

## Garantias (verificadas por teste automatizado)

| Risco | Proteção |
|---|---|
| Criar duas subcontas (ação irreversível, sem chave de idempotência) | reserva no banco por imobiliária; 3 requisições simultâneas criam 1 conta; falha libera nova tentativa; **sem repetição automática** |
| Clique duplo na emissão | reserva da cobrança; as demais recebem "em andamento" ou "já emitida" |
| Falha no meio (cobrança criada, resposta perdida) | antes de repetir, consulta o Asaas por `externalReference`; nunca emite dois boletos |
| Queda do provedor | timeout de 10 s, 2 repetições só para falhas transitórias; mensagem humana; reserva liberada |
| Webhook falso | token em tempo constante; sem token configurado nada passa; no modo chave própria, token por imobiliária |
| Evento repetido | `id` do evento único: reconhecido e ignorado |
| Queda depois de gravar o evento | gravado **antes** de processar; pendentes são reprocessados (rotina a cada minuto e botão) |
| Baixa com valor errado | só `PAYMENT_RECEIVED` baixa; valor do provedor diferente do cobrado **não baixa**: vai para revisão e avisa a equipe |
| Pagamento em duplicidade | evento para cobrança já baixada não baixa de novo e avisa |
| Reajuste depois de emitir | cobrança fica "desatualizada"; a reemissão cancela a antiga e cria a nova |
| Contrato encerrado | cobranças futuras emitidas são canceladas no Asaas; se falhar, avisa a equipe |
| Vazamento entre imobiliárias | cada cobrança vai para a carteira da própria imobiliária; eventos e contas isolados por imobiliária |
| Vazamento de segredos | chave principal só no ambiente; chave da subconta e CPF/CNPJ criptografados; nada disso em respostas, auditoria ou logs |

## Confirmado (documentação oficial do Asaas e código do Aidate)

- Header `access_token`; User-Agent (o Aidate envia `ASAAS_USER_AGENT`); URLs de produção e sandbox.
- `POST /payments`: `customer`, `billingType`, `value`, `dueDate`, `externalReference`, `fine`, `interest`, `split` (`walletId` + `percentualValue`/`fixedValue`, conforme usado no Aidate), `postalService`.
- `POST /accounts` (subconta): `name`, `email`, `cpfCnpj`, `companyType` (`LIMITED` para CNPJ), `birthDate` (CPF), `incomeValue`, `mobilePhone`, endereço; resposta com `id`, `walletId`, `apiKey`.
- Webhook: header `asaas-access-token`, token de 32 a 255 caracteres, entrega "ao menos uma vez", `id` único do evento, responder 200 após persistir, fila pausada após 15 falhas, até 10 webhooks por conta.
- `GET /payments?externalReference=`, `GET /payments/{id}/pixQrCode`.

## Pontos NÃO confirmados

1. **Formato de multa e juros** em `POST /payments` (`fine: { value: % }`, `interest: { value: % ao mês }`): assumido; o Aidate não usa multa/juros, então não serve de referência.
2. **Valor pago em atraso** no webhook (original ou atualizado): por isso a baixa compara com o valor **original** e calcula multa/juros pela regra do contrato.
3. **`PAYMENT_CONFIRMED` x `PAYMENT_RECEIVED`** no boleto: o Aidate aceita os dois; o Aimob, por prudência com aluguel, só baixa com `RECEIVED` (a baixa pode chegar um dia útil depois).
4. Quem arca com as **tarifas** em cobranças com split, e se `BOLETO` aceita Pix na mesma cobrança (a documentação do QR Code indica que sim).
5. **Eventos de estorno/chargeback**: só atualizam o status e avisam; não há estorno automático do repasse.

## Fora do escopo

Cartão, conciliação bancária, saque/extrato da subconta, repasse automático ao proprietário (continua registro manual) e outros provedores (a interface `PaymentProvider` permite acrescentar).

## Desenvolvimento local sem conta Asaas

```bash
npm run mock:asaas -w @aimob/api    # Asaas simulado em http://127.0.0.1:4010 (inclui /accounts e /payments)
# apps/api/.env:
#   ASAAS_API_KEY=$aact_dev_chave_simulada_0000000000
#   ASAAS_API_URL=http://127.0.0.1:4010/v3
#   ASAAS_WEBHOOK_TOKEN=<32+ caracteres>      PUBLIC_API_URL=http://127.0.0.1:3100
curl -X POST "http://127.0.0.1:4010/_sim/receive?payment=pay_N&url=http://127.0.0.1:3100/api/webhooks/asaas&token=<ASAAS_WEBHOOK_TOKEN>"
```

Em produção, `ASAAS_API_KEY` é a chave real da conta principal (a mesma conta usada pelo Aidate, se for essa a decisão) e **nunca** deve ser copiada para o repositório.
