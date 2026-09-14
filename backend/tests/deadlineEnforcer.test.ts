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
      getMarket: vi.fn(),
    },
  };
});

import { applyMigrations, createTestPool, resetDatabase, seedTestUser } from "./helpers/db.js";
import { genlayerClient } from "../src/genlayer/client.js";
import { insertMarket, setMarketStatus, setMarketContractId, getMarketById } from "../src/db/repositories.js";
import { runDeadlineEnforcerOnce } from "../src/jobs/deadlineEnforcer.js";

let pool: Pool;
const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function baseChainMarket(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    creator: WALLET,
    question: "q",
    category: "test",
    horizonYears: 1,
    resolutionCriteria: "criteria",
    allowedEvidenceTypes: "news",
    createdAt: Math.floor(Date.now() / 1000) - 1000,
    resolvesAt: Math.floor(Date.now() / 1000) - 60,
    status: "active",
    poolDeposited: "1000000000000000000",
    totalYes: "0",
    totalNo: "0",
    adjudicationRequestedAt: 0,
    verdict: "",
    evidenceCount: 0,
    ...overrides,
  };
}

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

    const result = await runDeadlineEnforcerOnce();
    expect(result.checked).toBe(0);

    const refreshed = await getMarketById(market.id);
    expect(refreshed?.status).toBe("open");
    expect(refreshed?.deadline_enforced_at).toBeNull();
  });

  it("does NOT flip status when wall clock has passed but the contract's own resolves_at says it hasn't (never trust wall-clock alone)", async () => {
    const market = await insertMarket({
      question: "Will Y happen?",
      category: "test",
      horizonYears: 1,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() - 60 * 1000).toISOString(), // already past by wall clock
    });
    await setMarketStatus(market.id, "open");
    await setMarketContractId(market.id, "2");

    vi.mocked(genlayerClient.getMarket).mockResolvedValue(
      baseChainMarket({ id: 2, status: "active", resolvesAt: Math.floor(Date.now() / 1000) + 3600 })
    );

    const result = await runDeadlineEnforcerOnce();
    expect(result.checked).toBe(1);
    expect(result.enforced).toBe(0);

    const refreshed = await getMarketById(market.id);
    expect(refreshed?.status).toBe("open");
    expect(refreshed?.deadline_enforced_at).toBeNull();
  });

  it("flips to awaiting_adjudication only when BOTH wall clock and the contract confirm the deadline", async () => {
    const market = await insertMarket({
      question: "Will Z happen?",
      category: "test",
      horizonYears: 1,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    await setMarketStatus(market.id, "open");
    await setMarketContractId(market.id, "3");

    vi.mocked(genlayerClient.getMarket).mockResolvedValue(
      baseChainMarket({ id: 3, status: "active", resolvesAt: Math.floor(Date.now() / 1000) - 60 })
    );

    const result = await runDeadlineEnforcerOnce();
    expect(result.enforced).toBe(1);

    const refreshed = await getMarketById(market.id);
    expect(refreshed?.status).toBe("awaiting_adjudication");
    expect(refreshed?.deadline_enforced_at).not.toBeNull();
  });

  it("skips a market the chain already advanced past 'active' (someone else's wallet got there first — never double-enforce)", async () => {
    const market = await insertMarket({
      question: "Will W happen?",
      category: "test",
      horizonYears: 1,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    await setMarketStatus(market.id, "open");
    await setMarketContractId(market.id, "4");

    vi.mocked(genlayerClient.getMarket).mockResolvedValue(
      baseChainMarket({ id: 4, status: "awaiting_adjudication" })
    );

    const result = await runDeadlineEnforcerOnce();
    expect(result.enforced).toBe(0);

    const refreshed = await getMarketById(market.id);
    // Still "open" in Postgres at this instant — the chain indexer (not the
    // deadline enforcer) is responsible for pulling this transition in.
    expect(refreshed?.status).toBe("open");
  });
});
