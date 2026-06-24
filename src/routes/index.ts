import { FastifyInstance } from "fastify";
import homeRoutes from "./home.routes";
import userRoutes from "./user.routes";
import configRoutes from "./config.routes";
import proxyRoutes from "./proxy.routes";
import bookmakerRoutes from "./bookmaker.routes";
import teamsRoutes from "./teams.routes";
import leaguesRoutes from "./leagues.routes";
import marketsRoutes from "./markets.routes";

export default async function routes(app: FastifyInstance) {
  app.register(homeRoutes);
  app.register(userRoutes, { prefix: "/user" });
  app.register(configRoutes, { prefix: "/config" });
  app.register(proxyRoutes, { prefix: "/proxy" });
  app.register(bookmakerRoutes, { prefix: "/bookmaker" });
  app.register(teamsRoutes, { prefix: "/teams" });
  app.register(leaguesRoutes, { prefix: "/leagues" });
  app.register(marketsRoutes, { prefix: "/markets" });
}
