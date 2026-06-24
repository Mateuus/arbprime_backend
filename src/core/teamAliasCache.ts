import { getRedisClient } from "@Core/redis";
import { ExternalWriteDataSource, ensureExternalWriteDb } from "../database/external-write-data-source";
import { Team as TeamEntity } from "../database/external/team.entity";
import { TeamAlias as TeamAliasEntity } from "../database/external/team-alias.entity";

/**
 * Espelha o `rebuildFromDb()` do arbbetting_master (TeamAliasManager): relê
 * `teams` + `team_aliases` do MySQL e reconstrói o cache quente do Redis. O
 * matcher do master também reconstrói a cada ciclo (~120s); chamamos aqui logo
 * após uma escrita de curadoria para a mudança refletir IMEDIATAMENTE (sem
 * esperar o ciclo). É best-effort: se o Redis falhar, o MySQL continua sendo a
 * fonte da verdade e o matcher reconstrói no próximo ciclo.
 *
 * Chaves (idênticas ao master):
 *  - ArbBetting:Cache:TeamAliasMap   hash  `${sport}|${category}|${aliasNorm}` -> teamId
 *  - ArbBetting:Cache:TeamMeta       hash  teamId -> JSON {canonicalName, category}
 *  - ArbBetting:Cache:TeamAliasVersion  string  timestamp (cache buster)
 */
const BASE = process.env.ARB_FOLDER_BASE_RKEY || "ArbBetting";
const ALIAS_MAP_KEY = `${BASE}:Cache:TeamAliasMap`;
const TEAM_META_KEY = `${BASE}:Cache:TeamMeta`;
const VERSION_KEY = `${BASE}:Cache:TeamAliasVersion`;

export async function rebuildTeamAliasCache(): Promise<number> {
  await ensureExternalWriteDb();
  const teams = await ExternalWriteDataSource.getRepository(TeamEntity).find();
  const aliases = await ExternalWriteDataSource.getRepository(TeamAliasEntity).find();

  const aliasMap: Record<string, string> = {};
  for (const a of aliases) {
    aliasMap[`${a.sport}|${a.category}|${a.aliasNorm}`] = String(a.teamId);
  }
  const metaObj: Record<string, string> = {};
  for (const t of teams) {
    metaObj[String(t.id)] = JSON.stringify({ canonicalName: t.canonicalName, category: t.category });
  }

  const redis = getRedisClient();
  const pipeline = redis.pipeline();
  pipeline.del(ALIAS_MAP_KEY, TEAM_META_KEY);
  if (Object.keys(aliasMap).length) pipeline.hset(ALIAS_MAP_KEY, aliasMap);
  if (Object.keys(metaObj).length) pipeline.hset(TEAM_META_KEY, metaObj);
  pipeline.set(VERSION_KEY, String(Date.now()));
  await pipeline.exec();

  return Object.keys(aliasMap).length;
}
