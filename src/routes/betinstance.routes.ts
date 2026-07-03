import { FastifyInstance } from "fastify";
import {
  listInstances, getInstance, createInstance, updateInstance, deleteInstance,
  startInstance, pauseInstance, stopInstance, testLogin, listInstanceEvents,
  listInstanceProxies, checkInstanceProxies, clearInstanceEvents,
  getInstanceBalance, renewInstanceSession, submitMfaCode,
} from "@Controllers";
import { checkAuth } from "../middlewares/auth.middleware";

/**
 * Instâncias de Bet (daemon por usuário que loga na casa e aposta valuebet auto).
 * User-scoped (checkAuth). Registrado com prefixo /instances. Start/Pause/Stop
 * gravam desiredState e publicam comando no Redis p/ o Bet Worker reconciliar.
 */
export default async function betInstanceRoutes(app: FastifyInstance) {
  const auth = { preHandler: [checkAuth] };

  app.get("/", auth, listInstances);
  app.post("/", auth, createInstance);
  app.get("/proxies", auth, listInstanceProxies);
  app.post("/proxies/check", auth, checkInstanceProxies);
  app.post("/test-login", auth, testLogin);
  app.get("/:id", auth, getInstance);
  app.put("/:id", auth, updateInstance);
  app.delete("/:id", auth, deleteInstance);
  app.post("/:id/start", auth, startInstance);
  app.post("/:id/pause", auth, pauseInstance);
  app.post("/:id/stop", auth, stopInstance);
  app.get("/:id/events", auth, listInstanceEvents);
  app.delete("/:id/events", auth, clearInstanceEvents);
  app.get("/:id/balance", auth, getInstanceBalance);
  app.post("/:id/renew", auth, renewInstanceSession);
  app.post("/:id/mfa", auth, submitMfaCode);
}
