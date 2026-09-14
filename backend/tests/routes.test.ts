import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";

vi.mock("../src/genlayer/client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/genlayer/client.js")>(
    "../src/genlayer/client.js"
  );
  return {
    ...actual,
    genlayerClient: { ...actual.genlayerClient, isConfigured: () => false },
  };
});

import { applyMigrations, createTestPool, resetDatabase, seedTestUser } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import { pool as appPool } from "../src/db/pool.js";
import { insertMarket, setMarketStatus } from "../src/db/repositories.js";

let pool: Pool;
let app: FastifyInstance;
const WALLET = "0xcccccccccccccccccccccccccccccccccccccccc";

describe("REST API — evidence submission & market lifecycle", () => {
  beforeAll(async () => {
    pool = createTestPool();
    await applyMigrations(pool);
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await appPool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await seedTestUser(pool, WALLET);
  });

  it("GET /health reflects real DB connectivity", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.db).toBe("up");
  });

  it("records a market as pending_chain BEFORE any USDC deposit is confirmed on Base Sepolia", async () => {
    const token = app.jwt.sign({ wallet: WALLET });

    const res = await app.inject({
      method: "POST",
      url: "/markets",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        question: "Will historians call 2026 a turning point?",
        category: "culture",
        horizonYears: 10,
        resolutionCriteria: "Resolved by consensus of independent retrospectives.",
        resolvesAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.market.status).toBe("pending_chain");
    expect(body.market.contract_market_id).toBe(null);
  });

  it("rejects a market recording request missing required fields", async () => {
    const token = app.jwt.sign({ wallet: WALLET });

    const res = await app.inject({
      method: "POST",
      url: "/markets",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        question: "Missing fields?",
        category: "test",
        horizonYears: 1,
        // resolutionCriteria / resolvesAt intentionally omitted
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects market recording without auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/markets",
      payload: {
        question: "Unauthorized market?",
        category: "test",
        horizonYears: 1,
        resolutionCriteria: "criteria text long enough",
        resolvesAt: new Date(Date.now() + 3600_000).toISOString(),
        txHash: "0xabc",
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("submits evidence (already on-chain) and records it as confirmed", async () => {
    const market = await insertMarket({
      question: "Will E happen?",
      category: "test",
      horizonYears: 1,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await setMarketStatus(market.id, "open");

    const token = app.jwt.sign({ wallet: WALLET });
    const res = await app.inject({
      method: "POST",
      url: `/markets/${market.id}/evidence`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        sourceType: "news",
        url: "https://example.com/article",
        summary: "Some summary text",
        txHash: "0xevidence1",
      },
    });

    expect(res.statusCode).toBe(201);

    const evidenceListRes = await app.inject({ method: "GET", url: `/markets/${market.id}/evidence` });
    const evidenceBody = evidenceListRes.json();
    expect(evidenceBody.evidence).toHaveLength(1);
    expect(evidenceBody.evidence[0].url).toBe("https://example.com/article");
    // weight is null until the contract's adjudication assigns it — never assumed client-side.
    expect(evidenceBody.evidence[0].weight).toBeNull();
  });

  it("market cannot be adjudicated before its deadline (adjudicate status reflects real state, not assumptions)", async () => {
    const market = await insertMarket({
      question: "Will F happen?",
      category: "test",
      horizonYears: 1,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() + 3600_000).toISOString(), // future
    });
    await setMarketStatus(market.id, "open");

    const res = await app.inject({ method: "GET", url: `/markets/${market.id}/adjudicate` });
    const body = res.json();
    expect(body.status).toBe("open");
    expect(body.adjudication.requested).toBe(false);
    expect(body.adjudication.settled).toBe(false);
  });

  it("lists markets filterable by status and category", async () => {
    const m1 = await insertMarket({
      question: "Will G happen?",
      category: "science",
      horizonYears: 2,
      resolutionCriteria: "criteria",
      createdBy: WALLET,
      resolvesAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await setMarketStatus(m1.id, "open");

    const res = await app.inject({ method: "GET", url: "/markets?category=science&status=open" });
    const body = res.json();
    expect(body.markets.length).toBeGreaterThanOrEqual(1);
    expect(body.markets.every((m: any) => m.category === "science")).toBe(true);
  });
});
