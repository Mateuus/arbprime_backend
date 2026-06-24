import 'dotenv/config';
import 'reflect-metadata';
import { DataSource } from "typeorm";
import { OddsEvent } from "./external/odds-event.entity";
import { OddsCurrent } from "./external/odds-current.entity";
import { OddsHistory } from "./external/odds-history.entity";
import { EventGroup } from "./external/event-group.entity";
import { EventGroupMember } from "./external/event-group-member.entity";
import { League } from "./external/league.entity";
import { LeagueAlias } from "./external/league-alias.entity";

/**
 * DataSource SECUNDÁRIA, somente-leitura, apontando para o MySQL do
 * arbbetting_master (mesmo servidor, banco diferente). É de onde o arbprime puxa
 * o catálogo de eventos (`odds_events`) e odds (`odds_current` / `odds_history`).
 *
 * - `synchronize: false`: nunca alteramos o schema do banco do outro sistema.
 * - Entities passadas explicitamente (não por glob) para não colidir com a
 *   AppDataSource principal, que tem `synchronize: true`.
 * - Reaproveita as credenciais DB_* (mesmo servidor MySQL); só o nome do banco
 *   muda via ARBBET_DB_NAME / ARBBET_DB_NAME_PROD (com defaults sensatos).
 */
const port = process.env.ARBBET_DB_PORT
  ? parseInt(process.env.ARBBET_DB_PORT, 10)
  : (process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306);

const databaseName = process.env.NODE_ENV === 'production'
  ? (process.env.ARBBET_DB_NAME_PROD || 'arbbetting_production')
  : (process.env.ARBBET_DB_NAME || 'arbbetting_development');

export const ExternalDataSource = new DataSource({
  type: 'mysql',
  host: process.env.ARBBET_DB_HOST || process.env.DB_HOST,
  port,
  username: process.env.ARBBET_DB_USER || process.env.DB_USER,
  password: process.env.ARBBET_DB_PASS || process.env.DB_PASS,
  database: databaseName,
  synchronize: false,
  logging: false,
  entities: [OddsEvent, OddsCurrent, OddsHistory, EventGroup, EventGroupMember, League, LeagueAlias],
  subscribers: [],
  migrations: []
});

let initPromise: Promise<DataSource> | null = null;

/**
 * Garante que a ExternalDataSource esteja inicializada (lazy, idempotente).
 * Falha de conexão aqui NÃO derruba o arbprime — só propaga o erro para o
 * controller, que responde com erro HTTP. A inicialização é memoizada; se falhar,
 * a próxima chamada tenta de novo.
 */
export async function ensureExternalDb(): Promise<DataSource> {
  if (ExternalDataSource.isInitialized) return ExternalDataSource;
  if (!initPromise) {
    initPromise = ExternalDataSource.initialize().catch((err) => {
      initPromise = null; // permite retry na próxima chamada
      throw err;
    });
  }
  return initPromise;
}
