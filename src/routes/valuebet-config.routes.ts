import { FastifyInstance } from "fastify";
import { getValuebetConfig, updateValuebetConfig } from "@Controllers";
import { checkAuth, checkAdmin } from "../middlewares/auth.middleware";

/**
 * Configuração runtime do motor de value bet (STRING JSON no Redis
 * `ArbPrime:Configs:ValuebetConfig`). Admin-only. Registrado com prefixo
 * /valuebet/config.
 */
export default async function valuebetConfigRoutes(app: FastifyInstance) {
  const admin = { preHandler: [checkAuth, checkAdmin] };

  app.get("/", admin, getValuebetConfig);
  app.put("/", admin, updateValuebetConfig);
}
