import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";

/**
 * Espelho da tabela `bookmaker_market_names` do arbbetting_master. Dicionário
 * curado (casa, mercado canônico) -> NOME EXIBIDO como a casa apresenta no site
 * (ex.: (estrelabet, draw-no-bet) -> "Empate Anula"). Usado p/ preencher
 * `leg.rawMarket` e ajudar o usuário a achar o mercado na casa.
 *
 * `bookmaker = ""` indica DEFAULT global (fallback p/ qualquer casa). Chave única
 * (bookmaker, marketId). Fonte da verdade no MySQL do arbbetting; o robô lê um
 * espelho no Redis (`ArbPrime:Configs:MarketNames`), reconstruído pelo ArbPrime
 * após cada edição (ver `marketNameCache`). Mantido idêntico ao master.
 */
@Entity("bookmaker_market_names")
@Unique("uq_bookmaker_market_name", ["bookmaker", "marketId"])
@Index("idx_bmn_bookmaker", ["bookmaker"])
export class BookmakerMarketName {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  /** Casa de apostas (ex.: "estrelabet"). "" = default global p/ qualquer casa. */
  @Column({ type: "varchar", length: 50, default: "" })
  bookmaker!: string;

  /** Id canônico do mercado (ex.: "win-to-nil-away", "draw-no-bet-1st-half"). */
  @Column({ name: "market_id", type: "varchar", length: 80 })
  marketId!: string;

  /** Nome do mercado como a casa apresenta no site (ex.: "Empate Anula Aposta"). */
  @Column({ name: "display_name", type: "varchar", length: 160 })
  displayName!: string;

  /** seed (semeado do canônico PT) | feed (capturado do feed) | manual (curado aqui). */
  @Column({ type: "varchar", length: 10, default: "seed" })
  source!: string;

  @Column({ name: "created_at", type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  updatedAt!: Date;
}
