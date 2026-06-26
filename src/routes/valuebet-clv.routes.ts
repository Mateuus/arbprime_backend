import { FastifyInstance } from "fastify";
import { getClvSummary, getClvBreakdown, getJuiceBreakdown, getClvTimeseries, getClvPending } from "@Controllers";
import { checkAuth } from "../middlewares/auth.middleware";

/**
 * Dashboard de CLV / performance dos value bets (lê `valuebet_emissions` do
 * arbbetting_master via ExternalDataSource). Exige login. Prefixo /valuebet/clv.
 */
export default async function valuebetClvRoutes(app: FastifyInstance) {
  const auth = { preHandler: [checkAuth] };

  app.get("/summary", auth, getClvSummary);
  app.get("/breakdown", auth, getClvBreakdown);
  app.get("/juice", auth, getJuiceBreakdown);
  app.get("/timeseries", auth, getClvTimeseries);
  app.get("/pending", auth, getClvPending);
}
