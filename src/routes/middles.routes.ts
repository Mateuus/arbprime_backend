import { FastifyInstance } from "fastify";
import { middlesController } from "@Controllers";
import { checkAuth } from "../middlewares/auth.middleware";

/**
 * Middles (apostas de intervalo) — leitura GATED (exige login, como surebets e
 * value bets). O consumo em tempo real é via WebSocket (método `middles`); estas
 * rotas REST são a leitura pontual equivalente.
 */
export default async function middlesRoutes(app: FastifyInstance) {
  const auth = { preHandler: [checkAuth] };

  app.get("/", auth, middlesController.getMiddles);
  app.get("/:groupId", auth, middlesController.getMiddleByGroupId);
}
