import { getRedisClient } from "@Core/redis";
import { logger, LoggerClass } from "@Core/logger";
import { ExternalWriteDataSource, ensureExternalWriteDb } from "../database/external-write-data-source";
import { Proxy } from "../database/external/proxy.entity";

const ARBPRIME_FOLDER_BASE_RKEY = process.env.ARBPRIME_FOLDER_BASE_RKEY || "ArbPrime";
const PROXY_REDIS_KEY = `${ARBPRIME_FOLDER_BASE_RKEY}:Configs:ProxyList`;

/**
 * Espelha o conjunto de proxies do banco para o Redis no formato consumido pelo
 * proxyManager de referência (hash chaveado por ip:port). É chamado após qualquer
 * mutação (sync/criação/edição/toggle/remoção) para manter o Redis em sincronia.
 */
export async function syncProxiesToRedis(): Promise<void> {
  try {
    await ensureExternalWriteDb();
    const repo = ExternalWriteDataSource.getRepository(Proxy);
    const proxies = await repo.find();
    const redis = getRedisClient();

    const payload: Record<string, string> = {};
    for (const p of proxies) {
      const field = `${p.ip}:${p.port}`;
      payload[field] = JSON.stringify({
        protocol: p.protocol,
        iptype: p.ipType,
        ip: p.ip,
        port: String(p.port),
        login: p.login,
        password: p.password,
        isprivate: p.isPrivate,
        isenabled: p.isEnabled,
        // Escopo por casa: vazio = pool global; não-vazio = só essas casas (slugs).
        // O robô usa para reservar, ex., os residenciais só para a bet365.
        scope: Array.isArray(p.scope) ? p.scope : []
      });
    }

    // Reconstrói a hash do zero para refletir remoções.
    await redis.del(PROXY_REDIS_KEY);
    if (Object.keys(payload).length > 0) {
      await redis.hset(PROXY_REDIS_KEY, payload);
    }
  } catch (error) {
    logger.error(
      `❌ Erro ao espelhar proxies no Redis: ${(error as Error).message}`,
      LoggerClass.LogCategory.Server,
      "[PROXY_MANAGER]"
    );
  }
}
