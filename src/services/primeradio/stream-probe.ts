/**
 * Sonda de stream de rádio (Icecast/SHOUTcast).
 *
 * Por que isso vive no backend e não no navegador: a resposta do Icecast não
 * manda `access-control-allow-origin`, então um `fetch()` do front morre no
 * CORS — e mesmo que passasse, o navegador não expõe cabeçalho `icy-*` pro JS.
 * O `<audio>` toca porque media element não passa por CORS, mas ele não devolve
 * nenhuma dessas informações. Por isso o painel pergunta pro backend.
 *
 * O que a gente extrai:
 *   1. cabeçalhos da resposta   → formato, bitrate, nome/gênero da estação
 *   2. /status-json.xsl         → ouvintes agora e pico (só Icecast 2)
 *   3. metadata in-band         → "tocando agora" (StreamTitle), quando o
 *                                 servidor manda `icy-metaint`
 */

/** Tempo máximo esperando o servidor da rádio — o admin está olhando a tela. */
const TIMEOUT_MS = 8000;
/** Um leitor de verdade (Winamp) destrava metadata que alguns servidores negam a "curl". */
const UA = "WinampMPEG/5.0";

export interface StreamProbe {
  ok: boolean;
  /** Motivo da falha, pronto pra mostrar ao admin. */
  error?: string;
  status?: number;
  contentType?: string | null;
  /** "audio" (stream direto), "playlist" (HLS/m3u/pls) ou "outro". */
  kind?: "audio" | "playlist" | "outro";
  name?: string | null;
  genre?: string | null;
  description?: string | null;
  bitrate?: number | null;
  channels?: number | null;
  sampleRate?: number | null;
  listeners?: number | null;
  listenerPeak?: number | null;
  /** StreamTitle do momento (costuma vir vazio em rádio de jogo). */
  nowPlaying?: string | null;
}

/**
 * Bloqueia alvo interno. O endpoint é admin-only, mas ele faz o servidor buscar
 * uma URL arbitrária — sem essa trava viraria um scanner da rede interna
 * (o .210 do banco, o próprio localhost). Cobre o caso literal; rebind de DNS
 * está fora de escopo pra uma ferramenta de painel.
 */
const isInternalHost = (host: string): boolean => {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) return true;
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
};

const num = (v: string | null | undefined): number | null => {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** "no name"/"Unspecified description" são os placeholders do Icecast — tratamos como vazio. */
const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? "").trim();
  if (!s) return null;
  if (/^(no name|unspecified description|unspecified|various)$/i.test(s)) return null;
  return s;
};

/** `ice-audio-info: ice-bitrate=128;ice-channels=2;ice-samplerate=48000` */
const parseAudioInfo = (raw: string | null) => {
  const out: { bitrate: number | null; channels: number | null; sampleRate: number | null } = {
    bitrate: null, channels: null, sampleRate: null,
  };
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const [k, v] = part.split("=");
    const key = decodeURIComponent((k || "").trim()).toLowerCase();
    if (key.includes("bitrate")) out.bitrate = num(v);
    else if (key.includes("channels")) out.channels = num(v);
    else if (key.includes("samplerate")) out.sampleRate = num(v);
  }
  return out;
};

const kindOf = (contentType: string | null): "audio" | "playlist" | "outro" => {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("mpegurl") || ct.includes("x-scpls") || ct.includes("vnd.apple")) return "playlist";
  if (ct.startsWith("audio/") || ct.includes("ogg") || ct.includes("aacp")) return "audio";
  return "outro";
};

/**
 * Lê o StreamTitle da metadata in-band. Formato: depois dos cabeçalhos vêm
 * `metaint` bytes de áudio, 1 byte de tamanho (em blocos de 16) e o texto.
 * A 128kbps, os 16000 bytes típicos são ~1s de áudio — barato.
 */
const readNowPlaying = async (body: ReadableStream<Uint8Array>, metaint: number): Promise<string | null> => {
  const reader = body.getReader();
  const buf: number[] = [];
  const need = metaint + 1;
  try {
    while (buf.length < need) {
      const { done, value } = await reader.read();
      if (done) return null;
      for (const b of value) buf.push(b);
      if (buf.length > need + 8192) break; // trava de segurança
    }
    const len = buf[metaint] * 16;
    if (len <= 0) return null;
    while (buf.length < need + len) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const b of value) buf.push(b);
    }
    const raw = Buffer.from(buf.slice(need, need + len)).toString("utf8");
    const m = raw.match(/StreamTitle='([^']*)'/);
    return clean(m?.[1]);
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
};

/** Ouvintes/pico via /status-json.xsl (só Icecast 2; falha silenciosa nos demais). */
const fetchIcecastStats = async (url: URL): Promise<{ listeners: number | null; peak: number | null; name: string | null; genre: string | null }> => {
  const empty = { listeners: null, peak: null, name: null, genre: null };
  try {
    const res = await fetch(new URL("/status-json.xsl", url.origin).toString(), {
      signal: AbortSignal.timeout(4000),
      headers: { "User-Agent": UA },
    });
    if (!res.ok) return empty;
    const json = (await res.json()) as { icestats?: { source?: unknown } };
    const src = json?.icestats?.source;
    // `source` é objeto quando há 1 mountpoint e array quando há vários.
    const list = (Array.isArray(src) ? src : src ? [src] : []) as Record<string, unknown>[];
    const mount = list.find((s) => String(s.listenurl || "").endsWith(url.pathname)) || list[0];
    if (!mount) return empty;
    return {
      listeners: num(String(mount.listeners ?? "")),
      peak: num(String(mount.listener_peak ?? "")),
      name: clean(String(mount.server_name ?? "")),
      genre: clean(String(mount.genre ?? "")),
    };
  } catch {
    return empty;
  }
};

export const probeStream = async (rawUrl: string): Promise<StreamProbe> => {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: "URL inválida." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Só aceitamos links http:// ou https://." };
  }
  if (isInternalHost(url.hostname)) {
    return { ok: false, error: "Endereço interno não é permitido." };
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "Icy-MetaData": "1", "User-Agent": UA, Accept: "*/*" },
    });
  } catch (e) {
    const msg = (e as Error)?.name === "TimeoutError"
      ? "O servidor da rádio não respondeu a tempo."
      : "Não foi possível conectar nesse endereço.";
    return { ok: false, error: msg };
  }

  if (!res.ok) {
    void res.body?.cancel().catch(() => undefined);
    return { ok: false, status: res.status, error: `O servidor respondeu ${res.status}.` };
  }

  const h = res.headers;
  const contentType = h.get("content-type");
  const kind = kindOf(contentType);
  const audioInfo = parseAudioInfo(h.get("ice-audio-info"));
  const metaint = num(h.get("icy-metaint"));

  const nowPlaying = metaint && res.body ? await readNowPlaying(res.body, metaint) : null;
  // Se não fomos ler a metadata, ainda assim precisamos soltar a conexão: sem
  // isso o servidor nos contaria como ouvinte grudado.
  if (!metaint || !res.body) void res.body?.cancel().catch(() => undefined);

  const stats = await fetchIcecastStats(url);

  return {
    ok: true,
    status: res.status,
    contentType,
    kind,
    name: clean(h.get("icy-name")) ?? stats.name,
    genre: clean(h.get("icy-genre")) ?? stats.genre,
    description: clean(h.get("icy-description")),
    bitrate: num(h.get("icy-br")) ?? audioInfo.bitrate,
    channels: audioInfo.channels,
    sampleRate: audioInfo.sampleRate,
    listeners: stats.listeners,
    listenerPeak: stats.peak,
    nowPlaying,
  };
};
