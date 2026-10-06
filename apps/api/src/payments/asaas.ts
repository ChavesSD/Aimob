import { GatewayError, type CreatePaymentInput, type GatewayPayment, type PaymentProvider, type PixQr } from './provider.js';

const BASE = { sandbox: 'https://api-sandbox.asaas.com/v3', production: 'https://api.asaas.com/v3' } as const;

export interface AsaasOptions {
  apiKey: string;
  environment: 'sandbox' | 'production';
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Pausas entre tentativas (ms). Em testes, zeros. */
  backoffMs?: number[];
}

/** Endereço da API. Só fora de produção é possível apontar para um servidor simulado (ASAAS_BASE_URL), para desenvolvimento. */
function baseUrl(env: 'sandbox' | 'production'): string {
  const override = process.env.ASAAS_BASE_URL;
  if (override && process.env.NODE_ENV !== 'production') return override.replace(/\/$/, '');
  return BASE[env];
}

const reais = (cents: number) => Number((cents / 100).toFixed(2));

/**
 * Provedor Asaas (API v3). Baseado na documentação oficial: autenticação por header `access_token`,
 * `externalReference` para reconciliação e `GET /payments?externalReference=` para evitar cobrança duplicada.
 * NÃO validado contra conta real (sem chave de sandbox nesta etapa): ver docs/PAGAMENTOS.md.
 */
export class AsaasProvider implements PaymentProvider {
  readonly name = 'asaas' as const;
  private f: typeof fetch;
  private timeout: number;
  private backoff: number[];

  constructor(private o: AsaasOptions) {
    this.f = o.fetchImpl ?? fetch;
    this.timeout = o.timeoutMs ?? 10_000;
    this.backoff = o.backoffMs ?? [300, 900];
  }

  /** Uma chamada HTTP. Erros de rede/5xx/429 viram 'unavailable' (reaproveitáveis); 4xx viram erro definitivo. */
  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeout);
    let res: Response;
    try {
      res = await this.f(`${baseUrl(this.o.environment)}${path}`, {
        method, signal: ctl.signal,
        headers: { access_token: this.o.apiKey, 'content-type': 'application/json', 'user-agent': 'Aimob/1.0' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new GatewayError('unavailable', 'O provedor de pagamentos não respondeu. Tente novamente em instantes.');
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => '');
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* corpo não-JSON */ }
    if (res.ok) return json as T;
    if (res.status === 401 || res.status === 403) throw new GatewayError('auth', 'A chave de API do provedor foi recusada. Reconecte a conta de pagamentos.', res.status);
    if (res.status === 429 || res.status >= 500) throw new GatewayError('unavailable', 'O provedor de pagamentos está indisponível no momento. Tente novamente em instantes.', res.status);
    const detail = Array.isArray(json?.errors) ? json.errors.map((e: any) => e?.description).filter(Boolean).join(' ') : '';
    throw new GatewayError('validation', detail || 'O provedor de pagamentos recusou a solicitação.', res.status);
  }

  /** Repete só falhas transitórias, com espera crescente. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) {
        const retryable = e instanceof GatewayError && e.code === 'unavailable';
        if (!retryable || i >= this.backoff.length) throw e;
        await new Promise((r) => setTimeout(r, this.backoff[i]));
      }
    }
  }

  async testConnection() {
    await this.withRetry(() => this.call('GET', '/payments?limit=1'));
  }

  async ensureCustomer(i: { name: string; document: string; email?: string; phone?: string; externalReference: string }) {
    const r = await this.withRetry(() => this.call<{ id: string }>('POST', '/customers', {
      name: i.name, cpfCnpj: i.document, email: i.email, mobilePhone: i.phone, externalReference: i.externalReference,
    }));
    return { id: r.id };
  }

  async findPaymentByExternalReference(ref: string): Promise<GatewayPayment | null> {
    const r = await this.withRetry(() => this.call<{ data?: any[] }>('GET', `/payments?externalReference=${encodeURIComponent(ref)}&limit=10`));
    const hit = (r.data ?? []).find((p) => p.externalReference === ref && p.deleted !== true);
    return hit ? this.map(hit) : null;
  }

  async createPayment(i: CreatePaymentInput): Promise<GatewayPayment> {
    const body = {
      customer: i.customerId, billingType: 'UNDEFINED', value: reais(i.valueCents), dueDate: i.dueDate,
      description: i.description, externalReference: i.externalReference,
      fine: { value: i.fineBps / 100 }, interest: { value: i.interestBpsMonth / 100 },
    };
    try {
      return this.map(await this.call<any>('POST', '/payments', body));
    } catch (e) {
      if (!(e instanceof GatewayError) || e.code !== 'unavailable') throw e;
      // Falha ambígua (timeout/5xx): a cobrança pode ter sido criada. Consulta por externalReference antes de repetir,
      // para nunca emitir dois boletos para o mesmo vencimento.
      const existing = await this.withRetry(() => this.findPaymentByExternalReference(i.externalReference));
      if (existing) return existing;
      return this.withRetry(async () => this.map(await this.call<any>('POST', '/payments', body)));
    }
  }

  async getPixQr(paymentId: string): Promise<PixQr | null> {
    try {
      const r = await this.withRetry(() => this.call<any>('GET', `/payments/${encodeURIComponent(paymentId)}/pixQrCode`));
      return r?.payload ? { payload: r.payload, encodedImage: r.encodedImage, expiresAt: r.expirationDate } : null;
    } catch (e) {
      if (e instanceof GatewayError && e.code === 'validation') return null; // sem Pix disponível para esta cobrança
      throw e;
    }
  }

  async cancelPayment(paymentId: string) {
    await this.withRetry(() => this.call('DELETE', `/payments/${encodeURIComponent(paymentId)}`));
  }

  private map(p: any): GatewayPayment {
    return { id: String(p.id), status: String(p.status ?? 'PENDING'), invoiceUrl: p.invoiceUrl, bankSlipUrl: p.bankSlipUrl, externalReference: p.externalReference };
  }
}
