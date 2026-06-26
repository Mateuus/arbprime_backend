import { FastifyRequest, FastifyReply } from "fastify";
import { AppDataSource } from "@Database";
import { SurebetReport, User } from "@Entities";
import { createResponse } from "@utils";

/**
 * Reclamações (reports) de surebets. Usuário cria; admin tria/resolve.
 */

const repo = () => AppDataSource.getRepository(SurebetReport);

const VALID_REASONS = ['different_teams', 'event_not_found', 'wrong_markets', 'different_odds', 'closed_market', 'other'];

interface ReportBody {
  reason?: string;
  scope?: 'event' | 'leg';
  eventId?: string;
  sport?: string;
  league?: string;
  home?: string;
  away?: string;
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

  try {
    const report = repo().create({
      user: userId ? ({ id: userId } as User) : null,
      reason: b.reason,
      scope: b.scope === 'leg' ? 'leg' : 'event',
      eventId: String(b.eventId),
      sport: b.sport || 'futebol',
      league: b.league || null,
      home: b.home || null,
      away: b.away || null,
      bookmaker: b.bookmaker ? b.bookmaker.toLowerCase() : null,
      houseEventId: b.houseEventId || null,
      market: b.market || null,
      selection: b.selection || null,
      handicap: b.handicap != null ? String(b.handicap) : null,
      price: b.price != null ? Number(b.price) : null,
      surebetKey: b.surebetKey || null,
      note: b.note ? String(b.note).slice(0, 1000) : null,
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

  try {
    const qb = repo().createQueryBuilder('r')
      .leftJoin('r.user', 'user')
      .addSelect(['user.id', 'user.fullname', 'user.email'])
      .orderBy('r.createdAt', 'DESC'); // coluna simples (sort de prioridade é feito pelas abas de status)
    if (status) qb.andWhere('r.status = :status', { status });
    if (reason) qb.andWhere('r.reason = :reason', { reason });

    const [rows, total] = await qb.skip((p - 1) * l).take(l).getManyAndCount();
    // Contadores por status (para badges).
    const counts = await repo().createQueryBuilder('r').select('r.status', 'status').addSelect('COUNT(*)', 'count').groupBy('r.status').getRawMany<{ status: string; count: string }>();
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
