import { FastifyInstance } from "fastify";
import homeRoutes from "./home.routes";
import userRoutes from "./user.routes";
import configRoutes from "./config.routes";

export default async function routes(app: FastifyInstance) {
  app.register(homeRoutes);
  app.register(userRoutes, { prefix: "/user" });
  app.register(configRoutes, { prefix: "/config" });
}
