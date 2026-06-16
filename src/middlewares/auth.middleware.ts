/// <reference path="../types/types.d.ts" />
import { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { createResponse } from "@utils";

// Carregar variáveis de ambiente
dotenv.config();

// preHandler de autenticação do Fastify. Retornar a reply interrompe o ciclo
// da requisição (Fastify detecta que a resposta já foi enviada).
export const checkAuth = async (req: FastifyRequest, reply: FastifyReply) => {
  const token = req.cookies["MToken"];

  if (!token) {
    return reply.code(401).send(createResponse(0, "Authentication token is missing", []));
  }

  try {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new Error("JWT_SECRET is not defined");
    }

    const decodedToken = jwt.verify(token, jwtSecret) as { id: string; email: string; role: string };
    req.userData = { userId: decodedToken.id, email: decodedToken.email, role: decodedToken.role, token: token };
  } catch (error) {
    return reply.code(401).send(createResponse(0, "Invalid authentication token", []));
  }
};
