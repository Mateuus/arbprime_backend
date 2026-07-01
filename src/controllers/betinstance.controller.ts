import { FastifyRequest, FastifyReply } from 'fastify';
import { Between, MoreThanOrEqual, LessThanOrEqual } from 'typeorm';
import { AppDataSource } from '@Database';
import { BetInstance, BetInstanceEvent } from '@Entities';
import { createResponse } from '@utils';
import {
  BetInstanceConfig, DEFAULT_INSTANCE_CONFIG,
} from '../database/entities/BetInstance';
import { DesiredState, InstanceStatus } from '../enums/bet-instance.enum';
import { encryptSecret, decryptSecret, isEncryptionConfigured } from '../utils/crypto';
import { publishCommand } from '../betworker/bus';
import { serializeInstance, getUserInstancesStatus } from '../services/betinstance/betinstance.service';
import { BetanoClient } from '../betbot/betano/betano-client';
import { checkBetanoProxy } from '../betbot/betano/proxy-check';
import { loadProxyById, loadProxyList } from '../betbot/proxy-list';

const instRepo = () => AppDataSource.getRepository(BetInstance);
const evtRepo = () => AppDataSource.getRepository(BetInstanceEvent);
const uid = (req: FastifyRequest): string | undefined => req.userData?.userId;

const num = (v: unknown, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

// Limite "0 ou vazio = sem limite": undefined (campo ausente) → default; null/0/
// negativo → null (sem limite); positivo → o valor. Distingue ausência de "sem limite".
const capInt = (v: unknown, def: number | null): number | null => {
  if (v === undefined) return def;
  if (v === null) return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const capFloat = (v: unknown, def: number | null): number | null => {
  if (v === undefined) return def;
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Sanitiza/mescla a config vinda do frontend com os defaults (coerção + clamps). */
function mergeConfig(partial: Partial<BetInstanceConfig> | undefined): BetInstanceConfig {
  const p = partial || {};
  const d = DEFAULT_INSTANCE_CONFIG;
  const tiers = Array.isArray(p.tiers) ? p.tiers.map(Number).filter((t) => [1, 2, 3].includes(t)) : d.tiers;
  return {
    tiers: tiers.length ? tiers : d.tiers,
    edgeMin: num(p.edgeMin, d.edgeMin),
    oddMin: num(p.oddMin, d.oddMin),
    oddMax: num(p.oddMax, d.oddMax),
    confidenceMin: Math.min(1, Math.max(0, num(p.confidenceMin, d.confidenceMin))),
    markets: Array.isArray(p.markets) && p.markets.length ? p.markets.map(String) : null,
    leagues: Array.isArray(p.leagues) && p.leagues.length ? p.leagues.map(String) : null,
    stakeMode: p.stakeMode === 'flat' ? ('flat' as BetInstanceConfig['stakeMode']) : d.stakeMode,
    kellyMultiplier: Math.max(0, num(p.kellyMultiplier, d.kellyMultiplier)),
    flatStake: p.flatStake != null ? Math.max(0, num(p.flatStake, 0)) : d.flatStake,
    minStake: Math.max(0, num(p.minStake, d.minStake)),
    maxStakePerBet: Math.max(0, num(p.maxStakePerBet, d.maxStakePerBet)),
    stakeRounding: Math.max(0, num(p.stakeRounding, d.stakeRounding)),
    dedupeScope: (['perEmission', 'perEventSelection', 'perEvent'].includes(String(p.dedupeScope))
      ? p.dedupeScope : d.dedupeScope) as BetInstanceConfig['dedupeScope'],
    maxBetsPerEvent: Math.max(1, Math.floor(num(p.maxBetsPerEvent, d.maxBetsPerEvent))),
    maxBetsPerDay: capInt(p.maxBetsPerDay, d.maxBetsPerDay),
    maxStakePerDay: capFloat(p.maxStakePerDay, d.maxStakePerDay),
    stopLossDay: capFloat(p.stopLossDay, d.stopLossDay),
    pollIntervalSec: Math.max(5, Math.floor(num(p.pollIntervalSec, d.pollIntervalSec))),
    dryRun: p.dryRun != null ? !!p.dryRun : d.dryRun,
    maxEventDays: capFloat(p.maxEventDays, d.maxEventDays),
    restartPolicy: (['always', 'on-failure', 'never'].includes(String(p.restartPolicy))
      ? p.restartPolicy : d.restartPolicy) as BetInstanceConfig['restartPolicy'],
    maxRetries: Math.max(0, Math.floor(num(p.maxRetries, d.maxRetries))),
    proxyId: p.proxyId != null ? (p.proxyId ? String(p.proxyId) : null) : d.proxyId,
  };
}

// ===================== CRUD =====================

export const listInstances = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  try {
    return reply.send(createResponse(1, 'Instâncias carregadas.', await getUserInstancesStatus(userId)));
  } catch (e) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar instâncias.', { error: (e as Error).message }));
  }
};

export const getInstance = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { id } = req.params as { id: string };
  const inst = await instRepo().findOneBy({ id, userId });
  if (!inst) return reply.code(404).send(createResponse(0, 'Instância não encontrada.', null));
  return reply.send(createResponse(1, 'Instância carregada.', serializeInstance(inst)));
};

interface CreateBody {
  name?: string; bookmakerSlug?: string; bankrollId?: string; accountId?: string;
  config?: Partial<BetInstanceConfig>; username?: string; password?: string;
}

export const createInstance = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const b = (req.body || {}) as CreateBody;
  if (!b.name || !b.name.trim()) return reply.code(400).send(createResponse(0, 'Nome é obrigatório.', null));
  if ((b.username || b.password) && !isEncryptionConfigured()) {
    return reply.code(500).send(createResponse(0, 'Cifra de credenciais não configurada no servidor (INSTANCE_ENC_KEY).', null));
  }
  try {
    const inst = instRepo().create({
      userId,
      name: b.name.trim().slice(0, 120),
      bookmakerSlug: (b.bookmakerSlug || 'betano').toLowerCase(),
      bankrollId: b.bankrollId || null,
      accountId: b.accountId || null,
      desiredState: DesiredState.STOPPED,
      status: InstanceStatus.STOPPED,
      strategy: 'valuebet',
      config: mergeConfig(b.config),
      encUsername: b.username ? encryptSecret(b.username) : null,
      encPassword: b.password ? encryptSecret(b.password) : null,
      credentialsSetAt: b.username && b.password ? new Date() : null,
    });
    const saved = await instRepo().save(inst);
    return reply.send(createResponse(1, 'Instância criada.', serializeInstance(saved)));
  } catch (e) {
    return reply.code(500).send(createResponse(0, 'Erro ao criar instância.', { error: (e as Error).message }));
  }
};

export const updateInstance = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { id } = req.params as { id: string };
  const b = (req.body || {}) as CreateBody;
  const inst = await instRepo().findOneBy({ id, userId });
  if (!inst) return reply.code(404).send(createResponse(0, 'Instância não encontrada.', null));
  try {
    if (b.name != null) inst.name = String(b.name).trim().slice(0, 120);
    if (b.bankrollId !== undefined) inst.bankrollId = b.bankrollId || null;
    if (b.accountId !== undefined) inst.accountId = b.accountId || null;
    if (b.config) inst.config = mergeConfig({ ...inst.config, ...b.config });
    if (b.username && b.password) {
      if (!isEncryptionConfigured()) return reply.code(500).send(createResponse(0, 'Cifra não configurada (INSTANCE_ENC_KEY).', null));
      inst.encUsername = encryptSecret(b.username);
      inst.encPassword = encryptSecret(b.password);
      inst.credentialsSetAt = new Date();
    }
    const saved = await instRepo().save(inst);
    // Se está rodando, recarrega o runner p/ pegar a nova config/credencial.
    if (saved.desiredState === DesiredState.RUNNING) {
      await publishCommand({ type: 'reload', instanceId: saved.id });
    }
    return reply.send(createResponse(1, 'Instância atualizada.', serializeInstance(saved)));
  } catch (e) {
    return reply.code(500).send(createResponse(0, 'Erro ao atualizar instância.', { error: (e as Error).message }));
  }
};

export const deleteInstance = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { id } = req.params as { id: string };
  const inst = await instRepo().findOneBy({ id, userId });
  if (!inst) return reply.code(404).send(createResponse(0, 'Instância não encontrada.', null));
  try {
    await publishCommand({ type: 'stop', instanceId: id }); // derruba o runner antes
    await instRepo().delete({ id, userId });
    return reply.send(createResponse(1, 'Instância removida.', { id }));
  } catch (e) {
    return reply.code(500).send(createResponse(0, 'Erro ao remover instância.', { error: (e as Error).message }));
  }
};

// ===================== CONTROLE (Start/Pause/Stop) =====================

const setDesired = async (
  req: FastifyRequest, reply: FastifyReply,
  desired: DesiredState, cmd: 'start' | 'pause' | 'stop', okMsg: string,
) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { id } = req.params as { id: string };
  const inst = await instRepo().findOneBy({ id, userId });
  if (!inst) return reply.code(404).send(createResponse(0, 'Instância não encontrada.', null));
  if (cmd === 'start' && !(inst.encUsername && inst.encPassword)) {
    return reply.code(400).send(createResponse(0, 'Defina as credenciais da casa antes de iniciar.', null));
  }
  inst.desiredState = desired;
  await instRepo().save(inst);
  await publishCommand({ type: cmd, instanceId: id });
  return reply.send(createResponse(1, okMsg, serializeInstance(inst)));
};

export const startInstance = (req: FastifyRequest, reply: FastifyReply) =>
  setDesired(req, reply, DesiredState.RUNNING, 'start', 'Instância iniciando.');
export const pauseInstance = (req: FastifyRequest, reply: FastifyReply) =>
  setDesired(req, reply, DesiredState.PAUSED, 'pause', 'Instância pausada.');
export const stopInstance = (req: FastifyRequest, reply: FastifyReply) =>
  setDesired(req, reply, DesiredState.STOPPED, 'stop', 'Instância parada.');

// ===================== TEST LOGIN =====================

interface TestBody { instanceId?: string; username?: string; password?: string; proxyId?: string }

/**
 * Testa credenciais + proxy fazendo um login REAL (curto, fecha depois). Aceita
 * creds no body (pré-criação) ou instanceId (usa as cifradas). Sobe o cycletls
 * pontualmente no processo da API — uso manual/infrequente.
 */
export const testLogin = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const b = (req.body || {}) as TestBody;
  let username = b.username;
  let password = b.password;
  let proxyId = b.proxyId ?? null;

  if (b.instanceId) {
    const inst = await instRepo().findOneBy({ id: b.instanceId, userId });
    if (!inst) return reply.code(404).send(createResponse(0, 'Instância não encontrada.', null));
    if (inst.encUsername && inst.encPassword) {
      try { username = decryptSecret(inst.encUsername); password = decryptSecret(inst.encPassword); }
      catch { return reply.code(500).send(createResponse(0, 'Falha ao decifrar credenciais.', null)); }
    }
    if (proxyId == null) proxyId = inst.config?.proxyId ?? null;
  }
  if (!username || !password) return reply.code(400).send(createResponse(0, 'Informe usuário e senha.', null));

  const proxy = proxyId ? await loadProxyById(proxyId) : null;
  if (proxyId && !proxy) return reply.code(400).send(createResponse(0, `Proxy ${proxyId} não encontrado na lista.`, null));

  const client = new BetanoClient({ proxy, timeoutSec: 30 });
  try {
    const s = await client.login({ username, password });
    return reply.send(createResponse(1, 'Login OK.', { ok: true, customerId: s.customerId, proxy: proxy ? `${proxy.ip}:${proxy.port}` : null }));
  } catch (e) {
    const kind = (e as { kind?: string }).kind || 'unknown';
    return reply.send(createResponse(1, 'Login falhou.', { ok: false, kind, message: (e as Error).message }));
  } finally {
    await client.close().catch(() => {});
  }
};

// ===================== EVENTOS (log ao vivo) =====================

export const listInstanceEvents = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { id } = req.params as { id: string };
  const inst = await instRepo().findOneBy({ id, userId });
  if (!inst) return reply.code(404).send(createResponse(0, 'Instância não encontrada.', null));

  const q = (req.query || {}) as { limit?: string; from?: string; to?: string; type?: string };
  const limit = Math.min(1000, Math.max(1, num(q.limit, 100)));
  const where: Record<string, unknown> = { instanceId: id, userId };
  if (q.type && q.type !== 'all') where.type = q.type;
  const from = q.from ? new Date(q.from) : null;
  const to = q.to ? new Date(q.to) : null;
  const fromOk = from && !isNaN(from.getTime());
  const toOk = to && !isNaN(to.getTime());
  if (fromOk && toOk) where.createdAt = Between(from as Date, to as Date);
  else if (fromOk) where.createdAt = MoreThanOrEqual(from as Date);
  else if (toOk) where.createdAt = LessThanOrEqual(to as Date);

  const events = await evtRepo().find({ where, order: { createdAt: 'DESC' }, take: limit });
  return reply.send(createResponse(1, 'Eventos carregados.', events));
};

/** Limpa o log (apaga os eventos) da instância. */
export const clearInstanceEvents = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { id } = req.params as { id: string };
  const inst = await instRepo().findOneBy({ id, userId });
  if (!inst) return reply.code(404).send(createResponse(0, 'Instância não encontrada.', null));
  const res = await evtRepo().delete({ instanceId: id, userId });
  return reply.send(createResponse(1, 'Log limpo.', { deleted: res.affected ?? 0 }));
};

// ===================== PROXIES (p/ a UI de config) =====================

export const listInstanceProxies = async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    const list = await loadProxyList({ onlyEnabled: true });
    // redige credenciais — só o que a UI precisa p/ escolher
    const data = list.map((p) => ({ id: p.id, ip: p.ip, port: p.port, iptype: p.iptype, scope: p.scope }));
    return reply.send(createResponse(1, 'Proxies carregados.', data));
  } catch (e) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar proxies.', { error: (e as Error).message }));
  }
};

/**
 * Verifica TODOS os proxis habilitados p/ a Betano (vivo + Cloudflare + DataDome)
 * usando o checkBetanoProxy — p/ o usuário escolher um que FUNCIONA. Com creds,
 * testa o login (o gate real do DataDome); sem creds, só liveness+Cloudflare.
 * Roda com concorrência limitada (4) p/ não abrir Go demais. Ordena funcionais
 * primeiro, por latência.
 */
export const checkInstanceProxies = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const b = (req.body || {}) as { username?: string; password?: string; withLogin?: boolean };
  const withLogin = b.withLogin !== false && !!(b.username && b.password);

  const proxies = await loadProxyList({ onlyEnabled: true });
  const results: Array<{ id: string; ip: string; port: string; iptype: string; functional: boolean; reason: string; latencyMs: number; dataDomeOk: boolean | null }> = [];
  const queue = [...proxies];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      try {
        const r = await checkBetanoProxy(p, { withLogin, username: b.username, password: b.password, timeoutSec: 20 });
        results.push({ id: p.id, ip: p.ip, port: p.port, iptype: p.iptype, functional: r.functional, reason: r.reason, latencyMs: r.latencyMs, dataDomeOk: r.dataDomeOk });
      } catch (e) {
        results.push({ id: p.id, ip: p.ip, port: p.port, iptype: p.iptype, functional: false, reason: (e as Error).message, latencyMs: 0, dataDomeOk: null });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, proxies.length || 1) }, worker));
  results.sort((a, c) => (Number(c.functional) - Number(a.functional)) || (a.latencyMs - c.latencyMs));
  return reply.send(createResponse(1, `Proxies verificados (${withLogin ? 'com login' : 'liveness'}).`, results));
};
