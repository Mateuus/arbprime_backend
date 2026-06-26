import path from 'path';
import { AppDataSource } from '@Database';
import { PaymentProviderConfig } from '@Entities';
import { EfiBankProvider } from './efibank/efibank.provider';
import type { IPaymentProvider, PaymentProviderConfigInput, ProviderEnvironment } from './payment-provider.interface';

/**
 * Factory dos providers de pagamento. Lê a configuração da tabela
 * `payment_provider_configs` (editável no admin) com fallback ao .env.
 * Resolve caminhos de certificado relativos a partir do cwd do backend.
 */
export class PaymentProviderFactory {
  private static resolveCert(certPath: string | null | undefined): string {
    const p = certPath || '';
    if (!p) return '';
    return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  }

  /** Lê a config do Efí do banco (preferencial) ou do .env (fallback). */
  static async getEfiConfig(): Promise<PaymentProviderConfigInput> {
    let row: PaymentProviderConfig | null = null;
    try {
      row = await AppDataSource.getRepository(PaymentProviderConfig).findOneBy({ provider: 'efibank' });
    } catch {
      row = null;
    }

    const environment: ProviderEnvironment =
      (row?.environment as ProviderEnvironment) ||
      ((process.env.PAYMENT_ENV as ProviderEnvironment) || 'sandbox');

    const isSandbox = environment === 'sandbox';

    const clientId = isSandbox
      ? row?.sandboxClientId || process.env.EFI_SANDBOX_CLIENT_ID || ''
      : row?.prodClientId || process.env.EFI_PROD_CLIENT_ID || '';
    const clientSecret = isSandbox
      ? row?.sandboxClientSecret || process.env.EFI_SANDBOX_CLIENT_SECRET || ''
      : row?.prodClientSecret || process.env.EFI_PROD_CLIENT_SECRET || '';
    const certPath = isSandbox
      ? row?.sandboxCertPath || process.env.EFI_SANDBOX_PIX_CERT || ''
      : row?.prodCertPath || process.env.EFI_PROD_PIX_CERT || '';
    const pixKey = isSandbox
      ? row?.sandboxPixKey || process.env.EFI_SANDBOX_PIX_KEY || ''
      : row?.prodPixKey || process.env.EFI_PROD_PIX_KEY || '';

    return {
      environment,
      clientId,
      clientSecret,
      certPath: this.resolveCert(certPath),
      pixKey,
      webhookSecret: row?.webhookSecret || process.env.EFI_WEBHOOK_SECRET || undefined,
    };
  }

  /** Instancia o provider Efí com a config atual (sempre fresco — config pode mudar no admin). */
  static async getEfiProvider(): Promise<IPaymentProvider> {
    const config = await this.getEfiConfig();
    if (!config.clientId || !config.clientSecret || !config.certPath || !config.pixKey) {
      throw new Error('Configuração do Efí incompleta. Configure em Admin → Pagamentos.');
    }
    return new EfiBankProvider(config);
  }

  /** Provider padrão (hoje só Efí). */
  static async getDefaultProvider(): Promise<IPaymentProvider> {
    return this.getEfiProvider();
  }
}
