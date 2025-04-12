import { Router } from "express";
import homeRoutes from "./home.routes";
import userRoutes from "./user.routes";
import configRouters from "./config.routes";

const router = Router();

router.use("/", homeRoutes); 
router.use("/user", userRoutes);
router.use("/config", configRouters);

export default router;