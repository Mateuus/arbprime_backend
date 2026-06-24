import 'dotenv/config';
import 'reflect-metadata';
import { DataSource } from "typeorm";
import { Team } from "./external/team.entity";
import { TeamAlias } from "./external/team-alias.entity";
import { League } from "./external/league.entity";
import { LeagueAlias } from "./external/league-alias.entity";
import { BookmakerMarketName } from "./external/bookmaker-market-name.entity";

/**
 * DataSource SECUNDÁRIA, GRAVÁVEL, apontando para o MySQL do arbbetting_master.
 * É separada da ExternalDataSource (read-only de odds) de propósito: aqui só
 * vivem as tabelas de CURADORIA editáveis pelo ArbPrime — `teams` e
 * `team_aliases` — que o próprio arbbetting_master documenta como "editável pelo
 * ArbPrime" (mesclar times, confirmar/corrigir alias). O matcher do master lê
 * essas tabelas e reconstrói o cache do Redis a cada ciclo.
 *
 * - `synchronize: false`: o schema é DONO do arbbetting_master; nunca alteramos.
 * - Entities passadas explicitamente (não por glob) para não colidir com a
 *   AppDataSource principal (synchronize:true) nem com a ExternalDataSource.
 * - Reaproveita as credenciais DB_* (mesmo servidor MySQL); só o nome do banco
 *   muda via ARBBET_DB_NAME / ARBBET_DB_NAME_PROD. Para endurecer no futuro,
 *   basta provisionar uma conta de privilégio mínimo em ARBBET_WRITE_DB_USER/PASS
 *   (com fallback para as credenciais atuais).
 */
const port = process.env.ARBBET_DB_PORT
  ? parseInt(process.env.ARBBET_DB_PORT, 10)
  : (process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306);

const databaseName = process.env.NODE_ENV === 'production'
  ? (process.env.ARBBET_DB_NAME_PROD || 'arbbetting_production')
  : (process.env.ARBBET_DB_NAME || 'arbbetting_development');

export const ExternalWriteDataSource = new DataSource({
  type: 'mysql',
  host: process.env.ARBBET_DB_HOST || process.env.DB_HOST,
  port,
  username: process.env.ARBBET_WRITE_DB_USER || process.env.ARBBET_DB_USER || process.env.DB_USER,
  password: process.env.ARBBET_WRITE_DB_PASS || process.env.ARBBET_DB_PASS || process.env.DB_PASS,
  database: databaseName,
  synchronize: false,
  logging: false,
  entities: [Team, TeamAlias, League, LeagueAlias, BookmakerMarketName],
  subscribers: [],
  migrations: []
});

let initPromise: Promise<DataSource> | null = null;

/**
 * Garante que a ExternalWriteDataSource esteja inicializada (lazy, idempotente).
 * Falha de conexão NÃO derruba o arbprime — propaga o erro ao controller, que
 * responde 503. A inicialização é memoizada; se falhar, a próxima chamada tenta
 * de novo.
 */
export async function ensureExternalWriteDb(): Promise<DataSource> {
  if (ExternalWriteDataSource.isInitialized) return ExternalWriteDataSource;
  if (!initPromise) {
    initPromise = ExternalWriteDataSource.initialize().catch((err) => {
      initPromise = null; // permite retry na próxima chamada
      throw err;
    });
  }
  return initPromise;
}
