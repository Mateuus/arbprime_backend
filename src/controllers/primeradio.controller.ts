import { FastifyReply, FastifyRequest } from "fastify";
import { AppDataSource } from "@Database";
import { PrimeTvRadioEvent, PrimeTvRadioStation } from "@Entities";
import { createResponse } from "@utils";
import { getListen, listAdmin, listPublic } from "../services/primeradio/primeradio.service";
import { probeStream } from "../services/primeradio/stream-probe";

/**
 * PrimeRádio — lista pública, escuta (autenticada) e CRUD do painel admin.
 *
 * Os jogos são cadastrados à mão (nós somos o fornecedor). A `streamUrl` só sai
 * na rota autenticada de escuta — a lista pública nunca a expõe.
 */

const repo = () => AppDataSource.getRepository(PrimeTvRadioEvent);
const stationRepo = () => AppDataSource.getRepository(PrimeTvRadioStation);

interface RadioBody {
  homeName?: string | null;
  awayName?: string | null;
  homeSofaId?: string | null;
  awaySofaId?: string | null;
  title?: string | null;
  competition?: string | null;
  country?: string | null;
  countryCode?: string | null;
  sport?: string;
  startTime?: string;
  endTime?: string;
  streamUrl?: string;
  station?: string | null;
  coverUrl?: string | null;
  isActive?: boolean;
  /** Emissoras do jogo. Quando vem, SUBSTITUI a lista inteira. */
  stations?: StationBody[];
}

interface StationBody {
  name?: string | null;
  streamUrl?: string;
  city?: string | null;
  logoUrl?: string | null;
}


/**
 * Regrava as emissoras do jogo. Semântica de SUBSTITUIÇÃO: o painel manda a
 * lista inteira como está na tela, então apagar aqui e reinserir mantém o
 * backend fiel ao que o admin vê — sem precisar rastrear o que ele removeu.
 */
const saveStations = async (eventId: string, list: StationBody[]): Promise<void> => {
  await stationRepo().delete({ eventId });
  const rows = list
    .filter((st) => (st.streamUrl || "").trim())
    .map((st, i) => stationRepo().create({
      eventId,
      name: (st.name || "").trim().slice(0, 140) || "Transmissão",
      streamUrl: (st.streamUrl || "").trim(),
      city: str(st.city),
      logoUrl: str(st.logoUrl),
      sortOrder: i,
      isActive: true,
    }));
  if (rows.length) await stationRepo().save(rows);
};

/** minutos padrão de duração quando o admin não manda `endTime`. */
const DEFAULT_DURATION_MIN = 100;

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
};

/** soma minutos a um ISO wallclock preservando a convenção (volta tagueado com Z). */
const addMinutesIso = (iso: string, minutes: number): string => {
  const t = new Date(iso).getTime();
  return new Date(t + minutes * 60_000).toISOString();
};

/** Aplica no alvo só as chaves presentes no body (padrão dos controllers de admin). */
const normalize = (b: RadioBody, target: PrimeTvRadioEvent): void => {
  if ("homeName" in b) target.homeName = str(b.homeName);
  if ("awayName" in b) target.awayName = str(b.awayName);
  if ("homeSofaId" in b) target.homeSofaId = str(b.homeSofaId);
  if ("awaySofaId" in b) target.awaySofaId = str(b.awaySofaId);
  if ("title" in b) target.title = str(b.title);
  if ("competition" in b) target.competition = str(b.competition);
  if ("country" in b) target.country = str(b.country);
  if ("countryCode" in b) target.countryCode = str(b.countryCode)?.toUpperCase().slice(0, 8) || null;
  if (typeof b.sport === "string" && b.sport.trim()) target.sport = b.sport.trim();
  if (typeof b.startTime === "string" && b.startTime.trim()) target.startTime = b.startTime.trim();
  if (typeof b.endTime === "string" && b.endTime.trim()) target.endTime = b.endTime.trim();
  if (typeof b.streamUrl === "string" && b.streamUrl.trim()) target.streamUrl = b.streamUrl.trim();
  if ("station" in b) target.station = str(b.station);
  if ("coverUrl" in b) target.coverUrl = str(b.coverUrl);
  if (b.isActive !== undefined) target.isActive = !!b.isActive;
};

/** Valida o mínimo: precisa de identificação (times OU título), horário e link. */
const validate = (row: PrimeTvRadioEvent): string | null => {
  const hasTeams = !!(row.homeName && row.awayName);
  if (!hasTeams && !row.title) return "Informe os dois times ou um título para o evento.";
  if (!row.startTime || Number.isNaN(new Date(row.startTime).getTime())) return "Horário de início inválido.";
  if (!row.endTime || Number.isNaN(new Date(row.endTime).getTime())) return "Horário de término inválido.";
  if (new Date(row.endTime).getTime() <= new Date(row.startTime).getTime()) {
    return "O término precisa ser depois do início.";
  }
  return null;
};

/** Pelo menos uma emissora tem que sobrar — sem isso não há o que tocar. */
const validateStations = (list: StationBody[] | undefined, row: PrimeTvRadioEvent): string | null => {
  if (list === undefined) return row.streamUrl ? null : "Informe ao menos uma rádio.";
  const clean = list.filter((st) => (st.streamUrl || "").trim());
  if (!clean.length) return "Informe ao menos uma rádio com link.";
  for (const st of clean) {
    if (!(st.name || "").trim()) return "Toda rádio precisa de um nome.";
  }

  return null;
};

// ---------------------------------------------------------------- público ----

/** GET /primeradio/events — lista pública (sem a URL do stream). */
export const listPrimeRadioEvents = async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    return reply.send(createResponse(1, "Transmissões de rádio carregadas.", await listPublic()));
  } catch (error) {
    return reply.code(500).send(
      createResponse(0, "Erro ao carregar as transmissões de rádio.", { error: (error as Error).message }),
    );
  }
};

/** GET /primeradio/listen/:id — dados p/ ouvir (autenticado). Só aqui sai a URL. */
export const getPrimeRadioListen = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  try {
    const data = await getListen(id);
    if (!data) return reply.code(404).send(createResponse(0, "Transmissão não encontrada ou já encerrada.", []));
    return reply.send(createResponse(1, "Transmissão pronta.", data));
  } catch (error) {
    return reply.code(500).send(
      createResponse(0, "Erro ao abrir a transmissão.", { error: (error as Error).message }),
    );
  }
};

// ------------------------------------------------------------------ admin ----

/** GET /primeradio/admin/events — tudo, inclusive encerrados/inativos. */
export const listPrimeRadioAdmin = async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    return reply.send(createResponse(1, "Transmissões carregadas.", await listAdmin()));
  } catch (error) {
    return reply.code(500).send(
      createResponse(0, "Erro ao carregar as transmissões.", { error: (error as Error).message }),
    );
  }
};

/** POST /primeradio/admin/events — cria. `endTime` é opcional (início + 100 min). */
export const createPrimeRadioEvent = async (req: FastifyRequest, reply: FastifyReply) => {
  const body = (req.body || {}) as RadioBody;
  try {
    const row = repo().create({ sport: "futebol", isActive: true });
    normalize(body, row);
    // Fim não informado → sugere início + 100 min (o formulário já preenche, mas
    // a API também aceita sem, p/ o futuro fluxo "colar link e criar".)
    if (!row.endTime && row.startTime && !Number.isNaN(new Date(row.startTime).getTime())) {
      row.endTime = addMinutesIso(row.startTime, DEFAULT_DURATION_MIN);
    }
    const invalid = validate(row) || validateStations(body.stations, row);
    if (invalid) return reply.code(400).send(createResponse(0, invalid, []));
    row.createdBy = req.userData?.userId || null;
    const saved = await repo().save(row);
    if (body.stations) await saveStations(saved.id, body.stations);
    return reply.code(201).send(createResponse(1, "Transmissão criada.", saved));
  } catch (error) {
    return reply.code(500).send(
      createResponse(0, "Erro ao criar a transmissão.", { error: (error as Error).message }),
    );
  }
};

/** PATCH /primeradio/admin/events/:id — edita. */
export const updatePrimeRadioEvent = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  const body = (req.body || {}) as RadioBody;
  try {
    const row = await repo().findOneBy({ id });
    if (!row) return reply.code(404).send(createResponse(0, "Transmissão não encontrada.", []));
    normalize(body, row);
    const invalid = validate(row) || validateStations(body.stations, row);
    if (invalid) return reply.code(400).send(createResponse(0, invalid, []));
    const saved = await repo().save(row);
    if (body.stations) await saveStations(saved.id, body.stations);
    return reply.send(createResponse(1, "Transmissão atualizada.", saved));
  } catch (error) {
    return reply.code(500).send(
      createResponse(0, "Erro ao atualizar a transmissão.", { error: (error as Error).message }),
    );
  }
};

/** POST /primeradio/admin/events/:id/end — encerra agora (some da lista pública). */
export const endPrimeRadioEvent = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  try {
    const row = await repo().findOneBy({ id });
    if (!row) return reply.code(404).send(createResponse(0, "Transmissão não encontrada.", []));
    row.endedAt = new Date();
    return reply.send(createResponse(1, "Transmissão encerrada.", await repo().save(row)));
  } catch (error) {
    return reply.code(500).send(
      createResponse(0, "Erro ao encerrar a transmissão.", { error: (error as Error).message }),
    );
  }
};

/** POST /primeradio/admin/events/:id/reopen — desfaz o encerramento manual. */
export const reopenPrimeRadioEvent = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  try {
    const row = await repo().findOneBy({ id });
    if (!row) return reply.code(404).send(createResponse(0, "Transmissão não encontrada.", []));
    row.endedAt = null;
    return reply.send(createResponse(1, "Transmissão reaberta.", await repo().save(row)));
  } catch (error) {
    return reply.code(500).send(
      createResponse(0, "Erro ao reabrir a transmissão.", { error: (error as Error).message }),
    );
  }
};

/** DELETE /primeradio/admin/events/:id — remove de vez. */
export const deletePrimeRadioEvent = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  try {
    const row = await repo().findOneBy({ id });
    if (!row) return reply.code(404).send(createResponse(0, "Transmissão não encontrada.", []));
    await repo().remove(row);
    return reply.send(createResponse(1, "Transmissão removida.", []));
  } catch (error) {
    return reply.code(500).send(
      createResponse(0, "Erro ao remover a transmissão.", { error: (error as Error).message }),
    );
  }
};

/**
 * POST /primeradio/admin/probe — testa o link antes de salvar.
 *
 * Serve pro admin saber se o endereço está no ar e é áudio de verdade; o que a
 * estação declarar (nome, gênero, ouvintes) vem junto de brinde. Ver o porquê
 * de não dar pra fazer isso no navegador em services/primeradio/stream-probe.
 */
export const probePrimeRadioStream = async (req: FastifyRequest, reply: FastifyReply) => {
  const { url } = (req.body || {}) as { url?: string };
  if (!url || typeof url !== "string" || !url.trim()) {
    return reply.code(400).send(createResponse(0, "Informe a URL do stream.", []));
  }
  try {
    const result = await probeStream(url);
    return reply.send(createResponse(1, result.ok ? "Stream no ar." : (result.error || "Falhou."), result));
  } catch (error) {
    return reply.code(500).send(
      createResponse(0, "Erro ao testar o stream.", { error: (error as Error).message }),
    );
  }
};
