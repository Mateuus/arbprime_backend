import { FastifyRequest, FastifyReply } from "fastify";

export const homeController = {
  getHome: (req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ message: "Bem-vindo à API!" });
  }
};
