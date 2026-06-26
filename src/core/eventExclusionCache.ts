import { getRedisClient } from "@Core/redis";
import { AppDataSource } from "@Database";
import { EventExclusion } from "@Entities";

/**
 * Exclusões GLOBAIS de eventos do cálculo de surebets. Fonte da verdade é a
 * tabela local `event_exclusions` (arbprime); espelhamos no Redis para o robô
 * arbbetting_master honrar no matching/cálculo, e para o próprio arbprime
 * filtrar o que serve via WebSocket (efeito imediato).
 *
 * Chave/campos (contrato com o robô):
 *  - ArbPrime:Configs:EventExclusions  hash
 *      `house:{bookmaker}:{houseEventId}`          -> "1"  (excluir a casa inteira do evento)
 *      `market:{bookmaker}:{houseEventId}:{market}` -> "1"  (excluir 1 mercado da casa no evento)
 *      `group:{groupId}`                            -> "1"  (excluir o evento inteiro)
 *  ({market} = mercado canônico `{id}:{subId}`, pode conter ':')
 */
const EXCLUSIONS_KEY = process.env.EVENT_EXCLUSIONS_KEY || "ArbPrime:Configs:EventExclusions";

export interface ExclusionSets {
  houses: Set<string>;  // `${bookmaker}:${houseEventId}`
  markets: Set<string>; // `${bookmaker}:${houseEventId}:${market}`
  groups: Set<string>;  // groupId
}

/** Reconstrói o hash do Redis a partir da tabela. Hash vazio é válido (= sem exclusões). */
export async function rebuildEventExclusionCache(): Promise<number> {
  const rows = await AppDataSource.getRepository(EventExclusion).findBy({ isActive: true });

  const data: Record<string, string> = {};
  for (const r of rows) {
    if (r.scope === "house" && r.bookmaker && r.houseEventId) {
      data[`house:${r.bookmaker.toLowerCase()}:${r.houseEventId}`] = "1";
    } else if (r.scope === "market" && r.bookmaker && r.houseEventId && r.market) {
      data[`market:${r.bookmaker.toLowerCase()}:${r.houseEventId}:${r.market}`] = "1";
    } else if (r.scope === "event" && r.groupId) {
      data[`group:${r.groupId}`] = "1";
    }
  }

  const redis = getRedisClient();
  // Substitui o hash inteiro (remoções refletem na hora). Vazio => só apaga.
  const multi = redis.multi().del(EXCLUSIONS_KEY);
  if (Object.keys(data).length > 0) multi.hset(EXCLUSIONS_KEY, data);
  await multi.exec();
  return Object.keys(data).length;
}

/** Lê o hash e devolve os Sets para filtrar a lista servida. Best-effort. */
export async function getExclusionSets(): Promise<ExclusionSets> {
  const houses = new Set<string>();
  const markets = new Set<string>();
  const groups = new Set<string>();
  try {
    const redis = getRedisClient();
    const raw = await redis.hgetall(EXCLUSIONS_KEY);
    for (const field of Object.keys(raw || {})) {
      // Ordem importa: `market:` é prefixo distinto de `house:`/`group:`.
      if (field.startsWith("market:")) markets.add(field.slice("market:".length));
      else if (field.startsWith("house:")) houses.add(field.slice("house:".length));
      else if (field.startsWith("group:")) groups.add(field.slice("group:".length));
    }
  } catch (error) {
    console.error("[eventExclusionCache] getExclusionSets falhou:", (error as Error).message);
  }
  return { houses, markets, groups };
}
