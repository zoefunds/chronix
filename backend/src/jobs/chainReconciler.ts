/**
 * Chain-write reconciler — permissionless state-advance actions.
 *
 * This queue is for the two non-payable, fully-permissionless "keeper"
 * actions (request_adjudication, settle) that the backend automates using
 * its relayer account, purely as a convenience so markets don't sit stuck
 * waiting for someone to click a button — any wallet could call the same
 * methods with the same effect. The relayer-gated funding/payout mirror
 * actions (create_market, stake, claim_payout, claim_timeout_refund,
 * cancel_market) are handled by jobs/baseRelay.ts instead, since those are
 * driven by Base Sepolia escrow events, not by wall-clock deadlines.
 * Implements exponential backoff with a max attempt count before flagging a
 * job "failed" for manual review. market_events.confirmed is set to true
 * ONLY after an actual tx receipt confirms the state change — never
 * optimistically.
 */
import { env } from "../config.js";
import { logger } from "../lib/logger.js";
import { pool, withTransaction } from "../db/pool.js";
import {
  claimNextPendingSyncJobs,
  markChainSyncConfirmed,
  markChainSyncFailed,
  markChainSyncRetry,
  insertMarketEvent,
  type ChainSyncQueueRow,
} from "../db/repositories.js";
import { genlayerClient, GenLayerNotConfiguredError } from "../genlayer/client.js";

let running = false;

function computeBackoffMs(attempts: number): number {
  const backoff = env.CHAIN_SYNC_BASE_BACKOFF_MS * 2 ** attempts;
  return Math.min(backoff, 10 * 60 * 1000);
}

async function submitKeeperAction(job: ChainSyncQueueRow): Promise<{ txHash: string } | null> {
  const payload = job.payload as { contractMarketId: number | string };
  const contractMarketId = Number(payload.contractMarketId);

  switch (job.action) {
    case "request_adjudication":
      return genlayerClient.requestAdjudication(contractMarketId);
    case "settle":
      return genlayerClient.settle(contractMarketId);
    default:
      throw new Error(`Unknown chain_sync_queue action: ${job.action} (only keeper actions belong in this queue)`);
  }
}

export async function processJob(job: ChainSyncQueueRow): Promise<"confirmed" | "retry" | "failed" | "skipped"> {
  try {
    const submission = await submitKeeperAction(job);

    if (submission === null) {
      // No keeper key configured — leave pending indefinitely rather than
      // burning retry attempts; a user's own wallet calling the same
      // permissionless method will still work regardless.
      return "skipped";
    }

    const receipt = await genlayerClient.waitForReceipt(submission.txHash);
    const status = (receipt as { status?: string })?.status;

    if (status && status !== "success" && status !== "SUCCESS") {
      throw new Error(`Keeper tx ${submission.txHash} did not succeed (status=${status})`);
    }

    if (job.market_id) {
      await withTransaction(async (client) => {
        await insertMarketEvent(
          {
            marketId: job.market_id!,
            type: job.action === "request_adjudication" ? "verdict_pending" : "verdict_settled",
            payload: { txHash: submission.txHash },
            chainTxHash: submission.txHash,
            confirmed: true,
          },
          client
        );
      });
    }

    await markChainSyncConfirmed(job.id);
    return "confirmed";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (err instanceof GenLayerNotConfiguredError) {
      logger.debug({ jobId: job.id }, "GenLayer not configured yet; leaving job pending");
      await markChainSyncRetry(job.id, message, new Date(Date.now() + computeBackoffMs(0)));
      return "retry";
    }

    const nextAttempts = job.attempts + 1;
    if (nextAttempts >= env.CHAIN_SYNC_MAX_ATTEMPTS) {
      await markChainSyncFailed(job.id, message);
      logger.error({ jobId: job.id, action: job.action }, "Keeper job exceeded max attempts; flagged for manual review");
      return "failed";
    }

    const backoffMs = computeBackoffMs(job.attempts);
    await markChainSyncRetry(job.id, message, new Date(Date.now() + backoffMs));
    logger.warn({ jobId: job.id, action: job.action, backoffMs, err: message }, "Keeper job failed; scheduled retry");
    return "retry";
  }
}

export async function runReconcilerOnce(): Promise<{ processed: number }> {
  const client = await pool.connect();
  let jobs: ChainSyncQueueRow[] = [];
  try {
    await client.query("BEGIN");
    jobs = await claimNextPendingSyncJobs(client, 10);
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
