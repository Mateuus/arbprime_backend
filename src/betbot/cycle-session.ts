/**
 * Sessão cycletls reusável: 1 cliente Go vivo (caro no startup, barato por request)
 * + cookie jar + helper de request (GET/POST/PATCH) com proxy. Uma sessão por
 * instância de bet. Porta ALTA/aleatória (nunca 9119 fixo) p/ não colidir quando
 * várias instâncias rodam no mesmo processo/worker.
 */
import initCycleTLS, { CycleTLSClient } from 'cycletls';
import { Jar, Proxy, proxyUrl, decode, CHROME_JA3, CHROME_UA } from './http';

export type HttpMethod = 'get' | 'post' | 'patch' | 'put' | 'delete';

export interface CycleResponse {
  status: number;
  body: string;
  json: any;
  headers: any;
}

export interface CycleSessionOpts {
  proxy?: Proxy | null;
  port?: number;        // porta do cycletls (o worker atribui única por instância)
  timeoutSec?: number;  // timeout por request (default 30s)
  jar?: Jar;
}

function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 19000); // 20000..38999
}

export class CycleSession {
  private client: CycleTLSClient | null = null;
  private port: number;
  private timeoutSec: number;
  jar: Jar;
  proxy: Proxy | null;

  constructor(opts: CycleSessionOpts = {}) {
    this.proxy = opts.proxy ?? null;
    this.timeoutSec = opts.timeoutSec ?? 30;
    this.jar = opts.jar ?? new Jar();
    this.port = opts.port ?? randomPort();
  }

  setProxy(p: Proxy | null): void { this.proxy = p; }
  setJar(j: Jar): void { this.jar = j; }

  private async ensureClient(): Promise<CycleTLSClient> {
    if (this.client) return this.client;
    this.client = await initCycleTLS({ port: this.port, timeout: 30000 });
    return this.client;
  }

  /** Uma requisição. `sendCookies:false` p/ checar sessão anônima (diff com/sem cookie). */
  async request(
    method: HttpMethod,
    url: string,
    opts: { body?: string; headers?: Record<string, string>; sendCookies?: boolean } = {},
  ): Promise<CycleResponse> {
    const client = await this.ensureClient();
    const headers: Record<string, string> = {
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      ...(opts.headers || {}),
    };
    if (opts.sendCookies !== false) {
      const cookie = this.jar.header();
      if (cookie) headers['Cookie'] = cookie;
    }
    const res: any = await client(
      url,
      {
        ja3: CHROME_JA3,
        userAgent: CHROME_UA,
        headers,
        timeout: this.timeoutSec,
        ...(this.proxy ? { proxy: proxyUrl(this.proxy) } : {}),
        ...(opts.body != null ? { body: opts.body } : {}),
      },
      method as any,
    );
    this.jar.ingest(res.headers);
    const body = decode(res);
    let json: any = null;
    try { json = JSON.parse(body); } catch { /* HTML/challenge */ }
    return { status: res.status, body, json, headers: res.headers || {} };
  }

  /** Mata o cliente travado e sobe outro numa porta nova no próximo request (hang recovery). */
  async recycle(): Promise<void> {
    const old = this.client;
    this.client = null;
    this.port = randomPort();
    if (old) { try { await old.exit(); } catch { /* best-effort */ } }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) { try { await c.exit(); } catch { /* best-effort */ } }
  }
}
