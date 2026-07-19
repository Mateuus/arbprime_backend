import "./module-alias";
import cron from 'node-cron';
import path from 'path';
import dotenv from "dotenv";
import { logger, LoggerClass } from "@Core/logger";
import { initializeRedis, isRedisConnected } from "@Core/redis";
import { startServer } from "@Core/server";
import { startWebSocketServer } from "@Core/websocket";
import { LogCategory, LogColor } from '@Enums';
import EventHandler from "./schedulers/eventHandler";
import { AppDataSource } from "./database/data-source";
import { getWorkerPath } from "@utils/functions";
import { seedDefaultPlans, seedPaymentConfig, seedManualConfig } from "@utils/seed";
import { rebuildEventExclusionCache } from "@Core/eventExclusionCache";
import { bootstrapPrimeTvProvider } from "@Services/primetv/provider-client";
import { primeTvCache } from "@Services/primetv/provider-cache";

dotenv.config();

// Inicializa o EventHandler
const eventHandler = new EventHandler();

// Agendar o cron job para verificar as tarefas a cada 1 segundos
cron.schedule('*/1 * * * * *', () => {
    eventHandler.checkTasks();
});

async function eventHandlerCreate() {
    
    /*******************************************MONITOR**************************************************************/
    
    eventHandler.addTask({
        name: '[MONITOR]',
        lastExecuted: null,
        interval: 1000 * 3,  // 3 segundos
        workerPath: getWorkerPath('monitor.schedulers'),
        options: {  },
        color: LogColor.Yellow
    });

    /*******************************************MONITOR FEES*********************************************************/
    /*
    eventHandler.addTask({
        name: '[MONITOR FEES]',
        lastExecuted: null,
        interval: 1000 * 60 * 15,  // 15  minutos
        workerPath: getWorkerPath('feesmonitor.schedulers'),
        options: {  },
        color: LogColor.Yellow
    });*/
}

async function initializeServices() {
    try {
        // 🔄 Inicializar e verificar se o Redis está online
        logger.log("🔄 Inicializando Redis...", LoggerClass.LogCategory.Database, "[ROOT]", LoggerClass.LogColor.White);
        const isRedisOnline = await initializeRedis();
        if (!isRedisOnline) {
            throw new Error("Redis não está disponível.");
        }
        
        // Verificar se a instância está ativa
        if (!isRedisConnected()) {
            throw new Error("Instância do Redis não está conectada.");
        }

        // Reconstrói o cache de exclusões de eventos (Redis) a partir do banco.
        try {
            const n = await rebuildEventExclusionCache();
            logger.log(`🚫 Cache de exclusões reconstruído (${n}).`, LoggerClass.LogCategory.Database, "[EXCL]", LoggerClass.LogColor.White);
        } catch (e) {
            logger.error(`Falha ao reconstruir exclusões: ${(e as Error).message}`, LoggerClass.LogCategory.Database, "[EXCL]");
        }

        // Login no fornecedor do PrimeTV (interno/automático). Fire-and-forget: não
        // atrasa nem derruba a subida — só loga se autenticou (ou o que faltou).
        void bootstrapPrimeTvProvider();

        // Cache de eventos do PrimeTV: busca o cache do fornecedor a cada 5 min
        // (refresh imediato no start). Roda no processo principal — alimenta o
        // singleton que a API /primetv/events lê.
        primeTvCache.start();

        // ✅ Iniciar o servidor Fastify
        logger.log("📄 Iniciando o servidor Fastify...", LoggerClass.LogCategory.Server, "[ROOT]", LoggerClass.LogColor.White);
        await startServer();

        logger.log("📡 Iniciando o servidor WebSocket...", LoggerClass.LogCategory.Server, "[ROOT]", LoggerClass.LogColor.White);
        startWebSocketServer();
        if (process.env.NODE_ENV === 'production') {
            await eventHandlerCreate(); // Executa apenas em produção
            logger.log("🛠️ EventHandler carregado para ambiente de produção", LoggerClass.LogCategory.Server, "[ROOT]", LoggerClass.LogColor.Green);
          } else {
            logger.log("⚠️ EventHandler ignorado (não está em produção)", LoggerClass.LogCategory.Server, "[ROOT]", LoggerClass.LogColor.White);
          }
    } catch (error) {
        logger.error(`❌ Erro crítico na inicialização: ${(error as Error).message}`, LoggerClass.LogCategory.Server, "[ROOT]");
        process.exit(1); // Encerra o sistema em caso de erro
    }
}

// Conecta no banco com RETRY + backoff. O MySQL (.210) pode não estar pronto quando esta
// máquina sobe no boot — antes, o initialize() rejeitava, o `.catch` só logava (sem retry
// nem exit) e o REST :3000 NUNCA subia; o processo ficava "online" (vivo pelo cron acima)
// mas sem servidores, e o pm2 não reiniciava. Agora reconecta a cada `delayMs` até o banco
// responder e só então sobe Fastify + WebSocket.
async function connectDatabaseWithRetry(delayMs = 5000): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await AppDataSource.initialize();
      logger.log("📄 Banco de dados conectado com sucesso...", LoggerClass.LogCategory.Database, "[MYSQL]", LoggerClass.LogColor.Magenta);
      return;
    } catch (error) {
      logger.error(
        `❌ Falha ao conectar no banco (tentativa ${attempt}): ${(error as Error).message}. Nova tentativa em ${delayMs / 1000}s...`,
        LoggerClass.LogCategory.Database,
        "[MYSQL]"
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// Iniciar a verificação e inicialização dos serviços
connectDatabaseWithRetry()
  .then(() => {
    logger.log("📢 Inicializando serviços do sistema...", LoggerClass.LogCategory.Server, "[ROOT]", LoggerClass.LogColor.White);
    // Semeia planos padrão e config dos providers de pagamento (idempotente).
    Promise.all([seedDefaultPlans(), seedPaymentConfig(), seedManualConfig()]).catch((e) =>
      logger.error(`Seed de planos/pagamento falhou: ${(e as Error).message}`, LoggerClass.LogCategory.Database, "[SEED]")
    );
    initializeServices();
  })
  .catch((error) => {
    // O loop acima só sai em sucesso; se ainda assim cair aqui é erro inesperado —
    // encerra p/ o pm2 reiniciar, em vez de ficar zumbi sem servidores.
    logger.error(`❌ Erro fatal na inicialização do banco: ${(error as Error).message}`, LoggerClass.LogCategory.Database, "[MYSQL]");
    process.exit(1);
  });
