import Redis from "ioredis";
import { logger, LoggerClass } from "@Core/logger";
import dotenv from "dotenv";

// Carregar variáveis de ambiente
dotenv.config();

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379;

const redisClient = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT
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