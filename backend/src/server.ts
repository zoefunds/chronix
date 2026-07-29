import { buildApp } from "./app.js";
import { env } from "./config.js";
import { logger } from "./lib/logger.js";
import { startDeadlineEnforcer } from "./jobs/deadlineEnforcer.js";
import { startChainReconciler } from "./jobs/chainReconciler.js";
import { pool } from "./db/pool.js";

async function main() {
  const app = await buildApp();

  const stopDeadlineEnforcer = startDeadlineEnforcer();
  const stopChainReconciler = startChainReconciler();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down gracefully");
    stopDeadlineEnforcer();
    stopChainReconciler();
    try {
      await app.close();
      await pool.end();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info({ port: env.PORT }, "EchoMarkets backend listening");
}

main().catch((err) => {
  logger.error({ err }, "Fatal error during startup");
  process.exit(1);
});
