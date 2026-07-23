/**
 * ZapClient — cliente headless do "zap-protocol-v1" (WebSocket pushdata da bet365).
 * É a "sessão viva" que o /BetsWebAPI/addbet exige: sem estar conectado + autenticado + SUBSCRITO no
 * tópico do jogo, o addbet recusa {cs:2,sr:-1}. Pra APOSTAR basta connect+auth+subscribe (não parseia odds).
 *
 * O WS roda por um TRANSPORTE curl_cffi (TLS impersonada de Chrome) — o `ws` do Node toma 403 do
 * Cloudflare no premws. O transporte é request-response (wsConnect/wsSend/wsRecv/wsClose).
 *
 * Protocolo (provado de s_main_13.js + captura real /tmp/bet365_full_capture.jsonl):
 *   URL       wss://<host>/zap/?uid=<dígitos>   subprotocolo "zap-protocol-v1"
 *   HANDSHAKE "#"\x03"P"\x01 <defaultTopic> "," "S_"<pstk> [",A_"<nst>] \x00
 *   RESPOSTA  "<code>"\x02"<connId>"\x00   → 100=conectado · 101=reenviar com A_ · 111=rejeitado
 *   SUBSCRIBE \x16 \x00 <topics vírgula> ",A_"<nst> \x01     (CLIENT_SUBSCRIBE=0x16, NONE_ENCODING=0x00)
 *   HEARTBEAT (55s) \x16 \x00 "A_"<nst> \x01
 *   CLOSE     \x1D \x00
 *   S_ = cookie `pstk`. A_ = nst mintado fresco por handshake-stage2/subscribe/heartbeat.
 *   Host prematch = premws-pt2.365lpodds.com (defaultTopic "__time,P-ENDP"). Tópico jogo = <FI>C<cls>A_<lang>.
 */
import { randomBytes } from 'crypto';

const C = {
  SUBPROTOCOL: 'zap-protocol-v1',
  RECORD_DELIM: '\x01',
  FIELD_DELIM: '\x02',
  HS_DELIM: '\x03',
  END: '\x00',
  CLIENT_SUBSCRIBE: '\x16',
  CLIENT_CLOSE: '\x1d',
  NONE_ENCODING: '\x00',
  HS_HEADER: '#\x03P\x01', // PROTOCOL(35='#') VERSION(3) CONNECTION_TYPE(80='P') CAPABILITIES(1)
  HEARTBEAT_MS: 55000,
};

/** Transporte WS (request-response). Implementado pelo CurlCffiSession (TLS impersonada). */
export interface ZapTransport {
  wsConnect(url: string, headers?: Record<string, string>): Promise<void>;
  wsSend(frame: string, text?: boolean): Promise<void>;
  wsRecv(): Promise<{ data: string; flags: number } | null>;
  wsClose(): Promise<void>;
}

export interface ZapOpts {
  transport: ZapTransport;
  host?: string;
  defaultTopic?: string;
  pstk: string;
  mintNst: (wsUrl: string) => Promise<string>;
  userAgent?: string;
  origin?: string;
  debug?: (line: string) => void;
}

export class ZapClient {
  private readonly o: ZapOpts;
  private readonly host: string;
  private readonly defaultTopic: string;
  private uid = '';
  private wsUrl = '';
  private connectionId = '';
  private connected = false;
  private hbTimer: NodeJS.Timeout | null = null;
  private subscribed = new Set<string>();

  constructor(opts: ZapOpts) {
    this.o = opts;
    this.host = opts.host || 'premws-pt2.365lpodds.com';
    this.defaultTopic = opts.defaultTopic || '__time,P-ENDP';
  }

  private log(s: string) { this.o.debug?.('[zap] ' + s); }
  private newUid(): string { return randomBytes(8).readBigUInt64BE(0).toString().padStart(16, '0').slice(0, 16); }

  /** Conecta + handshake (S_ → 101 → S_+A_ → 100). Resolve quando conectado (100). */
  async connect(): Promise<void> {
    this.uid = this.newUid();
    this.wsUrl = `wss://${this.host}/zap/?uid=${this.uid}`;
    this.log(`connect ${this.wsUrl}`);
    await this.o.transport.wsConnect(this.wsUrl, {
      'Sec-WebSocket-Protocol': C.SUBPROTOCOL,
      Origin: this.o.origin || 'https://www.bet365.bet.br',
      ...(this.o.userAgent ? { 'User-Agent': this.o.userAgent } : {}),
      'Cache-Control': 'no-cache', Pragma: 'no-cache', 'Accept-Language': 'en-US,en;q=0.9',
    });

    // handshake stage 1 (só S_)
    await this.o.transport.wsSend(this.handshakeFrame(null));
    this.log('→ handshake stage1 (S_)');

    for (let step = 0; step < 4; step++) {
      const msg = await this.o.transport.wsRecv();
      if (!msg) throw new Error('[zap] recv timeout no handshake');
      const parts = msg.data.split(C.HS_DELIM)[0].split(C.FIELD_DELIM);
      const code = parts[0];
      const connId = (parts[1] || '').split(C.END)[0];
      this.log(`← handshake code=${code} conn=${connId}`);
      if (code === '100') { this.connectionId = connId; this.connected = true; this.startHeartbeat(); return; }
      if (code === '101') {
        this.connectionId = connId;
        const nst = await this.o.mintNst(this.wsUrl);
        await this.o.transport.wsSend(this.handshakeFrame(nst));
        this.log('→ handshake stage2 (S_+A_)');
        continue;
      }
      if (code === '111') throw new Error('[zap] rejeitado (111)');
      throw new Error('[zap] handshake inesperado: ' + JSON.stringify(msg.data.slice(0, 24)));
    }
    throw new Error('[zap] handshake não convergiu');
  }

  private handshakeFrame(token: string | null): string {
    let t = C.HS_HEADER + this.defaultTopic + ',' + 'S_' + this.o.pstk;
    if (token) t += ',A_' + token;
    return t + C.END;
  }

  /** Subscribe nos tópicos (ex.: [`<FI>C1A_33`, controle...]). Anexa A_<nst> fresco. */
  async subscribe(topics: string[]): Promise<void> {
    if (!this.connected) throw new Error('zap não conectado');
    const nst = await this.o.mintNst(this.wsUrl);
    const frame = C.CLIENT_SUBSCRIBE + C.NONE_ENCODING + topics.join(',') + ',A_' + nst + C.RECORD_DELIM;
    await this.o.transport.wsSend(frame);
    for (const t of topics) this.subscribed.add(t);
    this.log(`→ subscribe ${topics.join(',')}`);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.hbTimer = setInterval(async () => {
      try {
        const nst = await this.o.mintNst(this.wsUrl);
        await this.o.transport.wsSend(C.CLIENT_SUBSCRIBE + C.NONE_ENCODING + 'A_' + nst + C.RECORD_DELIM);
      } catch (e) { this.log('heartbeat err: ' + (e as Error).message); }
    }, C.HEARTBEAT_MS);
    if (this.hbTimer.unref) this.hbTimer.unref();
  }
  private stopHeartbeat(): void { if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; } }

  get isConnected(): boolean { return this.connected; }
  isSubscribed(topic: string): boolean { return this.subscribed.has(topic); }

  async close(): Promise<void> {
    this.stopHeartbeat();
    try { await this.o.transport.wsSend(C.CLIENT_CLOSE + C.END); } catch { /* */ }
    try { await this.o.transport.wsClose(); } catch { /* */ }
    this.connected = false;
  }
}
