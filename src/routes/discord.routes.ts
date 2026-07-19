import { FastifyInstance } from "fastify";
import {
  adminDiscordHealth,
  adminSyncAllDiscordRoles,
  discordCallback,
  getDiscordStatus,
  startDiscordLink,
  syncMyDiscordRoles,
  unlinkDiscord,
} from "@Controllers";
import { checkAdmin, checkAuth } from "../middlewares/auth.middleware";

export default async function discordRoutes(app: FastifyInstance) {
  const auth = { preHandler: [checkAuth] };
  const admin = { preHandler: [checkAuth, checkAdmin] };

  app.get("/status", auth, getDiscordStatus);
  app.get("/link", auth, startDiscordLink);
  // Callback NÃO é autenticado: quem chega é o navegador vindo do Discord,
  // sem cookie garantido. A identidade vem do `state` (JWT assinado).
  app.get("/callback", discordCallback);
  app.post("/unlink", auth, unlinkDiscord);
  app.post("/sync", auth, syncMyDiscordRoles);

  app.post("/admin/sync-all", admin, adminSyncAllDiscordRoles);
  app.get("/admin/health", admin, adminDiscordHealth);
}
