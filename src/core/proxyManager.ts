import { getRedisClient } from "@Core/redis";
import { logger, LoggerClass } from "@Core/logger";
import { ExternalWriteDataSource, ensureExternalWriteDb } from "../database/external-write-data-source";
import { Proxy } from "../database/external/proxy.entity";

const ARBPRIME_FOLDER_BASE_RKEY = process.env.ARBPRIME_FOLDER_BASE_RKEY || "ArbPrime";
const PROXY_REDIS_KEY = `${ARBPRIME_FOLDER_BASE_RKEY}:Configs:ProxyList`;

/**
 * Identidade de UM proxy na hash do Redis.
 *
 * ⚠️ Era só `ip:port`, e isso QUEBRA no modelo gateway. Medido em 24/ago/2026: o
 * pedido novo do proxy-seller veio como **10 credenciais no MESMO `ip:port`**
 * (`62.93.164.201:50100`), cada login saindo por um IP diferente (151.242.33.x).
 * Com a chave antiga as 10 colidiam num único field e sobrava 1 proxy de 10.
 *
 * O login entra na chave só quando existe, então proxies sem credencial mantêm a
 * chave antiga (`ip:port`) e nada muda para eles. O field é OPACO para quem lê (o
 * `getProxyList` do master só o guarda como `id`, não parseia) — por isso dá para
 * mudar o formato sem quebrar os coletores.
 */
const proxyFieldOf = (p: Pick<Proxy, "ip" | "port" | "login">): string =>
  p.login ? `${p.ip}:${p.port}:${p.login}` : `${p.ip}:${p.port}`;

/**
 * Espelha o conjunto de proxies do banco para o Redis no formato consumido pelo
 * proxyManager de referência (hash chaveada por `proxyFieldOf`). É chamado após
 * qualquer mutação (sync/criação/edição/toggle/remoção) para manter o Redis em sincronia.
 */
export async function syncProxiesToRedis(): Promise<void> {
  try {
    await ensureExternalWriteDb();
    const repo = ExternalWriteDataSource.getRepository(Proxy);
    const proxies = await repo.find();
    const redis = getRedisClient();

    const payload: Record<string, string> = {};
    for (const p of proxies) {
      const field = proxyFieldOf(p);
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
