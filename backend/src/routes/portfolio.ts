import type { FastifyInstance } from "fastify";
import { walletParamSchema } from "../schemas/index.js";
import { listPortfolioPositionsForWallet } from "../db/repositories.js";

export async function portfolioRoutes(fastify: FastifyInstance) {
  fastify.get("/portfolio/:wallet", async (request, reply) => {
    const { wallet } = walletParamSchema.parse(request.params);
    const positions = await listPortfolioPositionsForWallet(wallet);
    return reply.send({ wallet, positions });
  });
}
