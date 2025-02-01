import { logger, LoggerClass } from "@Core/logger";
import { checkRedisConnection } from "@Core/redis";
import { startServer } from "@Core/server";

async function initializeServices() {
    try {
        logger.log("📢 Inicializando serviços do sistema...", LoggerClass.LogCategory.Server, "Index", LoggerClass.LogColor.Blue);

        // 🔄 Verificar se o Redis está online
        const isRedisOnline = await checkRedisConnection();
        if (!isRedisOnline) {
            throw new Error("Redis não está disponível.");
        }

        // ✅ Iniciar o servidor Express
        logger.log("📄 Iniciando o servidor Express...", LoggerClass.LogCategory.Server, "Express", LoggerClass.LogColor.Green);
        startServer();

    } catch (error) {
        logger.error(`❌ Erro crítico na inicialização: ${(error as Error).message}`, LoggerClass.LogCategory.Server, "Index");
        process.exit(1); // Encerra o sistema em caso de erro
    }
}

// Iniciar a verificação e inicialização dos serviços
initializeServices();
