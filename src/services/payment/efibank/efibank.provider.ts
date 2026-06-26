import crypto from 'crypto';
import EfiPay from 'sdk-typescript-apis-efi';
import type {
  IPaymentProvider,
  PaymentProviderConfigInput,
  CreateChargeInput,
  ChargeResponse,
  ChargeStatusResponse,
  WebhookEvent,
  PaymentStatus,
  ProviderEnvironment,
} from '../payment-provider.interface';
import type {
  EfiPixChargeResponse,
  EfiQrCodeResponse,
  EfiPixChargeStatus,
  EfiWebhookPayload,
} from './efibank.types';
import { EFI_STATUS_MAP } from './efibank.types';

/**
 * Provider de pagamentos PIX via Efí Bank. Cobranças imediatas (cob) com QR Code.
 * Doc: https://dev.efipay.com.br/docs/api-pix
 */
export class EfiBankProvider implements IPaymentProvider {
  readonly name = 'efibank';
  readonly environment: ProviderEnvironment;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  private pixKey: string;

  constructor(private config: PaymentProviderConfigInput) {
    this.environment = config.environment;
    this.pixKey = config.pixKey;

    this.client = new EfiPay({
      sandbox: config.environment === 'sandbox',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      pix_cert: config.certPath,
    });
  }

  /** Cria uma cobrança PIX imediata + QR Code. */
  async createCharge(input: CreateChargeInput): Promise<ChargeResponse> {
    const txid = this.generateTxId(input.correlationId);
    const valorDecimal = (input.amountCents / 100).toFixed(2);

    const body: Record<string, unknown> = {
      calendario: { expiracao: input.expiresInSeconds ?? 3600 },
      valor: { original: valorDecimal },
      chave: this.pixKey,
      solicitacaoPagador: input.description.substring(0, 140),
    };

    // Devedor é opcional; só envia se tivermos CPF/CNPJ válido.
    if (input.customer.taxId) {
      const taxId = input.customer.taxId.replace(/\D/g, '');
      if (taxId.length === 11) body.devedor = { nome: input.customer.name, cpf: taxId };
      else if (taxId.length === 14) body.devedor = { nome: input.customer.name, cnpj: taxId };
    }

    const response: EfiPixChargeResponse = await this.client.pixCreateImmediateCharge({ txid }, body);

    let qr: EfiQrCodeResponse | null = null;
    try {
      qr = await this.client.pixGenerateQRCode({ id: response.loc.id });
    } catch (err) {
      console.error('[EfiBankProvider] Erro ao gerar QR Code:', (err as Error).message);
    }

    return {
      externalId: response.txid,
      correlationId: input.correlationId,
      status: this.mapStatus(response.status),
      amountCents: input.amountCents,
      pixCopiaECola: qr?.qrcode || response.pixCopiaECola || '',
      pixQrCodeImage: qr?.imagemQrcode,
      expiresAt: input.expiresInSeconds ? new Date(Date.now() + input.expiresInSeconds * 1000) : undefined,
      rawResponse: response,
    };
  }

  /** Consulta o status de uma cobrança pelo txid. */
  async getChargeStatus(txid: string): Promise<ChargeStatusResponse> {
    const response: EfiPixChargeStatus = await this.client.pixDetailCharge({ txid });
    const pagamentos = response.pix || [];
    const totalPago = pagamentos.reduce((sum, p) => sum + parseFloat(p.valor), 0);

    return {
      externalId: response.txid,
      status: this.mapStatus(response.status),
      amountCents: Math.round(parseFloat(response.valor.original) * 100),
      amountPaidCents: totalPago > 0 ? Math.round(totalPago * 100) : undefined,
      paidAt: pagamentos.length > 0 ? new Date(pagamentos[0].horario) : undefined,
    };
  }

  /** Processa um webhook de PIX recebido. */
  async processWebhook(payload: unknown): Promise<WebhookEvent> {
    const data = payload as EfiWebhookPayload;
    if (!data.pix || !Array.isArray(data.pix) || data.pix.length === 0) {
      throw new Error('Webhook sem dados de PIX válidos');
    }

    const pix = data.pix[0];
    if (!pix.txid) throw new Error('Webhook de recebimento sem txid');

    const valor = parseFloat(pix.valor || '0');
    if (isNaN(valor) || valor <= 0) throw new Error(`Valor inválido no webhook: ${pix.valor}`);

    return {
      event: 'payment.received',
      externalId: pix.txid,
      status: 'completed',
      amountPaidCents: Math.round(valor * 100),
      paidAt: new Date(pix.horario),
      rawData: data,
    };
  }

  /**
   * Registra a URL de webhook na chave PIX. IMPORTANTE: a Efí adiciona /pix ao
   * final da URL registrada — registramos a base sem /pix.
   */
  async configureWebhook(webhookUrl: string): Promise<unknown> {
    return this.client.pixConfigWebhook({ chave: this.pixKey }, { webhookUrl });
  }

  /** Consulta o webhook registrado para a chave PIX. */
  async getWebhookInfo(): Promise<unknown> {
    return this.client.pixDetailWebhook({ chave: this.pixKey });
  }

  // ===== auxiliares =====

  private generateTxId(correlationId: string): string {
    const clean = correlationId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 30);
    const random = crypto.randomBytes(3).toString('hex'); // 6 chars
    // txid Efí: 26..35 alfanuméricos.
    return `${clean}${random}`.slice(0, 35).padEnd(26, '0');
  }

  private mapStatus(efiStatus: keyof typeof EFI_STATUS_MAP): PaymentStatus {
    return (EFI_STATUS_MAP[efiStatus] || 'pending') as PaymentStatus;
  }
}
