import { FastifyInstance } from "fastify";
import { getProxyList, addProxyList, findTeamAliases, addTeamAliases, removeTeamAliases, searchEventByTeams, searchEventByBookmaker, disableBookmakerEvents, handleEventAction } from "@Controllers";
import { checkAuth } from "../middlewares/auth.middleware";

export default async function configRoutes(app: FastifyInstance) {
  app.get("/proxy/list", getProxyList);
  app.post("/proxy/add-list", addProxyList);

  app.get("/team/aliases/find", findTeamAliases);
  app.post("/team/aliases/add", addTeamAliases);
  app.delete("/team/aliases/remove", removeTeamAliases);

  app.get("/event/search", { preHandler: checkAuth }, searchEventByTeams);
  app.post("/event/action", { preHandler: checkAuth }, handleEventAction);
  app.get("/event/bookmaker/search", { preHandler: checkAuth }, searchEventByBookmaker);
  app.post("/event/bookmaker/disable", { preHandler: checkAuth }, disableBookmakerEvents);
}
