import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

vi.mock("../src/genlayer/client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/genlayer/client.js")>(
    "../src/genlayer/client.js"
  );
  return {
    ...actual,
    genlayerClient: {
      ...actual.genlayerClient,
      isConfigured: () => true,
      createMarket: vi.fn(),
      claimTimeoutRefund: vi.fn(),
      pollReceipt: vi.fn(),
    },
  };
});

import { applyMigrations, createTestPool, resetDatabase, seedTestUser } from "./helpers/db.js";
import { genlayerClient } from "../src/genlayer/client.js";
import {
  enqueueChainSync,
  getChainSyncJob,
  getMarketById,
  insertMarket,
} from "../src/db/repositories.js";
import { processJob, runReconcilerOnce } from "../src/jobs/chainReconciler.js";
import { pool as appPool } from "../src/db/pool.js";

let pool: Pool;
const WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("chain-write reconciler", () => {
  beforeAll(async () => {
    pool = createTestPool();
    await applyMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
    await appPool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await seedTestUser(pool, WALLET);
    vi.clearAllMocks();
  });

  it("retries a failed chain write with backoff instead of dropping it", async () => {
    const market = await insertMarket({
      question: "Will A happen?",
      category: "test",
      horizonYears: 1,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() + 1000).toISOString(),
    });

    const job = await enqueueChainSync({
      marketId: market.id,
      action: "create_market",
      payload: {
        question: market.question,
        category: market.category,
        horizonYears: 1,
        resolutionCriteria: "criteria",
        resolvesAt: market.resolves_at,
        initialLiquidityGen: "1.0",
      },
    });

    vi.mocked(genlayerClient.createMarket).mockRejectedValue(new Error("simulated RPC failure"));

    const outcome = await processJob(job);
    expect(outcome).toBe("retry");

    const refreshed = await getChainSyncJob(job.id);
    expect(refreshed?.status).toBe("pending");
    expect(refreshed?.attempts).toBe(1);
    expect(refreshed?.last_error).toContain("simulated RPC failure");
    expect(new Date(refreshed!.next_retry_at).getTime()).toBeGreaterThan(Date.now());

    // Market must not be silently marked open/confirmed on a failed chain write —
    // it should still be pending_chain (never orphaned as "confirmed").
    const marketAfter = await getMarketById(market.id);
    expect(marketAfter?.status).toBe("pending_chain");
    expect(marketAfter?.contract_market_id).toBeNull();
  });

  it("flags a job as failed for manual review after exceeding max attempts", async () => {
    const market = await insertMarket({
      question: "Will B happen?",
      category: "test",
      horizonYears: 1,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() + 1000).toISOString(),
    });

    const job = await enqueueChainSync({
      marketId: market.id,
      action: "create_market",
      payload: { initialLiquidityGen: "1.0" },
    });

    vi.mocked(genlayerClient.createMarket).mockRejectedValue(new Error("persistent failure"));

    // CHAIN_SYNC_MAX_ATTEMPTS is set to 3 in tests/setup.ts
    let current = job;
    for (let i = 0; i < 3; i++) {
      await processJob(current);
      current = (await getChainSyncJob(job.id))!;
    }

    expect(current.status).toBe("failed");
    expect(current.attempts).toBeGreaterThanOrEqual(3);
  });

  it("only marks confirmed after a successful receipt, and reaches the timeout-reclaim path", async () => {
    const market = await insertMarket({
      question: "Will C happen?",
      category: "test",
      horizonYears: 1,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() - 1000).toISOString(),
    });

    const job = await enqueueChainSync({
      marketId: market.id,
      action: "claim_timeout_refund",
      payload: { wallet: WALLET, contractMarketId: "chain-market-c" },
    });

    vi.mocked(genlayerClient.claimTimeoutRefund).mockResolvedValue({ txHash: "0xdeadbeef" });
    vi.mocked(genlayerClient.pollReceipt).mockResolvedValue({
      txHash: "0xdeadbeef",
      status: "success",
    });

    const outcome = await processJob(job);
    expect(outcome).toBe("confirmed");

    const refreshed = await getChainSyncJob(job.id);
    expect(refreshed?.status).toBe("confirmed");
  });

  it("runReconcilerOnce claims pending jobs without double-processing across concurrent calls", async () => {
    const market = await insertMarket({
      question: "Will D happen?",
      category: "test",
      horizonYears: 1,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() + 1000).toISOString(),
    });
    await enqueueChainSync({
      marketId: market.id,
      action: "create_market",
      payload: { initialLiquidityGen: "1.0" },
    });

    vi.mocked(genlayerClient.createMarket).mockRejectedValue(new Error("still failing"));

    const [a, b] = await Promise.all([runReconcilerOnce(), runReconcilerOnce()]);
    // Only one of the two concurrent passes should have claimed the single job.
    expect(a.processed + b.processed).toBe(1);
  });
});
