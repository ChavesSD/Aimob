import { GatewayError, type CreatePaymentInput, type GatewayPayment, type PaymentProvider, type PixQr } from './provider.js';

const BASE = { sandbox: 'https://api-sandbox.asaas.com/v3', production: 'https://api.asaas.com/v3' } as const;

export interface AsaasOptions {
  apiKey: string;
  environment: 'sandbox' | 'production';
  /** Endereço da API (conta da plataforma, via ASAAS_API_URL). Quando ausente, vale `environment`. */
  baseUrl?: string;
  /** Asaas exige User-Agent em contas novas; mesmo critério do Aidate (ASAAS_USER_AGENT). */
  userAgent?: string;
  /** Conta da plataforma: cobra com split de 100% para a carteira (subconta) da imobiliária. */
  splitWalletId?: string;
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

export interface SubAccountInput {
  name: string; email: string; document: string; birthDate?: string; monthlyRevenueCents: number;
  phone?: string; street?: string; number?: string; complement?: string; neighborhood?: string; cep?: string;
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
      res = await this.f(`${this.o.baseUrl ?? baseUrl(this.o.environment)}${path}`, {
        method, signal: ctl.signal,
        headers: { access_token: this.o.apiKey, 'content-type': 'application/json', 'user-agent': this.o.userAgent ?? 'Aimob' },
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
    const body: Record<string, unknown> = {
      // BOLETO já traz o Pix (QR) junto e não oferece cartão: aluguel não deve ser pago parcelado no cartão.
      customer: i.customerId, billingType: 'BOLETO', value: reais(i.valueCents), dueDate: i.dueDate,
      description: i.description, externalReference: i.externalReference,
      fine: { value: i.fineBps / 100 }, interest: { value: i.interestBpsMonth / 100 },
      postalService: false, // sem envio postal do boleto (serviço pago do Asaas), como no Aidate
    };
    if (this.o.splitWalletId) body.split = [{ walletId: this.o.splitWalletId, percentualValue: 100 }];
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

  /**
   * Cria a subconta da imobiliária (Marketplace do Asaas), usando a chave PRINCIPAL da plataforma.
   * Mesmo contrato usado pelo Aidate. Pode exigir que o Asaas habilite Marketplace/Subcontas na conta principal.
   * Retorna a chave da subconta (só é entregue nesta resposta) e a carteira que recebe o split.
   */
  async createSubAccount(p: SubAccountInput): Promise<{ id: string; walletId: string; apiKey: string }> {
    const body: Record<string, unknown> = {
      name: p.name, email: p.email, cpfCnpj: p.document,
      companyType: p.document.length === 14 ? 'LIMITED' : undefined,
      birthDate: p.document.length === 11 ? p.birthDate : undefined,
      incomeValue: reais(p.monthlyRevenueCents), mobilePhone: p.phone,
      address: p.street, addressNumber: p.number, complement: p.complement, province: p.neighborhood, postalCode: p.cep,
    };
    for (const k of Object.keys(body)) if (body[k] === undefined || body[k] === '') delete body[k];
    // Sem repetição automática: criar conta é uma ação irreversível e o provedor não oferece chave de idempotência.
    const r = await this.call<any>('POST', '/accounts', body);
    if (!r?.id || !r?.walletId) throw new GatewayError('unknown', 'Resposta inválida do provedor ao criar a conta de recebimento.');
    return { id: String(r.id), walletId: String(r.walletId), apiKey: String(r.apiKey ?? '') };
  }

  async cancelPayment(paymentId: string) {
    await this.withRetry(() => this.call('DELETE', `/payments/${encodeURIComponent(paymentId)}`));
  }

  private map(p: any): GatewayPayment {
    return { id: String(p.id), status: String(p.status ?? 'PENDING'), invoiceUrl: p.invoiceUrl, bankSlipUrl: p.bankSlipUrl, externalReference: p.externalReference };
  }
}
