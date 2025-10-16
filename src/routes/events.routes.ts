import { Router } from "express";
import { getEvents, getEventById, getEventsStats } from "@Controllers/events.controller";

const router = Router();

/**
 * @route GET /api/events
 * @desc Buscar eventos com paginação e filtros
 * @query page, limit, search, sport, disabled, league, bookmaker
 */
router.get('/', getEvents);

/**
 * @route GET /api/events/stats
 * @desc Obter estatísticas dos eventos
 */
router.get('/stats', getEventsStats);

/**
 * @route GET /api/events/:id
 * @desc Buscar evento específico por ID
 */
router.get('/:id', getEventById);

export default router;
