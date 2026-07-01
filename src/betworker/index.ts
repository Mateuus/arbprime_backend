/**
 * Entrypoint do Bet Worker — processo PM2 SEPARADO (dist/betworker/index.js) no
 * mesmo repo/codebase do backend. Compartilha entidades/crypto/Redis/getFormatted
 * valuebets, mas roda isolado (memória/crash) da API+WS. A API não importa `betbot`,
 * então o binário Go do cycletls só sobe aqui.
 *
 * PM2: adicionar um app ao ecosystem.config.js apontando p/ este arquivo, com
 * autorestart + INSTANCE_ENC_KEY no env (senão as credenciais não decifram).
 */
import 'dotenv/config';
import { AppDataSource } from '../database/data-source';
import { initializeRedis, isRedisConnected } from '../core/redis';
import { isEncryptionConfigured } from '../utils/crypto';
import { Supervisor } from './supervisor';

async function main(): Promise<void> {
  console.log('[betworker] iniciando…');
  if (!isEncryptionConfigured()) {
    console.error('[betworker] FATAL: INSTANCE_ENC_KEY ausente — sem ela não dá p/ decifrar credenciais.');
    process.exit(1);
  }

  await AppDataSource.initialize();
  console.log('[betworker] MySQL ✅');
  await initializeRedis();
  if (!isRedisConnected()) throw new Error('Redis não conectou');
  console.log('[betworker] Redis ✅');

  const supervisor = new Supervisor();
  await supervisor.start();

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[betworker] ${sig} — encerrando runners…`);
    try { await supervisor.stop(); } catch (e) { console.error(e); }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => { console.error('[betworker] fatal no boot:', e); process.exit(1); });
