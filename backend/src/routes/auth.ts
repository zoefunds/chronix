import type { FastifyInstance } from "fastify";
import { nonceRequestSchema, siweVerifySchema } from "../schemas/index.js";

export async function authRoutes(fastify: FastifyInstance) {
  // Issue a SIWE nonce for a given wallet, to be embedded in the message the wallet signs.
  fastify.post("/auth/nonce", async (request, reply) => {
    const body = nonceRequestSchema.parse(request.body);
    const nonce = fastify.issueNonce(body.wallet);
    return reply.send({ nonce });
  });

  // Verify a signed SIWE message and issue a session JWT.
  fastify.post("/auth/verify", async (request, reply) => {
    const body = siweVerifySchema.parse(request.body);
    try {
      const { wallet } = await fastify.verifySiwe(body);
      const token = fastify.jwt.sign({ wallet });
      return reply.send({ token, wallet });
    } catch (err) {
      return reply.code(401).send({
        error: "siwe_verification_failed",
        message: err instanceof Error ? err.message : "Verification failed",
      });
    }
  });

  fastify.get("/auth/me", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    return reply.send({ wallet: request.walletAddress });
  });
}
