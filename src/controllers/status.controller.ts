import { FastifyRequest, FastifyReply } from "fastify";
import { AppDataSource } from "@Database";
import { Bookmaker } from "@Entities";
import { createResponse } from "@utils/resFormatter";
import { getRedisClient, isRedisConnected } from "@Core/redis";

/**
 * Status Page (PÚBLICO) — saúde dos coletores (crawlers) do arbbetting_master.
 *
 * Fonte: hash Redis `ArbBetting:UpdateBookData`, escrito pelos workers a cada
 * ciclo. Cada field é `<casa>:<esporte>` (ex.: `betano:futebol`) e o valor é o
 * JSON do último ciclo: { status, eventos, date (ISO), duration (ms) }.
 *
 * Aqui apenas LEMOS (somente leitura), enriquecemos com o cadastro da casa
 * (nome/ícone/cor) e calculamos a SAÚDE (online / atrasado / offline) a partir
 * da idade do último report. Os limiares são devolvidos junto para o frontend
 * recalcular a saúde "ao vivo" (sem precisar refazer a requisição) usando o
 * relógio do servidor — evitando divergência por fuso/relógio do cliente.
 */

const ARB_FOLDER_BASE_RKEY = process.env.ARB_FOLDER_BASE_RKEY || "ArbBetting";
const UPDATE_BOOK_DATA_HASH = `${ARB_FOLDER_BASE_RKEY}:UpdateBookData`;

// Limiares padrão de saúde (em segundos). Em estado saudável os coletores
// reportam a cada poucos minutos; estes valores dão folga sem mascarar quedas.
// Podem ser sobrescritos por env ou por query (?stale=&offline=).
const DEFAULT_STALE_SECONDS = Number(process.env.STATUS_STALE_SECONDS) || 300; // 5 min
const DEFAULT_OFFLINE_SECONDS = Number(process.env.STATUS_OFFLINE_SECONDS) || 900; // 15 min

const bookmakerRepository = AppDataSource.getRepository(Bookmaker);

type Health = "online" | "stale" | "offline";

interface CrawlerStatus {
  key: string;          // field cru: "betano:futebol"
  bookmaker: string;    // slug da casa: "betano"
  sport: string;        // esporte: "futebol"
  name: string;         // nome amigável (cadastro) ou o próprio slug
  logoUrl: string | null;
  color: string | null;
  registered: boolean;  // a casa existe no cadastro (bookmakers)?
  status: string;       // status cru do ciclo ("Finalizado", etc.)
  events: number;       // nº de eventos buscados no último ciclo
  durationMs: number;   // duração do último ciclo (ms)
  date: string | null;  // ISO do fim do último ciclo
  ageSeconds: number | null; // idade do report (segundos) no momento da resposta
  health: Health;       // online | stale | offline
}

const clampPositive = (raw: string | undefined, def: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
};

const healthFor = (ageSeconds: number | null, stale: number, offline: number): Health => {
  if (ageSeconds == null) return "offline";
  if (ageSeconds > offline) return "offline";
  if (ageSeconds > stale) return "stale";
  return "online";
};

/**
 * GET /status/crawlers
 * Lista o estado de cada coletor (casa × esporte), já enriquecido e com a
 * saúde calculada. Público — não expõe nada sensível (só contadores/horários).
 * Query: stale, offline (override dos limiares, em segundos).
 */
export const getCrawlersStatus = async (req: FastifyRequest, reply: FastifyReply) => {
  const { stale, offline } = req.query as Record<string, string>;
  const staleSeconds = clampPositive(stale, DEFAULT_STALE_SECONDS);
  // offline nunca pode ser <= stale (senão "stale" some); garante ordem coerente.
  const offlineSeconds = Math.max(clampPositive(offline, DEFAULT_OFFLINE_SECONDS), staleSeconds + 1);

  if (!isRedisConnected()) {
    return reply.code(503).send(createResponse(0, "Redis indisponível — não foi possível ler o status dos coletores.", null));
  }

  try {
    const raw = await getRedisClient().hgetall(UPDATE_BOOK_DATA_HASH);

    // Cadastro das casas para enriquecer (nome amigável, ícone, cor). Indexado
    // por slug. Casas que ainda não foram cadastradas caem no fallback (slug).
    const bookmakers = await bookmakerRepository.find();
    const bySlug = new Map(bookmakers.map((b) => [b.slug.toLowerCase(), b]));

    const now = Date.now();

    const crawlers: CrawlerStatus[] = Object.entries(raw)
      .map(([field, json]): CrawlerStatus | null => {
        let parsed: { status?: string; eventos?: number; date?: string; duration?: number };
        try {
          parsed = JSON.parse(json);
        } catch {
          return null; // ignora entradas corrompidas
        }

        // O field é `casa:esporte`; a casa pode ter ':' no nome? Não — o slug é
        // normalizado (sem ':'). Mesmo assim, separamos pelo ÚLTIMO ':' para o
        // esporte e juntamos o resto como casa, sendo conservadores.
        const idx = field.lastIndexOf(":");
        const bookmaker = idx >= 0 ? field.slice(0, idx) : field;
        const sport = idx >= 0 ? field.slice(idx + 1) : "";

        const dateStr = parsed.date || null;
        const ts = dateStr ? new Date(dateStr).getTime() : NaN;
        const ageSeconds = Number.isFinite(ts) ? Math.max(0, Math.round((now - ts) / 1000)) : null;

        const meta = bySlug.get(bookmaker.toLowerCase());

        return {
          key: field,
          bookmaker,
          sport,
          name: meta?.name || bookmaker,
          logoUrl: meta?.logoUrl ?? null,
          color: meta?.color ?? null,
          registered: !!meta,
          status: parsed.status || "—",
          events: Number(parsed.eventos) || 0,
          durationMs: Number(parsed.duration) || 0,
          date: dateStr,
          ageSeconds,
          health: healthFor(ageSeconds, staleSeconds, offlineSeconds)
        };
      })
      .filter((c): c is CrawlerStatus => c !== null)
      // Mais recente primeiro (sem data vai para o fim).
      .sort((a, b) => {
        const ta = a.date ? new Date(a.date).getTime() : -Infinity;
        const tb = b.date ? new Date(b.date).getTime() : -Infinity;
        return tb - ta;
      });

    const summary = {
      total: crawlers.length,
      online: crawlers.filter((c) => c.health === "online").length,
      stale: crawlers.filter((c) => c.health === "stale").length,
      offline: crawlers.filter((c) => c.health === "offline").length,
      totalEvents: crawlers.reduce((acc, c) => acc + c.events, 0),
      sports: Array.from(new Set(crawlers.map((c) => c.sport).filter(Boolean))).sort(),
      // Report mais recente entre todos os coletores (referência de "última atividade").
      lastUpdate: crawlers.find((c) => c.date)?.date ?? null
    };

    return reply.send(
      createResponse(1, "Status dos coletores carregado com sucesso.", {
        crawlers,
        summary,
        thresholds: { staleSeconds, offlineSeconds },
        serverTime: new Date(now).toISOString()
      })
    );
  } catch (error) {
    return reply.code(500).send(createResponse(0, `Erro ao carregar status dos coletores: ${(error as Error).message}`, null));
  }
};
