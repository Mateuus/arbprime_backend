import { Router } from "express";
import { getProxyList, addProxyList } from "@Controllers";
import { checkAuth } from '../middlewares/auth.middleware';

const router = Router();

router.get("/proxy/list", getProxyList);
router.post("/proxy/add-list", addProxyList);

export default router;