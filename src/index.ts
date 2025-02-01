import "./module-alias";
import dotenv from "dotenv";
import { logger, LoggerClass } from "@Core/logger";
import { checkRedisConnection } from "@Core/redis";
import { startServer } from "@Core/server";
import { startWebSocketServer } from "@Core/websocket";

async function initializeServices() {
    try {
        logger.log("📢 Inicializando serviços do sistema...", LoggerClass.LogCategory.Server, "[ROOT]", LoggerClass.LogColor.White);

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

    } catch (error) {
        logger.error(`❌ Erro crítico na inicialização: ${(error as Error).message}`, LoggerClass.LogCategory.Server, "[ROOT]");
        process.exit(1); // Encerra o sistema em caso de erro
    }
}

// Iniciar a verificação e inicialização dos serviços
initializeServices();
