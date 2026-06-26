import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn
} from 'typeorm';

/**
 * Espelho da tabela `proxies` — cujo schema agora é DONO do arbbetting_master
 * (lá fica a entity canônica e o synchronize). O ArbPrime apenas CURA esta tabela
 * (tela /admin/proxies) via ExternalWriteDataSource e espelha no Redis
 * (`ArbPrime:Configs:ProxyList`), de onde os coletores leem.
 *
 * Fica fora de `entities/` (que a AppDataSource principal varre por glob) para
 * não ser recriada/sincronizada no banco do arbprime. Colunas em camelCase para
 * casar exatamente com a tabela existente — NÃO renomear.
 */
@Entity('proxies')
@Index('IDX_proxy_provider_external', ['provider', 'externalId'], { unique: true })
export class Proxy {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ default: 'manual' })
  provider!: string;

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
   * Escopo de uso: slugs de casas (Bookmaker.slug) às quais o proxy fica restrito.
   * Vazio/null = pool global. Espelhado no Redis p/ o robô filtrar por casa.
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
