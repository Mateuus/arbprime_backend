/// <reference path="../types/types.d.ts" />
import { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { createResponse } from "@utils";
import { AppDataSource } from "@Database";
import { User } from "@Entities";
import { resolveUserAccess } from "@Services/subscription.service";

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

// preHandler de auth OPCIONAL: se houver cookie válido, popula req.userData;
// se não houver (ou for inválido), segue como anônimo. NUNCA rejeita.
// Usado em rotas públicas que personalizam o retorno para quem está logado.
export const optionalAuth = async (req: FastifyRequest) => {
  const token = req.cookies["MToken"];
  if (!token) return;
  try {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) return;
    const decodedToken = jwt.verify(token, jwtSecret) as { id: string; email: string; role: string };
    req.userData = { userId: decodedToken.id, email: decodedToken.email, role: decodedToken.role, token: token };
  } catch {
    /* anônimo */
  }
};

// preHandler de autorização: exige role 'admin' (use depois de checkAuth).
// IMPORTANTE: valida o papel DIRETO NO BANCO (fonte da verdade), não pelo JWT.
// O token guarda o role do momento do login (validade 24h); se confiássemos nele,
// promover/rebaixar um usuário no banco só valeria após relogar. Lendo do banco,
// a mudança vale na hora — e um admin rebaixado perde o acesso imediatamente.
export const checkAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
  const denied = () => reply.code(403).send(createResponse(0, "Acesso restrito a administradores", []));
  if (!req.userData?.userId) return denied();

  try {
    const user = await AppDataSource.getRepository(User).findOneBy({ id: req.userData.userId });
    if (!user || user.role !== "admin") return denied();
    // Mantém o role coerente com o banco para o resto do request.
    req.userData.role = user.role;
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao validar permissão de administrador.", { error: (error as Error).message }));
  }
};

// Fábrica de preHandler de autorização por NÍVEL do plano (use depois de checkAuth).
// Ex.: `{ preHandler: [checkAuth, requireLevel(3)] }`.
//
// O nível vem de `resolveUserAccess`, e não de `User.level` direto nem do JWT:
// ela é a fonte da verdade — expira em lote as assinaturas vencidas ANTES de
// decidir e devolve o maior nível ainda ativo. Ler a coluna crua deixaria passar
// quem tem plano vencido mas ainda não "tocado"; ler o JWT congelaria o nível no
// momento do login (token vale 24h).
//
// Nega com 403 + `{ premium: true, ... }` — mesma convenção do gate de banca do
// Analytix, que o frontend já usa para abrir o upsell de plano.
export const requireLevel = (minLevel: number) => async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;
  if (!userId) {
    return reply.code(401).send(createResponse(0, "Não autenticado.", []));
  }

  try {
    const access = await resolveUserAccess(userId);
    if ((access.level ?? 0) < minLevel) {
      return reply.code(403).send(
        createResponse(0, `Este recurso é exclusivo do plano nível ${minLevel}. Faça um upgrade para liberar.`, {
          premium: true,
          level: access.level ?? 0,
          requiredLevel: minLevel,
        }),
      );
    }
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao validar o nível do plano.", { error: (error as Error).message }));
  }
};
