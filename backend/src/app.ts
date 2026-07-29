import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import { corsOrigins, env } from "./config.js";
import { authPlugin } from "./plugins/auth.js";
import { errorHandlerPlugin } from "./plugins/errorHandler.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { marketsRoutes } from "./routes/markets.js";
import { portfolioRoutes } from "./routes/portfolio.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
          : undefined,
    },
    trustProxy: true,
  });

  await app.register(sensible);
  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
  });
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: "1 minute",
  });

  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(marketsRoutes);
  await app.register(portfolioRoutes);

  return app;
}

export { env };
