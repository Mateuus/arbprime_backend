import { FastifyInstance } from "fastify";
import {
  listTeams, getTeam, createTeam, updateTeam, addAlias, updateAlias, deleteAlias, mergeTeams,
  searchSofascore, backfillSofascore, reconcileCatalog
} from "@Controllers";
import { checkAuth, checkAdmin } from "../middlewares/auth.middleware";

/**
 * Curadoria de Times & Aliases (tabelas canônicas `teams` / `team_aliases` do
 * arbbetting_master). TUDO é admin-only — é dado que dirige o casamento de
 * eventos. Registrado com prefixo /teams.
 */
export default async function teamsRoutes(app: FastifyInstance) {
  const admin = { preHandler: [checkAuth, checkAdmin] };

  app.get("/", admin, listTeams);
  app.post("/", admin, createTeam);
  app.post("/merge", admin, mergeTeams);
  // Reconciliação do catálogo a partir do event match (odds_events/event_groups).
  app.post("/reconcile", admin, reconcileCatalog);
  // SoFaScore (enriquecimento do crest/logo) — estáticas ANTES de /:id.
  app.get("/sofascore/search", admin, searchSofascore);
  app.post("/sofascore/backfill", admin, backfillSofascore);
  app.get("/:id", admin, getTeam);
  app.put("/:id", admin, updateTeam);
  app.post("/:id/aliases", admin, addAlias);
  app.put("/:id/aliases/:aliasId", admin, updateAlias);
  app.delete("/:id/aliases/:aliasId", admin, deleteAlias);
}
