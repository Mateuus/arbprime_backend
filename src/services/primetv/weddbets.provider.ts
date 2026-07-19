import { PrimeTvChannel, PrimeTvEvent, PrimeTvStatus, PrimeTvTeam, PrimeTvView } from "@Interfaces";
import { PrimeTvSource, makePrimeTvId } from "./primetv.source";

/**
 * Formato BRUTO do fornecedor weddbets (ex.: youreventinrealtime/cache.json).
 * Só os campos que o mapper consome — o resto (servidor, transmissaoCanais,
 * remoteSources, etc.) é ignorado de propósito para não vazar detalhe de
 * fornecedor no nosso schema.
 */
export interface WeddbetsRawEvent {
  _id: string;
  nome: string;
  equipe1?: string;
  equipe2?: string;
  equipe1Icone?: number | string | null;
  equipe2Icone?: number | string | null;
  dataHora?: number;
  dataMinuto?: number;
  dataDia?: number;
  dataMes?: number;
  dataAno?: number;
  sofaScoreId?: string | null;
  competicao?: string;
  competicaoIcone?: string | null; // ISO-2 do país (ex.: "CN") ou ""
  pais?: string | null;
  situacao?: number; // 1 = agendado; 3 = ao vivo; 4 = ENCERRADO (não pegar/listar)
  canais?: number;
  williamHillId?: string | null;
  /** fontes remotas do sinal; se alguma tem audioId, há narração/áudio. */
  remoteSources?: Array<{ audioId?: string | null }>;
}

const PROVIDER = "weddbets";

// Emojis que o fornecedor injeta no `nome` (esporte + 🔊 de áudio). Removidos
// para o título limpo. Mantidos aqui p/ também DETECTAR o esporte antes de tirar.
const SPORT_EMOJI: Record<string, string> = {
  "🏐": "volei",
  "🏀": "basquete",
  "🎾": "tenis",
  "🏎": "automobilismo",
  "🏁": "automobilismo",
  "⚾": "beisebol",
  "🏈": "futebol-americano",
  "🏒": "hoquei",
  "🏉": "rugby",
  "⚽": "futebol",
};

// Esportes que NÃO são confronto time-vs-time (usam só o título).
const NON_VERSUS_SPORTS = new Set(["automobilismo"]);

const AUDIO_EMOJI = "🔊";

/** Remove os emojis conhecidos e normaliza espaços do nome cru. */
const cleanName = (nome: string): string =>
  nome
    .replace(new RegExp(Object.keys(SPORT_EMOJI).join("|"), "g"), "")
    .replace(new RegExp(AUDIO_EMOJI, "g"), "")
    .replace(/\s+/g, " ")
    .trim();

/** Detecta o esporte por emoji no nome, com fallback por palavra na competição. */
const detectSport = (nome: string, competicao: string): string => {
  for (const [emoji, sport] of Object.entries(SPORT_EMOJI)) {
    if (nome.includes(emoji)) return sport;
  }
  const c = competicao.toLowerCase();
  if (/\bformula 1\b|\bf1\b|grand prix|moto ?gp/.test(c)) return "automobilismo";
  if (/\bnba\b|\bwnba\b|basquete|basketball/.test(c)) return "basquete";
  if (/\bvolei\b|volleyball|nations league.*volei/.test(c)) return "volei";
  if (/\bwta\b|\batp\b|tennis|tênis/.test(c)) return "tenis";
  return "futebol";
};

/** slug estável (a-z0-9-) para agrupar/filtrar competições. */
export const slugify = (s: string): string =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove diacríticos combinados
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "outros";

/**
 * Monta o ISO do horário de início a partir dos campos data* (wallclock de
 * Brasília GMT-3). Seguindo a convenção do projeto (ver frontend eventTime),
 * carimbamos com Z e o frontend exibe verbatim com timeZone:'UTC'. Retorna null
 * se a data for incompleta/inválida.
 */
const buildStartIso = (r: WeddbetsRawEvent): string | null => {
  const { dataAno, dataMes, dataDia, dataHora, dataMinuto } = r;
  if (!dataAno || !dataMes || !dataDia) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  const iso = `${dataAno}-${p(dataMes)}-${p(dataDia)}T${p(dataHora ?? 0)}:${p(dataMinuto ?? 0)}:00.000Z`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
};

/**
 * situacao do fornecedor → nosso status: 3 = ao vivo; 4 = encerrado; demais
 * (1 etc.) = agendado. Encerrados são descartados na origem (ver isFinishedRaw),
 * mas mapeamos defensivamente caso algum escape.
 */
const mapStatus = (situacao?: number): PrimeTvStatus =>
  situacao === 3 ? "live" : situacao === 4 ? "finished" : "upcoming";

/** Evento ENCERRADO no bruto (situacao 4) — não pegar nem listar. */
export const isFinishedRaw = (r: WeddbetsRawEvent): boolean => r.situacao === 4;

// Os campos data* são horário de BRASÍLIA (GMT-3). O instante REAL (UTC) do
// kickoff = wallclock + 3h. Usado pra promover agendado→ao vivo assim que o
// horário passa, sem depender do cache (que confirma no refresh de 5 min).
const BRASILIA_OFFSET_MS = 3 * 60 * 60 * 1000;

/** ms (UTC) reais do kickoff a partir do ISO wallclock-BRT; null se inválido. */
const kickoffRealMs = (startIso: string): number | null => {
  const t = new Date(startIso).getTime();
  return Number.isNaN(t) ? null : t + BRASILIA_OFFSET_MS;
};

/**
 * Constrói a url do escudo a partir do id do ícone. O fornecedor usa ids de time
 * do SofaScore; a imagem pública fica em /api/v1/team/{id}/image. Pode falhar
 * (hotlink/CORS) — por isso o frontend sempre cai em iniciais no onError.
 */
const teamIconUrl = (iconId: string | null): string | null =>
  iconId ? `https://api.sofascore.com/api/v1/team/${iconId}/image` : null;

const toIconId = (v: number | string | null | undefined): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  return /^\d+$/.test(s) ? s : null;
};

const buildTeam = (name: string | undefined, iconRaw: number | string | null | undefined): PrimeTvTeam => {
  const iconId = toIconId(iconRaw);
  return { name: (name || "").trim(), iconId, iconUrl: teamIconUrl(iconId) };
};

const compactRefs = (obj: Record<string, string | null | undefined>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) if (v) out[k] = String(v);
  return out;
};

/** Mapeia UM item bruto do weddbets → PrimeTvEvent. */
export const mapWeddbetsEvent = (r: WeddbetsRawEvent): PrimeTvEvent | null => {
  if (!r || !r._id) return null;
  const startTime = buildStartIso(r);
  if (!startTime) return null;

  const competition = (r.competicao || "Outros").trim();
  const sport = detectSport(r.nome || "", competition);
  const isVersus = !NON_VERSUS_SPORTS.has(sport) && !!(r.equipe1 && r.equipe2);
  const home = buildTeam(r.equipe1, r.equipe1Icone);
  const away = buildTeam(r.equipe2, r.equipe2Icone);

  // Status base pelo situacao; se ainda "agendado" mas o kickoff (Brasília) já
  // passou, promovemos a AO VIVO na hora — não esperamos o cache confirmar.
  let status = mapStatus(r.situacao);
  if (status === "upcoming") {
    const kickoff = kickoffRealMs(startTime);
    if (kickoff !== null && kickoff <= Date.now()) status = "live";
  }

  const title = isVersus && home.name && away.name ? `${home.name} x ${away.name}` : cleanName(r.nome || "");
  const hasAudio =
    (r.nome || "").includes(AUDIO_EMOJI) ||
    (Array.isArray(r.remoteSources) && r.remoteSources.some((rs) => !!rs?.audioId));

  return {
    id: makePrimeTvId(PROVIDER, r._id),
    provider: PROVIDER,
    sourceId: r._id, // guardado internamente; nunca serializado ao cliente
    sport,
    isVersus,
    title,
    home,
    away,
    competition,
    competitionKey: slugify(competition),
    country: (r.pais || "").trim() || null,
    countryCode: (r.competicaoIcone || "").trim().toUpperCase() || null,
    startTime,
    status,
    isLive: status === "live",
    hasAudio,
    channels: typeof r.canais === "number" ? r.canais : 0,
    externalRefs: compactRefs({ sofaScoreId: r.sofaScoreId, williamHillId: r.williamHillId }),
  };
};

// ---------------------------------------------------------------------------
// VIEW / sessão de transmissão de UM evento (GET /api/evento/view/:id).
// ---------------------------------------------------------------------------

/** Item cru do `view` do weddbets (só os campos que consumimos). */
export interface WeddbetsViewItem {
  _id: string;
  servidor?: string;
  servidorTipo?: string;
  msToken?: string;
  sessaoView?: string;
  key?: string;
  canal?: number | string; // o fornecedor manda como string (ex.: "4")
  idCanal?: string;
  transmissaoCanais?: Record<string, { status?: boolean; servidor?: string; tag?: string; limite?: number }>;
}

/** canal pode vir número ou string ("4") — normaliza p/ número (0 se inválido). */
const parseCanal = (v: number | string | undefined): number => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isNaN(n) ? 0 : n;
};

export interface WeddbetsViewResponse {
  erro?: boolean;
  mensagem?: string;
  itens?: WeddbetsViewItem[];
}

/** transmissaoCanais (mapa "0".."N") → lista tipada de canais. */
const mapChannels = (tc: WeddbetsViewItem["transmissaoCanais"]): PrimeTvChannel[] => {
  if (!tc) return [];
  return Object.entries(tc)
    .map(([idx, c]) => ({
      canal: parseInt(idx, 10),
      status: !!c?.status,
      server: c?.servidor || null,
      tag: c?.tag || null,
      limit: typeof c?.limite === "number" ? c.limite : null,
    }))
    .filter((c) => !Number.isNaN(c.canal))
    .sort((a, b) => a.canal - b.canal);
};

/**
 * Mapeia o `itens[0]` do view weddbets → nosso PrimeTvView (schema padrão). O
 * `servidor` já vem pronto p/ o canal atual (`canal`). `fetchedAtIso` é passado
 * pelo chamador (o mapper não gera timestamps).
 */
export const mapWeddbetsView = (
  item: WeddbetsViewItem,
  ourId: string,
  sourceId: string,
  fetchedAtIso: string,
): PrimeTvView => ({
  provider: PROVIDER,
  eventId: ourId,
  sourceId,
  channel: parseCanal(item.canal),
  channelId: item.idCanal || null,
  server: item.servidor || "",
  serverType: item.servidorTipo || "",
  msToken: item.msToken || "",
  sessionView: item.sessaoView || null,
  key: item.key || null,
  channels: mapChannels(item.transmissaoCanais),
  fetchedAt: fetchedAtIso,
});

/**
 * Fonte weddbets. Recebe um loader do bruto (cache do fornecedor) e devolve tudo
 * já normalizado. Itens que não mapeiam (sem data etc.) são descartados.
 */
export class WeddbetsSource implements PrimeTvSource {
  readonly provider = PROVIDER;
  constructor(private loadRaw: () => Promise<WeddbetsRawEvent[]>) {}

  async fetch(): Promise<PrimeTvEvent[]> {
    const raw = await this.loadRaw();
    return raw
      .map((r) => mapWeddbetsEvent(r))
      .filter((e): e is PrimeTvEvent => e !== null);
  }
}
