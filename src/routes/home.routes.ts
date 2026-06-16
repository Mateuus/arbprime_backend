import { FastifyInstance } from "fastify";
import { homeController } from "@Controllers";

export default async function homeRoutes(app: FastifyInstance) {
  app.get("/", homeController.getHome);
}
