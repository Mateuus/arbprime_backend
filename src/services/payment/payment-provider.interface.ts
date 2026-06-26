// Interface unificada para providers de pagamento (padrão Strategy).
// Hoje só Efí Bank, mas mantém a porta aberta p/ outros (Woovi, etc).

export type ProviderEnvironment = 'sandbox' | 'production';
export type PaymentStatus = 'pending' | 'completed' | 'failed' | 'cancelled' | 'refunded';

export interface CreateChargeInput {
  /** id único para idempotência (vira o txid) */
  correlationId: string;
  /** valor em centavos (1000 = R$ 10,00) */
  amountCents: number;
  /** descrição da cobrança (solicitacaoPagador) */
  description: string;
  customer: {
    name: string;
    email?: string;
    taxId?: string; // CPF/CNPJ (só dígitos)
  };
  /** segundos até expirar (default 3600) */
  expiresInSeconds?: number;
}

export interface ChargeResponse {
  externalId: string;       // txid no provider
  correlationId: string;
  status: PaymentStatus;
  amountCents: number;
  pixCopiaECola: string;    // código copia-e-cola
  pixQrCodeImage?: string;  // data URI da imagem
  expiresAt?: Date;
  rawResponse?: unknown;
}

export interface ChargeStatusResponse {
  externalId: string;
  status: PaymentStatus;
  amountCents: number;
  amountPaidCents?: number;
  paidAt?: Date;
}

export interface WebhookEvent {
  event: string;            // ex.: 'payment.received'
  externalId: string;       // txid
  status: PaymentStatus;
  amountPaidCents?: number;
  paidAt?: Date;
  rawData: unknown;
}

export interface PaymentProviderConfigInput {
  environment: ProviderEnvironment;
  clientId: string;
  clientSecret: string;
  certPath: string;
  pixKey: string;        // chave PIX recebedora
  webhookSecret?: string;
}

export interface IPaymentProvider {
  readonly name: string;
  readonly environment: ProviderEnvironment;
  createCharge(input: CreateChargeInput): Promise<ChargeResponse>;
  getChargeStatus(externalId: string): Promise<ChargeStatusResponse>;
  processWebhook(payload: unknown): Promise<WebhookEvent>;
  /** registra a URL de webhook na chave PIX (Efí adiciona /pix ao final) */
  configureWebhook(webhookUrl: string): Promise<unknown>;
  /** consulta o webhook registrado p/ a chave PIX */
  getWebhookInfo(): Promise<unknown>;
}
