import { FastifyRequest, FastifyReply } from 'fastify';
import { In } from 'typeorm';
import { AppDataSource } from '@Database';
import { CommunityProfile, CommunityConsent, Bankroll, Bet, BankrollTransaction, User, Follow, Notification } from '@Entities';
import { createResponse } from '@utils';
import * as community from '@Services/community.service';
import * as analytix from '@Services/analytix.service';

/**
 * Comunidade — Fase 1: perfil público, publicar banca (opt-in) e track record
 * verificável. Leitura é PÚBLICA (sem auth); publicar/editar exige login.
 */

const profileRepo = () => AppDataSource.getRepository(CommunityProfile);
const consentRepo = () => AppDataSource.getRepository(CommunityConsent);
const bankrollRepo = () => AppDataSource.getRepository(Bankroll);
const betRepo = () => AppDataSource.getRepository(Bet);
const txRepo = () => AppDataSource.getRepository(BankrollTransaction);
const userRepo = () => AppDataSource.getRepository(User);
const followRepo = () => AppDataSource.getRepository(Follow);
const notifRepo = () => AppDataSource.getRepository(Notification);

const uid = (req: FastifyRequest): string | undefined => req.userData?.userId;

// Carrega o escopo público de um handle (perfil + bancas públicas + apostas públicas + txs).
const loadPublicScope = async (handle: string) => {
  const profile = await profileRepo().findOneBy({ handle: handle.toLowerCase() });
  if (!profile || profile.visibility !== 'public') return null;
  const user = await userRepo().findOneBy({ id: profile.userId });
  const pb = await bankrollRepo().find({ where: { userId: profile.userId, isPublic: true } });
  const pbIds = new Set(pb.map((b) => b.id));
  const allBets = pbIds.size ? await betRepo().find({ where: { userId: profile.userId } }) : [];
  const bankById = new Map(pb.map((b) => [b.id, b]));
  const publicBets = allBets.filter((bt) => pbIds.has(bt.bankrollId) && community.isBetPublic(bt, bankById.get(bt.bankrollId)));
  const allTxs = pbIds.size ? await txRepo().find({ where: { userId: profile.userId } }) : [];
  const txs = allTxs.filter((t) => pbIds.has(t.bankrollId));
  return { profile, user, pb, publicBets, txs };
};

// ===================== PÚBLICO (sem auth) =====================

export const listPublicProfiles = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const profiles = await profileRepo().find({ where: { visibility: 'public' } });
    if (!profiles.length) return reply.send(createResponse(1, 'Comunidade carregada.', []));
    const userIds = profiles.map((p) => p.userId);
    const bankrolls = await bankrollRepo().find({ where: { userId: In(userIds), isPublic: true } });
    const pubUserIds = new Set(bankrolls.map((b) => b.userId));
    const bankByUser = new Map<string, Bankroll[]>();
    for (const b of bankrolls) { (bankByUser.get(b.userId) || bankByUser.set(b.userId, []).get(b.userId)!).push(b); }
    const users = await userRepo().find({ where: { id: In([...pubUserIds].length ? [...pubUserIds] : ['__none__']) } });
    const userById = new Map(users.map((u) => [u.id, u]));
    const bets = pubUserIds.size ? await betRepo().find({ where: { userId: In([...pubUserIds]) } }) : [];

    // Quem o viewer já segue (para o botão Seguir nos cards).
    const viewerId = uid(req);
    const followingSet = new Set<string>();
    if (viewerId) {
      const myFollows = await followRepo().find({ where: { followerId: viewerId } });
      myFollows.forEach((f) => followingSet.add(f.followingId));
    }

    const cards = profiles
      .filter((p) => pubUserIds.has(p.userId))
      .map((p) => {
        const pb = bankByUser.get(p.userId) || [];
        const pbIds = new Set(pb.map((b) => b.id));
        const bankById = new Map(pb.map((b) => [b.id, b]));
        const userBets = bets.filter((bt) => pbIds.has(bt.bankrollId) && community.isBetPublic(bt, bankById.get(bt.bankrollId)));
        return { ...community.serializeProfileCard(p, userById.get(p.userId) || null, pb, userBets), isFollowing: followingSet.has(p.userId), isSelf: p.userId === viewerId };
      })
      .sort((a, b) => b.yield - a.yield);

    return reply.send(createResponse(1, 'Comunidade carregada.', cards));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar comunidade.', { error: (error as Error).message }));
  }
};

export const getPublicProfile = async (req: FastifyRequest, reply: FastifyReply) => {
  const { handle } = req.params as { handle: string };
  try {
    const scope = await loadPublicScope(handle);
    if (!scope) return reply.code(404).send(createResponse(0, 'Perfil não encontrado.', []));
    const data = community.serializePublicProfile(scope.profile, scope.user, scope.pb, scope.publicBets, scope.txs);
    const viewerId = uid(req);
    const isSelf = viewerId === scope.profile.userId;
    const isFollowing = !!viewerId && !isSelf
      ? !!(await followRepo().findOneBy({ followerId: viewerId, followingId: scope.profile.userId }))
      : false;
    return reply.send(createResponse(1, 'Perfil carregado.', { ...data, isSelf, isFollowing }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar perfil.', { error: (error as Error).message }));
  }
};

export const getPublicTrackRecord = async (req: FastifyRequest, reply: FastifyReply) => {
  const { handle } = req.params as { handle: string };
  const q = (req.query || {}) as { page?: string; limit?: string };
  const page = Math.max(1, parseInt(q.page || '1') || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit || '20') || 20));
  try {
    const scope = await loadPublicScope(handle);
    if (!scope) return reply.code(404).send(createResponse(0, 'Perfil não encontrado.', []));
    const unit = community.serializePublicProfile(scope.profile, scope.user, scope.pb, scope.publicBets, scope.txs).unit;
    const showCurrency = scope.pb.some((b) => b.showCurrency);
    const sorted = scope.publicBets.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const total = sorted.length;
    const items = sorted.slice((page - 1) * limit, page * limit).map((bt) => community.serializePublicBet(bt, { unit, showCurrency }));
    return reply.send(createResponse(1, 'Track record carregado.', { items, total, page, limit, totalPages: Math.ceil(total / limit) }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar track record.', { error: (error as Error).message }));
  }
};

export const getPublicCurve = async (req: FastifyRequest, reply: FastifyReply) => {
  const { handle } = req.params as { handle: string };
  const q = (req.query || {}) as { bucket?: string };
  const bucket = (['day', 'week', 'month'].includes(q.bucket || '') ? q.bucket : 'day') as 'day' | 'week' | 'month';
  try {
    const scope = await loadPublicScope(handle);
    if (!scope) return reply.code(404).send(createResponse(0, 'Perfil não encontrado.', []));
    return reply.send(createResponse(1, 'Curva carregada.', community.buildPublicCurve(scope.publicBets, scope.txs, scope.pb, bucket)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar curva.', { error: (error as Error).message }));
  }
};

// ===================== AUTENTICADO =====================

const serializeProfile = (p: CommunityProfile) => ({
  id: p.id, handle: p.handle, displayName: p.displayName, avatar: p.avatar, bio: p.bio,
  visibility: p.visibility, showRealName: p.showRealName, isVerifiedTipster: p.isVerifiedTipster,
  followersCount: p.followersCount, followingCount: p.followingCount,
  createdAt: p.createdAt, updatedAt: p.updatedAt,
});

export const getMyCommunityProfile = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  try {
    const profile = await profileRepo().findOneBy({ userId });
    const consents = await consentRepo().find({ where: { userId }, order: { createdAt: 'DESC' } });
    return reply.send(createResponse(1, 'Perfil carregado.', { profile: profile ? serializeProfile(profile) : null, consents }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar perfil.', { error: (error as Error).message }));
  }
};

export const saveCommunityProfile = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const b = (req.body || {}) as { handle?: string; displayName?: string; avatar?: string; bio?: string; visibility?: string; showRealName?: boolean };
  try {
    let profile = await profileRepo().findOneBy({ userId });
    const handle = community.normalizeHandle(b.handle || (profile?.handle ?? ''));
    if (!profile && !community.isValidHandle(handle)) {
      return reply.code(400).send(createResponse(0, 'Handle inválido. Use 3–32 caracteres: letras minúsculas, números ou _.', []));
    }
    // Handle único.
    if (handle && (!profile || handle !== profile.handle)) {
      if (!community.isValidHandle(handle)) return reply.code(400).send(createResponse(0, 'Handle inválido.', []));
      const taken = await profileRepo().findOneBy({ handle });
      if (taken && taken.userId !== userId) return reply.code(409).send(createResponse(0, 'Esse handle já está em uso.', []));
    }

    const vis = ['private', 'followers', 'public'].includes(b.visibility || '') ? (b.visibility as CommunityProfile['visibility']) : undefined;
    if (!profile) {
      profile = profileRepo().create({
        userId, handle,
        displayName: b.displayName ? String(b.displayName).slice(0, 60) : null,
        avatar: b.avatar ? String(b.avatar).slice(0, 65000) : null,
        bio: b.bio ? String(b.bio).slice(0, 280) : null,
        visibility: vis || 'public',
        showRealName: !!b.showRealName,
      });
    } else {
      if (handle && handle !== profile.handle) { profile.handle = handle; profile.handleChangedAt = new Date(); }
      if (b.displayName !== undefined) profile.displayName = b.displayName ? String(b.displayName).slice(0, 60) : null;
      if (b.avatar !== undefined) profile.avatar = b.avatar ? String(b.avatar).slice(0, 65000) : null;
      if (b.bio !== undefined) profile.bio = b.bio ? String(b.bio).slice(0, 280) : null;
      if (vis) profile.visibility = vis;
      if (b.showRealName !== undefined) profile.showRealName = !!b.showRealName;
    }
    const saved = await profileRepo().save(profile);
    return reply.send(createResponse(1, 'Perfil salvo.', serializeProfile(saved)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao salvar perfil.', { error: (error as Error).message }));
  }
};

export const recordConsent = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const b = (req.body || {}) as { type?: string; granted?: boolean };
  const VALID = ['public_history', 'leaderboard', 'real_name', 'show_currency'];
  if (!b.type || !VALID.includes(b.type)) return reply.code(400).send(createResponse(0, 'Tipo de consentimento inválido.', []));
  try {
    const c = consentRepo().create({ userId, type: b.type, granted: !!b.granted, termsVersion: 'v1' });
    const saved = await consentRepo().save(c);
    return reply.code(201).send(createResponse(1, 'Consentimento registrado.', saved));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao registrar consentimento.', { error: (error as Error).message }));
  }
};

export const setBankrollVisibility = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { id } = req.params as { id: string };
  const b = (req.body || {}) as { visibility?: string; showCurrency?: boolean };
  const vis = ['private', 'followers', 'public'].includes(b.visibility || '') ? (b.visibility as Bankroll['visibility']) : null;
  if (!vis) return reply.code(400).send(createResponse(0, 'Visibilidade inválida.', []));
  try {
    const bankroll = await bankrollRepo().findOneBy({ id, userId });
    if (!bankroll) return reply.code(404).send(createResponse(0, 'Banca não encontrada.', []));
    // Para tornar pública é preciso ter um perfil (handle) na Comunidade.
    if (vis !== 'private') {
      const profile = await profileRepo().findOneBy({ userId });
      if (!profile) return reply.code(400).send(createResponse(0, 'Crie seu perfil da Comunidade antes de tornar uma banca pública.', { needProfile: true }));
    }
    bankroll.visibility = vis;
    bankroll.isPublic = vis === 'public';
    if (b.showCurrency !== undefined) bankroll.showCurrency = !!b.showCurrency;
    const saved = await bankrollRepo().save(bankroll);
    return reply.send(createResponse(1, 'Visibilidade atualizada.', { id: saved.id, visibility: saved.visibility, showCurrency: saved.showCurrency, isPublic: saved.isPublic }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao atualizar visibilidade.', { error: (error as Error).message }));
  }
};

export const setBetVisibility = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { id } = req.params as { id: string };
  const b = (req.body || {}) as { visibility?: string };
  const vis = ['inherit', 'private', 'followers', 'public'].includes(b.visibility || '') ? (b.visibility as Bet['visibility']) : null;
  if (!vis) return reply.code(400).send(createResponse(0, 'Visibilidade inválida.', []));
  try {
    const bet = await betRepo().findOneBy({ id, userId });
    if (!bet) return reply.code(404).send(createResponse(0, 'Aposta não encontrada.', []));
    bet.visibility = vis;
    await betRepo().save(bet);
    return reply.send(createResponse(1, 'Visibilidade da aposta atualizada.', { id, visibility: vis }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao atualizar visibilidade.', { error: (error as Error).message }));
  }
};

// ===================== SEGUIR =====================

export const followUser = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { handle } = req.params as { handle: string };
  try {
    const target = await profileRepo().findOneBy({ handle: handle.toLowerCase() });
    if (!target) return reply.code(404).send(createResponse(0, 'Perfil não encontrado.', []));
    if (target.userId === userId) return reply.code(400).send(createResponse(0, 'Você não pode seguir a si mesmo.', []));

    const existing = await followRepo().findOneBy({ followerId: userId, followingId: target.userId });
    if (!existing) {
      await followRepo().save(followRepo().create({ followerId: userId, followingId: target.userId, status: 'active' }));
      await profileRepo().increment({ userId: target.userId }, 'followersCount', 1);
      await profileRepo().increment({ userId }, 'followingCount', 1);
      const me = await profileRepo().findOneBy({ userId });
      const meUser = me ? null : await userRepo().findOneBy({ id: userId });
      const actorName = me?.displayName || me?.handle || meUser?.fullname || 'Alguém';
      await notifRepo().save(notifRepo().create({
        userId: target.userId, kind: 'new_follower', actorUserId: userId,
        actorHandle: me?.handle || null, actorName: me?.displayName || me?.handle || meUser?.fullname || null,
        actorAvatar: me?.avatar || meUser?.profile || null,
        targetId: me?.handle || null, title: `${actorName} começou a te seguir`,
      }));
    }
    return reply.send(createResponse(1, 'Seguindo.', { following: true }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao seguir.', { error: (error as Error).message }));
  }
};

export const unfollowUser = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { handle } = req.params as { handle: string };
  try {
    const target = await profileRepo().findOneBy({ handle: handle.toLowerCase() });
    if (!target) return reply.code(404).send(createResponse(0, 'Perfil não encontrado.', []));
    const existing = await followRepo().findOneBy({ followerId: userId, followingId: target.userId });
    if (existing) {
      await followRepo().remove(existing);
      if (target.followersCount > 0) await profileRepo().decrement({ userId: target.userId }, 'followersCount', 1);
      const me = await profileRepo().findOneBy({ userId });
      if (me && me.followingCount > 0) await profileRepo().decrement({ userId }, 'followingCount', 1);
    }
    return reply.send(createResponse(1, 'Deixou de seguir.', { following: false }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao deixar de seguir.', { error: (error as Error).message }));
  }
};

// ===================== FEED (Seguindo) =====================

export const getFeed = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const q = (req.query || {}) as { page?: string; limit?: string };
  const page = Math.max(1, parseInt(q.page || '1') || 1);
  const limit = Math.min(50, Math.max(1, parseInt(q.limit || '20') || 20));
  try {
    const follows = await followRepo().find({ where: { followerId: userId, status: 'active' } });
    const followingIds = follows.map((f) => f.followingId);
    if (!followingIds.length) return reply.send(createResponse(1, 'Feed carregado.', { items: [], total: 0, page, limit, totalPages: 0 }));

    const profiles = await profileRepo().find({ where: { userId: In(followingIds), visibility: 'public' } });
    const profByUser = new Map(profiles.map((p) => [p.userId, p]));
    const pubUserIds = profiles.map((p) => p.userId);
    if (!pubUserIds.length) return reply.send(createResponse(1, 'Feed carregado.', { items: [], total: 0, page, limit, totalPages: 0 }));

    const bankrolls = await bankrollRepo().find({ where: { userId: In(pubUserIds), isPublic: true } });
    const bankById = new Map(bankrolls.map((b) => [b.id, b]));
    const banksByUser = new Map<string, Bankroll[]>();
    for (const b of bankrolls) { (banksByUser.get(b.userId) || banksByUser.set(b.userId, []).get(b.userId)!).push(b); }
    const bets = await betRepo().find({ where: { userId: In(pubUserIds) } });
    const publicBets = bets
      .filter((bt) => community.isBetPublic(bt, bankById.get(bt.bankrollId)))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    const total = publicBets.length;
    const items = publicBets.slice((page - 1) * limit, page * limit).map((bt) => {
      const prof = profByUser.get(bt.userId)!;
      const userBanks = banksByUser.get(bt.userId) || [];
      const unit = community.pickUnit(userBanks);
      const showCurrency = userBanks.some((b) => b.showCurrency);
      return {
        author: { handle: prof.handle, displayName: prof.displayName || prof.handle, avatar: prof.avatar || null, isVerifiedTipster: prof.isVerifiedTipster },
        bet: community.serializePublicBet(bt, { unit, showCurrency }),
      };
    });
    return reply.send(createResponse(1, 'Feed carregado.', { items, total, page, limit, totalPages: Math.ceil(total / limit) }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar feed.', { error: (error as Error).message }));
  }
};

// ===================== NOTIFICAÇÕES =====================

export const getNotifications = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  try {
    const rows = await notifRepo().find({ where: { userId }, order: { createdAt: 'DESC' }, take: 50 });
    const unread = rows.filter((r) => !r.readAt).length;
    return reply.send(createResponse(1, 'Notificações carregadas.', { items: rows, unread }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar notificações.', { error: (error as Error).message }));
  }
};

export const markNotificationsRead = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  try {
    await notifRepo().createQueryBuilder()
      .update(Notification).set({ readAt: () => 'CURRENT_TIMESTAMP' })
      .where('userId = :userId AND readAt IS NULL', { userId }).execute();
    return reply.send(createResponse(1, 'Notificações marcadas como lidas.', { ok: true }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao marcar notificações.', { error: (error as Error).message }));
  }
};

// ===================== LEADERBOARD & ANALYTICS DA COMUNIDADE =====================

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

const windowFrom = (w?: string): Date | undefined => {
  if (!w || w === 'all') return undefined;
  const d = new Date();
  if (w === '7d') d.setDate(d.getDate() - 7);
  else if (w === '30d') d.setDate(d.getDate() - 30);
  else if (w === '90d') d.setDate(d.getDate() - 90);
  else return undefined;
  return d;
};

// Carrega o universo público (perfis públicos + suas bancas públicas + apostas
// públicas VERIFICADAS, opcionalmente dentro da janela).
const loadGlobalPublic = async (from?: Date) => {
  const profiles = await profileRepo().find({ where: { visibility: 'public' } });
  if (!profiles.length) return { profiles: [], banksByUser: new Map<string, Bankroll[]>(), betsByUser: new Map<string, Bet[]>(), allBets: [] as Bet[] };
  const userIds = profiles.map((p) => p.userId);
  const bankrolls = await bankrollRepo().find({ where: { userId: In(userIds), isPublic: true } });
  const bankById = new Map(bankrolls.map((b) => [b.id, b]));
  const banksByUser = new Map<string, Bankroll[]>();
  for (const b of bankrolls) { (banksByUser.get(b.userId) || banksByUser.set(b.userId, []).get(b.userId)!).push(b); }
  const bankUserIds = [...banksByUser.keys()];
  const rawBets = bankUserIds.length ? await betRepo().find({ where: { userId: In(bankUserIds) } }) : [];
  const allBets = rawBets.filter((bt) => bt.verified === 'verified' && community.isBetPublic(bt, bankById.get(bt.bankrollId)) && (!from || bt.createdAt >= from));
  const betsByUser = new Map<string, Bet[]>();
  for (const bt of allBets) { (betsByUser.get(bt.userId) || betsByUser.set(bt.userId, []).get(bt.userId)!).push(bt); }
  return { profiles: profiles.filter((p) => banksByUser.has(p.userId)), banksByUser, betsByUser, allBets };
};

export const getLeaderboard = async (req: FastifyRequest, reply: FastifyReply) => {
  const q = (req.query || {}) as { window?: string; metric?: string; sport?: string; minSample?: string };
  const metric = ['yield', 'roi', 'profit', 'winrate'].includes(q.metric || '') ? q.metric! : 'yield';
  const minSample = Math.max(1, parseInt(q.minSample || '5') || 5);
  const from = windowFrom(q.window);
  try {
    const { profiles, banksByUser, betsByUser } = await loadGlobalPublic(from);

    // Quem o viewer já segue (optionalAuth).
    const viewerId = uid(req);
    const followingSet = new Set<string>();
    if (viewerId) (await followRepo().find({ where: { followerId: viewerId } })).forEach((f) => followingSet.add(f.followingId));

    let totProfit = 0; let totTurnover = 0;
    const raw = profiles.map((p) => {
      let bets = betsByUser.get(p.userId) || [];
      if (q.sport) bets = bets.filter((b) => (b.sport || '') === q.sport);
      const banks = banksByUser.get(p.userId) || [];
      const summary = analytix.computeSummary(bets, [], banks, {});
      const unit = community.pickUnit(banks);
      totProfit += summary.totalProfit; totTurnover += summary.turnover;
      return {
        p, n: summary.settledCount, yield: summary.yield, roi: summary.roi, winRate: summary.winRate,
        avgOdd: summary.avgOdd, profitUnits: unit > 0 ? round2(summary.totalProfit / unit) : 0,
      };
    });

    const communityYield = totTurnover > 0 ? (totProfit / totTurnover) * 100 : 0;
    const K = 200; // força do shrinkage (puxa amostra pequena para a média)
    const qualifying = raw
      .filter((e) => e.n >= minSample)
      .map((e) => ({ ...e, adjYield: round2((e.n * e.yield + K * communityYield) / (e.n + K)) }));

    qualifying.sort((a, b) => {
      if (metric === 'roi') return b.roi - a.roi;
      if (metric === 'profit') return b.profitUnits - a.profitUnits;
      if (metric === 'winrate') return b.winRate - a.winRate;
      return b.adjYield - a.adjYield; // yield (ajustado)
    });

    const data = qualifying.slice(0, 100).map((e, i) => ({
      rank: i + 1,
      handle: e.p.handle,
      displayName: e.p.displayName || e.p.handle,
      avatar: e.p.avatar,
      isVerifiedTipster: e.p.isVerifiedTipster,
      betsCount: e.n,
      yield: e.yield,
      roi: e.roi,
      winRate: e.winRate,
      avgOdd: e.avgOdd,
      profitUnits: e.profitUnits,
      lowSample: e.n < 100,
      isFollowing: followingSet.has(e.p.userId),
      isSelf: e.p.userId === viewerId,
    }));

    return reply.send(createResponse(1, 'Ranking carregado.', { items: data, communityYield: round2(communityYield), minSample }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar ranking.', { error: (error as Error).message }));
  }
};

export const getCommunityAnalytics = async (req: FastifyRequest, reply: FastifyReply) => {
  const q = (req.query || {}) as { window?: string };
  const from = windowFrom(q.window);
  try {
    const { allBets } = await loadGlobalPublic(from);

    const bump = (m: Map<string, { profit: number; turnover: number; count: number }>, key: string, profit: number, turnover: number, resolved: boolean) => {
      const r = m.get(key) || { profit: 0, turnover: 0, count: 0 };
      r.profit += profit; r.turnover += turnover; if (resolved) r.count += 1;
      m.set(key, r);
    };
    const sportM = new Map<string, { profit: number; turnover: number; count: number }>();
    const marketM = new Map<string, { profit: number; turnover: number; count: number }>();
    const houseM = new Map<string, number>();
    const eventM = new Map<string, { home: string | null; away: string | null; sport: string | null; count: number }>();

    let profit = 0; let turnover = 0; let settled = 0; let oddW = 0; let oddWt = 0;
    const users = new Set<string>();

    for (const bet of allBets) {
      users.add(bet.userId);
      const legs = bet.legs || [];
      const p = analytix.betRealizedProfit(legs);
      const t = analytix.betTurnover(legs);
      profit += p; turnover += t;
      const resolvedBet = bet.status === 'settled';
      if (resolvedBet) settled += 1;
      bump(sportM, bet.sport || '—', p, t, resolvedBet);
      for (const l of legs) {
        if (analytix.isResolvedLeg(l.status)) { oddW += analytix.n(l.odd) * analytix.n(l.stake); oddWt += analytix.n(l.stake); }
        bump(marketM, l.market || '—', analytix.legPnl(l), analytix.legTurnover(l), analytix.isResolvedLeg(l.status));
        houseM.set(l.bookmakerSlug, (houseM.get(l.bookmakerSlug) || 0) + 1);
      }
      const ek = bet.eventId || `${bet.home || ''}|${bet.away || ''}`;
      const ev = eventM.get(ek) || { home: bet.home, away: bet.away, sport: bet.sport, count: 0 };
      ev.count += 1; eventM.set(ek, ev);
    }

    const toRows = (m: Map<string, { profit: number; turnover: number; count: number }>) =>
      [...m.entries()]
        .map(([key, r]) => ({ key, betsCount: r.count, yield: r.turnover > 0 ? round2((r.profit / r.turnover) * 100) : 0 }))
        .filter((r) => r.betsCount > 0)
        .sort((a, b) => b.yield - a.yield);

    return reply.send(createResponse(1, 'Analytics carregado.', {
      kpis: {
        activeUsers: users.size,
        totalBets: allBets.length,
        settledBets: settled,
        yield: turnover > 0 ? round2((profit / turnover) * 100) : 0,
        avgOdd: oddWt > 0 ? round2(oddW / oddWt) : 0,
      },
      bySport: toRows(sportM).slice(0, 8),
      byMarket: toRows(marketM).slice(0, 8),
      byHouse: [...houseM.entries()].map(([slug, count]) => ({ slug, count })).sort((a, b) => b.count - a.count).slice(0, 8),
      trending: [...eventM.values()].sort((a, b) => b.count - a.count).slice(0, 8),
    }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar analytics.', { error: (error as Error).message }));
  }
};
