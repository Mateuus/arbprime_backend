import { Request, Response } from "express";

export const homeController = {
  getHome: (req: Request, res: Response) => {
    res.json({ message: "Bem-vindo à API!" });
  }
};
