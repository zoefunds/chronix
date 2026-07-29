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
      requestAdjudication: vi.fn(),
      settle: vi.fn(),
      waitForReceipt: vi.fn(),
    },
  };
});

import { applyMigrations, createTestPool, resetDatabase, seedTestUser } from "./helpers/db.js";
import { genlayerClient } from "../src/genlayer/client.js";
import { enqueueChainSync, getChainSyncJob, insertMarket } from "../src/db/repositories.js";
import { processJob, runReconcilerOnce } from "../src/jobs/chainReconciler.js";
import { pool as appPool } from "../src/db/pool.js";

let pool: Pool;
const WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("chain reconciler — keeper actions (request_adjudication / settle)", () => {
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

  it("retries a failed keeper write with backoff instead of dropping it", async () => {
    const market = await insertMarket({
      question: "Will A happen?",
      category: "test",
      horizonYears: 1,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() - 1000).toISOString(),
      contractMarketId: "10",
    });

    const job = await enqueueChainSync({
      marketId: market.id,
      action: "request_adjudication",
      payload: { contractMarketId: 10 },
    });

    vi.mocked(genlayerClient.requestAdjudication).mockRejectedValue(new Error("simulated RPC failure"));

    const outcome = await processJob(job);
    expect(outcome).toBe("retry");

    const refreshed = await getChainSyncJob(job.id);
    expect(refreshed?.status).toBe("pending");
    expect(refreshed?.attempts).toBe(1);
    expect(refreshed?.last_error).toContain("simulated RPC failure");
    expect(new Date(refreshed!.next_retry_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("flags a job as failed for manual review after exceeding max attempts (never orphaned silently)", async () => {
    const market = await insertMarket({
      question: "Will B happen?",
      category: "test",
      horizonYears: 1,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() - 1000).toISOString(),
      contractMarketId: "11",
    });

    const job = await enqueueChainSync({
      marketId: market.id,
      action: "settle",
      payload: { contractMarketId: 11 },
    });

    vi.mocked(genlayerClient.settle).mockRejectedValue(new Error("persistent failure"));

    // CHAIN_SYNC_MAX_ATTEMPTS is set to 3 in tests/setup.ts
    let current = job;
    for (let i = 0; i < 3; i++) {
      await processJob(current);
      current = (await getChainSyncJob(job.id))!;
    }

    expect(current.status).toBe("failed");
    expect(current.attempts).toBeGreaterThanOrEqual(3);
  });

  it("only marks confirmed after a successful receipt (settle path)", async () => {
    const market = await insertMarket({
      question: "Will C happen?",
      category: "test",
      horizonYears: 1,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() - 1000).toISOString(),
      contractMarketId: "12",
    });

    const job = await enqueueChainSync({
      marketId: market.id,
      action: "settle",
      payload: { contractMarketId: 12 },
    });

    vi.mocked(genlayerClient.settle).mockResolvedValue({ txHash: "0xdeadbeef" });
    vi.mocked(genlayerClient.waitForReceipt).mockResolvedValue({ status: "success" } as any);

    const outcome = await processJob(job);
    expect(outcome).toBe("confirmed");

    const refreshed = await getChainSyncJob(job.id);
    expect(refreshed?.status).toBe("confirmed");
  });

  it("treats a failed on-chain receipt as retryable, not confirmed", async () => {
    const market = await insertMarket({
      question: "Will C2 happen?",
      category: "test",
      horizonYears: 1,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() - 1000).toISOString(),
      contractMarketId: "13",
    });

    const job = await enqueueChainSync({
      marketId: market.id,
      action: "settle",
      payload: { contractMarketId: 13 },
    });

    vi.mocked(genlayerClient.settle).mockResolvedValue({ txHash: "0xbadbad" });
    vi.mocked(genlayerClient.waitForReceipt).mockResolvedValue({ status: "failed" } as any);

    const outcome = await processJob(job);
    expect(outcome).toBe("retry");

    const refreshed = await getChainSyncJob(job.id);
    expect(refreshed?.status).toBe("pending");
  });

  it("skips (never burns an attempt) when no keeper key is configured", async () => {
    const market = await insertMarket({
      question: "Will D happen?",
      category: "test",
      horizonYears: 1,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() - 1000).toISOString(),
      contractMarketId: "14",
    });

    const job = await enqueueChainSync({
      marketId: market.id,
      action: "request_adjudication",
      payload: { contractMarketId: 14 },
    });

    vi.mocked(genlayerClient.requestAdjudication).mockResolvedValue(null);

    const outcome = await processJob(job);
    expect(outcome).toBe("skipped");

    const refreshed = await getChainSyncJob(job.id);
    expect(refreshed?.status).toBe("pending");
    expect(refreshed?.attempts).toBe(0);
  });

  it("runReconcilerOnce claims pending jobs without double-processing across concurrent calls", async () => {
    const market = await insertMarket({
      question: "Will E happen?",
      category: "test",
      horizonYears: 1,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() - 1000).toISOString(),
      contractMarketId: "15",
    });
    await enqueueChainSync({
      marketId: market.id,
      action: "request_adjudication",
      payload: { contractMarketId: 15 },
    });

    vi.mocked(genlayerClient.requestAdjudication).mockRejectedValue(new Error("still failing"));

    const [a, b] = await Promise.all([runReconcilerOnce(), runReconcilerOnce()]);
    // Only one of the two concurrent passes should have claimed the single job.
    expect(a.processed + b.processed).toBe(1);
  });
});
