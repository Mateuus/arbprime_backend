import { logger, LoggerClass } from "@Core/logger";

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
