import { FastifyRequest, FastifyReply } from 'fastify';
import { In, Between, MoreThanOrEqual, LessThanOrEqual, IsNull } from 'typeorm';
import { AppDataSource } from '@Database';
import {
  Bankroll, UserBookmakerAccount, Bet, BetLeg, BankrollTransaction, Partner,
} from '@Entities';
import { BetType, BetStatus, LegStatus, BetSide, TxType } from '@Enums';
import { createResponse } from '@utils';
import { resolveUserAccess } from '@Services/subscription.service';
import * as svc from '@Services/analytix.service';

/**
 * Controller do ArbPrime Analytix (rastreador de apostas + banca + analytics).
 * Tudo é user-scoped (checkAuth). A lógica de P&L vive em analytix.service.
 */

const bankrollRepo = () => AppDataSource.getRepository(Bankroll);
const accountRepo = () => AppDataSource.getRepository(UserBookmakerAccount);
const betRepo = () => AppDataSource.getRepository(Bet);
const legRepo = () => AppDataSource.getRepository(BetLeg);
const txRepo = () => AppDataSource.getRepository(BankrollTransaction);
const partnerRepo = () => AppDataSource.getRepository(Partner);

const uid = (req: FastifyRequest): string | undefined => req.userData?.userId;

const parseDate = (s?: string): Date | undefined => {
  if (!s) return undefined;
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
};

const LEG_STATUSES = Object.values(LegStatus);

// Garante a banca padrão do usuário (cria no 1º acesso). Retorna a default.
const ensureDefaultBankroll = async (userId: string): Promise<Bankroll> => {
  const list = await bankrollRepo().find({ where: { userId }, order: { createdAt: 'ASC' } });
  if (list.length) return list.find((b) => b.isDefault) || list[0];
  const created = bankrollRepo().create({
    userId, name: 'Banca Principal', currency: 'BRL',
    initialCapital: '0', unitValue: '0', isDefault: true, isActive: true,
  });
  return bankrollRepo().save(created);
};

/**
 * Garante a banca DEDICADA de value bet do usuário (cria sob demanda quando ele
 * lança a 1ª aposta de valor). Nunca é a default — value bet tem variância e
 * track record próprios; misturar com a banca de surebets contamina as métricas.
 * Não conta no limite premium de multi-banca (é gestão de estratégia, não banca
 * avulsa). Idempotente: 1 banca 'valuebet' por usuário.
 */
const ensureValuebetBankroll = async (userId: string): Promise<Bankroll> => {
  const existing = await bankrollRepo().findOne({ where: { userId, kind: 'valuebet' }, order: { createdAt: 'ASC' } });
  if (existing) return existing;
  const created = bankrollRepo().create({
    userId, name: 'Banca Value Bet', currency: 'BRL', kind: 'valuebet',
    initialCapital: '0', unitValue: '0', isDefault: false, isActive: true,
  });
  return bankrollRepo().save(created);
};

// ===================== BANCAS =====================

export const listBankrolls = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  try {
    await ensureDefaultBankroll(userId);
    const bankrolls = await bankrollRepo().find({ where: { userId }, order: { isDefault: 'DESC', createdAt: 'ASC' } });
    const bets = await betRepo().find({ where: { userId } });
    const txs = await txRepo().find({ where: { userId } });
    const data = bankrolls.map((b) => ({
      id: b.id, name: b.name, currency: b.currency, kind: b.kind,
      initialCapital: svc.n(b.initialCapital), unitValue: svc.n(b.unitValue),
      commissionPct: b.commissionPct == null ? null : svc.n(b.commissionPct),
      isDefault: b.isDefault, isActive: b.isActive,
      visibility: b.visibility, showCurrency: b.showCurrency, isPublic: b.isPublic,
      currentBalance: svc.computeBankrollBalance(b, bets, txs),
      createdAt: b.createdAt, updatedAt: b.updatedAt,
    }));
    return reply.send(createResponse(1, 'Bancas carregadas.', data));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar bancas.', { error: (error as Error).message }));
  }
};

/**
 * Garante (e retorna) a banca dedicada de value bet do usuário, com o saldo
 * atual calculado. Usado pela tela de Value Bets ao lançar uma aposta de valor.
 */
export const ensureValuebetBankrollHandler = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  try {
    const bankroll = await ensureValuebetBankroll(userId);
    const bets = await betRepo().find({ where: { userId } });
    const txs = await txRepo().find({ where: { userId } });
    const data = {
      id: bankroll.id, name: bankroll.name, currency: bankroll.currency, kind: bankroll.kind,
      initialCapital: svc.n(bankroll.initialCapital), unitValue: svc.n(bankroll.unitValue),
      commissionPct: bankroll.commissionPct == null ? null : svc.n(bankroll.commissionPct),
      isDefault: bankroll.isDefault, isActive: bankroll.isActive,
      visibility: bankroll.visibility, showCurrency: bankroll.showCurrency, isPublic: bankroll.isPublic,
      currentBalance: svc.computeBankrollBalance(bankroll, bets, txs),
      createdAt: bankroll.createdAt, updatedAt: bankroll.updatedAt,
    };
    return reply.send(createResponse(1, 'Banca de value bet pronta.', data));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao preparar a banca de value bet.', { error: (error as Error).message }));
  }
};

export const createBankroll = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const b = (req.body || {}) as { name?: string; initialCapital?: number; currency?: string; unitValue?: number; commissionPct?: number };
  if (!b.name || !b.name.trim()) return reply.code(400).send(createResponse(0, "O campo 'name' é obrigatório.", []));

  try {
    const count = await bankrollRepo().count({ where: { userId } });
    // Múltiplas bancas é recurso premium (1 banca é grátis).
    if (count >= 1) {
      const access = await resolveUserAccess(userId);
      if (!access.hasActivePlan) {
        return reply.code(403).send(createResponse(0, 'Ter mais de uma banca é um recurso para assinantes. Assine um plano para criar bancas adicionais.', { premium: true }));
      }
    }
    const created = bankrollRepo().create({
      userId, name: b.name.trim().slice(0, 120),
      currency: (b.currency || 'BRL').slice(0, 8),
      initialCapital: String(svc.n(b.initialCapital)),
      unitValue: String(svc.n(b.unitValue)),
      commissionPct: b.commissionPct != null ? String(svc.n(b.commissionPct)) : null,
      isDefault: count === 0, isActive: true,
    });
    const saved = await bankrollRepo().save(created);
    return reply.code(201).send(createResponse(1, 'Banca criada.', saved));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao criar banca.', { error: (error as Error).message }));
  }
};

export const updateBankroll = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { id } = req.params as { id: string };
  const b = (req.body || {}) as Partial<{ name: string; initialCapital: number; currency: string; unitValue: number; commissionPct: number; isDefault: boolean; isActive: boolean }>;
  try {
    const bankroll = await bankrollRepo().findOneBy({ id, userId });
    if (!bankroll) return reply.code(404).send(createResponse(0, 'Banca não encontrada.', []));
    if (b.name !== undefined) bankroll.name = String(b.name).trim().slice(0, 120) || bankroll.name;
    if (b.currency !== undefined) bankroll.currency = String(b.currency).slice(0, 8);
    if (b.initialCapital !== undefined) bankroll.initialCapital = String(svc.n(b.initialCapital));
    if (b.unitValue !== undefined) bankroll.unitValue = String(svc.n(b.unitValue));
    if (b.commissionPct !== undefined) bankroll.commissionPct = b.commissionPct == null ? null : String(svc.n(b.commissionPct));
    if (b.isActive !== undefined) bankroll.isActive = !!b.isActive;
    if (b.isDefault === true) {
      await bankrollRepo().update({ userId }, { isDefault: false });
      bankroll.isDefault = true;
    }
    const saved = await bankrollRepo().save(bankroll);
    return reply.send(createResponse(1, 'Banca atualizada.', saved));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao atualizar banca.', { error: (error as Error).message }));
  }
};

export const deleteBankroll = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { id } = req.params as { id: string };
  try {
    const bankroll = await bankrollRepo().findOneBy({ id, userId });
    if (!bankroll) return reply.code(404).send(createResponse(0, 'Banca não encontrada.', []));
    const count = await bankrollRepo().count({ where: { userId } });
    if (count <= 1) return reply.code(400).send(createResponse(0, 'Você precisa ter pelo menos uma banca.', []));
    await bankrollRepo().remove(bankroll);
    if (bankroll.isDefault) {
      const next = await bankrollRepo().findOne({ where: { userId }, order: { createdAt: 'ASC' } });
      if (next) { next.isDefault = true; await bankrollRepo().save(next); }
    }
    return reply.send(createResponse(1, 'Banca removida.', { id }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao remover banca.', { error: (error as Error).message }));
  }
};

// ===================== CASAS DO USUÁRIO =====================

export const listAccounts = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  try {
    const accounts = await accountRepo().find({ where: { userId }, order: { createdAt: 'ASC' } });
    const bets = await betRepo().find({ where: { userId } });
    const legs = bets.flatMap((b) => b.legs || []);
    const txs = await txRepo().find({ where: { userId } });
    const partners = await partnerRepo().find({ where: { userId } });
    const bankrolls = await bankrollRepo().find({ where: { userId } });
    const partnerName = new Map(partners.map((p) => [p.id, p.name]));
    const bankrollName = new Map(bankrolls.map((b) => [b.id, b.name]));
    const data = accounts.map((a) => ({
      id: a.id, slug: a.slug, label: a.label,
      isCustom: a.isCustom, customName: a.customName, customLogoUrl: a.customLogoUrl, customColor: a.customColor,
      partnerId: a.partnerId, partnerName: a.partnerId ? (partnerName.get(a.partnerId) || null) : null,
      bankrollId: a.bankrollId, bankrollName: a.bankrollId ? (bankrollName.get(a.bankrollId) || null) : null,
      initialBalance: svc.n(a.initialBalance), username: a.username, scope: a.scope,
      limited: a.limited, isActive: a.isActive, notes: a.notes,
      balance: svc.computeAccountBalance(a, legs, txs),
      createdAt: a.createdAt, updatedAt: a.updatedAt,
    }));
    return reply.send(createResponse(1, 'Casas carregadas.', data));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar casas.', { error: (error as Error).message }));
  }
};

interface AccountBody {
  slug?: string; label?: string; initialBalance?: number; username?: string; scope?: string; notes?: string;
  isCustom?: boolean; customName?: string; customLogoUrl?: string; customColor?: string;
  partnerId?: string | null; bankrollId?: string | null;
}

// slug estável a partir de um nome (casa personalizada). Prefixo 'custom-' evita
// colidir com o catálogo global e deixa claro que o display vem da própria conta.
const slugifyCustom = (name: string): string => {
  const base = (name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `custom-${base || 'casa'}`.slice(0, 80);
};

export const createAccount = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const b = (req.body || {}) as AccountBody;
  const isCustom = !!b.isCustom;

  let slug = (b.slug || '').trim().toLowerCase();
  if (isCustom && !slug) slug = slugifyCustom(b.customName || b.label || '');
  if (!slug) return reply.code(400).send(createResponse(0, isCustom ? 'Informe o nome da casa.' : "Selecione a casa.", []));
  if (isCustom && !b.customName) return reply.code(400).send(createResponse(0, 'Informe o nome da casa personalizada.', []));

  try {
    // ownership de parceiro/banca vinculados
    if (b.partnerId) {
      const p = await partnerRepo().findOneBy({ id: b.partnerId, userId });
      if (!p) return reply.code(404).send(createResponse(0, 'Parceiro não encontrado.', []));
    }
    if (b.bankrollId) {
      const bk = await bankrollRepo().findOneBy({ id: b.bankrollId, userId });
      if (!bk) return reply.code(404).send(createResponse(0, 'Banca não encontrada.', []));
    }
    // 1 conta por (casa, parceiro): permite a mesma casa para vários parceiros.
    const exists = await accountRepo().findOneBy({ userId, slug, partnerId: b.partnerId || IsNull() });
    if (exists) return reply.code(409).send(createResponse(0, 'Você já cadastrou esta casa para este parceiro.', { id: exists.id }));
    const created = accountRepo().create({
      userId, slug: slug.slice(0, 80),
      partnerId: b.partnerId || null,
      bankrollId: b.bankrollId || null,
      isCustom,
      customName: isCustom && b.customName ? String(b.customName).slice(0, 120) : null,
      customLogoUrl: isCustom && b.customLogoUrl ? String(b.customLogoUrl).slice(0, 65000) : null,
      customColor: isCustom && b.customColor ? String(b.customColor).slice(0, 32) : null,
      label: b.label ? String(b.label).slice(0, 120) : null,
      initialBalance: String(svc.n(b.initialBalance)),
      username: b.username ? String(b.username).slice(0, 120) : null,
      scope: b.scope ? String(b.scope).slice(0, 40) : null,
      notes: b.notes ? String(b.notes).slice(0, 1000) : null,
      limited: false, isActive: true,
    });
    const saved = await accountRepo().save(created);
    return reply.code(201).send(createResponse(1, 'Casa cadastrada.', saved));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao cadastrar casa.', { error: (error as Error).message }));
  }
};

export const updateAccount = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { id } = req.params as { id: string };
  const b = (req.body || {}) as Partial<{ label: string; initialBalance: number; username: string; scope: string; notes: string; limited: boolean; isActive: boolean; customName: string; customLogoUrl: string; customColor: string; partnerId: string | null; bankrollId: string | null }>;
  try {
    const acc = await accountRepo().findOneBy({ id, userId });
    if (!acc) return reply.code(404).send(createResponse(0, 'Casa não encontrada.', []));
    if (b.partnerId !== undefined) {
      if (b.partnerId) {
        const p = await partnerRepo().findOneBy({ id: b.partnerId, userId });
        if (!p) return reply.code(404).send(createResponse(0, 'Parceiro não encontrado.', []));
      }
      acc.partnerId = b.partnerId || null;
    }
    if (b.bankrollId !== undefined) {
      if (b.bankrollId) {
        const bk = await bankrollRepo().findOneBy({ id: b.bankrollId, userId });
        if (!bk) return reply.code(404).send(createResponse(0, 'Banca não encontrada.', []));
      }
      acc.bankrollId = b.bankrollId || null;
    }
    if (b.label !== undefined) acc.label = b.label ? String(b.label).slice(0, 120) : null;
    if (b.initialBalance !== undefined) acc.initialBalance = String(svc.n(b.initialBalance));
    if (b.username !== undefined) acc.username = b.username ? String(b.username).slice(0, 120) : null;
    if (b.scope !== undefined) acc.scope = b.scope ? String(b.scope).slice(0, 40) : null;
    if (b.notes !== undefined) acc.notes = b.notes ? String(b.notes).slice(0, 1000) : null;
    if (b.limited !== undefined) acc.limited = !!b.limited;
    if (b.isActive !== undefined) acc.isActive = !!b.isActive;
    // Casa personalizada: nome/logo/cor editáveis.
    if (acc.isCustom) {
      if (b.customName !== undefined) acc.customName = b.customName ? String(b.customName).slice(0, 120) : acc.customName;
      if (b.customLogoUrl !== undefined) acc.customLogoUrl = b.customLogoUrl ? String(b.customLogoUrl).slice(0, 65000) : null;
      if (b.customColor !== undefined) acc.customColor = b.customColor ? String(b.customColor).slice(0, 32) : null;
    }
    const saved = await accountRepo().save(acc);
    return reply.send(createResponse(1, 'Casa atualizada.', saved));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao atualizar casa.', { error: (error as Error).message }));
  }
};

export const deleteAccount = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { id } = req.params as { id: string };
  try {
    const acc = await accountRepo().findOneBy({ id, userId });
    if (!acc) return reply.code(404).send(createResponse(0, 'Casa não encontrada.', []));
    await accountRepo().remove(acc);
    return reply.send(createResponse(1, 'Casa removida.', { id }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao remover casa.', { error: (error as Error).message }));
  }
};

// ===================== APOSTAS =====================

interface CreateLegBody {
  bookmakerSlug?: string; accountId?: string; houseEventId?: string;
  market?: string; rawMarket?: string; selection?: string; handicap?: string | number | null;
  side?: string; odd?: number; stake?: number; commissionPct?: number; closingOdd?: number; isFreebet?: boolean;
}
interface CreateBetBody {
  bankrollId?: string; betType?: string;
  eventId?: string; home?: string; away?: string; sport?: string; league?: string;
  eventStart?: string; surebetKey?: string;
  totalStake?: number; expectedProfitPct?: number; expectedProfit?: number;
  source?: string; tags?: string[]; notes?: string; legs?: CreateLegBody[];
}

export const createBet = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const b = (req.body || {}) as CreateBetBody;

  if (!Array.isArray(b.legs) || b.legs.length === 0) {
    return reply.code(400).send(createResponse(0, 'Informe ao menos uma perna (leg).', []));
  }
  for (const l of b.legs) {
    if (!l.bookmakerSlug || !String(l.bookmakerSlug).trim()) return reply.code(400).send(createResponse(0, 'Cada perna precisa de uma casa (bookmakerSlug).', []));
    if (!(svc.n(l.odd) > 0)) return reply.code(400).send(createResponse(0, 'Cada perna precisa de uma odd válida (> 0).', []));
    if (!(svc.n(l.stake) >= 0)) return reply.code(400).send(createResponse(0, 'Cada perna precisa de um stake válido.', []));
  }

  try {
    let bankrollId = b.bankrollId;
    if (bankrollId) {
      const owned = await bankrollRepo().findOneBy({ id: bankrollId, userId });
      if (!owned) return reply.code(404).send(createResponse(0, 'Banca não encontrada.', []));
    } else {
      bankrollId = (await ensureDefaultBankroll(userId)).id;
    }

    const betType = b.betType === BetType.SINGLE || b.legs.length === 1 ? BetType.SINGLE : BetType.ARB;
    const totalStake = svc.n(b.totalStake) || b.legs.reduce((a, l) => a + svc.n(l.stake), 0);

    const legs: BetLeg[] = b.legs.map((l) => legRepo().create({
      bookmakerSlug: String(l.bookmakerSlug).trim().toLowerCase().slice(0, 80),
      accountId: l.accountId || null,
      houseEventId: l.houseEventId ? String(l.houseEventId).slice(0, 120) : null,
      market: l.market ? String(l.market).slice(0, 120) : null,
      rawMarket: l.rawMarket ? String(l.rawMarket).slice(0, 160) : null,
      selection: l.selection ? String(l.selection).slice(0, 160) : null,
      handicap: l.handicap != null && l.handicap !== '' ? String(l.handicap).slice(0, 40) : null,
      side: l.side === BetSide.LAY ? BetSide.LAY : BetSide.BACK,
      isFreebet: !!l.isFreebet,
      odd: String(svc.n(l.odd)),
      stake: String(svc.n(l.stake)),
      commissionPct: l.commissionPct != null ? String(svc.n(l.commissionPct)) : null,
      closingOdd: l.closingOdd != null ? String(svc.n(l.closingOdd)) : null,
      status: LegStatus.PENDING,
    }));

    const bet = betRepo().create({
      userId, bankrollId, betType, status: BetStatus.OPEN,
      eventId: b.eventId ? String(b.eventId).slice(0, 120) : null,
      home: b.home ? String(b.home).slice(0, 160) : null,
      away: b.away ? String(b.away).slice(0, 160) : null,
      sport: b.sport ? String(b.sport).slice(0, 60) : null,
      league: b.league ? String(b.league).slice(0, 120) : null,
      eventStart: parseDate(b.eventStart) || null,
      surebetKey: b.surebetKey ? String(b.surebetKey).slice(0, 220) : null,
      totalStake: String(svc.n(totalStake)),
      expectedProfitPct: b.expectedProfitPct != null ? String(svc.n(b.expectedProfitPct)) : null,
      expectedProfit: b.expectedProfit != null ? String(svc.n(b.expectedProfit)) : null,
      tags: Array.isArray(b.tags) ? b.tags.map((t) => String(t).slice(0, 40)).slice(0, 20) : null,
      notes: b.notes ? String(b.notes).slice(0, 2000) : null,
      source: b.source === 'manual' ? 'manual' : 'calculator',
      // Veio da calculadora = odds existiam no feed → verificável. Manual = não.
      verified: b.source === 'manual' ? 'unverified' : 'verified',
      hidden: false,
      legs,
    });
    const saved = await betRepo().save(bet);
    const full = await betRepo().findOneBy({ id: saved.id });
    return reply.code(201).send(createResponse(1, 'Aposta lançada.', full ? svc.serializeBet(full) : null));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao lançar aposta.', { error: (error as Error).message }));
  }
};

export const listBets = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const q = (req.query || {}) as { status?: string; bookmaker?: string; sport?: string; betType?: string; bankrollId?: string; from?: string; to?: string; page?: string; limit?: string };
  const page = Math.max(1, parseInt(q.page || '1') || 1);
  const limit = Math.min(200, Math.max(1, parseInt(q.limit || '30') || 30));
  const from = parseDate(q.from);
  const to = parseDate(q.to);

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { userId };
    if (q.status) where.status = q.status;
    if (q.sport) where.sport = q.sport;
    if (q.betType) where.betType = q.betType;
    if (q.bankrollId) where.bankrollId = q.bankrollId;
    if (from && to) where.createdAt = Between(from, to);
    else if (from) where.createdAt = MoreThanOrEqual(from);
    else if (to) where.createdAt = LessThanOrEqual(to);

    let bets = await betRepo().find({ where, order: { createdAt: 'DESC' }, take: 2000 });
    if (q.bookmaker) {
      const bk = q.bookmaker.toLowerCase();
      bets = bets.filter((bet) => (bet.legs || []).some((l) => (l.bookmakerSlug || '').toLowerCase() === bk));
    }
    const total = bets.length;
    const items = bets.slice((page - 1) * limit, page * limit).map(svc.serializeBet);
    return reply.send(createResponse(1, 'Apostas carregadas.', { items, total, page, limit, totalPages: Math.ceil(total / limit) }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar apostas.', { error: (error as Error).message }));
  }
};

export const getBet = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { id } = req.params as { id: string };
  try {
    const bet = await betRepo().findOneBy({ id, userId });
    if (!bet) return reply.code(404).send(createResponse(0, 'Aposta não encontrada.', []));
    return reply.send(createResponse(1, 'Aposta carregada.', svc.serializeBet(bet)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar aposta.', { error: (error as Error).message }));
  }
};

export const updateBet = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { id } = req.params as { id: string };
  const b = (req.body || {}) as Partial<{ tags: string[]; notes: string; hidden: boolean; home: string; away: string; sport: string; league: string }>;
  try {
    const bet = await betRepo().findOneBy({ id, userId });
    if (!bet) return reply.code(404).send(createResponse(0, 'Aposta não encontrada.', []));
    if (b.tags !== undefined) bet.tags = Array.isArray(b.tags) ? b.tags.map((t) => String(t).slice(0, 40)).slice(0, 20) : null;
    if (b.notes !== undefined) bet.notes = b.notes ? String(b.notes).slice(0, 2000) : null;
    if (b.hidden !== undefined) bet.hidden = !!b.hidden;
    if (b.home !== undefined) bet.home = b.home ? String(b.home).slice(0, 160) : null;
    if (b.away !== undefined) bet.away = b.away ? String(b.away).slice(0, 160) : null;
    if (b.sport !== undefined) bet.sport = b.sport ? String(b.sport).slice(0, 60) : null;
    if (b.league !== undefined) bet.league = b.league ? String(b.league).slice(0, 120) : null;
    const saved = await betRepo().save(bet);
    return reply.send(createResponse(1, 'Aposta atualizada.', svc.serializeBet(saved)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao atualizar aposta.', { error: (error as Error).message }));
  }
};

interface SettleLegBody { legId: string; status: string; settledReturn?: number; legProfit?: number }

export const settleBet = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { id } = req.params as { id: string };
  const b = (req.body || {}) as { legs?: SettleLegBody[] };
  if (!Array.isArray(b.legs) || b.legs.length === 0) return reply.code(400).send(createResponse(0, 'Informe as pernas a liquidar.', []));

  try {
    const bet = await betRepo().findOneBy({ id, userId });
    if (!bet) return reply.code(404).send(createResponse(0, 'Aposta não encontrada.', []));

    const now = new Date();
    const byId = new Map((bet.legs || []).map((l) => [l.id, l]));
    for (const upd of b.legs) {
      const leg = byId.get(upd.legId);
      if (!leg) continue;
      if (!LEG_STATUSES.includes(upd.status as LegStatus)) continue;
      leg.status = upd.status as LegStatus;
      leg.settledReturn = upd.settledReturn != null ? String(svc.n(upd.settledReturn)) : leg.settledReturn;
      if (upd.legProfit != null) {
        leg.legProfit = String(svc.n(upd.legProfit));
      } else if (leg.status === LegStatus.PENDING) {
        leg.legProfit = null;
      } else {
        leg.legProfit = String(svc.legPnl(leg));
      }
      leg.settledAt = leg.status === LegStatus.PENDING ? null : now;
    }

    const legs = Array.from(byId.values());
    bet.legs = legs;
    bet.status = svc.deriveBetStatus(legs);
    const realized = svc.betRealizedProfit(legs);
    bet.realizedProfit = legs.some((l) => svc.isResolvedLeg(l.status)) ? String(realized) : null;
    const fullySettled = bet.status === BetStatus.SETTLED || bet.status === BetStatus.VOID;
    bet.settledAt = fullySettled ? now : null;
    // Congela o track record ao liquidar (imutabilidade p/ a Comunidade).
    bet.lockedAt = fullySettled ? (bet.lockedAt || now) : null;

    await legRepo().save(legs);
    const saved = await betRepo().save(bet);
    const full = await betRepo().findOneBy({ id: saved.id });
    return reply.send(createResponse(1, 'Aposta liquidada.', full ? svc.serializeBet(full) : null));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao liquidar aposta.', { error: (error as Error).message }));
  }
};

export const deleteBet = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { id } = req.params as { id: string };
  try {
    const bet = await betRepo().findOneBy({ id, userId });
    if (!bet) return reply.code(404).send(createResponse(0, 'Aposta não encontrada.', []));
    await betRepo().remove(bet);
    return reply.send(createResponse(1, 'Aposta removida.', { id }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao remover aposta.', { error: (error as Error).message }));
  }
};

// ===================== TRANSAÇÕES =====================

export const listAnalytixTransactions = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const q = (req.query || {}) as { bankrollId?: string; accountId?: string; type?: string; from?: string; to?: string };
  const from = parseDate(q.from);
  const to = parseDate(q.to);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { userId };
    if (q.bankrollId) where.bankrollId = q.bankrollId;
    if (q.accountId) where.accountId = q.accountId;
    if (q.type) where.type = q.type;
    if (from && to) where.createdAt = Between(from, to);
    else if (from) where.createdAt = MoreThanOrEqual(from);
    else if (to) where.createdAt = LessThanOrEqual(to);
    const rows = await txRepo().find({ where, order: { createdAt: 'DESC' }, take: 1000 });
    const data = rows.map((t) => ({
      id: t.id, bankrollId: t.bankrollId, accountId: t.accountId, partnerId: t.partnerId, type: t.type,
      amount: svc.n(t.amount), betId: t.betId, description: t.description, createdAt: t.createdAt,
    }));
    return reply.send(createResponse(1, 'Transações carregadas.', data));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar transações.', { error: (error as Error).message }));
  }
};

export const createAnalytixTransaction = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const b = (req.body || {}) as { bankrollId?: string; type?: string; amount?: number; accountId?: string; partnerId?: string; description?: string };
  if (!b.bankrollId) return reply.code(400).send(createResponse(0, "O campo 'bankrollId' é obrigatório.", []));
  if (!b.type || !Object.values(TxType).includes(b.type as TxType)) return reply.code(400).send(createResponse(0, 'Tipo de transação inválido.', []));
  const raw = svc.n(b.amount);
  if (!raw || raw === 0) return reply.code(400).send(createResponse(0, 'Informe um valor válido.', []));

  try {
    const bankroll = await bankrollRepo().findOneBy({ id: b.bankrollId, userId });
    if (!bankroll) return reply.code(404).send(createResponse(0, 'Banca não encontrada.', []));
    if (b.accountId) {
      const acc = await accountRepo().findOneBy({ id: b.accountId, userId });
      if (!acc) return reply.code(404).send(createResponse(0, 'Casa não encontrada.', []));
    }
    if (b.partnerId) {
      const p = await partnerRepo().findOneBy({ id: b.partnerId, userId });
      if (!p) return reply.code(404).send(createResponse(0, 'Parceiro não encontrado.', []));
    }
    // Sinal pelo tipo: depósito/bônus (+), saque/repasse (-), ajuste (mantém).
    let amount = Math.abs(raw);
    if (b.type === TxType.WITHDRAWAL || b.type === TxType.PARTNER_PAYOUT) amount = -amount;
    else if (b.type === TxType.ADJUSTMENT) amount = raw;

    const tx = txRepo().create({
      userId, bankrollId: b.bankrollId, accountId: b.accountId || null, partnerId: b.partnerId || null,
      type: b.type as TxType, amount: String(amount),
      description: b.description ? String(b.description).slice(0, 200) : null,
    });
    const saved = await txRepo().save(tx);
    return reply.code(201).send(createResponse(1, 'Transação registrada.', { ...saved, amount: svc.n(saved.amount) }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao registrar transação.', { error: (error as Error).message }));
  }
};

export const deleteAnalytixTransaction = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { id } = req.params as { id: string };
  try {
    const tx = await txRepo().findOneBy({ id, userId });
    if (!tx) return reply.code(404).send(createResponse(0, 'Transação não encontrada.', []));
    await txRepo().remove(tx);
    return reply.send(createResponse(1, 'Transação removida.', { id }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao remover transação.', { error: (error as Error).message }));
  }
};

// ===================== PARCEIROS =====================

const VALID_COST_MODELS = ['rent', 'profit_share', 'hybrid'];

const serializePartner = (p: Partner) => ({
  id: p.id, name: p.name, cpf: p.cpf, phone: p.phone, email: p.email, pixKey: p.pixKey,
  costModel: p.costModel, rentAmount: p.rentAmount == null ? null : svc.n(p.rentAmount), rentPeriod: p.rentPeriod,
  profitSharePct: p.profitSharePct == null ? null : svc.n(p.profitSharePct),
  notes: p.notes, isActive: p.isActive, createdAt: p.createdAt, updatedAt: p.updatedAt,
});

interface PartnerBody {
  name?: string; cpf?: string; phone?: string; email?: string; pixKey?: string;
  costModel?: string; rentAmount?: number; rentPeriod?: string; profitSharePct?: number;
  notes?: string; isActive?: boolean;
}

export const listPartners = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  try {
    const partners = await partnerRepo().find({ where: { userId }, order: { createdAt: 'ASC' } });
    const accounts = await accountRepo().find({ where: { userId } });
    const bets = await betRepo().find({ where: { userId } });
    const txs = await txRepo().find({ where: { userId } });
    const data = partners.map((p) => ({ ...serializePartner(p), report: svc.computePartnerReport(p, accounts, bets, txs) }));
    return reply.send(createResponse(1, 'Parceiros carregados.', data));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar parceiros.', { error: (error as Error).message }));
  }
};

export const createPartner = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const b = (req.body || {}) as PartnerBody;
  if (!b.name || !b.name.trim()) return reply.code(400).send(createResponse(0, 'Informe o nome do parceiro.', []));
  const costModel = VALID_COST_MODELS.includes(b.costModel || '') ? (b.costModel as Partner['costModel']) : 'profit_share';
  try {
    const created = partnerRepo().create({
      userId, name: b.name.trim().slice(0, 160),
      cpf: b.cpf ? String(b.cpf).slice(0, 20) : null,
      phone: b.phone ? String(b.phone).slice(0, 40) : null,
      email: b.email ? String(b.email).slice(0, 160) : null,
      pixKey: b.pixKey ? String(b.pixKey).slice(0, 140) : null,
      costModel,
      rentAmount: b.rentAmount != null ? String(svc.n(b.rentAmount)) : null,
      rentPeriod: b.rentPeriod === 'week' ? 'week' : 'month',
      profitSharePct: b.profitSharePct != null ? String(svc.n(b.profitSharePct)) : null,
      notes: b.notes ? String(b.notes).slice(0, 2000) : null,
      isActive: true,
    });
    const saved = await partnerRepo().save(created);
    return reply.code(201).send(createResponse(1, 'Parceiro cadastrado.', serializePartner(saved)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao cadastrar parceiro.', { error: (error as Error).message }));
  }
};

export const updatePartner = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { id } = req.params as { id: string };
  const b = (req.body || {}) as PartnerBody;
  try {
    const p = await partnerRepo().findOneBy({ id, userId });
    if (!p) return reply.code(404).send(createResponse(0, 'Parceiro não encontrado.', []));
    if (b.name !== undefined) p.name = String(b.name).trim().slice(0, 160) || p.name;
    if (b.cpf !== undefined) p.cpf = b.cpf ? String(b.cpf).slice(0, 20) : null;
    if (b.phone !== undefined) p.phone = b.phone ? String(b.phone).slice(0, 40) : null;
    if (b.email !== undefined) p.email = b.email ? String(b.email).slice(0, 160) : null;
    if (b.pixKey !== undefined) p.pixKey = b.pixKey ? String(b.pixKey).slice(0, 140) : null;
    if (b.costModel !== undefined && VALID_COST_MODELS.includes(b.costModel)) p.costModel = b.costModel as Partner['costModel'];
    if (b.rentAmount !== undefined) p.rentAmount = b.rentAmount == null ? null : String(svc.n(b.rentAmount));
    if (b.rentPeriod !== undefined) p.rentPeriod = b.rentPeriod === 'week' ? 'week' : 'month';
    if (b.profitSharePct !== undefined) p.profitSharePct = b.profitSharePct == null ? null : String(svc.n(b.profitSharePct));
    if (b.notes !== undefined) p.notes = b.notes ? String(b.notes).slice(0, 2000) : null;
    if (b.isActive !== undefined) p.isActive = !!b.isActive;
    const saved = await partnerRepo().save(p);
    return reply.send(createResponse(1, 'Parceiro atualizado.', serializePartner(saved)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao atualizar parceiro.', { error: (error as Error).message }));
  }
};

export const deletePartner = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { id } = req.params as { id: string };
  try {
    const p = await partnerRepo().findOneBy({ id, userId });
    if (!p) return reply.code(404).send(createResponse(0, 'Parceiro não encontrado.', []));
    // Desvincula as contas do parceiro (viram contas sem dono) antes de remover.
    await accountRepo().update({ userId, partnerId: id }, { partnerId: null });
    await partnerRepo().remove(p);
    return reply.send(createResponse(1, 'Parceiro removido.', { id }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao remover parceiro.', { error: (error as Error).message }));
  }
};

// ===================== ANALYTICS =====================

const loadScope = async (userId: string, bankrollId?: string) => {
  const bankrolls = bankrollId
    ? await bankrollRepo().find({ where: { id: bankrollId, userId } })
    : await bankrollRepo().find({ where: { userId } });
  const ids = bankrolls.map((b) => b.id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const betWhere: any = { userId };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txWhere: any = { userId };
  if (bankrollId) { betWhere.bankrollId = In(ids.length ? ids : ['__none__']); txWhere.bankrollId = In(ids.length ? ids : ['__none__']); }
  const bets = await betRepo().find({ where: betWhere, take: 5000 });
  const txs = await txRepo().find({ where: txWhere, take: 5000 });
  return { bankrolls, bets, txs };
};

export const getSummary = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const q = (req.query || {}) as { bankrollId?: string; from?: string; to?: string };
  try {
    await ensureDefaultBankroll(userId);
    const { bankrolls, bets, txs } = await loadScope(userId, q.bankrollId);
    const summary = svc.computeSummary(bets, txs, bankrolls, { from: parseDate(q.from), to: parseDate(q.to) });
    return reply.send(createResponse(1, 'Resumo carregado.', summary));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar resumo.', { error: (error as Error).message }));
  }
};

export const getTimeseries = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const q = (req.query || {}) as { bankrollId?: string; from?: string; to?: string; bucket?: string };
  const bucket = (['day', 'week', 'month'].includes(q.bucket || '') ? q.bucket : 'day') as svc.Bucket;
  try {
    const { bankrolls, bets, txs } = await loadScope(userId, q.bankrollId);
    const series = svc.computeTimeseries(bets, txs, bankrolls, bucket, { from: parseDate(q.from), to: parseDate(q.to) });
    return reply.send(createResponse(1, 'Série carregada.', series));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar série.', { error: (error as Error).message }));
  }
};

export const getBreakdown = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const q = (req.query || {}) as { by?: string; bankrollId?: string; from?: string; to?: string };
  const by = (['bookmaker', 'sport', 'league', 'market', 'month'].includes(q.by || '') ? q.by : 'bookmaker') as svc.BreakdownDim;
  const from = parseDate(q.from);
  const to = parseDate(q.to);
  try {
    const { bets } = await loadScope(userId, q.bankrollId);
    const ranged = (from || to) ? bets.filter((b) => {
      if (from && b.createdAt < from) return false;
      if (to && b.createdAt > to) return false;
      return true;
    }) : bets;
    const rows = svc.computeBreakdown(ranged, by);
    return reply.send(createResponse(1, 'Recorte carregado.', rows));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar recorte.', { error: (error as Error).message }));
  }
};
