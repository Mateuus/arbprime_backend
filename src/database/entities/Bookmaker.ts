import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn
} from 'typeorm';

/**
 * Config do NoDelay por casa (ver enums/nodelay.enum.ts). Casas da MESMA
 * `noDelayPlatform` falam o mesmo protocolo de login e só mudam o endpoint —
 * por isso o endereço mora aqui (admin), não no código.
 */
export interface NoDelayBookmakerConfig {
  /** Endpoint do WebSocket de login (ex.: 'wss://swarm.7games.bet.br/'). */
  wssUrl?: string | null;
  /** Origin/operador enviado no handshake do WSS e no mint de token (ex.: 'https://7games.bet.br'). */
  origin?: string | null;
  /** Host da API rogue/FSB da casa (ex.: 'https://prod20563.fssb.io'). É POR CASA
   *  (7games=prod20563, betão=prod20562) — as odds e o place saem daqui. */
  rogueUrl?: string | null;
  /** swarm: site_id do request_session = partner_id da casa (7games = 18751367). Obrigatório. */
  siteId?: string | null;
  /** swarm: source do request_session (padrão 42 = web). */
  source?: number | null;
  /** swarm: idioma da sessão (padrão 'pt-br'). */
  language?: string | null;

  // ---- radar (widget de acompanhamento ao vivo) ----
  /**
   * Chave de assinatura do widget, POR ESPORTE (`{"default":"…","2":"…"}` —
   * a chave é o sportId da casa; `default` = futebol). Fica em config e não no
   * código porque rotaciona quando a casa renova o contrato. Sem ela o widget
   * cai na versão 2D, que funciona igual.
   */
  radarProfiles?: Record<string, string> | null;
  /** Origem que serve o /api/sportsbook/match-tracker-map (padrão: `url` da casa). */
  radarMapUrl?: string | null;
}

/**
 * Casa de aposta cadastrada no ArbPrime. O `slug` é a CHAVE de ligação com o
 * arbbetting_master: deve ser exatamente o identificador que ele já fornece
 * (ex.: 'pinnacle', 'betano', 'superbet'). Com isso o frontend casa cada odd/
 * evento ao registro e exibe ícone, nome amigável e cor da casa.
 */
@Entity('bookmakers')
export class Bookmaker {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Identificador da casa no arbbetting_master (ex.: 'pinnacle'). Único.
  @Index('IDX_bookmaker_slug', { unique: true })
  @Column()
  slug!: string;

  // Nome amigável para exibição (ex.: 'Pinnacle').
  @Column()
  name!: string;

  // Logo/ícone da casa: aceita URL (https...) OU um data URL (base64) quando a
  // imagem é enviada/colada no cadastro. Por isso é `text` (não cabe em varchar).
  @Column({ type: 'text', nullable: true })
  logoUrl!: string | null;

  // Cor de marca (hex ou classe), usada nos badges/realces.
  @Column({ type: 'varchar', length: 32, nullable: true })
  color!: string | null;

  // Site da casa (opcional).
  @Column({ type: 'varchar', nullable: true })
  url!: string | null;

  // Slug da casa "mãe" quando esta casa é um CLONE (mesma operação/odds).
  // Null = não é clone.
  @Column({ type: 'varchar', nullable: true })
  cloneOf!: string | null;

  // Comissão da casa em PORCENTAGEM (ex.: 6.5 = 6,5%), para casas de exchange
  // (ex.: Betfair) onde a comissão incide sobre o lucro. Usada para pré-preencher
  // automaticamente o campo de comissão na calculadora. Null = casa comum (0%).
  @Column({ type: 'float', nullable: true })
  commissionPct!: number | null;

  @Column({ default: true })
  isActive!: boolean;

  // ---- NoDelay (aposta rápida multi-conta) ----

  // "ActiveNoDelay": libera a casa no NoDelay. Só casas com isto ligado (e com
  // plataforma+wssUrl configurados) aparecem para o usuário conectar contas.
  @Column({ default: false })
  noDelayEnabled!: boolean;

  // Família de login (ver NoDelayPlatform). Define QUAL protocolo falar; o
  // ENDEREÇO vem do noDelayConfig — é o que permite reaproveitar o mesmo
  // cliente em várias casas do mesmo grupo (7games/betão/7k/apostatudo).
  @Column({ type: 'varchar', length: 32, nullable: true })
  noDelayPlatform!: string | null;

  @Column({ type: 'json', nullable: true })
  noDelayConfig!: NoDelayBookmakerConfig | null;

  // Ordem de exibição (menor primeiro).
  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
