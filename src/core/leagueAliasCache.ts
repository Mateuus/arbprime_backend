import { getRedisClient } from "@Core/redis";
import { ExternalWriteDataSource, ensureExternalWriteDb } from "../database/external-write-data-source";
import { League } from "../database/external/league.entity";
import { LeagueAlias } from "../database/external/league-alias.entity";

/**
 * Espelha o `rebuildFromDb()` do LeagueAliasManager do arbbetting_master: relê
 * `leagues` + `league_aliases` e reconstrói o cache quente do Redis. O matcher
 * também reconstrói a cada ciclo (~120s); chamamos aqui após uma escrita de
 * curadoria para refletir IMEDIATAMENTE. Best-effort (Redis falhar não derruba).
 *
 * Chaves (idênticas ao master):
 *  - ArbBetting:Cache:LeagueAliasMap     hash  `${sport}|${bookmaker}|${aliasNorm}` -> leagueId
 *  - ArbBetting:Cache:LeagueMeta         hash  leagueId -> JSON {canonicalName, country, countryKey}
 *  - ArbBetting:Cache:LeagueAliasVersion string  timestamp
 */
const BASE = process.env.ARB_FOLDER_BASE_RKEY || "ArbBetting";
const ALIAS_MAP_KEY = `${BASE}:Cache:LeagueAliasMap`;
const LEAGUE_META_KEY = `${BASE}:Cache:LeagueMeta`;
const VERSION_KEY = `${BASE}:Cache:LeagueAliasVersion`;

export async function rebuildLeagueAliasCache(): Promise<number> {
  await ensureExternalWriteDb();
  const leagues = await ExternalWriteDataSource.getRepository(League).find();
  const aliases = await ExternalWriteDataSource.getRepository(LeagueAlias).find();

  const aliasMap: Record<string, string> = {};
  for (const a of aliases) aliasMap[`${a.sport}|${a.bookmaker || ""}|${a.aliasNorm}`] = String(a.leagueId);
  const metaObj: Record<string, string> = {};
  for (const l of leagues) metaObj[String(l.id)] = JSON.stringify({ canonicalName: l.canonicalName, country: l.country, countryKey: l.countryKey });

  const redis = getRedisClient();
  const pipeline = redis.pipeline();
  pipeline.del(ALIAS_MAP_KEY, LEAGUE_META_KEY);
  if (Object.keys(aliasMap).length) pipeline.hset(ALIAS_MAP_KEY, aliasMap);
  if (Object.keys(metaObj).length) pipeline.hset(LEAGUE_META_KEY, metaObj);
  pipeline.set(VERSION_KEY, String(Date.now()));
  await pipeline.exec();

  return Object.keys(aliasMap).length;
}
