/**
 * Chain-write reconciler.
 *
 * Processes chain_sync_queue: pending -> attempt write/poll receipt -> confirmed
 * or failed-with-backoff-retry. Implements exponential backoff with a max attempt
 * count before flagging a job "failed" for manual review. market_events.confirmed
 * is set to true ONLY after an actual tx receipt confirms the state change —
 * never optimistically.
 */
import { env } from "../config.js";
import { logger } from "../lib/logger.js";
import { pool, withTransaction } from "../db/pool.js";
import {
  claimNextPendingSyncJobs,
  markChainSyncConfirmed,
  markChainSyncFailed,
  markChainSyncRetry,
  setMarketContractId,
  setMarketStatus,
  insertMarketEvent,
  type ChainSyncQueueRow,
} from "../db/repositories.js";
import { genlayerClient, GenLayerNotConfiguredError, type TxReceipt } from "../genlayer/client.js";

let running = false;

function computeBackoffMs(attempts: number): number {
  // Exponential backoff with a cap, e.g. 2s, 4s, 8s, 16s ... capped at 10 minutes.
  const backoff = env.CHAIN_SYNC_BASE_BACKOFF_MS * 2 ** attempts;
  return Math.min(backoff, 10 * 60 * 1000);
}

/** Dispatches a queued job to the appropriate GenLayer client method, returning a tx hash. */
async function submitChainAction(job: ChainSyncQueueRow): Promise<{ txHash: string }> {
  const payload = job.payload as Record<string, any>;

  switch (job.action) {
    case "create_market":
      return genlayerClient.createMarket({
        question: payload.question,
        category: payload.category,
        horizonYears: payload.horizonYears,
        resolutionCriteria: payload.resolutionCriteria,
        resolvesAt: payload.resolvesAt,
        initialLiquidityGen: payload.initialLiquidityGen,
      });
    case "stake":
      return genlayerClient.stake({
        contractMarketId: payload.contractMarketId,
        side: payload.side,
        amountGen: payload.amountGen,
        wallet: payload.wallet,
      });
    case "submit_evidence_pointer":
      return genlayerClient.submitEvidencePointer({
        contractMarketId: payload.contractMarketId,
        url: payload.url,
        sourceType: payload.sourceType,
        wallet: payload.wallet,
      });
    case "request_adjudication":
      return genlayerClient.requestAdjudication({ contractMarketId: payload.contractMarketId });
    case "settle":
      return genlayerClient.settle({ contractMarketId: payload.contractMarketId });
    case "claim_payout":
      return genlayerClient.claimPayout({
        contractMarketId: payload.contractMarketId,
        wallet: payload.wallet,
      });
    case "claim_timeout_refund":
      return genlayerClient.claimTimeoutRefund({
        contractMarketId: payload.contractMarketId,
        wallet: payload.wallet,
      });
    case "cancel_market":
      return genlayerClient.cancelMarket({ contractMarketId: payload.contractMarketId });
    default:
      throw new Error(`Unknown chain_sync_queue action: ${job.action}`);
  }
}

/** Applies the confirmed side-effect of a job to Postgres once its receipt is a success. */
async function applyConfirmedEffect(job: ChainSyncQueueRow, receipt: TxReceipt): Promise<void> {
  const payload = job.payload as Record<string, any>;

  await withTransaction(async (client) => {
    switch (job.action) {
      case "create_market": {
        if (job.market_id) {
          // NOTE: contract_market_id here is a TODO(contract-wiring) placeholder —
          // once the real contract returns its assigned market id in the receipt,
          // extract it from `receipt.raw` instead of reusing the tx hash.
          const contractMarketId =
            (receipt.raw as any)?.market_id?.toString() ?? receipt.txHash;
          await setMarketContractId(job.market_id, contractMarketId, client);
          await setMarketStatus(job.market_id, "open", client);
          await insertMarketEvent(
            {
              marketId: job.market_id,
              type: "created",
              payload: { contractMarketId },
              chainTxHash: receipt.txHash,
              confirmed: true,
            },
            client
          );
        }
        break;
      }
      case "request_adjudication": {
        if (job.market_id) {
          await insertMarketEvent(
            {
              marketId: job.market_id,
              type: "verdict_pending",
              payload: {},
              chainTxHash: receipt.txHash,
              confirmed: true,
            },
            client
          );
        }
        break;
      }
      case "settle": {
        if (job.market_id) {
          await setMarketStatus(job.market_id, "settled", client);
          await insertMarketEvent(
            {
              marketId: job.market_id,
              type: "verdict_settled",
              payload: (receipt.raw as any) ?? {},
              chainTxHash: receipt.txHash,
              confirmed: true,
            },
            client
          );
        }
        break;
      }
      case "claim_payout":
      case "claim_timeout_refund": {
        if (job.market_id) {
          await insertMarketEvent(
            {
              marketId: job.market_id,
              type: "payout_claimed",
              payload: { wallet: payload.wallet, action: job.action },
              chainTxHash: receipt.txHash,
              confirmed: true,
            },
            client
          );
        }
        break;
      }
      case "cancel_market": {
        if (job.market_id) {
          await setMarketStatus(job.market_id, "cancelled", client);
        }
        break;
      }
      case "submit_evidence_pointer":
      case "stake": {
        if (job.market_id) {
          await insertMarketEvent(
            {
              marketId: job.market_id,
              type: job.action === "stake" ? "verdict_pending" : "evidence_submitted",
              payload,
              chainTxHash: receipt.txHash,
              confirmed: true,
            },
            client
          );
        }
        break;
      }
      default:
        break;
    }
  });
}

export async function processJob(job: ChainSyncQueueRow): Promise<"confirmed" | "retry" | "failed"> {
  try {
    const { txHash } = await submitChainAction(job);
    const receipt = await genlayerClient.pollReceipt(txHash);

    if (receipt.status === "success") {
      await applyConfirmedEffect(job, receipt);
      await markChainSyncConfirmed(job.id);
      return "confirmed";
    }

    if (receipt.status === "failed") {
      throw new Error(`Chain tx ${txHash} failed on-chain`);
    }

    // Still pending after poll timeout: treat as a retryable condition.
    throw new Error(`Chain tx ${txHash} did not reach a terminal state before poll timeout`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (err instanceof GenLayerNotConfiguredError) {
      logger.debug({ jobId: job.id }, "GenLayer not configured yet; leaving job pending");
      // Don't burn an attempt while the contract simply isn't deployed/wired yet.
      await markChainSyncRetry(job.id, message, new Date(Date.now() + computeBackoffMs(0)));
      return "retry";
    }

    const nextAttempts = job.attempts + 1;
    if (nextAttempts >= env.CHAIN_SYNC_MAX_ATTEMPTS) {
      await markChainSyncFailed(job.id, message);
      logger.error({ jobId: job.id, action: job.action }, "Chain sync job exceeded max attempts; flagged for manual review");
      return "failed";
    }

    const backoffMs = computeBackoffMs(job.attempts);
    await markChainSyncRetry(job.id, message, new Date(Date.now() + backoffMs));
    logger.warn({ jobId: job.id, action: job.action, backoffMs, err: message }, "Chain sync job failed; scheduled retry");
    return "retry";
  }
}

export async function runReconcilerOnce(): Promise<{ processed: number }> {
  const client = await pool.connect();
  let jobs: ChainSyncQueueRow[] = [];
  try {
    await client.query("BEGIN");
    jobs = await claimNextPendingSyncJobs(client, 10);
    // We release the row locks immediately after reading; the actual chain call
    // happens outside this transaction since it can be slow (tx polling).
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  for (const job of jobs) {
    await processJob(job);
  }

  return { processed: jobs.length };
}

export function startChainReconciler(): () => void {
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const result = await runReconcilerOnce();
      if (result.processed > 0) {
        logger.info(result, "Chain reconciler pass complete");
      }
    } catch (err) {
      logger.error({ err }, "Chain reconciler pass failed");
    } finally {
      running = false;
    }
  }, env.CHAIN_RECONCILER_INTERVAL_MS);

  timer.unref();
  return () => clearInterval(timer);
}
