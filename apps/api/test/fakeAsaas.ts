/**
 * DUPLO DE TESTE do Asaas (nunca usado fora dos testes). Implementa só o subconjunto da API v3 que o Aimob usa,
 * segundo a documentação oficial, com injeção de falhas. Não substitui um teste contra o sandbox real.
 */
export interface Call { method: string; path: string; headers: Record<string, string>; body: any }
type Failure = { match: RegExp; kind: 'http500' | 'network' | 'http401' | 'http400' | 'lost-response'; times: number };

export class FakeAsaas {
  readonly validKey: string;
  customers = new Map<string, any>();
  payments = new Map<string, any>();
  accounts = new Map<string, any>();
  calls: Call[] = [];
  /** Latência artificial (ms) nas chamadas de criação, para forçar sobreposição entre requisições simultâneas. */
  delayMs = 0;
  private failures: Failure[] = [];
  private seq = 0;

  constructor(validKey = '$aact_test_chave_valida_000000000000') { this.validKey = validKey; }

  clearFailures() { this.failures = []; }
  failNext(match: RegExp, kind: Failure['kind'], times = 1) { this.failures.push({ match, kind, times }); }
  count(method: string, pathRe: RegExp) { return this.calls.filter((c) => c.method === method && pathRe.test(c.path)).length; }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v3/, '') + url.search;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path, headers, body });
    if (this.delayMs && method === 'POST') await new Promise((r) => setTimeout(r, this.delayMs));
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    if (headers['access_token'] !== this.validKey) return json(401, { errors: [{ code: 'invalid_access_token', description: 'A chave de API informada é inválida' }] });

    const f = this.failures.find((x) => x.times > 0 && x.match.test(`${method} ${path}`));
    let lost = false;
    if (f) {
      f.times--;
      if (f.kind === 'network') throw new TypeError('fetch failed');
      if (f.kind === 'http500') return json(500, { errors: [{ description: 'erro interno' }] });
      if (f.kind === 'http401') return json(401, { errors: [{ description: 'chave inválida' }] });
      if (f.kind === 'http400') return json(400, { errors: [{ code: 'invalid_action', description: 'O CPF/CNPJ informado é inválido.' }] });
      lost = f.kind === 'lost-response'; // cria de verdade, mas responde 500: o cenário perigoso
    }

    const respond = (status: number, data: unknown) => (lost ? json(500, { errors: [{ description: 'timeout no gateway' }] }) : json(status, data));

    if (method === 'GET' && path.startsWith('/payments?') && !path.includes('externalReference')) return json(200, { data: [], totalCount: 0, hasMore: false });
    if (method === 'POST' && path === '/customers') {
      if (!body?.name || !body?.cpfCnpj) return json(400, { errors: [{ description: 'Informe name e cpfCnpj.' }] });
      const id = `cus_${++this.seq}`;
      this.customers.set(id, { id, ...body });
      return respond(200, { id, ...body });
    }
    if (method === 'POST' && path === '/payments') {
      if (!this.customers.has(body?.customer)) return json(400, { errors: [{ description: 'Customer inválido.' }] });
      const id = `pay_${++this.seq}`;
      const p = { id, status: 'PENDING', invoiceUrl: `https://sandbox.asaas.com/i/${id}`, bankSlipUrl: `https://sandbox.asaas.com/b/${id}`, deleted: false, ...body };
      this.payments.set(id, p);
      return respond(200, p);
    }
    if (method === 'GET' && path.startsWith('/payments?externalReference=')) {
      const ref = decodeURIComponent(path.split('externalReference=')[1].split('&')[0]);
      const data = [...this.payments.values()].filter((p) => p.externalReference === ref && !p.deleted);
      return json(200, { data, totalCount: data.length, hasMore: false });
    }
    if (method === 'POST' && path === '/accounts') {
      if (!body?.name || !body?.cpfCnpj || !body?.email || !body?.incomeValue) return json(400, { errors: [{ description: 'Dados da conta incompletos.' }] });
      const id = `acc_${++this.seq}`;
      const acct = { id, walletId: `wallet_${this.seq}`, apiKey: `$aact_sub_${this.seq}_chave_da_subconta`, ...body };
      this.accounts.set(id, acct);
      return respond(200, acct);
    }
    const pix = path.match(/^\/payments\/([^/]+)\/pixQrCode$/);
    if (method === 'GET' && pix) {
      if (!this.payments.has(pix[1])) return json(404, { errors: [{ description: 'Não encontrado.' }] });
      return respond(200, { encodedImage: 'iVBORw0KGgo=', payload: `00020126580014br.gov.bcb.pix-${pix[1]}`, expirationDate: '2027-01-01 23:59:59' });
    }
    const del = path.match(/^\/payments\/([^/]+)$/);
    if (method === 'DELETE' && del) {
      const p = this.payments.get(del[1]);
      if (!p || p.deleted) return json(404, { errors: [{ description: 'Cobrança não encontrada.' }] });
      p.deleted = true; p.status = 'DELETED';
      return respond(200, { deleted: true, id: del[1] });
    }
    return json(404, { errors: [{ description: `rota não simulada: ${method} ${path}` }] });
  };
}
