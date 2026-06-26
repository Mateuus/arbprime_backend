import { FastifyInstance } from "fastify";
import { listHidden, addHidden, removeHidden, clearHidden } from "@Controllers";
import { checkAuth } from "../middlewares/auth.middleware";

/**
 * Itens ocultados por usuário (preferência pessoal). Tudo autenticado. Prefixo /hidden.
 */
export default async function hiddenRoutes(app: FastifyInstance) {
  const auth = { preHandler: checkAuth };

  app.get("/", auth, listHidden);
  app.post("/", auth, addHidden);
  app.delete("/clear", auth, clearHidden);
  app.delete("/:id", auth, removeHidden);
  app.delete("/", auth, removeHidden);
}
