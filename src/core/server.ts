import express from "express";
import cors, { CorsOptions } from 'cors';
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import routes from "@Routes";
import { localeMiddleware } from "../middlewares/locale";
import { logger, LoggerClass } from "@Core/logger";

// Carregar variáveis de ambiente
dotenv.config();

// Criar a instância do Express
const app = express();
const PORT_API = process.env.PORT_API ? parseInt(process.env.PORT_API) : 3000;

// Lista de origens permitidas, carregadas do .env
const allowedOrigins = [
  "http://localhost:4000",
  process.env.FRONTEND_PROD_URL,
  process.env.FRONTEND_DEV_URL
].filter(Boolean) as string[];

// Configurações do CORS
const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
      // Permite requisições sem origem (ex.: Postman) ou se a origem está na lista permitida
      if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
      } else {
          callback(new Error('Origin não permitida pelo CORS'));
      }
  },
  credentials: true, // Permite envio de cookies e credenciais
  optionsSuccessStatus: 200 // Para compatibilidade com navegadores mais antigos
};

// Configurar Middlewares
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(localeMiddleware); // Usa o middleware de tradução

// Configurar Rotas
app.use("/", routes);

// Iniciar o Servidor
export const startServer = () => {
  app.listen(PORT_API, () => {
    logger.log(
      `🚀 Servidor Express rodando na porta ${PORT_API}`,
      LoggerClass.LogCategory.Server,
      "[Express]",
      LoggerClass.LogColor.Red
    );
  });
};

// Exportar o app para testes e uso externo
export default app;