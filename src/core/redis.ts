import Redis from "ioredis";
import { logger, LoggerClass } from "@Core/logger";
import dotenv from "dotenv";

// Carregar variáveis de ambiente
dotenv.config();

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379;

/**
 * Classe Singleton para gerenciar a instância única do Redis
 */
class RedisManager {
  private static instance: RedisManager;
  private redisClient: Redis | null = null;
  private isConnected: boolean = false;

  private constructor() {}

  /**
   * Obtém a instância única do RedisManager
   */
  public static getInstance(): RedisManager {
    if (!RedisManager.instance) {
      RedisManager.instance = new RedisManager();
    }
    return RedisManager.instance;
  }

  /**
   * Inicializa a conexão com o Redis
   */
  public async initialize(): Promise<boolean> {
    try {
      if (this.redisClient && this.isConnected) {
        return true;
      }

      this.redisClient = new Redis({
        host: REDIS_HOST,
        port: REDIS_PORT,
        maxRetriesPerRequest: 3,
        lazyConnect: true
      });

      // Evento de erro no Redis
      this.redisClient.on("error", (err) => {
        logger.error(`❌ Erro ao conectar ao Redis: ${err}`, LoggerClass.LogCategory.Database, "Redis");
        this.isConnected = false;
      });

      // Evento de conexão bem-sucedida
      this.redisClient.on("connect", () => {
        logger.log("✅ Redis conectado com sucesso!", LoggerClass.LogCategory.Database, "[Redis]", LoggerClass.LogColor.Magenta);
        this.isConnected = true;
      });

      // Evento de reconexão
      this.redisClient.on("reconnecting", () => {
        logger.log("🔄 Redis reconectando...", LoggerClass.LogCategory.Database, "[Redis]", LoggerClass.LogColor.Yellow);
      });

      // Conectar ao Redis
      await this.redisClient.connect();
      
      // Verificar conexão com ping
      await this.redisClient.ping();
      
      this.isConnected = true;
      return true;
    } catch (error) {
      logger.error("❌ Falha ao inicializar Redis. Verifique se o servidor está rodando.", LoggerClass.LogCategory.Database, "Redis");
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Obtém a instância do cliente Redis
   */
  public getClient(): Redis {
    if (!this.redisClient || !this.isConnected) {
      throw new Error("Redis não está inicializado ou conectado. Chame initialize() primeiro.");
    }
    return this.redisClient;
  }

  /**
   * Verifica se o Redis está conectado
   */
  public isRedisConnected(): boolean {
    return this.isConnected && this.redisClient !== null;
  }

  /**
   * Fecha a conexão com o Redis
   */
  public async disconnect(): Promise<void> {
    if (this.redisClient) {
      await this.redisClient.disconnect();
      this.isConnected = false;
      logger.log("🔌 Redis desconectado", LoggerClass.LogCategory.Database, "[Redis]", LoggerClass.LogColor.Yellow);
    }
  }
}

// Instância única do RedisManager
const redisManager = RedisManager.getInstance();

// Verifica a conexão inicial com o Redis
export const checkRedisConnection = async (): Promise<boolean> => {
  return await redisManager.initialize();
};

// Obtém a instância do cliente Redis
export const getRedisClient = (): Redis => {
  return redisManager.getClient();
};

// Verifica se o Redis está conectado
export const isRedisConnected = (): boolean => {
  return redisManager.isRedisConnected();
};

// Inicializa o Redis
export const initializeRedis = async (): Promise<boolean> => {
  return await redisManager.initialize();
};

// Desconecta o Redis
export const disconnectRedis = async (): Promise<void> => {
  return await redisManager.disconnect();
};

// Exporta a instância do RedisManager para compatibilidade
export default redisManager;