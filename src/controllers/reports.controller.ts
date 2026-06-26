import { FastifyRequest, FastifyReply } from "fastify";
import { AppDataSource } from "@Database";
import { SurebetReport, User } from "@Entities";
import { createResponse } from "@utils";

/**
 * Reclamações (reports) de surebets. Usuário cria; admin tria/resolve.
 */

const repo = () => AppDataSource.getRepository(SurebetReport);

const VALID_REASONS = ['different_teams', 'event_not_found', 'wrong_markets', 'different_odds', 'closed_market', 'other'];

// Janela após o kickoff em que ainda consideramos o evento "rolando"; passado
// isso, o evento já acabou e some da fila admin. Override por env.
const FINISHED_AFTER_MS = Number(process.env.EVENT_FINISHED_AFTER_MS) || 3 * 60 * 60 * 1000;

// Date a partir de string ISO do client (mesma lógica do hidden controller).
const parseStart = (v?: string | null): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

interface ReportBody {
  reason?: string;
  scope?: 'event' | 'leg';
  eventId?: string;
  sport?: string;
  league?: string;
  home?: string;
  away?: string;
  eventStartAt?: string;
  bookmaker?: string;
  houseEventId?: string;
  market?: string;
  selection?: string;
  handicap?: string;
  price?: number;
  surebetKey?: string;
  note?: string;
}

// POST /reports — usuário cria uma reclamação.
export const createReport = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;
  const b = (req.body || {}) as ReportBody;

  if (!b.reason || !VALID_REASONS.includes(b.reason)) {
    return reply.code(400).send(createResponse(0, "Motivo inválido.", []));
  }
  if (!b.eventId) return reply.code(400).send(createResponse(0, "O campo 'eventId' é obrigatório.", []));

  // Trunca strings ao tamanho da respectiva coluna p/ evitar ER_DATA_TOO_LONG
  // (os valores vêm direto do client; surebetKey/nomes longos passam dos limites).
  const cut = (v: unknown, max: number): string | null => {
    if (v == null) return null;
    const s = String(v);
    return s ? s.slice(0, max) : null;
  };

  try {
    const report = repo().create({
      user: userId ? ({ id: userId } as User) : null,
      reason: b.reason,
      scope: b.scope === 'leg' ? 'leg' : 'event',
      eventId: String(b.eventId).slice(0, 64),
      sport: cut(b.sport, 32) || 'futebol',
      league: cut(b.league, 200),
      home: cut(b.home, 200),
      away: cut(b.away, 200),
      eventStartAt: parseStart(b.eventStartAt),
      bookmaker: b.bookmaker ? b.bookmaker.toLowerCase().slice(0, 40) : null,
      houseEventId: cut(b.houseEventId, 64),
      market: cut(b.market, 120),
      selection: cut(b.selection, 120),
      handicap: cut(b.handicap, 32),
      price: b.price != null ? Number(b.price) : null,
      surebetKey: cut(b.surebetKey, 512),
      note: cut(b.note, 1000),
      status: 'open',
    });
    const saved = await repo().save(report);
    return reply.code(201).send(createResponse(1, "Reclamação enviada. Obrigado!", { id: saved.id }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao enviar reclamação.", { error: (error as Error).message }));
  }
};

// GET /reports/mine — reclamações do próprio usuário.
export const getMyReports = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;
  if (!userId) return reply.code(401).send(createResponse(0, "Não autenticado.", []));
  try {
    const rows = await repo().createQueryBuilder('r').where('r.userId = :userId', { userId }).orderBy('r.createdAt', 'DESC').take(50).getMany();
    return reply.send(createResponse(1, "Reclamações carregadas.", rows));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao carregar reclamações.", { error: (error as Error).message }));
  }
};

// ===================== ADMIN =====================

const serialize = (r: SurebetReport & { user?: User | null }) => ({
  id: r.id,
  reason: r.reason,
  scope: r.scope,
  eventId: r.eventId,
  sport: r.sport,
  league: r.league,
  home: r.home,
  away: r.away,
  eventStartAt: r.eventStartAt,
  bookmaker: r.bookmaker,
  houseEventId: r.houseEventId,
  market: r.market,
  selection: r.selection,
  handicap: r.handicap,
  price: r.price,
  surebetKey: r.surebetKey,
  note: r.note,
  status: r.status,
  adminNote: r.adminNote,
  resolvedAt: r.resolvedAt,
  createdAt: r.createdAt,
  user: r.user ? { id: r.user.id, fullname: r.user.fullname, email: r.user.email } : null,
});

// GET /reports?status=&reason=&page=&limit= — fila admin.
export const listReports = async (req: FastifyRequest, reply: FastifyReply) => {
  const { status, reason, page = '1', limit = '30' } = (req.query || {}) as { status?: string; reason?: string; page?: string; limit?: string };
  const p = Math.max(1, parseInt(page) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit) || 30));

  // Eventos que já acabaram (kickoff + buffer) saem da fila. eventStartAt nulo
  // (reclamações antigas, sem snapshot do kickoff) continua aparecendo.
  const cutoff = new Date(Date.now() - FINISHED_AFTER_MS);
  const notFinished = '(r.eventStartAt IS NULL OR r.eventStartAt >= :cutoff)';

  try {
    const qb = repo().createQueryBuilder('r')
      .leftJoin('r.user', 'user')
      .addSelect(['user.id', 'user.fullname', 'user.email'])
      .where(notFinished, { cutoff })
      .orderBy('r.createdAt', 'DESC'); // coluna simples (sort de prioridade é feito pelas abas de status)
    if (status) qb.andWhere('r.status = :status', { status });
    if (reason) qb.andWhere('r.reason = :reason', { reason });

    const [rows, total] = await qb.skip((p - 1) * l).take(l).getManyAndCount();
    // Contadores por status (para badges) — mesma janela de "não acabou".
    const counts = await repo().createQueryBuilder('r').select('r.status', 'status').addSelect('COUNT(*)', 'count').where(notFinished, { cutoff }).groupBy('r.status').getRawMany<{ status: string; count: string }>();
    const countMap: Record<string, number> = {};
    for (const c of counts) countMap[c.status] = Number(c.count);

    return reply.send(createResponse(1, "Reclamações carregadas.", {
      reports: rows.map(serialize),
      counts: countMap,
      pagination: { page: p, limit: l, total, totalPages: Math.ceil(total / l) },
    }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao listar reclamações.", { error: (error as Error).message }));
  }
};

// PUT /reports/:id — admin atualiza status/nota.
export const updateReport = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  const b = (req.body || {}) as { status?: string; adminNote?: string };
  const userId = req.userData?.userId;

  try {
    const r = await repo().findOneBy({ id });
    if (!r) return reply.code(404).send(createResponse(0, "Reclamação não encontrada.", []));

    if (b.status && ['open', 'reviewing', 'resolved', 'dismissed'].includes(b.status)) {
      r.status = b.status as SurebetReport['status'];
      if (b.status === 'resolved' || b.status === 'dismissed') {
        r.resolvedBy = userId || null;
        r.resolvedAt = new Date();
      }
    }
    if (b.adminNote !== undefined) r.adminNote = b.adminNote ? String(b.adminNote).slice(0, 1000) : null;

    const saved = await repo().save(r);
    return reply.send(createResponse(1, "Reclamação atualizada.", serialize(saved)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao atualizar reclamação.", { error: (error as Error).message }));
  }
};
