/**
 * Servidor Asaas SIMULADO, só para desenvolvimento local (reaproveita o duplo usado nos testes).
 *   npm run mock:asaas -w @aimob/api            -> escuta em http://127.0.0.1:4010
 *   ASAAS_BASE_URL=http://127.0.0.1:4010/v3 npm run dev -w @aimob/api
 * Chave aceita: $aact_dev_chave_simulada_0000000000
 * Simular pagamento recebido (dispara o webhook de verdade para a API):
 *   curl -X POST "http://127.0.0.1:4010/_sim/receive?payment=pay_1&url=<URL do webhook>&token=<token>"
 */
import { createServer } from 'node:http';
import { FakeAsaas } from '../test/fakeAsaas.ts';

const KEY = '$aact_dev_chave_simulada_0000000000';
const fake = new FakeAsaas(KEY);
let seq = 0;

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1:4010');
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');

  if (url.pathname === '/_sim/receive' && req.method === 'POST') {
    const p = fake.payments.get(url.searchParams.get('payment') ?? '');
    if (!p) { res.writeHead(404).end('pagamento não encontrado'); return; }
    p.status = 'RECEIVED';
    const evt = { id: `evt_sim_${++seq}_${Date.now()}`, event: 'PAYMENT_RECEIVED', dateCreated: new Date().toISOString(),
      payment: { id: p.id, value: p.value, status: 'RECEIVED', paymentDate: new Date().toISOString().slice(0, 10), externalReference: p.externalReference } };
    const r = await fetch(url.searchParams.get('url')!, { method: 'POST', headers: { 'content-type': 'application/json', 'asaas-access-token': url.searchParams.get('token') ?? '' }, body: JSON.stringify(evt) });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sent: evt.id, webhookStatus: r.status }));
    return;
  }

  const r = await fake.fetch(`http://sim${url.pathname}${url.search}`, { method: req.method, headers: req.headers as Record<string, string>, body: body || undefined });
  res.writeHead(r.status, { 'content-type': 'application/json' }).end(await r.text());
}).listen(4010, '127.0.0.1', () => console.log('Asaas simulado em http://127.0.0.1:4010 (chave: ' + KEY + ')'));
