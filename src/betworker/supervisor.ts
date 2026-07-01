/**
 * Supervisor do Bet Worker: gerencia N InstanceRunners.
 *  - reconcile(): no boot (e periodicamente), sobe runners p/ toda instância com
 *    desiredState=running e derruba as que não são mais desejadas — é a RECUPERAÇÃO
 *    de estado pós-restart (o desejo vive no MySQL, não em memória).
 *  - comandos (Redis pub/sub): start/pause/stop/reload por instanceId.
 *  - watchdog: aplica a RESTART POLICY (always/on-failure/never + backoff) a runners
 *    que caíram (status error/session_expired) e continuam desejados.
 */
import Redis from 'ioredis';
import { AppDataSource } from '../database/data-source';
import { getRedisClient } from '../core/redis';
import { BetInstance } from '../database/entities/BetInstance';
import { DesiredState, InstanceStatus, RestartPolicy } from '../enums/bet-instance.enum';
import { InstanceRunner } from './instance-runner';
import { CMD_CHANNEL, InstanceCommand } from './bus';

interface RestartRec { count: number; nextAt: number }

export class Supervisor {
  private runners = new Map<string, InstanceRunner>();
  private restarts = new Map<string, RestartRec>();
  private sub: Redis | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private stopping = false;

  async start(): Promise<void> {
    await this.reconcile();
    await this.subscribeCommands();
    this.watchdog = setInterval(() => { void this.watchTick(); }, 30_000);
    console.log(`[supervisor] up — ${this.runners.size} instância(s) rodando`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    if (this.sub) { try { await this.sub.quit(); } catch { /* */ } this.sub = null; }
    await Promise.all([...this.runners.values()].map((r) => r.stop(InstanceStatus.STOPPED).catch(() => {})));
    this.runners.clear();
  }

  /** Sobe/derruba runners p/ bater com o desiredState do banco. */
  async reconcile(): Promise<void> {
    const repo = AppDataSource.getRepository(BetInstance);
    const wanted = await repo.find({ where: { desiredState: DesiredState.RUNNING } });
    const wantedIds = new Set(wanted.map((w) => w.id));

    for (const inst of wanted) {
      if (!this.runners.has(inst.id)) await this.launch(inst);
    }
    for (const [id, runner] of [...this.runners]) {
      if (!wantedIds.has(id)) {
        await runner.stop(InstanceStatus.STOPPED).catch(() => {});
        this.runners.delete(id);
        this.restarts.delete(id);
      }
    }
  }

  private async launch(inst: BetInstance): Promise<void> {
    const runner = new InstanceRunner(inst);
    this.runners.set(inst.id, runner);
    await runner.start().catch((e) => console.error(`[supervisor] launch ${inst.id} falhou:`, e?.message || e));
  }

  private async subscribeCommands(): Promise<void> {
    this.sub = getRedisClient().duplicate();
    await this.sub.subscribe(CMD_CHANNEL);
    this.sub.on('message', (_ch, raw) => {
      let cmd: InstanceCommand;
      try { cmd = JSON.parse(raw); } catch { return; }
      void this.handleCommand(cmd);
    });
  }

  private async handleCommand(cmd: InstanceCommand): Promise<void> {
    const inst = await AppDataSource.getRepository(BetInstance).findOneBy({ id: cmd.instanceId });
    if (!inst) return;
    const existing = this.runners.get(inst.id);
    switch (cmd.type) {
      case 'start':
        if (!existing) await this.launch(inst);
        break;
      case 'pause':
        if (existing) { await existing.stop(InstanceStatus.PAUSED).catch(() => {}); this.runners.delete(inst.id); }
        break;
      case 'stop':
        if (existing) { await existing.stop(InstanceStatus.STOPPED).catch(() => {}); this.runners.delete(inst.id); this.restarts.delete(inst.id); }
        break;
      case 'reload':
        if (existing) { await existing.stop(InstanceStatus.STOPPED).catch(() => {}); this.runners.delete(inst.id); }
        await this.launch(inst);
        break;
    }
  }

  /** Periódico: reconcilia + aplica restart policy a runners caídos. */
  private async watchTick(): Promise<void> {
    if (this.stopping) return;
    const repo = AppDataSource.getRepository(BetInstance);
    const wanted = await repo.find({ where: { desiredState: DesiredState.RUNNING } });
    const wantedIds = new Set(wanted.map((w) => w.id));

    // derruba runners não mais desejados
    for (const [id, runner] of [...this.runners]) {
      if (!wantedIds.has(id)) {
        await runner.stop(InstanceStatus.STOPPED).catch(() => {});
        this.runners.delete(id);
        this.restarts.delete(id);
      }
    }

    for (const inst of wanted) {
      const runner = this.runners.get(inst.id);
      if (runner && inst.status === InstanceStatus.RUNNING) {
        this.restarts.delete(inst.id); // saudável → zera backoff
        continue;
      }
      const dead = !runner || inst.status === InstanceStatus.ERROR || inst.status === InstanceStatus.SESSION_EXPIRED;
      if (dead && this.shouldRestart(inst)) {
        if (runner) { await runner.stop(InstanceStatus.STOPPED).catch(() => {}); }
        this.runners.delete(inst.id);
        await this.launch(inst);
      }
    }
  }

  private shouldRestart(inst: BetInstance): boolean {
    const pol = inst.config.restartPolicy;
    if (pol === RestartPolicy.NEVER) return false;
    if (inst.status === InstanceStatus.LOGIN_FAILED) return false; // credencial ruim: não martela
    if (pol === RestartPolicy.ON_FAILURE &&
        inst.status !== InstanceStatus.ERROR && inst.status !== InstanceStatus.SESSION_EXPIRED) {
      return false;
    }
    const rec = this.restarts.get(inst.id) ?? { count: 0, nextAt: 0 };
    if (Date.now() < rec.nextAt) return false;
    if (inst.config.maxRetries > 0 && rec.count >= inst.config.maxRetries) return false;
    rec.count += 1;
    rec.nextAt = Date.now() + Math.min(300_000, 1000 * 2 ** rec.count); // backoff exp, teto 5min
    this.restarts.set(inst.id, rec);
    return true;
  }
}
