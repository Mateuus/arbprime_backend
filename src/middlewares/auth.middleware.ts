/// <reference path="../types/types.d.ts" />
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { createResponse } from "@utils";

// Carregar variáveis de ambiente
dotenv.config();

export const checkAuth = (req: Request, res: Response, next: NextFunction) => {
  const token = req.cookies["MToken"];

  if (!token) {
    res.status(401).json(createResponse(0, "Authentication token is missing", []));
    return;
  }

  try {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new Error("JWT_SECRET is not defined");
    }

    const decodedToken = jwt.verify(token, jwtSecret) as { id: string; email: string; role: string };
    req.userData = { userId: decodedToken.id, email: decodedToken.email, role: decodedToken.role };
    next();
  } catch (error) {
   res.status(401).json(createResponse(0, "Invalid authentication token", []));
  }
};
