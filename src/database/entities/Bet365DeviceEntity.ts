import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { NoDelayAccount } from './NoDelayAccount';

/**
 * Device bet365 POR CONTA. Cada conta NoDelay do bet365 tem o SEU device (≠ device único da máquina):
 * o cookie de device-trust `aaat` é amarrado à conta (ue=email), então contas que compartilham device
 * se invalidam ({sr:8,"invalid_login"}). Ver [[bet365-multiaccount-device]].
 *
 * FLUXO:
 *  - criar conta → gera o device (newBet365Device: fingerprint da máquina + usdi/uqid próprio, SEM aaat) e grava aqui.
 *  - 1º login → o bet365 emite o `aaat` da conta; capturamos e ATUALIZAMOS esta entidade (trusted=true).
 *  - apostar → a instância quente carrega o device DAQUI (não o da máquina).
 *
 * `payload` guarda o Bet365Device completo (fingerprint/canvasDumps/syscolors/cf3/cf4/deviceTrust). O `aaat`
 * fica dentro de payload.deviceTrust.aaat quando capturado. `trusted` = já tem aaat da conta.
 */
@Entity('bet365_devices')
export class Bet365DeviceEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // 1 device por conta (unique). onDelete CASCADE: apagou a conta, some o device.
  @ManyToOne(() => NoDelayAccount, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'accountId' })
  account!: NoDelayAccount;

  @Column({ type: 'varchar', length: 64 })
  @Index('uq_bet365_device_account', { unique: true })
  accountId!: string;

  // Bet365Device completo (fingerprint, canvasDumps, syscolors, cf3, cf4, deviceTrust:{usdi, aaat?}).
  @Column({ type: 'json' })
  payload!: Record<string, unknown>;

  // true quando o `aaat` da conta já foi capturado no login (device confiável e pronto p/ apostar).
  @Column({ type: 'boolean', default: false })
  trusted!: boolean;

  @Column({ type: 'timestamp', nullable: true })
  trustedAt!: Date | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}
