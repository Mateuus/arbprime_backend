import { Router } from "express";
import { registerUser, loginUser,logoutAccount, getUserInfo, getUserAuth } from "@Controllers";
import { checkAuth } from '../middlewares/auth.middleware';

const UserRouter = Router();

UserRouter.post("/register", registerUser);
UserRouter.post('/login', loginUser);
UserRouter.post('/logout', checkAuth, logoutAccount);
UserRouter.get('/info', checkAuth, getUserInfo);
UserRouter.get('/auth', checkAuth, getUserAuth);

export default UserRouter;