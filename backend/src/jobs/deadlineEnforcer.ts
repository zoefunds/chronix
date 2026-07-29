/**
 * Deadline enforcer.
 *
 * Runs every DEADLINE_ENFORCER_INTERVAL_MS (default 60s). Finds markets whose
 * resolves_at has passed by wall clock but that haven't been flipped to
 * awaiting_adjudication yet. Wall clock alone is NEVER sufficient — the
 * contract itself enforces the deadline, so the backend confirms via the
 * GenLayer client's on-chain deadline-check before flipping local status.
 * This prevents the backend from racing ahead of chain truth.
 */
import { env } from "../config.js";
import { logger } from "../lib/logger.js";
import { genlayerClient, GenLayerNotConfiguredError } from "../genlayer/client.js";
import {
  enqueueChainSync,
  findMarketsPastDeadline,
  insertMarketEvent,
  markDeadlineEnforced,
} from "../db/repositories.js";
import { withTransaction } from "../db/pool.js";

let running = false;

export async function runDeadlineEnforcerOnce(): Promise<{ checked: number; enforced: number }> {
  const candidates = await findMarketsPastDeadline();
  let enforced = 0;

  for (const market of candidates) {
    if (!market.contract_market_id) {
      // Market creation hasn't even been chain-confirmed yet; nothing to enforce.
      logger.debug({ marketId: market.id }, "Skipping deadline check: no contract_market_id yet");
      continue;
    }

    try {
      const chainState = await genlayerClient.getMarketChainState(market.contract_market_id);

      if (!chainState.resolvesAtPassed) {
        // Wall clock says it's past due, but the contract disagrees (e.g. clock skew,
        // or the contract simply hasn't observed it yet). Do not flip — trust the chain.
        logger.info(
          { marketId: market.id },
          "Wall clock past resolves_at but chain has not confirmed deadline; deferring"
        );
        continue;
      }

      await withTransaction(async (client) => {
        await markDeadlineEnforced(market.id, client);
        await insertMarketEvent(
          {
            marketId: market.id,
            type: "deadline_passed",
            payload: { chainConfirmed: true },
            confirmed: true,
          },
          client
        );
        await enqueueChainSync(
          {
            marketId: market.id,
            action: "request_adjudication",
            payload: { contractMarketId: market.contract_market_id },
          },
          client
        );
      });

      enforced += 1;
      logger.info({ marketId: market.id }, "Market deadline enforced; awaiting adjudication");
    } catch (err) {
      if (err instanceof GenLayerNotConfiguredError) {
        logger.warn("GenLayer not configured yet — deadline enforcer cannot verify on-chain state");
        break; // no point checking further candidates this pass
      }
      logger.error({ err, marketId: market.id }, "Deadline enforcer failed to check on-chain state");
    }
  }

  return { checked: candidates.length, enforced };
}

export function startDeadlineEnforcer(): () => void {
  const timer = setInterval(async () => {
    if (running) return; // avoid overlapping runs if a pass takes longer than the interval
    running = true;
    try {
      const result = await runDeadlineEnforcerOnce();
      if (result.checked > 0) {
        logger.info(result, "Deadline enforcer pass complete");
      }
    } catch (err) {
      logger.error({ err }, "Deadline enforcer pass failed");
    } finally {
      running = false;
    }
  }, env.DEADLINE_ENFORCER_INTERVAL_MS);

  timer.unref();
  return () => clearInterval(timer);
}
