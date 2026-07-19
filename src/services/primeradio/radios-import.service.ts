/**
 * Importador dos jogos de rádio do radios.com.br.
 *
 * Por que via `betbot/CycleSession`: o site fica atrás de um managed challenge
 * da Cloudflare que devolve 403 pra qualquer cliente HTTP comum (testado até no
 * /sitemap.xml). O gatilho é o **fingerprint TLS**, não JavaScript — com o
 * CHROME_JA3 que o betbot já usa pras casas, as páginas voltam normais. Não
 * precisa de navegador headless.
 *
 * A cadeia do site tem 3 níveis:
 *   1. /futebol                          → os jogos do dia
 *   2. /radio/futebol/{slug}/{id}        → as emissoras daquele jogo
 *   3. /aovivo/{slug}/{id}               → a URL do stream da emissora
 *
 * O nível 3 é o caro (uma requisição por emissora), mas o par emissora→stream
 * quase nunca muda e se repete entre jogos e dias — por isso fica em cache no
 * Redis. Depois da primeira rodada, o custo cai pra ~15 requisições/hora.
 */
import { AppDataSource } from "@Database";
import { PrimeTvRadioEvent, PrimeTvRadioStation } from "@Entities";
import { getRedisClient } from "@Core/redis";
import { logger, LoggerClass } from "@Core/logger";
import { CycleSession } from "../../betbot/cycle-session";

const BASE = "https://www.radios.com.br";
const SOURCE = "radios.com.br";
/** Duração padrão do jogo (o site não publica o fim). */
const DURATION_MIN = 100;
/** O par emissora→stream é estável; 7 dias evita rebater no nível 3. */
const STREAM_TTL_SEC = 7 * 24 * 3600;
const streamKey = (id: string) => `ArbPrime:PrimeRadio:Stream:${id}`;

export interface ImportSummary {
  scanned: number;
  created: number;
  updated: number;
  stations: number;
  errors: string[];
}

const decodeEntities = (s: string): string =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
   .replace(/&([a-z]+);/gi, " ").trim();

/**
 * "19/07/2026" + "20:00" → "2026-07-19T20:00:00.000Z".
 *
 * ⚠️ O horário do site é de Brasília e a nossa convenção guarda o wallclock
 * "tagueado com Z" (o front renderiza verbatim). Por isso a montagem é textual:
 * usar `new Date()` aqui converteria fuso e jogaria tudo 3h fora.
 */
const toWallclockIso = (date: string, time: string): string | null => {
  const d = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const t = time.match(/^(\d{2}):(\d{2})$/);
  if (!d || !t) return null;
  return `${d[3]}-${d[2]}-${d[1]}T${t[1]}:${t[2]}:00.000Z`;
};

const addMinutesIso = (iso: string, minutes: number): string => {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? iso : new Date(t + minutes * 60_000).toISOString();
};

export interface ScrapedGame {
  sourceId: string;
  url: string;
  home: string;
  away: string;
  homeIconUrl: string | null;
  awayIconUrl: string | null;
  competition: string | null;
  startTime: string; // wallclock ISO
}

export interface ScrapedStation {
  sourceId: string;
  name: string;
  url: string; // página /aovivo do site
}

/**
 * Links dos jogos na listagem. Só o link mesmo — times, campeonato e horário
 * saem da página do jogo, que é mais completa e menos frágil que o cartão da
 * listagem (o cartão não traz o campeonato e o horário fica solto no HTML).
 */
export const parseGameLinks = (html: string): { sourceId: string; url: string }[] => {
  const out: { sourceId: string; url: string }[] = [];
  const seen = new Set<string>();
  const re = /href="((?:https?:\/\/[^"]*)?\/radio\/futebol\/[^"/]+\/(\d+))"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const [, href, sourceId] = m;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    out.push({ sourceId, url: href.startsWith("http") ? href : `${BASE}${href}` });
  }
  return out;
};

/**
 * Dados do confronto na página do jogo: times (do <title>), escudos,
 * campeonato e o horário oficial ("19/07/2026 às 19:00", Brasília).
 */
export const parseGamePage = (html: string): Omit<ScrapedGame, "sourceId" | "url"> | null => {
  const title = decodeEntities((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "");
  const teams = title.replace(/^Ouvir\s*/i, "").split(/\s+ao vivo\b/i)[0].split(/\s+x\s+/i);
  if (teams.length < 2) return null;

  const when = html.match(/(\d{2}\/\d{2}\/\d{4})\s*às\s*(\d{2}:\d{2})/);
  const startTime = when ? toWallclockIso(when[1], when[2]) : null;
  if (!startTime) return null;

  const icons = [...html.matchAll(/<img[^>]+src="(https?:\/\/img\.radios\.com\.br\/time\/[^"]+)"/g)].map((m) => m[1]);
  const competition = decodeEntities((html.match(/<strong>([^<]{3,80})<\/strong>/) || [])[1] || "") || null;

  return {
    home: teams[0].trim(),
    away: teams[1].trim(),
    homeIconUrl: icons[0] || null,
    awayIconUrl: icons[1] || null,
    competition,
    startTime,
  };
};

/**
 * Emissoras que transmitem o jogo.
 *
 * ⚠️ Escopo: a página inteira tem ~120 links "Ouvir" (barra lateral, outras
 * seções). As emissoras DESTE jogo são só as que estão dentro dos blocos
 * `class="resultado"`. Sem esse recorte, cada jogo importaria a rádio errada.
 * O contador "Mostrando 1-N de N resultados" serve de conferência.
 */
export const parseStations = (html: string): ScrapedStation[] => {
  const out: ScrapedStation[] = [];
  const seen = new Set<string>();
  const blocks = html.split(/class="resultado[^"]*"/).slice(1);
  for (const b of blocks) {
    const href = b.match(/href="((?:https?:\/\/[^"]*)?\/aovivo\/[^"/]+\/(\d+))"/);
    const name = b.match(/title="Ouvir ([^"]+)"/);
    if (!href || !name) continue;
    const sourceId = href[2];
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    out.push({
      sourceId,
      name: decodeEntities(name[1]),
      url: href[1].startsWith("http") ? href[1] : `${BASE}${href[1]}`,
    });
  }
  return out;
};

/** Quantas emissoras o site DIZ que existem — confere o recorte acima. */
export const parseDeclaredCount = (html: string): number | null => {
  const m = html.match(/Mostrando\s+\d+-\d+\s+de\s+(\d+)/i);
  return m ? Number(m[1]) : null;
};

/** A URL do áudio, que o player da página carrega num objeto JS. */
export const parseStreamUrl = (html: string): string | null => {
  const direct = html.match(/['"]url['"]\s*:\s*['"](https?:\/\/[^'"]+)['"]/);
  if (direct) return direct[1];
  const src = html.match(/src:\s*["'](https?:\/\/[^"']+)["']/);
  return src ? src[1] : null;
};

/** Resolve o stream da emissora, com cache (o par quase nunca muda). */
const resolveStream = async (session: CycleSession, st: ScrapedStation): Promise<string | null> => {
  const key = streamKey(st.sourceId);
  // O cache é OTIMIZAÇÃO, nunca dependência: `getRedisClient()` estoura se o
  // Redis não subiu, e sem esta guarda o importador não traria emissora nenhuma.
  try {
    const cached = await getRedisClient().get(key);
    if (cached) return cached;
  } catch { /* sem cache: busca na fonte */ }

  const res = await session.request("get", st.url);
  if (res.status !== 200) return null;
  const url = parseStreamUrl(res.body || "");
  if (url) {
    try { await getRedisClient().set(key, url, "EX", STREAM_TTL_SEC); } catch { /* idem */ }
  }
  return url;
};

const eventRepo = () => AppDataSource.getRepository(PrimeTvRadioEvent);
const stationRepo = () => AppDataSource.getRepository(PrimeTvRadioStation);

/**
 * Roda uma importação. Idempotente: casa pelo par (source, sourceId), então
 * rodar de hora em hora atualiza o que mudou em vez de duplicar.
 *
 * Não mexe em jogo cadastrado à mão (source null) nem reabre o que o admin
 * encerrou — curadoria humana ganha do importador.
 */
export const runImport = async (): Promise<ImportSummary> => {
  const sum: ImportSummary = { scanned: 0, created: 0, updated: 0, stations: 0, errors: [] };
  const session = new CycleSession({ timeoutSec: 30 });

  try {
    const listing = await session.request("get", `${BASE}/futebol`);
    if (listing.status !== 200) {
      sum.errors.push(`listagem respondeu ${listing.status}`);
      return sum;
    }
    const links = parseGameLinks(listing.body || "");
    sum.scanned = links.length;
    if (!links.length) {
      // Sinal clássico de mudança de layout — melhor gritar do que importar nada em silêncio.
      sum.errors.push("nenhum jogo encontrado na listagem (o HTML do site pode ter mudado)");
      return sum;
    }

    for (const link of links) {
      try {
        // A página do jogo traz confronto, campeonato, horário E as emissoras.
        const page = await session.request("get", link.url);
        if (page.status !== 200) {
          sum.errors.push(`jogo ${link.sourceId} respondeu ${page.status}`);
          continue;
        }
        const g = parseGamePage(page.body || "");
        if (!g) {
          sum.errors.push(`jogo ${link.sourceId}: não consegui ler o confronto`);
          continue;
        }

        let row = await eventRepo().findOne({ where: { source: SOURCE, sourceId: link.sourceId } });
        const isNew = !row;
        if (row?.endedAt) continue; // admin encerrou: respeita

        if (!row) {
          row = eventRepo().create({ source: SOURCE, sourceId: link.sourceId, isActive: true, sport: "futebol" });
        }
        row.homeName = g.home;
        row.awayName = g.away;
        row.homeIconUrl = g.homeIconUrl;
        row.awayIconUrl = g.awayIconUrl;
        row.competition = g.competition;
        row.startTime = g.startTime;
        row.endTime = addMinutesIso(g.startTime, DURATION_MIN);
        const saved = await eventRepo().save(row);
        if (isNew) sum.created++; else sum.updated++;

        // Emissoras do jogo (recorte pelos blocos "resultado" — ver parseStations)
        const stations = parseStations(page.body || "");
        const declared = parseDeclaredCount(page.body || "");
        if (declared !== null && stations.length !== declared) {
          // Recorte divergindo do que o site declara = seletor desatualizado.
          sum.errors.push(`jogo ${link.sourceId}: li ${stations.length} emissoras mas o site declara ${declared}`);
        }

        const resolved: { name: string; streamUrl: string; sourceId: string }[] = [];
        for (const st of stations) {
          const streamUrl = await resolveStream(session, st);
          if (streamUrl) resolved.push({ name: st.name, streamUrl, sourceId: st.sourceId });
        }
        if (!resolved.length) continue;

        // Substitui a lista: o site é a fonte da verdade pros jogos importados.
        await stationRepo().delete({ eventId: saved.id });
        await stationRepo().save(resolved.map((st, i) => stationRepo().create({
          eventId: saved.id,
          name: st.name,
          streamUrl: st.streamUrl,
          city: null,
          logoUrl: null,
          sortOrder: i,
          isActive: true,
        })));
        sum.stations += resolved.length;
      } catch (e) {
        sum.errors.push(`jogo ${link.sourceId}: ${(e as Error).message}`);
      }
    }
    return sum;
  } finally {
    try { await session.close(); } catch { /* encerrando mesmo */ }
  }
};

/** Wrapper pro agendador: nunca deixa a exceção subir e derrubar o cron. */
export const runImportSafe = async (): Promise<void> => {
  try {
    const r = await runImport();
    logger.info(
      `import: ${r.scanned} jogos, ${r.created} novos, ${r.updated} atualizados, ${r.stations} emissoras` +
      (r.errors.length ? ` | ${r.errors.length} erro(s): ${r.errors.slice(0, 3).join("; ")}` : ""),
      LoggerClass.LogCategory.Server,
      "[RADIO]",
    );
  } catch (e) {
    logger.error(`import falhou: ${(e as Error).message}`, LoggerClass.LogCategory.Server, "[RADIO]");
  }
};
