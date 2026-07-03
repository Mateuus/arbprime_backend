/**
 * Barramento Redis da Instância de Bet — estado runtime + comunicação worker↔controle.
 *
 * Chaves (todas sob `ArbPrime:BetInstance`):
 *   :Commands            (pub/sub) controle→worker: { type:start|pause|stop|reload, instanceId }
 *   :Status              (pub/sub) worker→controle: { instanceId, userId, status, lastError?, ts } (WS relay)
 *   :<id>:hb             heartbeat (TTL) — liveness observável pelo controle
 *   :<id>:session        sessão da casa CIFRADA (cookies+customerId) p/ evitar re-login todo restart
 *   :<id>:placed         SET de chaves de dedupe já apostadas
 *   :<id>:lock:<key>     lock in-flight (SET NX EX) antes do place (anti place duplo)
 *   :<id>:day:<yyyymmdd> hash contadores do dia { bets, stake }
 */
import { getRedisClient } from '../core/redis';
import { encryptSecret, decryptSecret, isEncryptionConfigured } from '../utils/crypto';
import { BetanoSessionState, MfaPending } from '../betbot/betano/betano-client';

const BASE = 'ArbPrime:BetInstance';
export const CMD_CHANNEL = `${BASE}:Commands`;
export const STATUS_CHANNEL = `${BASE}:Status`;

export type InstanceCommand = { type: 'start' | 'pause' | 'stop' | 'reload' | 'renew'; instanceId: string };
export interface StatusMessage {
  instanceId: string;
  userId: string;
  status: string;
  lastError?: string | null;
  ts: number;
}

const kHb = (id: string) => `${BASE}:${id}:hb`;
const kSession = (id: string) => `${BASE}:${id}:session`;
const kMfa = (id: string) => `${BASE}:${id}:mfa`;
const kBalance = (id: string) => `${BASE}:${id}:balance`;
const kPlaced = (id: string) => `${BASE}:${id}:placed`;
const kLock = (id: string, key: string) => `${BASE}:${id}:lock:${key}`;
const kDay = (id: string, day: string) => `${BASE}:${id}:day:${day}`;
const kEvCount = (id: string) => `${BASE}:${id}:evcount`;

function today(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ---- comandos / status ----
export async function publishCommand(cmd: InstanceCommand): Promise<void> {
  await getRedisClient().publish(CMD_CHANNEL, JSON.stringify(cmd));
}
export async function publishStatus(msg: StatusMessage): Promise<void> {
  await getRedisClient().publish(STATUS_CHANNEL, JSON.stringify(msg));
}

// ---- heartbeat ----
export async function setHeartbeat(instanceId: string, ttlSec: number, payload: Record<string, unknown> = {}): Promise<void> {
  await getRedisClient().set(kHb(instanceId), JSON.stringify({ ts: Date.now(), ...payload }), 'EX', Math.max(5, ttlSec));
}
export async function getHeartbeat(instanceId: string): Promise<{ ts: number } & Record<string, unknown> | null> {
  const raw = await getRedisClient().get(kHb(instanceId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ---- sessão cifrada ----
// TTL de 23h: a Betano derruba a sessão em ~23h; o blob some sozinho perto disso.
export async function saveSession(instanceId: string, session: BetanoSessionState, ttlSec = 23 * 3600): Promise<void> {
  if (!isEncryptionConfigured()) throw new Error('INSTANCE_ENC_KEY ausente — não posso persistir sessão cifrada');
  const blob = encryptSecret(JSON.stringify(session));
  await getRedisClient().set(kSession(instanceId), blob, 'EX', ttlSec);
}
export async function loadSession(instanceId: string): Promise<BetanoSessionState | null> {
  const blob = await getRedisClient().get(kSession(instanceId));
  if (!blob) return null;
  try { return JSON.parse(decryptSecret(blob)) as BetanoSessionState; } catch { return null; }
}
export async function clearSession(instanceId: string): Promise<void> {
  await getRedisClient().del(kSession(instanceId));
}

// ---- MFA pendente (desafio 2FA aguardando o código do usuário) ----
// TTL curto (5min): o código SMS expira; se passar, refaz o login (novo código).
export async function saveMfaPending(instanceId: string, pending: MfaPending, ttlSec = 5 * 60): Promise<void> {
  if (!isEncryptionConfigured()) throw new Error('INSTANCE_ENC_KEY ausente — não posso persistir MFA cifrado');
  const blob = encryptSecret(JSON.stringify(pending));
  await getRedisClient().set(kMfa(instanceId), blob, 'EX', ttlSec);
}
export async function loadMfaPending(instanceId: string): Promise<MfaPending | null> {
  const blob = await getRedisClient().get(kMfa(instanceId));
  if (!blob) return null;
  try { return JSON.parse(decryptSecret(blob)) as MfaPending; } catch { return null; }
}
export async function clearMfaPending(instanceId: string): Promise<void> {
  await getRedisClient().del(kMfa(instanceId));
}

// ---- saldo real da casa (cache p/ a UI ler sem bater na casa a cada request) ----
export interface CachedBalance {
  cash: number; betting: number; bonus: number; total: number;
  openBetsCount: number; openBetsBalance: number; currency: string; symbol: string; fetchedAt: number;
}
export async function setBalance(instanceId: string, bal: CachedBalance, ttlSec = 10 * 60): Promise<void> {
  await getRedisClient().set(kBalance(instanceId), JSON.stringify(bal), 'EX', Math.max(30, ttlSec));
}
export async function getBalanceCache(instanceId: string): Promise<CachedBalance | null> {
  const raw = await getRedisClient().get(kBalance(instanceId));
  if (!raw) return null;
  try { return JSON.parse(raw) as CachedBalance; } catch { return null; }
}

// ---- dedupe (SET + lock in-flight) ----
export async function loadPlacedKeys(instanceId: string): Promise<Set<string>> {
  const members = await getRedisClient().smembers(kPlaced(instanceId));
  return new Set(members);
}
export async function isPlaced(instanceId: string, key: string): Promise<boolean> {
  return (await getRedisClient().sismember(kPlaced(instanceId), key)) === 1;
}
/** Reserva a chave antes do place (SET NX EX). true = reservou; false = já em voo/apostada. */
export async function claimLock(instanceId: string, key: string, ttlSec = 60): Promise<boolean> {
  const res = await getRedisClient().set(kLock(instanceId, key), '1', 'EX', ttlSec, 'NX');
  return res === 'OK';
}
export async function commitPlaced(instanceId: string, key: string): Promise<void> {
  await getRedisClient().sadd(kPlaced(instanceId), key);
  await getRedisClient().del(kLock(instanceId, key));
}
export async function releaseLock(instanceId: string, key: string): Promise<void> {
  await getRedisClient().del(kLock(instanceId, key));
}

// ---- contadores diários (maxBetsPerDay / maxStakePerDay) ----
export interface DayCounters { bets: number; stake: number }
export async function getDayCounters(instanceId: string): Promise<DayCounters> {
  const h = await getRedisClient().hgetall(kDay(instanceId, today()));
  return { bets: Number(h.bets || 0), stake: Number(h.stake || 0) };
}
export async function incrDayCounters(instanceId: string, stake: number): Promise<void> {
  const r = getRedisClient();
  const key = kDay(instanceId, today());
  await r.hincrby(key, 'bets', 1);
  await r.hincrbyfloat(key, 'stake', stake);
  await r.expire(key, 3 * 24 * 3600); // some sozinho em 3 dias
}

// ---- contador de apostas por evento (maxBetsPerEvent) ----
export async function getEventCount(instanceId: string, eventId: string): Promise<number> {
  return Number((await getRedisClient().hget(kEvCount(instanceId), eventId)) || 0);
}
export async function incrEventCount(instanceId: string, eventId: string): Promise<void> {
  await getRedisClient().hincrby(kEvCount(instanceId), eventId, 1);
}
