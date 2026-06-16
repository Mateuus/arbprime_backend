import { FastifyInstance } from "fastify";
import { registerUser, lookupCPF, loginUser, logoutAccount, getUserInfo, getUserAuth, changePassword, getUserFilters, getFilterById, createFilter, updateFilter, deleteFilter } from "@Controllers";
import { checkAuth } from "../middlewares/auth.middleware";

export default async function userRoutes(app: FastifyInstance) {
  app.post("/register", registerUser);
  app.post("/lookup", lookupCPF);
  app.post("/login", loginUser);
  app.post("/logout", { preHandler: checkAuth }, logoutAccount);
  app.get("/info", { preHandler: checkAuth }, getUserInfo);
  app.get("/auth", { preHandler: checkAuth }, getUserAuth);
  app.put("/change-password", { preHandler: checkAuth }, changePassword);

  app.get("/abfilters", { preHandler: checkAuth }, getUserFilters);
  app.get("/abfilters/:id", { preHandler: checkAuth }, getFilterById);
  app.post("/abfilters", { preHandler: checkAuth }, createFilter);
  app.put("/abfilters/:id", { preHandler: checkAuth }, updateFilter);
  app.delete("/abfilters/:id", { preHandler: checkAuth }, deleteFilter);
}
