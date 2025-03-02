import { Router } from "express";
import homeRoutes from "./home.routes";
import userRoutes from "./user.routes";

const router = Router();

router.use("/", homeRoutes); 
router.use("/user", userRoutes);

export default router;