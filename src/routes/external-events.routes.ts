import { FastifyInstance } from "fastify";
import {
  getExternalEvents,
  getGroupedEvents,
  getEventGroup,
  getExternalEventById,
  getExternalEventOdds,
  getExternalEventHistory
} from "@Controllers/external-events.controller";

/**
 * Eventos lidos do banco do arbbetting_master (somente leitura).
 * Registrado com prefixo /external/events.
 */
export default async function externalEventsRoutes(app: FastifyInstance) {
  // GET /external/events — lista paginada do catálogo cru
  app.get("/", getExternalEvents);

  // GET /external/events/grouped — lista paginada AGRUPADA (1 item por evento real)
  app.get("/grouped", getGroupedEvents);

  // GET /external/events/group/:bookmaker/:eventId — evento real (grupo) + comparação de odds entre casas
  app.get("/group/:bookmaker/:eventId", getEventGroup);

  // GET /external/events/:bookmaker/:eventId — evento + odds atuais
  app.get("/:bookmaker/:eventId", getExternalEventById);

  // GET /external/events/:bookmaker/:eventId/odds — odds atuais
  app.get("/:bookmaker/:eventId/odds", getExternalEventOdds);

  // GET /external/events/:bookmaker/:eventId/history — histórico de odds
  app.get("/:bookmaker/:eventId/history", getExternalEventHistory);
}
