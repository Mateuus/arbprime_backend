import { FastifyRequest, FastifyReply } from "fastify";
import { DeepPartial } from "typeorm";
import axios from "axios";
import { SocksProxyAgent } from "socks-proxy-agent";
import { AppDataSource } from "@Database";
import { Proxy } from "@Entities";
import { createResponse } from "@utils/resFormatter";
import { fetchProxySellerList, ProxySellerType, ProxySellerProxy } from "@Services/proxyseller.service";
import { syncProxiesToRedis } from "@Core/proxyManager";

const proxyRepository = AppDataSource.getRepository(Proxy);

const SELLER_TYPES: ProxySellerType[] = ["ipv4", "ipv6", "mobile", "isp", "mix", "resident"];

// Faz o parse de uma linha no formato login:senha@ip:porta (auth opcional; suporta ipv6).
function parseProxyLine(line: string): { ip: string; port: number; login: string; password: string } | null {
  let host = line;
  let login = "";
  let password = "";

  const atIdx = line.lastIndexOf("@");
  if (atIdx !== -1) {
    const cred = line.slice(0, atIdx);
    host = line.slice(atIdx + 1);
    const colonIdx = cred.indexOf(":");
    if (colonIdx !== -1) {
      login = cred.slice(0, colonIdx);
      password = cred.slice(colonIdx + 1);
    } else {
      login = cred;
    }
  }

  const portIdx = host.lastIndexOf(":"); // último ':' separa o ip (inclui ipv6) da porta
  if (portIdx === -1) return null;

  const ip = host.slice(0, portIdx).trim();
  const portStr = host.slice(portIdx + 1).trim();
  const port = Number(portStr);

  if (!ip || !portStr || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { ip, port, login, password };
}

// Mapeia um proxy cru do Proxy-Seller para o formato da entidade.
function mapProxySeller(item: ProxySellerProxy, type: string): DeepPartial<Proxy> {
  const portHttp = item.port_http ?? item.port_socks ?? 0;
  return {
    provider: "proxy-seller",
    externalId: String(item.id),
    orderId: item.order_id != null ? String(item.order_id) : null,
    protocol: (item.protocol || "http").toLowerCase(),
    ipType: type || "ipv4",
    ip: item.ip_only || item.ip || "",
    port: Number(portHttp) || 0,
    portSocks: item.port_socks != null ? Number(item.port_socks) : null,
    login: item.login || "",
    password: item.password || "",
    country: item.country || null,
    countryAlpha3: item.country_alpha3 || null,
    status: item.status_type || item.status || null,
    comment: item.comment || null,
    dateStart: item.date_start || null,
    dateEnd: item.date_end || null
  };
}

/**
 * Registry de providers. Cada provider sabe buscar sua lista e devolvê-la já
 * normalizada no formato da entidade. Adicionar um novo provider = nova entrada aqui.
 */
const PROVIDERS: Record<string, (type: string) => Promise<DeepPartial<Proxy>[]>> = {
  "proxy-seller": async (type: string) => {
    const sellerType: ProxySellerType | "" = SELLER_TYPES.includes(type as ProxySellerType)
      ? (type as ProxySellerType)
      : "";
    const list = await fetchProxySellerList(sellerType);
    return list.map((item) => mapProxySeller(item, sellerType));
  }
};

// GET /proxy — lista todos os proxies persistidos
export const listProxies = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const proxies = await proxyRepository.find({ order: { createdAt: "DESC" } });
    return reply.send(createResponse(1, "Proxies carregados com sucesso.", proxies));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao listar proxies.", { error }));
  }
};

// POST /proxy/sync { provider, type } — puxa a lista do provider e faz upsert no banco
export const syncProvider = async (req: FastifyRequest, reply: FastifyReply) => {
  const { provider = "proxy-seller", type = "" } = (req.body || {}) as { provider?: string; type?: string };

  const fetchList = PROVIDERS[provider];
  if (!fetchList) {
    return reply.code(400).send(
      createResponse(0, `Provider '${provider}' não suportado. Disponíveis: ${Object.keys(PROVIDERS).join(", ")}`, [])
    );
  }

  try {
    const list = await fetchList(type);

    let created = 0;
    let updated = 0;

    for (const mapped of list) {
      if (!mapped.ip) continue;

      const existing = await proxyRepository.findOneBy({ provider, externalId: mapped.externalId as string });
      if (existing) {
        proxyRepository.merge(existing, mapped);
        await proxyRepository.save(existing);
        updated++;
      } else {
        await proxyRepository.save(proxyRepository.create(mapped));
        created++;
      }
    }

    await syncProxiesToRedis();

    return reply.send(
      createResponse(
        1,
        `Sincronização (${provider}${type ? `/${type}` : ""}) concluída. Novos: ${created} | Atualizados: ${updated} | Recebidos: ${list.length}`,
        { provider, type, created, updated, total: list.length }
      )
    );
  } catch (error) {
    return reply.code(500).send(
      createResponse(0, `Erro ao sincronizar com '${provider}': ${(error as Error).message}`, {
        error: (error as Error).message
      })
    );
  }
};

// POST /proxy — adiciona um proxy manualmente
export const addProxy = async (req: FastifyRequest, reply: FastifyReply) => {
  const body = (req.body || {}) as {
    ip?: string; port?: number | string; protocol?: string; ipType?: string;
    login?: string; password?: string; isPrivate?: boolean; comment?: string;
  };

  if (!body.ip || body.port == null || body.port === "") {
    return reply.code(400).send(createResponse(0, "Campos 'ip' e 'port' são obrigatórios.", []));
  }

  try {
    const proxy = proxyRepository.create({
      provider: "manual",
      ip: String(body.ip),
      port: Number(body.port),
      protocol: body.protocol || "http",
      ipType: body.ipType || "ipv4",
      login: body.login || "",
      password: body.password || "",
      isPrivate: body.isPrivate ?? true,
      isEnabled: true,
      comment: body.comment || null
    });
    await proxyRepository.save(proxy);
    await syncProxiesToRedis();
    return reply.code(201).send(createResponse(1, "Proxy adicionado com sucesso.", proxy));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao adicionar proxy.", { error }));
  }
};

// POST /proxy/bulk { list, protocol? } — importa vários proxies (login:senha@ip:porta por linha)
export const bulkAddProxies = async (req: FastifyRequest, reply: FastifyReply) => {
  const body = (req.body || {}) as { list?: string; protocol?: string };

  if (!body.list || typeof body.list !== "string" || !body.list.trim()) {
    return reply.code(400).send(
      createResponse(0, "Envie 'list' com um proxy por linha (login:senha@ip:porta).", [])
    );
  }

  const defaultProtocol = body.protocol || "http";
  const lines = body.list.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  let added = 0;
  let skipped = 0;
  let invalid = 0;

  try {
    for (const line of lines) {
      const parsed = parseProxyLine(line);
      if (!parsed) {
        invalid++;
        continue;
      }

      const { ip, port, login, password } = parsed;

      // Evita duplicar por ip:porta
      const existing = await proxyRepository.findOneBy({ ip, port });
      if (existing) {
        skipped++;
        continue;
      }

      const proxy = proxyRepository.create({
        provider: "manual",
        ip,
        port,
        protocol: defaultProtocol,
        ipType: ip.includes(":") ? "ipv6" : "ipv4",
        login,
        password,
        isPrivate: true,
        isEnabled: true
      });
      await proxyRepository.save(proxy);
      added++;
    }

    await syncProxiesToRedis();

    return reply.send(
      createResponse(
        1,
        `Importação concluída. Adicionados: ${added} | Pulados (existentes): ${skipped} | Inválidos: ${invalid}`,
        { added, skipped, invalid, total: lines.length }
      )
    );
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao importar lista de proxies.", { error }));
  }
};

// PUT /proxy/:id — edita campos do proxy
export const updateProxy = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  const body = (req.body || {}) as Record<string, unknown>;

  try {
    const proxy = await proxyRepository.findOneBy({ id });
    if (!proxy) {
      return reply.code(404).send(createResponse(0, "Proxy não encontrado.", []));
    }

    const allowed = [
      "protocol", "ipType", "ip", "port", "portSocks",
      "login", "password", "isPrivate", "isEnabled", "comment", "country"
    ];
    for (const key of allowed) {
      if (key in body) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (proxy as any)[key] = (body as any)[key];
      }
    }

    await proxyRepository.save(proxy);
    await syncProxiesToRedis();
    return reply.send(createResponse(1, "Proxy atualizado com sucesso.", proxy));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao atualizar proxy.", { error }));
  }
};

// PATCH /proxy/:id/toggle { isEnabled? } — ativa/desativa (alterna se não enviado)
export const toggleProxy = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  const body = (req.body || {}) as { isEnabled?: boolean };

  try {
    const proxy = await proxyRepository.findOneBy({ id });
    if (!proxy) {
      return reply.code(404).send(createResponse(0, "Proxy não encontrado.", []));
    }

    proxy.isEnabled = typeof body.isEnabled === "boolean" ? body.isEnabled : !proxy.isEnabled;
    await proxyRepository.save(proxy);
    await syncProxiesToRedis();
    return reply.send(createResponse(1, `Proxy ${proxy.isEnabled ? "ativado" : "desativado"}.`, proxy));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao alterar status do proxy.", { error }));
  }
};

// URL alvo do teste: ecoa o IP de saída em texto puro (rápido e leve).
const TEST_TARGET_URL = "https://api.ipify.org";
const TEST_TIMEOUT_MS = 12000;

/**
 * Faz uma requisição real através do proxy para medir latência e validar conectividade.
 * Para http/https usa o suporte nativo de proxy do axios; para socks5 usa o SocksProxyAgent.
 */
async function runProxyCheck(proxy: Proxy): Promise<{
  ok: boolean;
  latencyMs: number | null;
  exitIp: string | null;
  message: string;
}> {
  const start = Date.now();
  const auth = proxy.login ? { username: proxy.login, password: proxy.password } : undefined;
  const isSocks = proxy.protocol === "socks5" || proxy.protocol === "socks";

  try {
    let response;
    if (isSocks) {
      const cred = proxy.login ? `${encodeURIComponent(proxy.login)}:${encodeURIComponent(proxy.password)}@` : "";
      const host = proxy.ip.includes(":") ? `[${proxy.ip}]` : proxy.ip;
      const agent = new SocksProxyAgent(`socks5://${cred}${host}:${proxy.port}`);
      response = await axios.get(TEST_TARGET_URL, {
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        timeout: TEST_TIMEOUT_MS,
        responseType: "text"
      });
    } else {
      response = await axios.get(TEST_TARGET_URL, {
        proxy: {
          host: proxy.ip,
          port: proxy.port,
          auth,
          protocol: proxy.protocol === "https" ? "https" : "http"
        },
        timeout: TEST_TIMEOUT_MS,
        responseType: "text"
      });
    }

    const latencyMs = Date.now() - start;
    const exitIp = typeof response.data === "string" ? response.data.trim() : null;
    return { ok: true, latencyMs, exitIp, message: `OK — IP de saída ${exitIp || "?"} (${latencyMs}ms)` };
  } catch (error) {
    const latencyMs = Date.now() - start;
    const err = error as { code?: string; message?: string };
    const reason = err.code === "ECONNABORTED" ? "timeout" : err.code || err.message || "falha na conexão";
    return { ok: false, latencyMs, exitIp: null, message: `Falhou — ${reason} (${latencyMs}ms)` };
  }
}

// POST /proxy/:id/test — testa o proxy fazendo uma requisição real e mede a latência
export const testProxy = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };

  try {
    const proxy = await proxyRepository.findOneBy({ id });
    if (!proxy) {
      return reply.code(404).send(createResponse(0, "Proxy não encontrado.", []));
    }

    const result = await runProxyCheck(proxy);
    return reply.send(createResponse(result.ok ? 1 : 0, result.message, result));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao testar proxy.", { error: (error as Error).message }));
  }
};

// DELETE /proxy/:id — remove o proxy
export const deleteProxy = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };

  try {
    const proxy = await proxyRepository.findOneBy({ id });
    if (!proxy) {
      return reply.code(404).send(createResponse(0, "Proxy não encontrado.", []));
    }

    await proxyRepository.remove(proxy);
    await syncProxiesToRedis();
    return reply.send(createResponse(1, "Proxy removido com sucesso.", []));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao remover proxy.", { error }));
  }
};
