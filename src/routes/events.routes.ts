import { FastifyInstance } from "fastify";
import { getEvents, getEventById, getEventsStats, getEventDetails } from "@Controllers/events.controller";

export default async function eventsRoutes(app: FastifyInstance) {
  /**
   * @route GET /events
   * @desc Buscar eventos com paginação e filtros
   * @query page, limit, search, sport, disabled, league, bookmaker
   */
  app.get("/", getEvents);

  /**
   * @route GET /events/stats
   * @desc Obter estatísticas dos eventos
   */
  app.get("/stats", getEventsStats);

  /**
   * @route GET /events/:id
   * @desc Buscar evento específico por ID
   */
  app.get("/:id", getEventById);

  /**
   * @route GET /events/:id/details
   * @desc Buscar detalhes completos do evento com mercados e odds
   */
  app.get("/:id/details", getEventDetails);
}
