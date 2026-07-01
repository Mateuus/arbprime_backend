/**
 * InstanceRunner — o daemon de UMA instância: mantém a sessão da casa viva (proxy
 * pinado + re-login autônomo) e roda o loop de valuebet a cada pollIntervalSec:
 *   ensureSession → lê valuebets → filtra (tiers/gates) → dedupe → stake → placeBet
 *   → grava no Analytix → emite eventos + heartbeat.
 *
 * dryRun (default): monta tudo e loga "apostaria X", mas NÃO efetiva nem grava Bet.
 * O Supervisor cria/para runners e aplica a restart policy; o runner só reporta status.
 */
import { BetInstance, BetInstanceConfig } from '../database/entities/BetInstance';
import { AppDataSource } from '../database/data-source';
import { InstanceStatus, InstanceEventType } from '../enums/bet-instance.enum';
import { BetanoClient, BetanoCredentials } from '../betbot/betano/betano-client';
import { BetanoError } from '../betbot/betano/errors';
import { resolveSettledOutcome } from '../betbot/betano/betano-status';
import { loadProxyById } from '../betbot/proxy-list';
import { Proxy } from '../betbot/http';
import { decryptSecret } from '../utils/crypto';
import { readInstanceValuebets, FlatValuebet } from './valuebet-source';
import { computeStake } from './stake';
import { dedupeKey } from './dedupe';
import * as bus from './bus';
import {
  recordInstanceBet, logInstanceEvent, resolveInstanceBankroll, getBankrollBalance,
  settleInstanceBets, SettleInfo,
} from '../services/betinstance/betinstance.service';

export class InstanceRunner {
  private instance: BetInstance;
  private cfg: BetInstanceConfig;
  private client: BetanoClient | null = null;
  private proxy: Proxy | null = null;
  private bankrollId: string | null = null;
  private placed = new Set<string>();     // espelho do SET de dedupe (memória)
  private dryLogged = new Set<string>();   // em dryRun, não re-loga a mesma seleção
  private needRelogin = false;
  private ticking = false;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private lastDiagAt = 0;
  private lastSettleAt = 0;

  constructor(instance: BetInstance) {
    this.instance = instance;
    this.cfg = instance.config;
  }

  get id(): string { return this.instance.id; }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.setStatus(InstanceStatus.STARTING);
    try {
      this.proxy = this.cfg.proxyId ? await loadProxyById(this.cfg.proxyId) : null;
      if (this.cfg.proxyId && !this.proxy) {
        throw new BetanoError('network', `proxy pinado ${this.cfg.proxyId} não está na lista`);
      }
      this.placed = await bus.loadPlacedKeys(this.id);
      this.bankrollId = await resolveInstanceBankroll(this.instance);
      await this.ensureSession();
      await this.setStatus(InstanceStatus.RUNNING);
      await logInstanceEvent(this.instance, InstanceEventType.STATE, `instância iniciada (${this.cfg.dryRun ? 'DRY-RUN' : 'AO VIVO'})`);
      await this.tick();               // primeiro tick imediato
      this.schedule();
    } catch (e) {
      await this.handleFatal(e);
    }
  }

  async stop(status: InstanceStatus = InstanceStatus.STOPPED, reason?: string): Promise<void> {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.client) { await this.client.close().catch(() => {}); this.client = null; }
    await this.setStatus(status, reason ?? null);
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.tick();
      } catch (e) {
        await this.handleFatal(e);
        return;
      }
      if (this.running) this.schedule();
    }, Math.max(3, this.cfg.pollIntervalSec) * 1000);
  }

  private decryptCreds(): BetanoCredentials {
    if (!this.instance.encUsername || !this.instance.encPassword) {
      throw new BetanoError('rejected', 'instância sem credenciais da casa');
    }
    return {
      username: decryptSecret(this.instance.encUsername),
      password: decryptSecret(this.instance.encPassword),
    };
  }

  private async ensureSession(): Promise<void> {
    if (!this.client) {
      this.client = new BetanoClient({ proxy: this.proxy, timeoutSec: 30 });
      const saved = await bus.loadSession(this.id);
      if (saved) this.client.importSession(saved);
    }
    if (!this.needRelogin && (await this.client.isSessionValid())) return;

    const creds = this.decryptCreds();
    const s = await this.client.login(creds);
    await bus.saveSession(this.id, s);
    this.needRelogin = false;
    await logInstanceEvent(this.instance, InstanceEventType.LOGIN, 'login/re-login OK', { meta: { customerId: s.customerId } });
  }

  private async tick(): Promise<void> {
    if (this.ticking || !this.running) return;
    this.ticking = true;
    try {
      await this.ensureSession();
      await this.maybeSettle();

      const day = await bus.getDayCounters(this.id);
      if (this.cfg.maxBetsPerDay != null && day.bets >= this.cfg.maxBetsPerDay) {
        await this.heartbeat('cap diário de apostas atingido');
        return;
      }
      if (this.cfg.maxStakePerDay != null && day.stake >= this.cfg.maxStakePerDay) {
        await this.heartbeat('cap diário de stake atingido');
        return;
      }

      const { matched, scanned } = await readInstanceValuebets(this.instance.bookmakerSlug, this.cfg);
      if (!matched.length) {
        await this.heartbeat('sem valuebet elegível');
        await this.maybeDiag(scanned > 0
          ? `${scanned} valuebet(s) da casa, nenhum passou os filtros (tiers/edge/odd/confiança)`
          : 'nenhum valuebet da casa no momento');
        return;
      }

      const balance = this.bankrollId ? await getBankrollBalance(this.bankrollId) : 0;
      let acted = 0;
      let dedupeSkips = 0;
      let capSkips = 0;
      let stakeSkips = 0;

      for (const vb of matched) {
        if (!this.running) break;
        const key = dedupeKey(this.cfg.dedupeScope, vb);
        if (this.placed.has(key) || (await bus.isPlaced(this.id, key))) { dedupeSkips++; continue; }
        if ((await bus.getEventCount(this.id, vb.eventId)) >= this.cfg.maxBetsPerEvent) { capSkips++; continue; }
        if (this.cfg.maxBetsPerDay != null && day.bets >= this.cfg.maxBetsPerDay) break;

        const st = computeStake(vb, this.cfg, { bankrollBalance: balance });
        if (st.skip) {
          stakeSkips++;
          const nk = 'skip:' + key;
          if (!this.dryLogged.has(nk)) {
            this.dryLogged.add(nk);
            await logInstanceEvent(this.instance, InstanceEventType.SKIP,
              `pulado: ${st.reason} — ${vb.home} x ${vb.away} (${vb.selection})`,
              { meta: { emissionId: vb.id, reason: st.reason, edgePct: vb.edgePct, balance } });
          }
          continue;
        }
        if (this.cfg.maxStakePerDay != null && day.stake + st.stake > this.cfg.maxStakePerDay) { capSkips++; continue; }

        await this.tryPlace(vb, key, st.stake, day);
        acted++;
      }

      await this.heartbeat();
      if (acted === 0) {
        await this.maybeDiag(
          `${matched.length} elegível(is), 0 nova(s): ${dedupeSkips} já apostada(s) (dedupe), ${stakeSkips} por stake, ${capSkips} por limite — saldo banca R$${balance.toFixed(2)}`,
        );
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Auto-settle (Fase 5): a cada ~5min lê o histórico LIQUIDADO da casa e concilia
   * as apostas DESTA instância (só source='instance' + houseBetId). Deriva o P&L do
   * retorno realizado. Nunca toca apostas manuais.
   */
  private async maybeSettle(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSettleAt < 5 * 60 * 1000) return;
    this.lastSettleAt = now;
    try {
      const hist = await this.client!.getHistory({ settled: true, days: 7 });
      const map = new Map<string, SettleInfo>();
      for (const b of hist) {
        if (!b.settled || !b.betId) continue;
        map.set(String(b.betId), resolveSettledOutcome(b.stakeAmount, b.returnAmount, b.oddValue));
      }
      if (!map.size) return;
      const { settled, details } = await settleInstanceBets(this.id, map);
      if (settled > 0) {
        await logInstanceEvent(this.instance, InstanceEventType.SETTLE,
          `${settled} aposta(s) conferida(s): ${details.slice(0, 6).join(', ')}`, { meta: { count: settled, details } });
      }
    } catch (e) {
      await logInstanceEvent(this.instance, InstanceEventType.ERROR,
        `falha ao conferir histórico: ${(e as Error).message}`, { level: 'warn' });
    }
  }

  /** Evento de diagnóstico rate-limited (no máx. 1 a cada 2min) p/ o usuário entender o loop. */
  private async maybeDiag(msg: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastDiagAt < 120_000) return;
    this.lastDiagAt = now;
    await logInstanceEvent(this.instance, InstanceEventType.STATE, msg, { level: 'info' });
  }

  private async tryPlace(vb: FlatValuebet, key: string, stake: number, day: bus.DayCounters): Promise<void> {
    // DRY-RUN: não reserva, não grava, não persiste dedupe — só loga 1× por seleção/processo.
    if (this.cfg.dryRun) {
      if (this.dryLogged.has(key)) return;
      try {
        const res = await this.client!.placeBet({
          selectionId: vb.selectionId!, eventId: vb.eventId, eventUrl: vb.link,
          amount: stake, minOdds: this.cfg.oddMin, hardCap: this.cfg.maxStakePerBet, dryRun: true,
        });
        this.dryLogged.add(key);
        await logInstanceEvent(this.instance, InstanceEventType.PLACE,
          `DRY: apostaria R$${stake.toFixed(2)} @ ${res.totalOdds ?? vb.odd} em ${vb.home} x ${vb.away} — ${vb.selection}`,
          { meta: { emissionId: vb.id, eventId: vb.eventId, odd: res.totalOdds ?? vb.odd, stake } });
      } catch (e) {
        await this.onBetError(e, vb, key);
      }
      return;
    }

    // AO VIVO: reserva o lock antes do place (anti place duplo).
    if (!(await bus.claimLock(this.id, key))) return;
    try {
      const res = await this.client!.placeBet({
        selectionId: vb.selectionId!, eventId: vb.eventId, eventUrl: vb.link,
        amount: stake, minOdds: this.cfg.oddMin, hardCap: this.cfg.maxStakePerBet, dryRun: false,
      });
      if (!res.accepted) {
        await bus.releaseLock(this.id, key);
        await logInstanceEvent(this.instance, InstanceEventType.SKIP,
          `place recusado (${res.errorCode ?? res.errors?.map((x) => x.code).join(',') ?? '?'})`,
          { level: 'warn', meta: { emissionId: vb.id, errors: res.errors } });
        return;
      }
      const rec = await recordInstanceBet({ instance: this.instance, vb, place: res, stake, bankrollId: this.bankrollId! });
      await bus.commitPlaced(this.id, key);
      this.placed.add(key);
      await bus.incrEventCount(this.id, vb.eventId);
      await bus.incrDayCounters(this.id, stake);
      day.bets++; day.stake += stake;
      await logInstanceEvent(this.instance, InstanceEventType.PLACE,
        `apostou R$${stake.toFixed(2)} @ ${res.totalOdds} — ${vb.home} x ${vb.away} (${vb.selection})${rec.duplicate ? ' [dup]' : ''}`,
        { meta: { emissionId: vb.id, betId: res.betId, odd: res.totalOdds, stake, betRowId: rec.bet?.id } });
    } catch (e) {
      await bus.releaseLock(this.id, key);
      await this.onBetError(e, vb, key);
    }
  }

  /** Erros por-aposta: auth = sessão caiu (re-login no próximo tick); demais = loga e segue. */
  private async onBetError(e: unknown, vb: FlatValuebet, _key: string): Promise<void> {
    const be = e as BetanoError;
    if (be?.kind === 'auth') {
      this.needRelogin = true;
      await bus.clearSession(this.id);
      await logInstanceEvent(this.instance, InstanceEventType.SESSION, 'sessão caiu — re-login no próximo ciclo', { level: 'warn' });
      throw e; // interrompe o loop deste tick; próximo tick reloga
    }
    if (be?.kind === 'datadome' || be?.kind === 'geocomply' || be?.kind === 'mfa' || be?.kind === 'rejected') {
      throw e; // fatal → handleFatal marca login_failed
    }
    await logInstanceEvent(this.instance, InstanceEventType.ERROR,
      `erro ao apostar: ${be?.message ?? e}`, { level: 'error', meta: { emissionId: vb.id, kind: be?.kind } });
  }

  private async handleFatal(e: unknown): Promise<void> {
    const be = e as BetanoError;
    const loginFail = be?.kind === 'datadome' || be?.kind === 'mfa' || be?.kind === 'rejected' || be?.kind === 'no_cookie';
    const status = loginFail ? InstanceStatus.LOGIN_FAILED : (be?.kind === 'auth' ? InstanceStatus.SESSION_EXPIRED : InstanceStatus.ERROR);
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await logInstanceEvent(this.instance, InstanceEventType.ERROR, `parou: ${be?.message ?? e}`, { level: 'error', meta: { kind: be?.kind } });
    await this.setStatus(status, be?.message ?? String(e));
    // Supervisor observa o status e aplica a restart policy.
  }

  private async heartbeat(note?: string): Promise<void> {
    const ttl = Math.max(30, this.cfg.pollIntervalSec * 3);
    await bus.setHeartbeat(this.id, ttl, { status: this.instance.status, note });
    await AppDataSource.getRepository(BetInstance).update(this.id, { lastHeartbeatAt: new Date(), lastRunAt: new Date() });
  }

  private async setStatus(status: InstanceStatus, lastError: string | null = null): Promise<void> {
    this.instance.status = status;
    await AppDataSource.getRepository(BetInstance).update(this.id, { status, lastError });
    await bus.publishStatus({ instanceId: this.id, userId: this.instance.userId, status, lastError, ts: Date.now() });
  }
}
