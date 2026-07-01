/**
 * Loader da lista de proxies do arbprime (Redis `ArbPrime:Configs:ProxyList`).
 * Acoplado ao arbprime (usa o Redis singleton) — de propósito FORA do core betbot
 * (http/cycle-session/betano-client), que fica portável ao futuro .exe (que teria
 * sua própria fonte de proxy / o IP direto do usuário).
 *
 * O `proxyId` da instância é a CHAVE do hash (`ip:port`) — não há id interno.
 * Residencial (proxy-seller) é túnel HTTP → protocol forçado a `http`.
 */
import { getRedisClient } from '../core/redis';
import { Proxy } from './http';

const PROXY_LIST_KEY = process.env.PROXY_LIST_KEY || 'ArbPrime:Configs:ProxyList';

export interface ProxyRecord extends Proxy {
  id: string;                        // == field do hash (ip:port)
  iptype: 'ipv4' | 'resident' | string;
  isenabled: boolean;
  scope: string[];
  portSocks?: string;
  isprivate?: boolean;
}

function toRecord(id: string, raw: any): ProxyRecord | null {
  if (!raw || !raw.ip || !raw.port) return null;
  const resident = raw.iptype === 'resident';
  return {
    id,
    protocol: resident ? 'http' : (raw.protocol || 'http'),
    ip: String(raw.ip),
    port: String(raw.port),
    login: String(raw.login ?? ''),
    password: String(raw.password ?? ''),
    iptype: raw.iptype,
    isenabled: raw.isenabled === true || raw.isenabled === 'true',
    scope: Array.isArray(raw.scope) ? raw.scope : [],
    portSocks: raw.portSocks != null ? String(raw.portSocks) : undefined,
    isprivate: !!raw.isprivate,
  };
}

/** Resolve um proxy pinado pelo id (`ip:port`). Null se não existe. */
export async function loadProxyById(id: string): Promise<ProxyRecord | null> {
  if (!id) return null;
  const raw = await getRedisClient().hget(PROXY_LIST_KEY, id);
  if (!raw) return null;
  try { return toRecord(id, JSON.parse(raw)); } catch { return null; }
}

/** Lista os proxies (com filtros opcionais). */
export async function loadProxyList(opts: { onlyEnabled?: boolean; iptype?: string } = {}): Promise<ProxyRecord[]> {
  const h = await getRedisClient().hgetall(PROXY_LIST_KEY);
  const out: ProxyRecord[] = [];
  for (const [id, raw] of Object.entries(h)) {
    let rec: ProxyRecord | null = null;
    try { rec = toRecord(id, JSON.parse(raw as string)); } catch { /* skip */ }
    if (!rec) continue;
    if (opts.onlyEnabled && !rec.isenabled) continue;
    if (opts.iptype && rec.iptype !== opts.iptype) continue;
    out.push(rec);
  }
  return out;
}
