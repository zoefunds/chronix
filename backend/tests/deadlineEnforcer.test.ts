import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

// Mock the GenLayer client BEFORE importing anything that transitively imports it,
// so the deadline enforcer never makes real network calls in tests.
vi.mock("../src/genlayer/client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/genlayer/client.js")>(
    "../src/genlayer/client.js"
  );
  return {
    ...actual,
    genlayerClient: {
      ...actual.genlayerClient,
      isConfigured: () => true,
      getMarketChainState: vi.fn(),
    },
  };
});

import { applyMigrations, createTestPool, resetDatabase, seedTestUser } from "./helpers/db.js";
import { genlayerClient } from "../src/genlayer/client.js";
import { insertMarket, setMarketContractId, setMarketStatus, getMarketById } from "../src/db/repositories.js";
import { runDeadlineEnforcerOnce } from "../src/jobs/deadlineEnforcer.js";

let pool: Pool;
const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("deadline enforcer — fail-closed transitions", () => {
  beforeAll(async () => {
    pool = createTestPool();
    await applyMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await seedTestUser(pool, WALLET);
    vi.clearAllMocks();
  });

  it("does NOT flip status when resolves_at has not passed by wall clock", async () => {
    const market = await insertMarket({
      question: "Will X happen by 2030?",
      category: "test",
      horizonYears: 5,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // future
    });
    await setMarketStatus(market.id, "open");
    await setMarketContractId(market.id, "chain-market-1");

    const result = await runDeadlineEnforcerOnce();
    expect(result.checked).toBe(0);

    const refreshed = await getMarketById(market.id);
    expect(refreshed?.status).toBe("open");
    expect(refreshed?.deadline_enforced_at).toBeNull();
  });

  it("does NOT flip status when wall clock has passed but on-chain check says it hasn't (never trust wall-clock alone)", async () => {
    const market = await insertMarket({
      question: "Will Y happen?",
      category: "test",
      horizonYears: 1,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() - 60 * 1000).toISOString(), // already past
    });
    await setMarketStatus(market.id, "open");
    await setMarketContractId(market.id, "chain-market-2");

    vi.mocked(genlayerClient.getMarketChainState).mockResolvedValue({
      contractMarketId: "chain-market-2",
      resolvesAtPassed: false, // chain disagrees with wall clock
      status: "open",
    });

    const result = await runDeadlineEnforcerOnce();
    expect(result.checked).toBe(1);
    expect(result.enforced).toBe(0);

    const refreshed = await getMarketById(market.id);
    expect(refreshed?.status).toBe("open");
    expect(refreshed?.deadline_enforced_at).toBeNull();
  });

  it("flips to awaiting_adjudication only when BOTH wall clock and chain confirm the deadline", async () => {
    const market = await insertMarket({
      question: "Will Z happen?",
      category: "test",
      horizonYears: 1,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    await setMarketStatus(market.id, "open");
    await setMarketContractId(market.id, "chain-market-3");

    vi.mocked(genlayerClient.getMarketChainState).mockResolvedValue({
      contractMarketId: "chain-market-3",
      resolvesAtPassed: true,
      status: "resolved",
    });

    const result = await runDeadlineEnforcerOnce();
    expect(result.enforced).toBe(1);

    const refreshed = await getMarketById(market.id);
    expect(refreshed?.status).toBe("awaiting_adjudication");
    expect(refreshed?.deadline_enforced_at).not.toBeNull();
  });

  it("skips markets without a confirmed contract_market_id (nothing to check on-chain yet)", async () => {
    const market = await insertMarket({
      question: "Will W happen?",
      category: "test",
      horizonYears: 1,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    await setMarketStatus(market.id, "open");
    // no contract_market_id set — still pending_chain in practice

    const result = await runDeadlineEnforcerOnce();
    expect(result.enforced).toBe(0);
    expect(genlayerClient.getMarketChainState).not.toHaveBeenCalled();
  });
});
