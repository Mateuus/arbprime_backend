import { Router } from "express";
import { registerUser, lookupCPF, loginUser,logoutAccount, getUserInfo, getUserAuth, changePassword, getUserFilters, getFilterById, createFilter, updateFilter, deleteFilter } from "@Controllers";
import { checkAuth } from '../middlewares/auth.middleware';

const UserRouter = Router();

UserRouter.post("/register", registerUser);
UserRouter.post("/lookup", lookupCPF);
UserRouter.post('/login', loginUser);
UserRouter.post('/logout', checkAuth, logoutAccount);
UserRouter.get('/info', checkAuth, getUserInfo);
UserRouter.get('/auth', checkAuth, getUserAuth);
UserRouter.put('/change-password', checkAuth, changePassword);

UserRouter.get('/abfilters/', checkAuth, getUserFilters);
UserRouter.get('/abfilters/:id', checkAuth, getFilterById);
UserRouter.post('/abfilters/', checkAuth, createFilter);
UserRouter.put('/abfilters/:id', checkAuth, updateFilter);
UserRouter.delete('/abfilters/:id', checkAuth, deleteFilter);

export default UserRouter;