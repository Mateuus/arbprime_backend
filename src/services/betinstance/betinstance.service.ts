/**
 * Escritas de dinheiro/estado da Instância de Bet no banco do arbprime (fonte única
 * de verdade — reusa a matemática do analytix.service). Chamado pelo Bet Worker.
 *
 * `recordInstanceBet` cria Bet+BetLeg com origem 'instance', ligando emissionId
 * (idempotência via índice único) e houseBetId (elo p/ conferir no histórico da
 * casa). Duplicata (mesmo instanceId+emissionId) é tratada como skip, não erro.
 */
import { In } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { Bet } from '../../database/entities/Bet';
import { BetLeg } from '../../database/entities/BetLeg';
import { Bankroll } from '../../database/entities/Bankroll';
import { BankrollTransaction } from '../../database/entities/BankrollTransaction';
import { BetInstance } from '../../database/entities/BetInstance';
import { BetInstanceEvent } from '../../database/entities/BetInstanceEvent';
import { BetType, BetStatus, LegStatus, BetSide, RESOLVED_LEG_STATUSES } from '../../enums/analytix.enum';
import { InstanceEventType, BET_SOURCE_INSTANCE } from '../../enums/bet-instance.enum';
import { computeBankrollBalance, deriveBetStatus } from '../analytix.service';
import { FlatValuebet } from '../../betworker/valuebet-source';
import { PlaceResult } from '../../betbot/betano/betano-client';
import { decryptSecret, isEncryptionConfigured } from '../../utils/crypto';

/** Decifra o username (só ele — nunca a senha) p/ exibir na UI. Null se não der. */
function safeUsername(enc: string | null): string | null {
  if (!enc || !isEncryptionConfigured()) return null;
  try { return decryptSecret(enc); } catch { return null; }
}

/** Serializa uma instância p/ o frontend — SEM segredos (só flag hasCredentials). */
export function serializeInstance(inst: BetInstance) {
  return {
    id: inst.id,
    name: inst.name,
    bookmakerSlug: inst.bookmakerSlug,
    strategy: inst.strategy,
    bankrollId: inst.bankrollId,
    accountId: inst.accountId,
    desiredState: inst.desiredState,
    status: inst.status,
    lastError: inst.lastError,
    lastHeartbeatAt: inst.lastHeartbeatAt,
    lastRunAt: inst.lastRunAt,
    config: inst.config,
    hasCredentials: !!(inst.encUsername && inst.encPassword),
    username: safeUsername(inst.encUsername), // só o login (senha nunca sai)
    createdAt: inst.createdAt,
    updatedAt: inst.updatedAt,
  };
}

/** Lista as instâncias do usuário (serializadas) — usado pelo REST e pelo WS. */
export async function getUserInstancesStatus(userId: string) {
  const rows = await AppDataSource.getRepository(BetInstance).find({
    where: { userId },
    order: { createdAt: 'ASC' },
  });
  return rows.map(serializeInstance);
}

/** Resolve a banca da instância: a configurada, senão a banca valuebet (find-or-create). */
export async function resolveInstanceBankroll(instance: BetInstance): Promise<string> {
  const repo = AppDataSource.getRepository(Bankroll);
  if (instance.bankrollId) {
    const b = await repo.findOneBy({ id: instance.bankrollId, userId: instance.userId });
    if (b) return b.id;
  }
  let vb = await repo.findOne({ where: { userId: instance.userId, kind: 'valuebet' } });
  if (!vb) {
    vb = await repo.save(repo.create({ userId: instance.userId, name: 'Banca Value Bet', kind: 'valuebet', isDefault: false }));
  }
  return vb.id;
}

/** Saldo atual da banca (derivado: capital inicial + Σ transações + Σ lucro realizado). */
export async function getBankrollBalance(bankrollId: string): Promise<number> {
  const bankroll = await AppDataSource.getRepository(Bankroll).findOneBy({ id: bankrollId });
  if (!bankroll) return 0;
  const bets = await AppDataSource.getRepository(Bet).find({ where: { bankrollId } }); // legs são eager
  const txs = await AppDataSource.getRepository(BankrollTransaction).find({ where: { bankrollId } });
  return computeBankrollBalance(bankroll, bets, txs);
}

export interface RecordBetInput {
  instance: BetInstance;
  vb: FlatValuebet;
  place: PlaceResult; // place aceito (accepted:true)
  stake: number;
  bankrollId: string;
}

/** Grava a aposta feita pela instância. `duplicate` se o índice único barrar (dedupe). */
export async function recordInstanceBet(input: RecordBetInput): Promise<{ bet?: Bet; duplicate?: boolean }> {
  const { instance, vb, place, stake, bankrollId } = input;
  const betRepo = AppDataSource.getRepository(Bet);
  const odd = Number(place.totalOdds ?? vb.odd);

  const bet = betRepo.create({
    userId: instance.userId,
    bankrollId,
    betType: BetType.SINGLE,
    status: BetStatus.OPEN,
    eventId: vb.groupId,          // evento canônico (grupo)
    home: vb.home,
    away: vb.away,
    sport: vb.sport,
    league: vb.league,
    eventStart: vb.date ? new Date(vb.date) : null,
    surebetKey: vb.id,
    instanceId: instance.id,
    emissionId: vb.id,
    totalStake: stake.toFixed(2),
    expectedProfitPct: vb.edgePct != null ? Number(vb.edgePct).toFixed(4) : null,
    source: BET_SOURCE_INSTANCE,
    verified: 'verified',
    legs: [
      {
        bookmakerSlug: instance.bookmakerSlug,
        accountId: instance.accountId,
        houseEventId: vb.eventId,
        houseSelectionId: vb.selectionId ?? null,
        houseBetId: place.betId ?? null,
        market: vb.market,
        rawMarket: vb.rawMarket ?? null,
        selection: vb.selection,
        handicap: vb.handicap ?? null,
        side: BetSide.BACK,
        odd: odd.toFixed(4),
        stake: stake.toFixed(2),
        status: LegStatus.PENDING,
      } as Partial<BetLeg>,
    ],
  });

  try {
    const saved = await betRepo.save(bet);
    return { bet: saved };
  } catch (e: any) {
    const code = e?.code || e?.driverError?.code;
    if (code === 'ER_DUP_ENTRY') return { duplicate: true };
    throw e;
  }
}

export interface SettleInfo {
  result: 'won' | 'lost' | 'void' | 'cashout';
  grossReturn: number;
  profit: number;
}

const LEG_STATUS_FOR: Record<SettleInfo['result'], LegStatus> = {
  won: LegStatus.WON, lost: LegStatus.LOST, void: LegStatus.VOID, cashout: LegStatus.CASHOUT,
};

/**
 * Liquida (settle) apostas da INSTÂNCIA a partir do histórico da casa. Só toca
 * apostas `source='instance'` com `houseBetId` — NUNCA as manuais do Analytix.
 * Casa por `houseBetId`; deriva P&L do retorno realizado (ver resolveSettledOutcome).
 */
export async function settleInstanceBets(
  instanceId: string,
  byHouseBetId: Map<string, SettleInfo>,
): Promise<{ settled: number; details: string[] }> {
  const betRepo = AppDataSource.getRepository(Bet);
  const openBets = await betRepo.find({
    where: { instanceId, source: BET_SOURCE_INSTANCE, status: In([BetStatus.OPEN, BetStatus.PARTIALLY_SETTLED]) },
  });
  let settled = 0;
  const details: string[] = [];
  for (const bet of openBets) {
    let changed = false;
    for (const leg of bet.legs || []) {
      if (!leg.houseBetId || RESOLVED_LEG_STATUSES.includes(leg.status)) continue;
      const info = byHouseBetId.get(String(leg.houseBetId));
      if (!info) continue;
      leg.status = LEG_STATUS_FOR[info.result];
      leg.settledReturn = info.grossReturn.toFixed(2);
      leg.legProfit = info.profit.toFixed(2);
      leg.settledAt = new Date();
      changed = true;
      details.push(`${leg.houseBetId}→${info.result}(${info.profit >= 0 ? '+' : ''}${info.profit.toFixed(2)})`);
    }
    if (changed) {
      bet.status = deriveBetStatus(bet.legs);
      bet.realizedProfit = (bet.legs || []).reduce((a, l) => a + (l.legProfit ? Number(l.legProfit) : 0), 0).toFixed(2);
      if (bet.status === BetStatus.SETTLED || bet.status === BetStatus.VOID) {
        bet.settledAt = new Date();
        bet.lockedAt = new Date();
      }
      await betRepo.save(bet);
      settled++;
    }
  }
  return { settled, details };
}

/** Registra um evento de auditoria (log ao vivo da UI). */
export async function logInstanceEvent(
  instance: Pick<BetInstance, 'id' | 'userId'>,
  type: InstanceEventType,
  message: string,
  opts: { level?: 'info' | 'warn' | 'error'; meta?: Record<string, unknown> } = {},
): Promise<void> {
  const repo = AppDataSource.getRepository(BetInstanceEvent);
  await repo.save(
    repo.create({
      instanceId: instance.id,
      userId: instance.userId,
      type,
      level: opts.level ?? 'info',
      message: String(message).slice(0, 400),
      meta: opts.meta ?? null,
    }),
  );
}
