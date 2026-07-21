import { Column, Entity, PrimaryColumn } from "typeorm";

/**
 * Mapa `team_id → sofascore_id` — tabela SEPARADA de propósito.
 *
 * NÃO pomos o `sofascore_id` direto na tabela `teams` porque o arbbetting_master
 * roda com `synchronize: true` (fleet de workers) e o TypeORM DROPA qualquer coluna
 * que não esteja na entidade DELE — então a coluna sumia em segundos. O synchronize,
 * porém, NUNCA dropa TABELAS que não conhece; esta tabela (definida só aqui, na
 * ExternalWriteDataSource com synchronize:false) fica imune. Colocalizada no banco
 * do arbbetting p/ dar join fácil com `teams` (e o master poder ler no futuro).
 *
 * Enriquecida OFFLINE (ação de admin em /admin/teams — busca por nome no SoFaScore),
 * nunca em runtime. O crest vem de https://api.sofascore.com/api/v1/team/{id}/image.
 */
@Entity("team_sofascore")
export class TeamSofascore {
  /** = teams.id (bigint). 1:1 com o time canônico. */
  @PrimaryColumn({ name: "team_id", type: "bigint" })
  teamId!: string;

  @Column({ name: "sofascore_id", type: "bigint" })
  sofascoreId!: string;

  @Column({ name: "updated_at", type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  updatedAt!: Date;
}
