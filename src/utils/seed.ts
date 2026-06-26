import { AppDataSource } from '@Database';
import { Plan, PaymentProviderConfig, ManualPaymentConfig } from '@Entities';

/**
 * Semeia os planos padrão (uma vez, se a tabela estiver vazia) e a configuração
 * dos providers de pagamento (Efí a partir do .env + manual padrão inativo).
 * Idempotente — só cria o que faltar.
 */

export const seedDefaultPlans = async (): Promise<void> => {
  const repo = AppDataSource.getRepository(Plan);
  const count = await repo.count();
  if (count > 0) return;

  const plans: Partial<Plan>[] = [
    {
      name: 'Mensal',
      description: 'Acesso completo ao ArbPrime por 30 dias.',
      price: 1800,
      promotionType: 'fixed',
      promotionValue: 400, // final R$ 1.400,00
      durationInDays: 30,
      level: 1,
      isTrial: false,
      isActive: true,
      sortOrder: 1,
    },
    {
      name: 'Semanal',
      description: 'Acesso completo ao ArbPrime por 7 dias.',
      price: 500,
      promotionType: 'fixed',
      promotionValue: 100, // final R$ 400,00
      durationInDays: 7,
      level: 1,
      isTrial: false,
      isActive: true,
      sortOrder: 2,
    },
    {
      name: 'Teste Grátis',
      description: 'Experimente o ArbPrime por 3 dias, sem custo.',
      price: 0,
      promotionType: 'none',
      promotionValue: 0,
      durationInDays: 3,
      level: 1,
      isTrial: true,
      isActive: true,
      sortOrder: 0,
    },
  ];

  await repo.save(plans.map((p) => repo.create(p)));
  console.log('[seed] Planos padrão criados.');
};

export const seedPaymentConfig = async (): Promise<void> => {
  const repo = AppDataSource.getRepository(PaymentProviderConfig);
  const existing = await repo.findOneBy({ provider: 'efibank' });
  if (existing) return;

  const row = repo.create({
    provider: 'efibank',
    isActive: true,
    isDefault: true,
    environment: (process.env.PAYMENT_ENV as 'sandbox' | 'production') || 'sandbox',
    sandboxClientId: process.env.EFI_SANDBOX_CLIENT_ID || null,
    sandboxClientSecret: process.env.EFI_SANDBOX_CLIENT_SECRET || null,
    sandboxCertPath: process.env.EFI_SANDBOX_PIX_CERT || null,
    sandboxPixKey: process.env.EFI_SANDBOX_PIX_KEY || null,
    prodClientId: process.env.EFI_PROD_CLIENT_ID || null,
    prodClientSecret: process.env.EFI_PROD_CLIENT_SECRET || null,
    prodCertPath: process.env.EFI_PROD_PIX_CERT || null,
    prodPixKey: process.env.EFI_PROD_PIX_KEY || null,
    webhookSecret: process.env.EFI_WEBHOOK_SECRET || null,
    webhookBaseUrl: process.env.EFI_WEBHOOK_BASE_URL || null,
  });
  await repo.save(row);
  console.log('[seed] Config de pagamento (Efí) criada a partir do .env.');
};

export const seedManualConfig = async (): Promise<void> => {
  const repo = AppDataSource.getRepository(ManualPaymentConfig);
  const existing = await repo.findOneBy({ provider: 'manual_pix' });
  if (existing) return;

  const row = repo.create({
    provider: 'manual_pix',
    isActive: false, // o admin configura o QR/chave e ativa em Admin → Pagamentos.
    displayName: 'PIX Manual',
    instructions: 'Pague com o QR Code ou a chave PIX acima e anexe o comprovante. Seu acesso é liberado após a confirmação do pagamento.',
  });
  await repo.save(row);
  console.log('[seed] Config de pagamento manual criada (inativa).');
};
