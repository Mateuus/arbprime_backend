import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/**
 * Configuração do provedor de pagamento MANUAL (PIX estático com aprovação humana).
 * Diferente do Efí: não há API/webhook. O admin fornece um QR (imagem) e/ou o
 * código copia-e-cola; o usuário paga, anexa o comprovante e o admin aprova na
 * fila de aprovações (ver services/payment/manual-payment.service).
 *
 * É uma linha única (provider = 'manual_pix'), semeada em boot (seedManualConfig).
 */
@Entity('manual_payment_configs')
export class ManualPaymentConfig {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'varchar', length: 32, unique: true, default: 'manual_pix' })
    provider!: string;

    // Quando inativo, o método não aparece no checkout do usuário.
    @Column({ type: 'boolean', default: false })
    isActive!: boolean;

    // Nome exibido ao usuário (ex.: 'PIX Manual', 'PIX Direto').
    @Column({ type: 'varchar', length: 64, default: 'PIX Manual' })
    displayName!: string;

    // Chave PIX recebedora (exibida ao usuário como referência).
    @Column({ type: 'varchar', length: 255, nullable: true })
    pixKey!: string | null;

    // Código PIX copia-e-cola (opcional) — exibido com botão de copiar.
    @Column({ type: 'text', nullable: true })
    pixCopiaECola!: string | null;

    // Imagem do QR como data URI (data:image/png;base64,...). Mesmo padrão do
    // pixQrCodeImage da PaymentTransaction (evita servir estáticos).
    @Column({ type: 'longtext', nullable: true })
    qrImage!: string | null;

    // Instruções livres exibidas ao usuário (ex.: "Após pagar, anexe o comprovante").
    @Column({ type: 'text', nullable: true })
    instructions!: string | null;

    @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
    updatedAt!: Date;
}
