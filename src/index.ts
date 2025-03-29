import "./module-alias";
import cron from 'node-cron';
import path from 'path';
import { logger, LoggerClass } from "@Core/logger";
import { checkRedisConnection } from "@Core/redis";
import { startServer } from "@Core/server";
import { startWebSocketServer } from "@Core/websocket";
import { LogCategory, LogColor } from '@Enums';
import EventHandler from "./schedulers/eventHandler";
import { AppDataSource } from "./database/data-source";
import { getWorkerPath } from "@utils/functions";

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
    eventHandler.addTask({
        name: '[MONITOR FEES]',
        lastExecuted: null,
        interval: 1000 * 60 * 15,  // 15  minutos
        workerPath: getWorkerPath('feesmonitor.schedulers'),
        options: {  },
        color: LogColor.Yellow
    });
}

async function initializeServices() {
    try {
        // 🔄 Verificar se o Redis está online
        const isRedisOnline = await checkRedisConnection();
        if (!isRedisOnline) {
            throw new Error("Redis não está disponível.");
        }

        // ✅ Iniciar o servidor Express
        logger.log("📄 Iniciando o servidor Express...", LoggerClass.LogCategory.Server, "[ROOT]", LoggerClass.LogColor.White);
        startServer();

        logger.log("📡 Iniciando o servidor WebSocket...", LoggerClass.LogCategory.Server, "[ROOT]", LoggerClass.LogColor.White);
        startWebSocketServer();
        //await eventHandlerCreate(); // Cria as tarefas do EventHandler
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
