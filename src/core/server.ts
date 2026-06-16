/// <reference path="../types/types.d.ts" />
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import dotenv from "dotenv";
import routes from "@Routes";
import { localeHook } from "../middlewares/locale";
import { logger, LoggerClass } from "@Core/logger";
import eventsRoutes from "@Routes/events.routes";

// Carregar variáveis de ambiente
dotenv.config();

// Criar a instância do Fastify (logger próprio desativado: usamos o Winston do projeto).
// ignoreTrailingSlash mantém a leniência do Express (ex.: /abfilters == /abfilters/).
const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true } });
const PORT_API = process.env.PORT_API ? parseInt(process.env.PORT_API) : 3000;

// Lista de origens permitidas, carregadas do .env
const allowedOrigins = [
  "http://localhost:4000",
  process.env.FRONTEND_PROD_URL,
  process.env.FRONTEND_DEV_URL
].filter(Boolean) as string[];

// Os campos userData/translations/locale são atribuídos por requisição nos
// hooks/preHandlers (ver localeHook e checkAuth); os tipos vêm de types.d.ts.

// Plugins (equivalentes aos middlewares do Express)
// CORS: permite requisições sem origem (ex.: Postman) ou origens da lista
app.register(cors, {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Origin não permitida pelo CORS"), false);
    }
  },
  credentials: true,            // Permite envio de cookies e credenciais
  optionsSuccessStatus: 200     // Compatibilidade com navegadores mais antigos
});

app.register(cookie);   // req.cookies / reply.setCookie / reply.clearCookie
app.register(formbody); // suporte a application/x-www-form-urlencoded (JSON é nativo)

// Hook de tradução (equivalente ao localeMiddleware)
app.addHook("onRequest", localeHook);

// Configurar Rotas (mesmos prefixos do Express: /, /user, /config, /events)
app.register(routes);
app.register(eventsRoutes, { prefix: "/events" });

// Iniciar o Servidor
export const startServer = async () => {
  try {
    // host 0.0.0.0 para aceitar conexões externas (Express ouvia em todas as interfaces)
    await app.listen({ port: PORT_API, host: "0.0.0.0" });
    logger.log(
      `🚀 Servidor Fastify rodando na porta ${PORT_API}`,
      LoggerClass.LogCategory.Server,
      "[Fastify]",
      LoggerClass.LogColor.Red
    );
  } catch (error) {
    logger.error(
      `❌ Falha ao iniciar o servidor Fastify: ${(error as Error).message}`,
      LoggerClass.LogCategory.Server,
      "[Fastify]"
    );
    process.exit(1);
  }
};

// Exportar o app para testes e uso externo
export default app;
