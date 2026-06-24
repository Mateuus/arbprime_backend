import { FastifyInstance } from "fastify";
import {
  listProxies, syncProvider, addProxy, bulkAddProxies, updateProxy, toggleProxy, testProxy, deleteProxy,
  residentPackageInfo, residentListsInfo, importResidentList, renameResidentListHandler, deleteResidentListHandler,
  residentGeoCountries, createResidentListHandler
} from "@Controllers";
import { checkAuth, checkAdmin } from "../middlewares/auth.middleware";

// Todas as rotas de proxy exigem autenticação + role admin.
export default async function proxyRoutes(app: FastifyInstance) {
  const admin = { preHandler: [checkAuth, checkAdmin] };

  app.get("/", admin, listProxies);
  app.post("/sync", admin, syncProvider);

  // Residencial (Proxy-Seller) — registrar antes de "/:id" para não colidir.
  app.get("/resident/package", admin, residentPackageInfo);
  app.get("/resident/lists", admin, residentListsInfo);
  app.get("/resident/geo", admin, residentGeoCountries);
  app.post("/resident/import", admin, importResidentList);
  app.post("/resident/list/create", admin, createResidentListHandler);
  app.post("/resident/list/rename", admin, renameResidentListHandler);
  app.delete("/resident/list/:id", admin, deleteResidentListHandler);

  app.post("/", admin, addProxy);
  app.post("/bulk", admin, bulkAddProxies);
  app.put("/:id", admin, updateProxy);
  app.patch("/:id/toggle", admin, toggleProxy);
  app.post("/:id/test", admin, testProxy);
  app.delete("/:id", admin, deleteProxy);
}
