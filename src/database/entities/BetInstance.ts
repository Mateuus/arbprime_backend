import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { User } from './User';
import { Bankroll } from './Bankroll';
import {
  DesiredState, InstanceStatus, DedupeScope, StakeMode, RestartPolicy,
} from '../../enums/bet-instance.enum';

/**
 * Configuração da estratégia da instância (v1: valuebet). Guardada como JSON.
 * Os gates aqui são POR-INSTÂNCIA (a config admin `ArbPrime:Configs:ValuebetConfig`
 * é global e alimenta o robô emissor; esta filtra o que ESTA instância aposta).
 */
export interface BetInstanceConfig {
  // ---- gates de seleção do valuebet ----
  tiers: number[];               // subconjunto de [1,2,3] (1=Pinnacle núcleo … 3=consenso)
  edgeMin: number;               // edgePct mínimo (%) p/ apostar
  oddMin: number;
  oddMax: number;
  confidenceMin: number;         // 0..1
  markets: string[] | null;      // allowlist de mercados canônicos (null = todos habilitados)
  leagues: string[] | null;      // allowlist de ligas (null = todas)

  // ---- dimensionamento do stake ----
  stakeMode: StakeMode;
  kellyMultiplier: number;       // multiplica vb.stakeFraction (já Kelly ¼); 1 = usa como veio
  flatStake: number | null;      // usado quando stakeMode = flat
  minStake: number;              // piso (respeita mínimo da casa)
  maxStakePerBet: number;
  stakeRounding: number;         // arredonda o stake p/ múltiplo (0 = centavos; 1 = R$1; 0.5; 5…)

  // ---- dedupe ("não apostar 2x na mesma seleção/evento") ----
  dedupeScope: DedupeScope;
  maxBetsPerEvent: number;

  // ---- limites de segurança ----
  maxBetsPerDay: number | null;
  maxStakePerDay: number | null;
  stopLossDay: number | null;    // perda diária (R$) que auto-pausa a instância

  // ---- operação ----
  pollIntervalSec: number;       // intervalo do loop (ex.: 20s)
  dryRun: boolean;               // simula (não efetiva o place)
  maxEventDays: number | null;   // só apostar jogos que começam em até X dias (null = sem limite)

  // ---- resiliência ----
  restartPolicy: RestartPolicy;
  maxRetries: number;            // tentativas antes de desistir (0 = infinito com backoff)

  // ---- rede ----
  proxyId: string | null;        // id do proxy PINADO da ArbPrime:Configs:ProxyList (null = origem direta / app pareado)
}

/** Defaults conservadores p/ uma instância nova (o controller usa ao criar). */
export const DEFAULT_INSTANCE_CONFIG: BetInstanceConfig = {
  tiers: [1, 2],
  edgeMin: 2.0,
  oddMin: 1.3,
  oddMax: 5.0,
  confidenceMin: 0.5,
  markets: null,
  leagues: null,
  stakeMode: StakeMode.KELLY,
  kellyMultiplier: 1.0,
  flatStake: null,
  minStake: 2.0,
  maxStakePerBet: 20.0,
  stakeRounding: 0,
  dedupeScope: DedupeScope.PER_EVENT,
  maxBetsPerEvent: 1,
  maxBetsPerDay: 50,
  maxStakePerDay: 200.0,
  stopLossDay: 100.0,
  pollIntervalSec: 20,
  dryRun: true,
  maxEventDays: null,
  restartPolicy: RestartPolicy.ON_FAILURE,
  maxRetries: 5,
  proxyId: null,
};

/**
 * "Instância de Bet": um daemon por usuário que mantém sessão logada numa casa
 * (v1 só betano) e aposta valuebet automático conforme `config`. O estado é
 * PERSISTIDO (sobrevive a restart): `desiredState` = o que o usuário quer;
 * `status` = o que o worker está realmente fazendo (via heartbeat).
 *
 * Credenciais da casa ficam CIFRADAS (AES-256-GCM, ver utils/crypto) — nunca em
 * claro, nunca devolvidas ao frontend.
 */
@Entity('bet_instances')
@Index('idx_betinst_user', ['userId'])
@Index('idx_betinst_desired', ['desiredState'])
export class BetInstance {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'varchar' })
  userId!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'varchar', length: 80, default: 'betano' })
  bookmakerSlug!: string; // v1: sempre 'betano'

  // Banca do Analytix onde a instância registra as apostas (kind='valuebet').
  @ManyToOne(() => Bankroll, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'bankrollId' })
  bankroll!: Bankroll | null;

  @Column({ type: 'varchar', nullable: true })
  bankrollId!: string | null;

  // Conta da casa (UserBookmakerAccount) — opcional, p/ ler saldo real / atribuir P&L.
  @Column({ type: 'varchar', nullable: true })
  accountId!: string | null;

  // ---- estado (desired vs actual) ----
  @Column({ type: 'varchar', length: 12, default: DesiredState.STOPPED })
  desiredState!: DesiredState;

  @Column({ type: 'varchar', length: 20, default: InstanceStatus.STOPPED })
  status!: InstanceStatus;

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  lastHeartbeatAt!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  lastRunAt!: Date | null;

  // ---- estratégia ----
  @Column({ type: 'varchar', length: 20, default: 'valuebet' })
  strategy!: string; // v1: sempre 'valuebet'

  @Column({ type: 'json' })
  config!: BetInstanceConfig;

  // ---- credenciais da casa (CIFRADAS — utils/crypto) ----
  @Column({ type: 'text', nullable: true })
  encUsername!: string | null;

  @Column({ type: 'text', nullable: true })
  encPassword!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  credentialsSetAt!: Date | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}
