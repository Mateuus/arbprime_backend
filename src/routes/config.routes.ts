import { Router } from "express";
import { getProxyList, addProxyList, findTeamAliases, addTeamAliases, removeTeamAliases } from "@Controllers";
import { checkAuth } from '../middlewares/auth.middleware';

const router = Router();

router.get("/proxy/list", getProxyList);
router.post("/proxy/add-list", addProxyList);

router.get("/team/aliases/find", findTeamAliases);
router.post("/team/aliases/add", addTeamAliases);
router.delete("/team/aliases/remove", removeTeamAliases);

export default router;