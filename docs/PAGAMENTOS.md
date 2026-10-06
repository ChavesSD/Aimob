# Pagamentos (Asaas)

Emissão de Pix/boleto para as cobranças de aluguel e baixa automática quando o pagamento é recebido.
Cada imobiliária usa **a própria conta no Asaas**: o dinheiro vai direto para ela e o Aimob nunca o custodia.

> **Estado:** implementado e testado contra um *duplo de teste* do Asaas, construído a partir da documentação oficial.
> **Ainda não foi validado contra o sandbox real do Asaas** (sem chave disponível nesta etapa). Faça o roteiro da seção
> "Validação no sandbox" antes de usar com dinheiro real.

## Como funciona

1. A gestão conecta a conta em **Pagamentos** (chave de API + ambiente). A chave é testada antes de salvar e guardada criptografada (AES-256-GCM, `DATA_ENC_KEY`); nunca volta nas respostas nem entra na auditoria.
2. O sistema mostra a **URL** e o **token** do webhook (uma única vez). Eles são cadastrados no painel do Asaas, em webhook de *cobranças*.
3. Em **Locação → Cobranças**, "Gerar Pix/boleto" (ou o lote dos próximos N dias) cria no Asaas uma cobrança `UNDEFINED` (o inquilino escolhe Pix ou boleto na página de pagamento), com multa e juros do contrato, e guarda link, boleto e Pix copia-e-cola.
3. Quando o Asaas avisa `PAYMENT_RECEIVED`, o sistema dá baixa, calcula multa/juros e gera o repasse, na mesma transação da baixa manual.

O CPF/CNPJ do inquilino é obrigatório para emitir (exigência do Asaas). É validado pelos dígitos verificadores, guardado criptografado e exibido só mascarado.

## Garantias (verificadas por teste automatizado)

| Risco | Proteção |
|---|---|
| Clique duplo ou duas pessoas emitindo ao mesmo tempo | reserva da cobrança no banco antes de chamar o provedor; as demais tentativas recebem "emissão em andamento" (o teste falha sem a reserva, nos dois bancos) |
| Falha no meio (cobrança criada, resposta perdida) | antes de repetir, consulta o Asaas por `externalReference` (= id da cobrança); nunca emite dois boletos |
| Queda do provedor | timeout de 10 s, 2 repetições com espera crescente só para falhas transitórias; erro vira mensagem humana e a reserva é liberada |
| Webhook falso | token por imobiliária no header `asaas-access-token`, comparado em tempo constante; imobiliária inexistente, token errado e token de *outra* imobiliária recebem a mesma resposta 401 |
| Evento repetido (entrega "ao menos uma vez") | `id` do evento é único; repetido é reconhecido (200) e ignorado |
| Queda depois de gravar o evento | o evento é gravado **antes** de processar; o que ficar pendente/falho é reprocessado (rotina a cada minuto e botão manual) |
| Dar baixa com valor errado | só `PAYMENT_RECEIVED` baixa; se o valor do provedor difere do valor da cobrança no sistema, **não baixa**: vai para revisão e avisa a equipe |
| Pagamento em duplicidade | evento para cobrança já baixada (inclusive manualmente) não baixa de novo e gera aviso |
| Reajuste depois de emitir | a cobrança emitida fica "desatualizada"; a reemissão cancela a antiga no Asaas e cria a nova com o valor certo |
| Contrato encerrado | cobranças futuras já emitidas são canceladas no Asaas; se falhar, a equipe é avisada |
| Vazamento entre imobiliárias | conta, eventos e cobranças são sempre por imobiliária; testado com token e id de pagamento de outra imobiliária |

## Confirmado na documentação oficial do Asaas (consulta em 05/10/2026)

- Autenticação por header `access_token`; URLs `https://api.asaas.com/v3` (produção) e `https://api-sandbox.asaas.com/v3` (sandbox).
- `POST /v3/payments`: `customer`, `billingType` (`BOLETO`, `PIX`, `CREDIT_CARD`, `UNDEFINED`), `value`, `dueDate`, `externalReference`, `fine`, `interest`; resposta com `id`, `status`, `invoiceUrl`, `bankSlipUrl`.
- `GET /v3/payments` filtra por `externalReference`; `GET /v3/payments/{id}/pixQrCode` devolve `payload` (copia-e-cola), `encodedImage` e `expirationDate`.
- `POST /v3/customers` exige `name` e `cpfCnpj`; a API **permite clientes duplicados**.
- Webhook: header `asaas-access-token`; token de 32 a 255 caracteres, sem espaços; entrega "ao menos uma vez" com `id` único por evento; responder 200 só depois de persistir; fila pausada após 15 falhas consecutivas.

## Pontos NÃO confirmados (validar no sandbox)

1. **Formato de multa e juros** em `POST /payments`: assumido `fine: { value: <% > }` e `interest: { value: <% ao mês> }`. A página de referência dedicada não pôde ser lida.
2. **Valor pago em atraso**: não confirmado se `payment.value` no webhook traz o valor original ou o atualizado com multa/juros. Por isso o sistema compara com o valor **original** da cobrança e calcula multa/juros com a regra do contrato (a baixa registra o valor calculado pelo Aimob). Se o Asaas cobrar valor diferente do calculado, haverá diferença entre o que o inquilino pagou e o registrado: confira no sandbox e ajuste.
3. **`PAYMENT_CONFIRMED` vs `PAYMENT_RECEIVED` no boleto**: por prudência só `RECEIVED` baixa.
4. **Busca de cliente existente**: o sistema não procura duplicados; um mesmo inquilino pode gerar clientes repetidos se o CPF for trocado (o id do cliente é reaproveitado enquanto o CPF não muda).
5. **Eventos de estorno/chargeback**: apenas atualizam o status e avisam; não há estorno automático do repasse.

## Validação no sandbox (roteiro)

1. Crie uma conta sandbox no Asaas e uma chave de API; em **Pagamentos**, ambiente *Sandbox*, conecte.
2. Cadastre o webhook no painel do Asaas com a URL e o token exibidos (a API precisa estar acessível por HTTPS, por exemplo com um túnel).
3. Cadastre CPF/CNPJ de teste no inquilino e emita uma cobrança. Confira no Asaas: valor, vencimento, multa e juros.
4. Pague no sandbox (Pix simulado) **em dia**: a cobrança deve ser baixada e o repasse gerado.
5. Emita uma cobrança **já vencida**, pague e compare o valor pago no Asaas com o "Total a receber" do Aimob; registre a diferença se houver.
6. Pague duas vezes / reenvie o evento pelo painel do Asaas: deve haver uma só baixa.
7. Altere o valor da cobrança no sistema depois de emitir: deve aparecer "reemita".

## Fora do escopo desta etapa

Cartão de crédito, split de pagamento (o repasse ao proprietário continua sendo um registro manual), conciliação bancária e outros provedores (a interface `PaymentProvider` permite acrescentá-los). **As tarifas do Asaas são cobradas da conta da imobiliária**: consulte a tabela vigente no Asaas.

## Desenvolvimento local sem conta Asaas

```bash
npm run mock:asaas -w @aimob/api        # Asaas simulado em http://127.0.0.1:4010 (chave: $aact_dev_chave_simulada_0000000000)
# no apps/api/.env:  ASAAS_BASE_URL=http://127.0.0.1:4010/v3  e  PUBLIC_API_URL=http://127.0.0.1:3100
curl -X POST "http://127.0.0.1:4010/_sim/receive?payment=pay_2&url=<URL do webhook>&token=<token>"   # simula pagamento recebido
```

`ASAAS_BASE_URL` é **ignorada em produção** (`NODE_ENV=production`).
