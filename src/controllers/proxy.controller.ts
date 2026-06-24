import { FastifyRequest, FastifyReply } from "fastify";
import { DeepPartial } from "typeorm";
import axios from "axios";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { AppDataSource } from "@Database";
import { Proxy } from "@Entities";
import { createResponse } from "@utils/resFormatter";
import {
  fetchProxySellerList, ProxySellerType, ProxySellerProxy,
  getResidentPackage, getResidentLists, downloadResidentList,
  renameResidentList, deleteResidentList, createResidentList, getResidentGeoCountries
} from "@Services/proxyseller.service";
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

// Normaliza o escopo (lista de slugs de casas): aceita array ou string CSV;
// devolve null para "pool global" (vazio) ou um array de slugs únicos e limpos.
function normalizeScope(raw: unknown): string[] | null {
  let arr: string[];
  if (Array.isArray(raw)) {
    arr = raw.map((s) => String(s));
  } else if (typeof raw === "string") {
    arr = raw.split(",");
  } else {
    return null;
  }
  const clean = Array.from(new Set(arr.map((s) => s.trim().toLowerCase()).filter(Boolean)));
  return clean.length ? clean : null;
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
    scope?: string[] | string;
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
      scope: normalizeScope(body.scope),
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
  const body = (req.body || {}) as { list?: string; protocol?: string; scope?: string[] | string };

  if (!body.list || typeof body.list !== "string" || !body.list.trim()) {
    return reply.code(400).send(
      createResponse(0, "Envie 'list' com um proxy por linha (login:senha@ip:porta).", [])
    );
  }

  const defaultProtocol = body.protocol || "http";
  const scope = normalizeScope(body.scope);
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
        isEnabled: true,
        scope
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
    // Escopo por casa precisa de normalização (array/CSV → array de slugs ou null).
    if ("scope" in body) {
      proxy.scope = normalizeScope(body.scope);
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
  const isSocks = proxy.protocol === "socks5" || proxy.protocol === "socks";
  const cred = proxy.login ? `${encodeURIComponent(proxy.login)}:${encodeURIComponent(proxy.password)}@` : "";
  const host = proxy.ip.includes(":") ? `[${proxy.ip}]` : proxy.ip;

  try {
    // Proxies HTTP/HTTPS são proxies de ENCAMINHAMENTO: conecta-se a eles por HTTP
    // e o agente faz CONNECT para o alvo HTTPS. O proxy nativo do axios tenta um TLS
    // contra o próprio proxy quando protocol='https' e quebra (ex.: gateway residencial
    // do Proxy-Seller, que é HTTP). Por isso usamos sempre um agent (http/socks).
    const agent = isSocks
      ? new SocksProxyAgent(`socks5://${cred}${host}:${proxy.port}`)
      : new HttpsProxyAgent(`http://${cred}${host}:${proxy.port}`);

    const response = await axios.get(TEST_TARGET_URL, {
      httpAgent: agent,
      httpsAgent: agent,
      proxy: false,
      timeout: TEST_TIMEOUT_MS,
      responseType: "text"
    });

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

/////////////////////////////// Residencial (Proxy-Seller) ///////////////////////////////

// GET /proxy/resident/package — banda restante, expiração e rotação do pacote residencial
export const residentPackageInfo = async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    const pkg = await getResidentPackage();
    return reply.send(createResponse(1, "Pacote residencial carregado.", pkg));
  } catch (error) {
    return reply.code(500).send(
      createResponse(0, `Erro ao buscar pacote residencial: ${(error as Error).message}`, { error: (error as Error).message })
    );
  }
};

// GET /proxy/resident/lists — listas (sheets) existentes no pacote residencial
export const residentListsInfo = async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    const lists = await getResidentLists();
    return reply.send(createResponse(1, "Listas residenciais carregadas.", lists));
  } catch (error) {
    return reply.code(500).send(
      createResponse(0, `Erro ao buscar listas residenciais: ${(error as Error).message}`, { error: (error as Error).message })
    );
  }
};

// Mapeia o protocolo enviado pelo front para o aceito pelo proxyDownload ('' = http).
function residentProto(proto?: string): "" | "https" | "socks5" {
  return proto === "https" || proto === "socks5" ? proto : "";
}

// POST /proxy/resident/import { listId, proto?, scope?, title? }
// Baixa os endpoints de uma lista residencial e faz upsert no pool de proxies.
export const importResidentList = async (req: FastifyRequest, reply: FastifyReply) => {
  const body = (req.body || {}) as { listId?: number | string; proto?: string; scope?: string[] | string; title?: string };

  if (body.listId == null || body.listId === "") {
    return reply.code(400).send(createResponse(0, "Campo 'listId' é obrigatório.", []));
  }

  const proto = residentProto(body.proto);
  const protocol = proto || "http";
  const scope = normalizeScope(body.scope);
  const comment = body.title ? `Residencial — ${body.title}` : "Residencial";

  try {
    const raw = await downloadResidentList(body.listId, proto);
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    let created = 0;
    let updated = 0;
    let invalid = 0;

    for (const line of lines) {
      const parsed = parseProxyLine(line);
      if (!parsed) {
        invalid++;
        continue;
      }
      const { ip, port, login, password } = parsed;
      // externalId estável por (lista, ip, porta) → reimportar é idempotente.
      const externalId = `resident-${body.listId}-${ip}-${port}`;

      const fields: DeepPartial<Proxy> = {
        provider: "proxy-seller",
        externalId,
        protocol,
        ipType: "resident",
        ip,
        port,
        login,
        password,
        isPrivate: true,
        scope,
        comment
      };

      const existing = await proxyRepository.findOneBy({ provider: "proxy-seller", externalId });
      if (existing) {
        proxyRepository.merge(existing, fields);
        await proxyRepository.save(existing);
        updated++;
      } else {
        await proxyRepository.save(proxyRepository.create({ ...fields, isEnabled: true }));
        created++;
      }
    }

    await syncProxiesToRedis();

    return reply.send(
      createResponse(
        1,
        `Lista residencial importada. Novos: ${created} | Atualizados: ${updated} | Inválidos: ${invalid}`,
        { created, updated, invalid, total: lines.length, scope }
      )
    );
  } catch (error) {
    return reply.code(500).send(
      createResponse(0, `Erro ao importar lista residencial: ${(error as Error).message}`, { error: (error as Error).message })
    );
  }
};

// GET /proxy/resident/geo — países disponíveis para o residencial (code + nome)
export const residentGeoCountries = async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    const countries = await getResidentGeoCountries();
    return reply.send(createResponse(1, "Países residenciais carregados.", countries));
  } catch (error) {
    return reply.code(500).send(
      createResponse(0, `Erro ao buscar países do residencial: ${(error as Error).message}`, { error: (error as Error).message })
    );
  }
};

// POST /proxy/resident/list/create — cria uma nova lista residencial no Proxy-Seller
export const createResidentListHandler = async (req: FastifyRequest, reply: FastifyReply) => {
  const body = (req.body || {}) as {
    title?: string; country?: string; region?: string; city?: string; isp?: string;
    rotation?: number | string; ports?: number | string; whitelist?: string; ext?: string;
  };

  if (!body.title?.trim()) {
    return reply.code(400).send(createResponse(0, "Campo 'title' é obrigatório.", []));
  }
  if (!body.country?.trim()) {
    return reply.code(400).send(createResponse(0, "Campo 'country' (código do país) é obrigatório.", []));
  }

  try {
    const created = await createResidentList({
      title: body.title.trim(),
      whitelist: body.whitelist || "",
      rotation: body.rotation != null && body.rotation !== "" ? Number(body.rotation) : 0,
      ports: body.ports != null && body.ports !== "" ? Number(body.ports) : 1,
      ext: body.ext || "txt",
      geo: {
        country: body.country.trim(),
        region: body.region || "",
        city: body.city || "",
        isp: body.isp || ""
      }
    });
    return reply.code(201).send(createResponse(1, "Lista residencial criada com sucesso.", created));
  } catch (error) {
    return reply.code(500).send(
      createResponse(0, `Erro ao criar lista residencial: ${(error as Error).message}`, { error: (error as Error).message })
    );
  }
};

// POST /proxy/resident/list/rename { id, title } — renomeia a lista no Proxy-Seller
export const renameResidentListHandler = async (req: FastifyRequest, reply: FastifyReply) => {
  const body = (req.body || {}) as { id?: number | string; title?: string };
  if (body.id == null || body.id === "" || !body.title?.trim()) {
    return reply.code(400).send(createResponse(0, "Campos 'id' e 'title' são obrigatórios.", []));
  }
  try {
    const result = await renameResidentList(body.id, body.title.trim());
    return reply.send(createResponse(1, "Lista renomeada com sucesso.", result));
  } catch (error) {
    return reply.code(500).send(
      createResponse(0, `Erro ao renomear lista: ${(error as Error).message}`, { error: (error as Error).message })
    );
  }
};

// DELETE /proxy/resident/list/:id — remove a lista no Proxy-Seller
export const deleteResidentListHandler = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  try {
    await deleteResidentList(id);
    return reply.send(createResponse(1, "Lista removida com sucesso.", []));
  } catch (error) {
    return reply.code(500).send(
      createResponse(0, `Erro ao remover lista: ${(error as Error).message}`, { error: (error as Error).message })
    );
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
