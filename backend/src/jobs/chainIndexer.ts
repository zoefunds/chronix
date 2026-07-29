/**
 * Chain indexer / reconciler.
 *
 * Periodically re-reads every market's on-chain state directly from
 * get_market() and syncs Postgres to match. This is what keeps the DB from
 * silently diverging from chain truth when a state transition happens
 * on-chain without going through this backend at all (e.g. a user's wallet
 * calling claim_payout directly) — the Event-Weaver lesson recorded in
 * MEMORY.md. Postgres is a read cache for the UI; get_market() is the only
 * source of truth for "is this market actually settled."
 */
import { logger } from "../lib/logger.js";
import { env } from "../config.js";
import { genlayerClient, GenLayerNotConfiguredError, type ChainMarket } from "../genlayer/client.js";
import {
  enqueueChainSync,
  findActiveChainMarkets,
  insertMarketEvent,
  syncMarketFromChain,
  type MarketRow,
  type MarketStatus,
} from "../db/repositories.js";

function mapContractStatus(chainStatus: string): MarketStatus {
  switch (chainStatus) {
    case "active":
      return "open";
    case "awaiting_adjudication":
      return "awaiting_adjudication";
    case "settled_yes":
    case "settled_no":
    case "settled_split":
      return "settled";
    case "refunded_timeout":
    case "cancelled":
      return "cancelled";
    default:
      return "open";
  }
}

async function reconcileOne(market: MarketRow, chain: ChainMarket): Promise<void> {
  const mapped = mapContractStatus(chain.status);

  // Financial figures (stake totals, pool) can change every single stake tx,
  // independent of a status transition — sync them every pass, not just when
  // status changes, so the Discover/MarketDetail UI never shows stale totals.
  await syncMarketFromChain(market.id, {
    status: mapped,
    verdict: chain.verdict || undefined,
    poolDepositedWei: chain.poolDeposited,
    totalYesWei: chain.totalYes,
    totalNoWei: chain.totalNo,
  });

  if (mapped === market.status) return;

  if (chain.status === "awaiting_adjudication") {
    // Deadline was just confirmed passed (by this or another wallet's
    // request_adjudication call) — queue the keeper to attempt settle().
    // Non-payable, permissionless, safe to enqueue repeatedly: settle()
    // itself rejects if called on a market that isn't awaiting_adjudication.
    await enqueueChainSync({
      marketId: market.id,
      action: "settle",
      payload: { contractMarketId: Number(market.contract_market_id) },
    });
  }

  if (chain.status.startsWith("settled_") && chain.verdict) {
    await insertMarketEvent({
      marketId: market.id,
      type: "verdict_settled",
      payload: { verdict: chain.verdict, contractStatus: chain.status },
      confirmed: true,
    });
  } else {
    await insertMarketEvent({
      marketId: market.id,
      type: "reconciled",
      payload: { fromStatus: market.status, toStatus: mapped, contractStatus: chain.status },
      confirmed: true,
    });
  }

  logger.info(
    { marketId: market.id, contractMarketId: market.contract_market_id, from: market.status, to: mapped },
    "Market reconciled from chain"
  );
}

export async function runChainIndexerOnce(): Promise<{ checked: number; updated: number }> {
  if (!genlayerClient.isConfigured()) return { checked: 0, updated: 0 };

  const markets = await findActiveChainMarkets();
  let updated = 0;

  for (const market of markets) {
    if (!market.contract_market_id) continue;
    try {
      const chain = await genlayerClient.getMarket(Number(market.contract_market_id));
      const before = market.status;
      await reconcileOne(market, chain);
      if (before !== mapContractStatus(chain.status)) updated += 1;
    } catch (err) {
      if (err instanceof GenLayerNotConfiguredError) break;
      logger.error({ err, marketId: market.id }, "Chain indexer failed to read market state");
    }
  }

  return { checked: markets.length, updated };
}

let running = false;

export function startChainIndexer(): () => void {
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const result = await runChainIndexerOnce();
      if (result.updated > 0) logger.info(result, "Chain indexer pass complete");
    } catch (err) {
      logger.error({ err }, "Chain indexer pass failed");
    } finally {
      running = false;
    }
  }, env.CHAIN_RECONCILER_INTERVAL_MS);

  timer.unref();
  return () => clearInterval(timer);
}
