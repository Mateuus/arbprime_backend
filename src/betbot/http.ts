/**
 * Camada HTTP base para automação autenticada de casas de aposta via `cycletls`
 * (impersonação TLS do Chrome — passa Cloudflare/DataDome sem navegador).
 *
 * Compartilhada entre casas (hoje só betano). Mantida DEPENDENCY-LIGHT de propósito
 * (só `cycletls`) para ser portável ao futuro app Electron (.exe) do usuário — que
 * roda o mesmo `BetanoClient` do IP residencial dele.
 *
 * JA3/UA são os do Chrome 124, idênticos aos do coletor (`impersonateClient`) e do
 * lab `Test/betano/*` no arbbetting_master — a Betano BR já valida esse fingerprint.
 */

export const CHROME_JA3 =
  '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-21,29-23-24,0';
export const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Proxy no formato de request (derivado de ArbPrime:Configs:ProxyList). */
export type Proxy = { protocol: string; ip: string; port: string; login: string; password: string };

export function proxyUrl(p: Proxy): string {
  return `${p.protocol}://${p.login}:${p.password}@${p.ip}:${p.port}`;
}

/** cycletls devolve HTML como Buffer e JSON como objeto — decodifica defensivo. */
export function decode(res: any): string {
  const d = res?.data;
  if (Buffer.isBuffer(d)) return d.toString('utf8');
  if (typeof d === 'string') return d;
  if (d && d.type === 'Buffer' && Array.isArray(d.data)) return Buffer.from(d.data).toString('utf8');
  return typeof d === 'object' && d != null ? JSON.stringify(d) : String(d);
}

/** Cookie jar simples name→value, com parse tolerante de Set-Cookie (case-insensitive). */
export class Jar {
  private m = new Map<string, string>();

  ingest(headers: any): void {
    if (!headers) return;
    let raw: any;
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'set-cookie') { raw = headers[k]; break; }
    }
    if (!raw) return;
    const list: string[] = Array.isArray(raw) ? raw : String(raw).split(/\n/);
    for (const line of list) {
      // pode vir mais de um cookie por linha; split cuidadoso p/ não quebrar em "Expires=...,"
      for (const piece of line.split(/,(?=\s*[A-Za-z0-9!#$%&'*+\-.^_`|~]+=)/)) {
        const first = piece.split(';')[0].trim();
        const eq = first.indexOf('=');
        if (eq <= 0) continue;
        this.m.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
      }
    }
  }

  header(): string {
    return [...this.m.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  names(): string[] { return [...this.m.keys()]; }
  get(name: string): string | undefined { return this.m.get(name); }
  set(name: string, val: string): void { this.m.set(name, val); }
  toObject(): Record<string, string> { return Object.fromEntries(this.m); }

  static from(cookies: Record<string, string> | null | undefined): Jar {
    const j = new Jar();
    for (const [k, v] of Object.entries(cookies || {})) j.m.set(k, String(v));
    return j;
  }
}

// Client-hints / sec-fetch que o DataDome inspeciona (Chrome 124).
export const SEC_CH: Record<string, string> = {
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

/** Headers de navegação (GET de página HTML). */
export function navHeaders(): Record<string, string> {
  return {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    ...SEC_CH,
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
  };
}

/** Headers XHR para POST/PATCH JSON (com Content-Type). */
export function xhrHeaders(referer: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    ...SEC_CH,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: referer,
  };
}

/** Headers XHR para GET JSON (sem Content-Type). */
export function xhrGetHeaders(referer: string): Record<string, string> {
  const h = xhrHeaders(referer);
  delete h['Content-Type'];
  return h;
}
