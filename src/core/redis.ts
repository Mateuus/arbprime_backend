import Redis from "ioredis";
import { logger, LoggerClass } from "@Core/logger";

const redisClient = new Redis({
  host: "127.0.0.1",
  port: 6379
});

// Evento de erro no Redis
redisClient.on("error", (err) => {
  logger.error(`❌ Erro ao conectar ao Redis: ${err}`, LoggerClass.LogCategory.Database, "Redis");
});

// Verifica a conexão inicial com o Redis
export const checkRedisConnection = async (): Promise<boolean> => {
  try {
    await redisClient.ping();
    logger.log("✅ Redis está online!", LoggerClass.LogCategory.Database, "[Redis]", LoggerClass.LogColor.Magenta);
    return true;
  } catch (error) {
    logger.error("❌ Falha ao conectar ao Redis. Verifique se o servidor está rodando.", LoggerClass.LogCategory.Database, "Redis");
    return false;
  }
};

export default redisClient;