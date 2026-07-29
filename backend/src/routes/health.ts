import type { FastifyInstance } from "fastify";
import { checkDbHealth } from "../db/pool.js";
import { genlayerClient } from "../genlayer/client.js";

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get("/health", async (request, reply) => {
    const dbOk = await checkDbHealth();
    const body = {
      status: dbOk ? "ok" : "degraded",
      db: dbOk ? "up" : "down",
      genlayerConfigured: genlayerClient.isConfigured(),
      timestamp: new Date().toISOString(),
    };
    // Fly.io health checks expect a non-2xx on failure to trigger restarts.
    return reply.code(dbOk ? 200 : 503).send(body);
  });
}
