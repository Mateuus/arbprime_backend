import { FastifyInstance } from "fastify";
import {
  listLeagues, listLeagueCountries, getLeague, createLeague, updateLeague,
  addLeagueAlias, updateLeagueAlias, deleteLeagueAlias, mergeLeagues
} from "@Controllers";
import { checkAuth, checkAdmin } from "../middlewares/auth.middleware";

/**
 * Curadoria de Ligas & Aliases (tabelas canônicas `leagues` / `league_aliases` do
 * arbbetting_master). TUDO é admin-only. Registrado com prefixo /leagues.
 */
export default async function leaguesRoutes(app: FastifyInstance) {
  const admin = { preHandler: [checkAuth, checkAdmin] };

  app.get("/", admin, listLeagues);
  app.get("/countries", admin, listLeagueCountries);
  app.post("/", admin, createLeague);
  app.post("/merge", admin, mergeLeagues);
  app.get("/:id", admin, getLeague);
  app.put("/:id", admin, updateLeague);
  app.post("/:id/aliases", admin, addLeagueAlias);
  app.put("/:id/aliases/:aliasId", admin, updateLeagueAlias);
  app.delete("/:id/aliases/:aliasId", admin, deleteLeagueAlias);
}
