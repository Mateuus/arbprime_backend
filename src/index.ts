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

// Iniciar a verificação e inicialização dos serviços
AppDataSource.initialize()
  .then(() => {
    logger.log("📢 Inicializando serviços do sistema...", LoggerClass.LogCategory.Server, "[ROOT]", LoggerClass.LogColor.White);
    logger.log("📄 Banco de dados conectado com sucesso...", LoggerClass.LogCategory.Database, "[MYSQL]", LoggerClass.LogColor.Magenta);
    initializeServices();
  })
  .catch((error) => {
    console.error("Erro ao conectar no banco de dados:", error);
});
