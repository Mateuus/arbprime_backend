import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { logger, LoggerClass } from "@Core/logger";
import routes from "@Routes";

// Carregar variáveis de ambiente
dotenv.config();

// Criar a instância do Express
const app = express();
const PORT_API = process.env.PORT_API ? parseInt(process.env.PORT_API) : 3000;

// Configurar Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

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