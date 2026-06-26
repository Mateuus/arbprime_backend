import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/**
 * Configuração de um provider de pagamento (atualmente só Efí Bank). Semeada a
 * partir do .env no primeiro boot (ver utils/seedPaymentConfig) e editável pelo
 * admin. A factory de pagamento lê esta config (com fallback ao .env).
 *
 * Guardamos credenciais de sandbox e produção; `environment` define qual está
 * em uso. Os certificados (.p12) ficam como arquivos; aqui guardamos o caminho.
 */
@Entity('payment_provider_configs')
export class PaymentProviderConfig {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'varchar', length: 32, unique: true })
    provider!: string; // 'efibank'

    @Column({ type: 'boolean', default: true })
    isActive!: boolean;

    @Column({ type: 'boolean', default: false })
    isDefault!: boolean;

    // Ambiente em uso: 'sandbox' (homologação) ou 'production'.
    @Column({ type: 'varchar', length: 16, default: 'sandbox' })
    environment!: 'sandbox' | 'production';

    // ---- Credenciais SANDBOX ----
    @Column({ type: 'varchar', length: 255, nullable: true })
    sandboxClientId!: string | null;

    @Column({ type: 'varchar', length: 255, nullable: true })
    sandboxClientSecret!: string | null;

    @Column({ type: 'varchar', length: 255, nullable: true })
    sandboxCertPath!: string | null;

    @Column({ type: 'varchar', length: 255, nullable: true })
    sandboxPixKey!: string | null;

    // ---- Credenciais PRODUÇÃO ----
    @Column({ type: 'varchar', length: 255, nullable: true })
    prodClientId!: string | null;

    @Column({ type: 'varchar', length: 255, nullable: true })
    prodClientSecret!: string | null;

    @Column({ type: 'varchar', length: 255, nullable: true })
    prodCertPath!: string | null;

    @Column({ type: 'varchar', length: 255, nullable: true })
    prodPixKey!: string | null;

    // Segredo opcional para validação adicional de webhook.
    @Column({ type: 'varchar', length: 255, nullable: true })
    webhookSecret!: string | null;

    // URL pública base da API (onde o provider entrega o webhook), ex.: https://api.arbprime.pro
    @Column({ type: 'varchar', length: 255, nullable: true })
    webhookBaseUrl!: string | null;

    @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
    updatedAt!: Date;
}
