import { FastifyInstance } from "fastify";
import { listMarketNames, upsertMarketName, bulkUpsertMarketNames, updateMarketName, deleteMarketName } from "@Controllers";
import { checkAuth, checkAdmin } from "../middlewares/auth.middleware";

/**
 * Curadoria dos nomes de mercado por casa (tabela `bookmaker_market_names` do
 * arbbetting_master). TUDO é admin-only. Registrado com prefixo /markets.
 */
export default async function marketsRoutes(app: FastifyInstance) {
  const admin = { preHandler: [checkAuth, checkAdmin] };

  app.get("/", admin, listMarketNames);
  app.post("/", admin, upsertMarketName);
  app.post("/bulk", admin, bulkUpsertMarketNames);
  app.put("/:id", admin, updateMarketName);
  app.delete("/:id", admin, deleteMarketName);
}
