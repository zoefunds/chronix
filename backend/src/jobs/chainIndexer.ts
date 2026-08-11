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
  findKnownContractMarketIds,
  findKnownEvidenceUrls,
  insertEvidenceFromChain,
  insertMarketEvent,
  insertMarketFromChain,
  syncMarketFromChain,
  upsertUser,
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

/**
 * Backfills evidence pointers that exist on-chain but never made it into
 * Postgres — same failure shape as discoverNewMarkets, but for
 * submit_evidence_pointer: the wallet's on-chain call succeeded, the
 * follow-up POST /markets/:id/evidence didn't (commonly: GenLayer RPC's
 * request-rate limit tripped while the frontend was still polling for the
 * receipt of a *previous* evidence tx, so the mirror call for THIS one
 * never even got attempted). Cheap to skip in the common case: get_market()
 * already gave us evidenceCount for free, so we only pay for
 * get_all_evidence() when that count doesn't match what's mirrored.
 */
async function backfillEvidence(market: MarketRow, chain: ChainMarket): Promise<number> {
  if (!chain.evidenceCount) return 0;
  const known = await findKnownEvidenceUrls(market.id);
  if (known.size >= chain.evidenceCount) return 0;

  const allEvidence = await genlayerClient.getAllEvidence(Number(market.contract_market_id));
  let backfilled = 0;
  for (const e of allEvidence) {
    if (!e.url || known.has(e.url)) continue;
    const submittedBy = e.submitter.toLowerCase();
    await upsertUser(submittedBy);
    const inserted = await insertEvidenceFromChain({
      marketId: market.id,
      sourceType: e.sourceType,
      url: e.url,
      submittedBy,
    });
    if (inserted) {
      backfilled += 1;
      await insertMarketEvent({
        marketId: market.id,
        type: "evidence_submitted",
        payload: { url: e.url, sourceType: e.sourceType, backfilled: true },
        confirmed: true,
      });
    }
  }
  if (backfilled > 0) {
    logger.info({ marketId: market.id, backfilled }, "Backfilled evidence missing from DB");
  }
  return backfilled;
}

/**
 * Discovers markets that exist on-chain but were never mirrored into
 * Postgres — i.e. the user's wallet successfully called create_market, but
 * the frontend's follow-up POST /markets never landed (session token
 * expired mid-flow, network blip, tab closed). Without this pass those
 * markets would be permanently invisible: reconcileOne only ever looks at
 * rows that already exist, so a market absent from the DB never gets a
 * chance to be found by "re-reading chain state" at all.
 */
async function discoverNewMarkets(): Promise<number> {
  const count = await genlayerClient.getMarketCount();
  const known = await findKnownContractMarketIds();
  let discovered = 0;

  for (let id = 0; id < count; id++) {
    if (known.has(id)) continue;
    try {
      const chain = await genlayerClient.getMarket(id);
      // markets.created_by has a FK into users(wallet_address), which is
      // normally populated by SIWE sign-in (lowercased there — see
      // plugins/auth.ts). Chain returns a checksummed (mixed-case) address,
      // so insert must both lowercase it AND ensure the row exists, since a
      // backfilled market's creator may never have signed in on this backend.
      const createdBy = chain.creator.toLowerCase();
      await upsertUser(createdBy);
      const inserted = await insertMarketFromChain({
        contractMarketId: id,
        question: chain.question,
        category: chain.category,
        horizonYears: chain.horizonYears,
        resolutionCriteria: chain.resolutionCriteria,
        createdBy,
        resolvesAt: new Date(chain.resolvesAt * 1000).toISOString(),
        status: mapContractStatus(chain.status),
        verdict: chain.verdict || undefined,
        poolDepositedWei: chain.poolDeposited,
        totalYesWei: chain.totalYes,
        totalNoWei: chain.totalNo,
        allowedEvidenceTypes: chain.allowedEvidenceTypes || null,
      });
      if (inserted) {
        discovered += 1;
        await insertMarketEvent({
          marketId: inserted.id,
          type: "created",
          payload: { contractMarketId: id, backfilled: true },
          confirmed: true,
        });
        logger.info({ contractMarketId: id, marketId: inserted.id }, "Backfilled market missing from DB");
      }
    } catch (err) {
      if (err instanceof GenLayerNotConfiguredError) break;
      logger.error({ err, contractMarketId: id }, "Chain indexer failed to backfill market");
    }
  }

  return discovered;
}

export async function runChainIndexerOnce(): Promise<{
  checked: number;
  updated: number;
  discovered: number;
  evidenceBackfilled: number;
}> {
  if (!genlayerClient.isConfigured()) return { checked: 0, updated: 0, discovered: 0, evidenceBackfilled: 0 };

  const discovered = await discoverNewMarkets();

  const markets = await findActiveChainMarkets();
  let updated = 0;
  let evidenceBackfilled = 0;

  for (const market of markets) {
    if (!market.contract_market_id) continue;
    try {
      const chain = await genlayerClient.getMarket(Number(market.contract_market_id));
      const before = market.status;
      await reconcileOne(market, chain);
      if (before !== mapContractStatus(chain.status)) updated += 1;
      evidenceBackfilled += await backfillEvidence(market, chain);
    } catch (err) {
      if (err instanceof GenLayerNotConfiguredError) break;
      logger.error({ err, marketId: market.id }, "Chain indexer failed to read market state");
    }
  }

  return { checked: markets.length, updated, discovered, evidenceBackfilled };
}

let running = false;

export function startChainIndexer(): () => void {
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const result = await runChainIndexerOnce();
      if (result.updated > 0 || result.discovered > 0 || result.evidenceBackfilled > 0) {
        logger.info(result, "Chain indexer pass complete");
      }
    } catch (err) {
      logger.error({ err }, "Chain indexer pass failed");
    } finally {
      running = false;
    }
  }, env.CHAIN_RECONCILER_INTERVAL_MS);

  timer.unref();
  return () => clearInterval(timer);
}
