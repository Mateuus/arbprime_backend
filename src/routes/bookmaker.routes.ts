import { FastifyInstance } from "fastify";
import {
  listBookmakers, addBookmaker, updateBookmaker, toggleBookmaker, deleteBookmaker
} from "@Controllers";
import { checkAuth, checkAdmin } from "../middlewares/auth.middleware";

/**
 * Casas de aposta. Leitura é pública (o app usa para exibir ícone/nome/cor);
 * as mutações exigem autenticação + role admin.
 */
export default async function bookmakerRoutes(app: FastifyInstance) {
  const admin = { preHandler: [checkAuth, checkAdmin] };

  app.get("/", listBookmakers);
  app.post("/", admin, addBookmaker);
  app.put("/:id", admin, updateBookmaker);
  app.patch("/:id/toggle", admin, toggleBookmaker);
  app.delete("/:id", admin, deleteBookmaker);
}
