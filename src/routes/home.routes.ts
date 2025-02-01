import { Router } from "express";
import { homeController } from "@Controllers";

const router = Router();

router.get("/", homeController.getHome);

export default router;