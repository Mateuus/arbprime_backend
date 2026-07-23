/**
 * Sessão HTTP via worker curl_cffi persistente (Python sidecar). É a ÚNICA forma que passa o login
 * da bet365: UMA Session curl_cffi viva, jar NATIVO gerindo cookies nos GETs de coleta + header Cookie
 * EXPLÍCITO (device-trust merge) no POST. Provado exaustivamente que o binário curl-impersonate, cookies
 * explícitos nos GETs, ou coleta/POST em Sessions separadas → resultCode=fail. Ver bet365_cffi_worker.py.
 *
 * Interface compatível com CycleSession/CurlImpersonateSession (request/jar/setJar/close), MAS:
 *  - jar.set() (injeção de device-trust) → set_cookie no jar do worker (usado no modo jar dos GETs);
 *  - request(..., { explicitCookie:true }) → manda o Cookie mesclado (mirror ordenado) como override no POST.
 */
import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { Proxy, proxyUrl } from './http';
import type { HttpMethod, CycleResponse } from './cycle-session';

function resolvePython(): string {
  const cands = [
    process.env.BET365_CFFI_PYTHON,
    join(__dirname, '../../python/.venv/bin/python'),
    join(process.cwd(), 'python/.venv/bin/python'),
  ].filter(Boolean) as string[];
  for (const c of cands) if (existsSync(c)) return c;
  return 'python3';
}
function resolveWorker(): string {
  const cands = [
    process.env.BET365_CFFI_WORKER,
    join(__dirname, '../../python/bet365_cffi_worker.py'),
    join(process.cwd(), 'python/bet365_cffi_worker.py'),
  ].filter(Boolean) as string[];
  for (const c of cands) if (existsSync(c)) return c;
  return cands[cands.length - 1];
}

/** Mirror de cookies (name→value) espelhando o jar do worker + fila de injeções (device-trust). */
class WorkerJar {
  private m = new Map<string, string>();
  pending: Array<{ name: string; value: string }> = [];

  /** Injeta no mirror E no jar do worker (device-trust aaat/usdi antes da coleta). */
  set(name: string, val: string): void { this.m.set(name, String(val)); this.pending.push({ name, value: String(val) }); }
  /** Injeta SÓ no mirror (merge device-trust p/ o Cookie explícito do POST) — NÃO polui o jar do worker. */
  setLocal(name: string, val: string): void { this.m.set(name, String(val)); }
  get(name: string): string | undefined { return this.m.get(name); }
  names(): string[] { return [...this.m.keys()]; }
  toObject(): Record<string, string> { return Object.fromEntries(this.m); }
  header(): string { return [...this.m.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  /** absorve o jar autoritativo do worker (sem re-enfileirar). Última ocorrência por nome vence. */
  absorb(pairs: Array<[string, string]>): void { for (const [n, v] of pairs) this.m.set(n, v); }
  drainPending(): Array<{ name: string; value: string }> { const p = this.pending; this.pending = []; return p; }
}

export interface CffiSessionOpts {
  proxy?: Proxy | null;
  timeoutSec?: number;
  userAgent?: string;
  baseHeaders?: Record<string, string>;
  cookieOrder?: string[];
  python?: string;
  worker?: string;
  /** Alvo de impersonation TLS do worker (default "chrome"=chrome146). Varre fingerprints p/ o addbet. */
  impersonate?: string;
}

export class CurlCffiSession {
  private proc: ChildProcess | null = null;
  private buf = '';
  private nextId = 1;
  private pendingReq = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private timeoutSec: number;
  private userAgent?: string;
  private baseHeaders: Record<string, string>;
  private cookieOrder?: string[];
  private python: string;
  private workerPath: string;
  private impersonate?: string;
  jar = new WorkerJar();
  proxy: Proxy | null;

  constructor(opts: CffiSessionOpts = {}) {
    this.proxy = opts.proxy ?? null;
    this.timeoutSec = opts.timeoutSec ?? 30;
    this.userAgent = opts.userAgent;
    this.baseHeaders = opts.baseHeaders ?? {};
    this.cookieOrder = opts.cookieOrder;
    this.python = opts.python ?? resolvePython();
    this.workerPath = opts.worker ?? resolveWorker();
    this.impersonate = opts.impersonate;
  }

  setProxy(p: Proxy | null): void { this.proxy = p; }

  /** Reidrata cookies salvos (restoreSession): empurra tudo pro jar do worker + mirror. */
  setJar(cookies: Record<string, string> | WorkerJar): void {
    const obj = cookies instanceof WorkerJar ? cookies.toObject() : cookies;
    this.jar = new WorkerJar();
    for (const [k, v] of Object.entries(obj || {})) this.jar.set(k, String(v));
  }

  private ensureProc(): ChildProcess {
    if (this.proc) return this.proc;
    const env = this.impersonate ? { ...process.env, BET365_IMPERSONATE: this.impersonate } : process.env;
    const p = spawn(this.python, [this.workerPath], { stdio: ['pipe', 'pipe', 'inherit'], env });
    p.stdout!.setEncoding('utf8');
    p.stdout!.on('data', (chunk: string) => this.onData(chunk));
    p.on('exit', () => { for (const { reject } of this.pendingReq.values()) reject(new Error('cffi worker saiu')); this.pendingReq.clear(); this.proc = null; });
    this.proc = p;
    return p;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx); this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: any; try { msg = JSON.parse(line); } catch { continue; }
      const w = this.pendingReq.get(msg.id);
      if (w) { this.pendingReq.delete(msg.id); w.resolve(msg); }
    }
  }

  private sendOp(op: any): Promise<any> {
    const proc = this.ensureProc();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pendingReq.set(id, { resolve, reject });
      const t = setTimeout(() => { if (this.pendingReq.delete(id)) reject(new Error('cffi worker timeout')); }, (this.timeoutSec + 10) * 1000);
      const done = (fn: (v: any) => void) => (v: any) => { clearTimeout(t); fn(v); };
      this.pendingReq.set(id, { resolve: done(resolve), reject: done(reject) });
      proc.stdin!.write(JSON.stringify({ id, ...op }) + '\n');
    });
  }

  /** Header Cookie na ordem canônica (cookieOrder primeiro) — igual ao CurlImpersonateSession. */
  private cookieHeader(): string {
    const raw = this.jar.header();
    if (!this.cookieOrder || !raw) return raw;
    const pairs = new Map<string, string>();
    for (const p of raw.split('; ')) { const i = p.indexOf('='); if (i > 0) pairs.set(p.slice(0, i), p.slice(i + 1)); }
    const out: string[] = [];
    for (const name of this.cookieOrder) { const v = pairs.get(name); if (v !== undefined) { out.push(`${name}=${v}`); pairs.delete(name); } }
    for (const [k, v] of pairs) out.push(`${k}=${v}`);
    return out.join('; ');
  }

  private async flushCookies(): Promise<void> {
    for (const c of this.jar.drainPending()) await this.sendOp({ op: 'set_cookie', name: c.name, value: c.value, domain: '.bet365.bet.br' });
  }

  /**
   * Uma requisição. Por padrão o jar do worker manda os cookies (modo dos GETs de coleta / OPTIONS).
   * `explicitCookie:true` manda o Cookie mesclado (mirror ordenado) como override (POST/saldo).
   */
  async request(
    method: HttpMethod | 'options',
    url: string,
    opts: { body?: string; headers?: Record<string, string>; sendCookies?: boolean; explicitCookie?: boolean } = {},
  ): Promise<CycleResponse> {
    await this.flushCookies();
    const headers: Record<string, string> = {
      'Accept-Language': 'en-US,en;q=0.9',
      ...this.baseHeaders,
      ...(opts.headers || {}),
    };
    if (this.userAgent && !Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) headers['user-agent'] = this.userAgent;

    let cookieOverride: string | null = null;
    if (opts.explicitCookie) cookieOverride = this.cookieHeader();

    const r = await this.sendOp({
      op: 'request', method: method.toUpperCase(), url, headers, body: opts.body ?? null,
      cookie_override: cookieOverride, timeout: this.timeoutSec,
      proxy: this.proxy ? proxyUrl(this.proxy) : null,
    });
    if (r.error) throw new Error(`cffi: ${r.error}`);
    if (Array.isArray(r.jar)) this.jar.absorb(r.jar);

    const headersObj: Record<string, string> = {};
    for (const [k, v] of (r.headers || [])) { if (k.toLowerCase() !== 'set-cookie') headersObj[k.toLowerCase()] = v; }
    let json: any = null;
    try { json = JSON.parse(r.body); } catch { /* HTML/challenge */ }
    return { status: r.status, body: r.body, json, headers: headersObj };
  }

  // ---- WebSocket (zap) via curl_cffi (TLS impersonada = passa o Cloudflare que barra o `ws` do Node) ----
  /** Abre o WS (HTTP upgrade). Lança se o servidor recusar (ex.: 403). */
  async wsConnect(url: string, headers: Record<string, string> = {}): Promise<void> {
    const r = await this.sendOp({ op: 'ws_connect', url, headers });
    if (r.error) throw new Error('ws_connect: ' + r.error);
  }
  /** Envia um frame (string com bytes de controle). text=true → frame TEXT (o zap manda como texto). */
  async wsSend(frame: string, text = true): Promise<void> {
    const r = await this.sendOp({ op: 'ws_send', data_b64: Buffer.from(frame, 'binary').toString('base64'), text });
    if (r.error) throw new Error('ws_send: ' + r.error);
  }
  /** Recebe um frame (bloqueia até frame/timeout). null = timeout. */
  async wsRecv(): Promise<{ data: string; flags: number } | null> {
    const r = await this.sendOp({ op: 'ws_recv' });
    if (r.error) throw new Error('ws_recv: ' + r.error);
    if (r.timeout) return null;
    return { data: Buffer.from(r.data_b64, 'base64').toString('binary'), flags: r.flags };
  }
  async wsClose(): Promise<void> { await this.sendOp({ op: 'ws_close' }).catch(() => {}); }

  async recycle(): Promise<void> { await this.sendOp({ op: 'reset' }).catch(() => {}); }

  async close(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    try { await Promise.race([this.sendOp({ op: 'close' }), new Promise((r) => setTimeout(r, 500))]); } catch { /* */ }
    try { p.kill(); } catch { /* */ }
    this.proc = null;
  }
}
