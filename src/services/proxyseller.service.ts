import axios from "axios";
import zlib from "zlib";
import { logger, LoggerClass } from "@Core/logger";

// Base da API do Proxy-Seller (mesma usada internamente pelo pacote npm).
const PS_BASE = "https://proxy-seller.com/personal/api/v1";

/**
 * O pacote `proxy-seller-user-api` é ESM puro (type: module). Como o backend é
 * compilado para CommonJS, usamos um import dinâmico real (via Function) para que
 * o TypeScript não rebaixe para require() — o que quebraria ao carregar um módulo ESM.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const dynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<any>;

// Tipos de proxy suportados pelo Proxy-Seller (proxy/list/{type}).
export type ProxySellerType = "ipv4" | "ipv6" | "mobile" | "isp" | "mix" | "resident";

// Item cru retornado pelo endpoint proxy/list do Proxy-Seller.
export interface ProxySellerProxy {
  id: number | string;
  order_id?: number | string;
  ip?: string;
  ip_only?: string;
  protocol?: string;
  port_http?: number;
  port_socks?: number;
  login?: string;
  password?: string;
  country?: string;
  country_alpha3?: string;
  status?: string;
  status_type?: string;
  date_start?: string;
  date_end?: string;
  comment?: string;
}

let cachedClient: any = null;

async function getClient(): Promise<any> {
  if (cachedClient) return cachedClient;

  const apiKey = process.env.PROXY_SELLER_API_KEY;
  if (!apiKey) {
    throw new Error("PROXY_SELLER_API_KEY não está definido no .env");
  }

  const mod = await dynamicImport("proxy-seller-user-api");
  const ProxySellerUserApi = mod.default || mod;
  cachedClient = new ProxySellerUserApi({ key: apiKey });
  return cachedClient;
}

// Normaliza a resposta: pode vir como array (tipo específico) ou objeto agrupado por tipo ('').
function normalizeList(data: any): ProxySellerProxy[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    return Object.values(data).flatMap((v: any) => (Array.isArray(v) ? v : []));
  }
  return [];
}

/**
 * Busca a lista de proxies do Proxy-Seller para um tipo (ou todos se vazio).
 */
export async function fetchProxySellerList(type: ProxySellerType | "" = ""): Promise<ProxySellerProxy[]> {
  try {
    const api = await getClient();
    const data = await api.proxyList(type);
    return normalizeList(data);
  } catch (error) {
    logger.error(
      `❌ Erro ao buscar proxies do Proxy-Seller: ${(error as Error).message}`,
      LoggerClass.LogCategory.Server,
      "[PROXY_SELLER]"
    );
    throw error;
  }
}

/**
 * Consulta o saldo da conta no Proxy-Seller (útil para diagnóstico).
 */
export async function getProxySellerBalance(): Promise<number> {
  const api = await getClient();
  return api.balance();
}

/////////////////////////////// Residencial ///////////////////////////////

// Informação do pacote residencial: tráfego (banda) restante, expiração, rotação.
// Os campos de tráfego vêm em BYTES.
export interface ResidentPackage {
  is_active?: boolean;
  rotation?: number;
  tarif_id?: number | string;
  traffic_limit?: number; // bytes
  traffic_usage?: number; // bytes
  expired_at?: string;
  auto_renew?: boolean;
  [key: string]: unknown;
}

// Uma "lista" (sheet) dentro do pacote residencial. O formato exato varia, então
// mantemos os campos conhecidos e deixamos o resto passar (id e title são o mínimo).
export interface ResidentList {
  id: number | string;
  title?: string;
  [key: string]: unknown;
}

/**
 * Dados do pacote residencial (banda restante, expiração). Base da aba "Residencial".
 */
export async function getResidentPackage(): Promise<ResidentPackage> {
  try {
    const api = await getClient();
    return await api.residentPackage();
  } catch (error) {
    logger.error(
      `❌ Erro ao buscar pacote residencial do Proxy-Seller: ${(error as Error).message}`,
      LoggerClass.LogCategory.Server,
      "[PROXY_SELLER]"
    );
    throw error;
  }
}

/**
 * Listas (sheets) existentes no pacote residencial.
 */
export async function getResidentLists(): Promise<ResidentList[]> {
  try {
    const api = await getClient();
    const data = await api.residentList();
    return Array.isArray(data) ? data : [];
  } catch (error) {
    logger.error(
      `❌ Erro ao buscar listas residenciais do Proxy-Seller: ${(error as Error).message}`,
      LoggerClass.LogCategory.Server,
      "[PROXY_SELLER]"
    );
    throw error;
  }
}

/**
 * Baixa os endpoints de uma lista residencial em texto (login:senha@ip:porta por linha).
 */
export async function downloadResidentList(
  listId: number | string,
  proto: "" | "https" | "socks5" = ""
): Promise<string> {
  const api = await getClient();
  const data = await api.proxyDownload("resident", "txt", proto, Number(listId));
  return typeof data === "string" ? data : "";
}

// Entrada para criar uma lista residencial. geo.country é alpha2 MAIÚSCULO
// (validado pelo provider); region/city/isp são NOMES exatos da base geo ou "".
export interface ResidentListCreateInput {
  title: string;
  whitelist?: string;
  rotation?: number; // segundos: -1 sticky | 0 a cada request | 1..3600
  geo: { country: string; region?: string; city?: string; isp?: string };
  ports?: number; // quantidade de endpoints (1..1000)
  ext?: string; // txt | csv
}

/**
 * Cria uma nova lista residencial. Endpoint/contrato verificados em produção:
 * POST resident/list/add com geo como OBJECT (array é parseado errado e ignora o geo).
 */
export async function createResidentList(input: ResidentListCreateInput): Promise<ResidentList> {
  const api = await getClient();
  const payload = {
    title: input.title,
    whitelist: input.whitelist ?? "",
    rotation: input.rotation ?? 0,
    geo: {
      country: (input.geo.country || "").toUpperCase(),
      region: input.geo.region ?? "",
      city: input.geo.city ?? "",
      isp: input.geo.isp ?? ""
    },
    export: {
      ports: input.ports ?? 1,
      ext: input.ext ?? "txt"
    }
  };
  // request() do pacote devolve data em sucesso e lança Error(message) em erro do provider.
  return api.request("POST", "resident/list/add", { data: payload });
}

// Descompacta um ZIP de arquivo único (stored ou deflate) usando só o zlib nativo.
function unzipSingleFile(buf: Buffer): string {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error("Arquivo geo não é um ZIP válido.");
  const method = buf.readUInt16LE(8);
  const compSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const dataStart = 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + compSize);
  if (method === 0) return data.toString("utf8");
  if (method === 8) return zlib.inflateRawSync(data).toString("utf8");
  throw new Error(`Método de compressão ZIP não suportado: ${method}`);
}

export interface ResidentGeoCountry {
  code: string;
  name: string;
}

let cachedGeoCountries: ResidentGeoCountry[] | null = null;

/**
 * Lista de países disponíveis para o residencial (code alpha2 + nome), extraída do
 * GET resident/geo (um ZIP com geo.json de ~3MB). Cacheada em memória após a 1ª busca.
 */
export async function getResidentGeoCountries(): Promise<ResidentGeoCountry[]> {
  if (cachedGeoCountries) return cachedGeoCountries;

  const apiKey = process.env.PROXY_SELLER_API_KEY;
  if (!apiKey) throw new Error("PROXY_SELLER_API_KEY não está definido no .env");

  const resp = await axios.get(`${PS_BASE}/${apiKey}/resident/geo`, {
    responseType: "arraybuffer",
    timeout: 30000
  });
  const json = unzipSingleFile(Buffer.from(resp.data));
  const tree = JSON.parse(json) as Array<{ code: string; name: string }>;

  cachedGeoCountries = tree
    .map((c) => ({ code: c.code, name: c.name }))
    .filter((c) => c.code && c.name)
    .sort((a, b) => a.name.localeCompare(b.name));

  return cachedGeoCountries;
}

/**
 * Renomeia uma lista residencial no Proxy-Seller.
 */
export async function renameResidentList(id: number | string, title: string): Promise<ResidentList> {
  const api = await getClient();
  return api.residentListRename(Number(id), title);
}

/**
 * Remove uma lista residencial no Proxy-Seller.
 */
export async function deleteResidentList(id: number | string): Promise<unknown> {
  const api = await getClient();
  return api.residentListDelete(Number(id));
}
