/** Contrato do provedor de pagamentos. O resto do sistema só conhece esta interface (nunca o Asaas diretamente). */

export type GatewayErrorCode = 'auth' | 'validation' | 'unavailable' | 'unknown';

/** Erro com mensagem já adequada para o usuário. Nunca carrega chaves nem cabeçalhos. */
export class GatewayError extends Error {
  constructor(public code: GatewayErrorCode, message: string, public status?: number) { super(message); }
}

export interface GatewayPayment {
  id: string;
  status: string;            // status do provedor (PENDING, RECEIVED, OVERDUE...)
  invoiceUrl?: string;       // página de pagamento (Pix/boleto/cartão)
  bankSlipUrl?: string;      // PDF do boleto
  externalReference?: string;
}

export interface CreatePaymentInput {
  customerId: string;
  valueCents: number;
  dueDate: string;           // YYYY-MM-DD
  description: string;
  externalReference: string; // id da cobrança no Aimob: chave de reconciliação e anti-duplicidade
  fineBps: number;
  interestBpsMonth: number;
}

export interface PixQr { payload: string; encodedImage?: string; expiresAt?: string }

export interface PaymentProvider {
  readonly name: 'asaas';
  ensureCustomer(input: { name: string; document: string; email?: string; phone?: string; externalReference: string }): Promise<{ id: string }>;
  createPayment(input: CreatePaymentInput): Promise<GatewayPayment>;
  findPaymentByExternalReference(ref: string): Promise<GatewayPayment | null>;
  getPixQr(paymentId: string): Promise<PixQr | null>;
  cancelPayment(paymentId: string): Promise<void>;
  testConnection(): Promise<void>;
}
