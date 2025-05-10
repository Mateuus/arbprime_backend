import { Router } from "express";
import { getProxyList, addProxyList, findTeamAliases, addTeamAliases, removeTeamAliases, searchEventByTeams, searchEventByBookmaker, disableBookmakerEvents, handleEventAction } from "@Controllers";
import { checkAuth } from '../middlewares/auth.middleware';

const router = Router();

router.get("/proxy/list", getProxyList);
router.post("/proxy/add-list", addProxyList);

router.get("/team/aliases/find", findTeamAliases);
router.post("/team/aliases/add", addTeamAliases);
router.delete("/team/aliases/remove", removeTeamAliases);



router.get('/event/search', checkAuth, searchEventByTeams);
router.post('/event/action', checkAuth, handleEventAction );
router.get('/event/bookmaker/search', checkAuth, searchEventByBookmaker);
router.post('/event/bookmaker/disable', checkAuth, disableBookmakerEvents);

export default router;