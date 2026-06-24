import { getRedisClient } from "@Core/redis";
import { ExternalWriteDataSource, ensureExternalWriteDb } from "../database/external-write-data-source";
import { BookmakerMarketName } from "../database/external/bookmaker-market-name.entity";

/**
 * Espelha o `syncMarketNamesDbToRedis()` do arbbetting_master: relê
 * `bookmaker_market_names` e reconstrói o cache quente do Redis que o robô usa
 * para resolver `leg.rawMarket`. Chamado após cada edição de curadoria no
 * ArbPrime para refletir IMEDIATAMENTE. Best-effort (Redis falhar não derruba).
 *
 * Chave/campos IDÊNTICOS ao master (market-name-resolver.ts):
 *  - ArbPrime:Configs:MarketNames   hash  `${bookmaker}:${marketId}` -> displayName
 *    (bookmaker "" = override global). Substitui o hash inteiro p/ refletir remoções.
 */
const MARKET_NAMES_KEY = process.env.MARKET_NAMES_KEY || "ArbPrime:Configs:MarketNames";

export async function rebuildMarketNameCache(): Promise<number> {
  await ensureExternalWriteDb();
  const rows = await ExternalWriteDataSource.getRepository(BookmakerMarketName).find();

  const data: Record<string, string> = {};
  for (const r of rows) {
    if (!r.displayName) continue;
    data[`${r.bookmaker}:${r.marketId}`] = r.displayName;
  }

  // Segurança: nunca zera o cache se não houver linhas (preserva o que o robô usa).
  if (Object.keys(data).length === 0) return 0;

  const redis = getRedisClient();
  await redis.multi().del(MARKET_NAMES_KEY).hset(MARKET_NAMES_KEY, data).exec();
  return Object.keys(data).length;
}
