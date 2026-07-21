/**
 * Solver do **AWS WAF challenge** da Superbet — 100% cycletls, SEM navegador.
 *
 * A Superbet (plataforma Betler) protege o `/api/v1/login` com um token do AWS WAF
 * (`x-aws-waf-token`). O desafio é do tipo **NetworkBandwidth** (`mp_verify`), que
 * — ao contrário do HashPoW/Scrypt — NÃO tem proof-of-work de CPU: `solution` é
 * `null` e o cliente só precisa (a) mandar um fingerprint "cifrado" e (b) fazer o
 * upload de um blob (`solution_data`) p/ a medição de banda.
 *
 * O fingerprint é só OFUSCADO (não secreto): AES-256-GCM com uma chave PÚBLICA
 * embutida no challenge.js de todo AWS WAF. Formato Superbet = `base64(iv)::hex(ct‖tag)`.
 *
 * Referência do fingerprint/`get_fp`: github.com/xKiian/awswaf (que NÃO implementa
 * o mp_verify/NetworkBandwidth — este módulo reconstrói esse tipo a partir de captura).
 *
 * O token é **IP-bound**: precisa ser mintado pelo MESMO egress (proxy) que fará o
 * login. Validade curta (minutos) — mintar na hora do login, não cachear entre IPs.
 */
import { randomBytes, randomUUID, createCipheriv } from 'crypto';
import { CycleSession } from '../cycle-session';
import { CHROME_UA } from '../http';
import { WEBGL_SAMPLES } from './superbet-webgl';

/**
 * Host do WebACL do AWS WAF da Superbet. É ESTÁTICO por WebACL (apiKey + capacity
 * unit), então fica hardcoded como default — sobrescrevível por config se a casa
 * trocar de ACL. `{host}/inputs` e `{host}/mp_verify` têm CORS `*` (públicos).
 */
export const SUPERBET_WAF_HOST =
  'ab5d8485472a.5cd02325.sa-east-1.token.awswaf.com/ab5d8485472a/cf10ee63cfb6';

/** Origin/referer da casa (a Superbet BR). Usado nos headers do WAF e do login. */
export const SUPERBET_ORIGIN = 'https://superbet.bet.br';

/** Chave PÚBLICA do AES-256-GCM do AWS WAF (a mesma p/ todo mundo; fp só ofuscado). */
const WAF_KEY = Buffer.from('6f71a512b1e035eaab53d8be73120d3fb68a0ca346b9560aab3e5cdf753d5e98', 'hex');

const rint = (a: number, b: number): number => Math.floor(Math.random() * (b - a)) + a;

/** CRC32 (IEEE) → o `checksum` do fp (8 hex UPPER). */
function crc32(buf: Buffer): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

/** encrypt(fp) → `base64(iv12)::hex(ciphertext‖tag)` (formato Superbet, 2 partes). */
function encryptFp(plaintext: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', WAF_KEY, iv);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  const tag = c.getAuthTag();
  return `${iv.toString('base64')}::${Buffer.concat([ct, tag]).toString('hex')}`;
}

/** Monta o fingerprint "Zoey" (porta fiel do `get_fp`) → { checksum, present(cifrado) }. */
function buildFingerprint(userAgent: string): { checksum: string; present: string } {
  const ts = Date.now();
  const gpu = WEBGL_SAMPLES[rint(0, WEBGL_SAMPLES.length)];
  const bins = Array.from({ length: 256 }, () => rint(0, 40));
  bins[0] = rint(14473, 16573);
  bins[255] = rint(14473, 16573);
  const fp = {
    metrics: { fp2: 1, browser: 0, capabilities: 1, gpu: 7, dnt: 0, math: 0, screen: 0, navigator: 0, auto: 1, stealth: 0, subtle: 0, canvas: 5, formdetector: 1, be: 0 },
    start: ts,
    flashVersion: null,
    plugins: [
      { name: 'PDF Viewer', str: 'PDF Viewer ' },
      { name: 'Chrome PDF Viewer', str: 'Chrome PDF Viewer ' },
      { name: 'Chromium PDF Viewer', str: 'Chromium PDF Viewer ' },
      { name: 'Microsoft Edge PDF Viewer', str: 'Microsoft Edge PDF Viewer ' },
      { name: 'WebKit built-in PDF', str: 'WebKit built-in PDF ' },
    ],
    dupedPlugins: 'PDF Viewer Chrome PDF Viewer Chromium PDF Viewer Microsoft Edge PDF Viewer WebKit built-in PDF ||1920-1080-1032-24-*-*-*',
    screenInfo: '1920-1080-1032-24-*-*-*',
    referrer: '',
    userAgent,
    location: '',
    webDriver: false,
    capabilities: {
      css: { textShadow: 1, WebkitTextStroke: 1, boxShadow: 1, borderRadius: 1, borderImage: 1, opacity: 1, transform: 1, transition: 1 },
      js: { audio: true, geolocation: Math.random() < 0.5, localStorage: 'supported', touch: false, video: true, webWorker: Math.random() < 0.5 },
      elapsed: 1,
    },
    gpu: { vendor: gpu.vendor, model: gpu.renderer, extensions: gpu.ext.split(';') },
    dnt: null,
    math: { tan: '-1.4214488238747245', sin: '0.8178819121159085', cos: '-0.5753861119575491' },
    automation: { wd: { properties: { document: [], window: [], navigator: [] } }, phantom: { properties: { window: [] } } },
    stealth: { t1: 0, t2: 0, i: 1, mte: 0, mtd: false },
    crypto: { crypto: 1, subtle: 1, encrypt: true, decrypt: true, wrapKey: true, unwrapKey: true, sign: true, verify: true, digest: true, deriveBits: true, deriveKey: true, getRandomValues: true, randomUUID: true },
    canvas: { hash: rint(645172295, 735192295), emailHash: null, histogramBins: bins },
    formDetected: false,
    numForms: 0,
    numFormElements: 0,
    be: { si: false },
    end: ts + 1,
    errors: [],
    version: '2.4.0',
    id: randomUUID(),
  };
  const payload = Buffer.from(JSON.stringify(fp), 'utf8');
  const checksum = crc32(payload).toString(16).padStart(8, '0').toUpperCase();
  const data = Buffer.concat([Buffer.from(`${checksum}#`, 'utf8'), payload]);
  return { checksum, present: encryptFp(data) };
}

/** Metrics do mp_verify — set fixo capturado (o servidor não valida os valores a fundo). */
const METRICS = [
  { name: '2', value: 0.6, unit: '2' }, { name: '100', value: 0, unit: '2' }, { name: '101', value: 1, unit: '2' },
  { name: '102', value: 0, unit: '2' }, { name: '103', value: 4, unit: '2' }, { name: '104', value: 0, unit: '2' },
  { name: '105', value: 0, unit: '2' }, { name: '106', value: 0, unit: '2' }, { name: '107', value: 0, unit: '2' },
  { name: '108', value: 0, unit: '2' }, { name: '110', value: 0, unit: '2' }, { name: '111', value: 4, unit: '2' },
  { name: '3', value: 4.6, unit: '2' }, { name: '7', value: 0, unit: '4' }, { name: '1', value: 15.4, unit: '2' },
  { name: '4', value: 3, unit: '2' }, { name: '5', value: 0.3, unit: '2' }, { name: '6', value: 18.7, unit: '2' },
  { name: '8', value: 1, unit: '4' },
];

const wafHeaders = (origin: string): Record<string, string> => ({
  Accept: '*/*',
  Origin: origin,
  Referer: `${origin}/`,
});

export interface SolveWafOpts {
  /** Host do WebACL (default SUPERBET_WAF_HOST). */
  host?: string;
  /** Origin da casa (default SUPERBET_ORIGIN). */
  origin?: string;
}

/**
 * Resolve o AWS WAF NetworkBandwidth e devolve o `x-aws-waf-token`. Usa a MESMA
 * `CycleSession` (mesmo proxy/egress) que fará o login — o token é IP-bound.
 * Lança em qualquer falha (inputs sem challenge, mp_verify sem token).
 */
export async function solveWafToken(session: CycleSession, opts: SolveWafOpts = {}): Promise<string> {
  const host = opts.host || SUPERBET_WAF_HOST;
  const origin = opts.origin || SUPERBET_ORIGIN;

  // 1) inputs → challenge {input, hmac, region}
  const inp = await session.request('get', `https://${host}/inputs?client=browser`, {
    headers: wafHeaders(origin),
    sendCookies: false,
  });
  const challenge = inp.json?.challenge;
  if (!challenge?.input) throw new Error(`WAF /inputs sem challenge (status ${inp.status})`);

  // 2) mp_verify multipart → { token }
  const { checksum, present } = buildFingerprint(CHROME_UA);
  const meta = {
    challenge,
    solution: null,
    signals: [{ name: 'Zoey', value: { Present: present } }],
    checksum,
    existing_token: null,
    client: 'Browser',
    domain: origin.replace(/^https?:\/\//, ''),
    metrics: METRICS,
  };
  const solutionData = Buffer.alloc(1024).toString('base64'); // difficulty 1 → 1KB de zeros
  const boundary = `----WebKitFormBoundary${randomBytes(8).toString('hex')}`;
  const body =
    `--${boundary}\r\nContent-Disposition: form-data; name="solution_metadata"\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="solution_data"\r\n\r\n${solutionData}\r\n` +
    `--${boundary}--\r\n`;

  const res = await session.request('post', `https://${host}/mp_verify`, {
    body,
    headers: { ...wafHeaders(origin), 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    sendCookies: false,
  });
  const token: string | undefined = res.json?.token;
  if (!token) throw new Error(`WAF /mp_verify sem token (status ${res.status})`);
  return token;
}
