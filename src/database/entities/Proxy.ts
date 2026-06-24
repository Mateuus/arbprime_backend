import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn
} from 'typeorm';

/**
 * Proxy persistido no banco. Cobre proxies vindos do provedor Proxy-Seller
 * (provider = 'proxy-seller') e proxies cadastrados manualmente (provider = 'manual').
 * O conjunto é espelhado no Redis (ArbPrime:Configs:ProxyList) pelo proxyManager.
 */
@Entity('proxies')
// Unicidade por (provider, externalId) — permite vários providers sem colidir o id externo.
@Index('IDX_proxy_provider_external', ['provider', 'externalId'], { unique: true })
export class Proxy {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Provedor de origem: 'manual', 'proxy-seller' e outros no futuro (extensível).
  @Column({ default: 'manual' })
  provider!: string;

  // id do proxy no provider externo (usado para upsert na sincronização). Null para manuais.
  @Column({ type: 'varchar', nullable: true })
  externalId!: string | null;

  @Column({ type: 'varchar', nullable: true })
  orderId!: string | null;

  @Column({ default: 'http' })
  protocol!: string; // http | https | socks5

  @Column({ default: 'ipv4' })
  ipType!: string; // ipv4 | ipv6 | resident | mobile | isp | mix

  @Column()
  ip!: string;

  @Column({ type: 'int' })
  port!: number;

  @Column({ type: 'int', nullable: true })
  portSocks!: number | null;

  @Column({ default: '' })
  login!: string;

  @Column({ default: '' })
  password!: string;

  @Column({ type: 'varchar', nullable: true })
  country!: string | null;

  @Column({ type: 'varchar', length: 3, nullable: true })
  countryAlpha3!: string | null;

  @Column({ type: 'varchar', nullable: true })
  status!: string | null;

  @Column({ default: true })
  isPrivate!: boolean;

  @Column({ default: true })
  isEnabled!: boolean;

  /**
   * Escopo de uso: lista de slugs de casas (Bookmaker.slug) às quais este proxy
   * fica restrito. Vazio/null = pool global (qualquer casa pode usar). Espelhado
   * no Redis para o robô (arbbetting_master) filtrar o proxy por casa — usado, por
   * ex., para reservar os residenciais (caros, por banda) só para a bet365.
   */
  @Column('simple-array', { nullable: true })
  scope!: string[] | null;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @Column({ type: 'varchar', nullable: true })
  dateStart!: string | null;

  @Column({ type: 'varchar', nullable: true })
  dateEnd!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
