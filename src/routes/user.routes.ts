import { Router } from "express";
import { registerUser, lookupCPF, loginUser,logoutAccount, getUserInfo, getUserAuth, changePassword } from "@Controllers";
import { checkAuth } from '../middlewares/auth.middleware';

const UserRouter = Router();

UserRouter.post("/register", registerUser);
UserRouter.post("/lookup", lookupCPF);
UserRouter.post('/login', loginUser);
UserRouter.post('/logout', checkAuth, logoutAccount);
UserRouter.get('/info', checkAuth, getUserInfo);
UserRouter.get('/auth', checkAuth, getUserAuth);
UserRouter.put('/change-password', checkAuth, changePassword);

export default UserRouter;