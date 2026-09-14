import type { FastifyInstance } from "fastify";
import {
  createMarketSchema,
  marketIdParamSchema,
  marketsQuerySchema,
  recordStakeSchema,
  submitEvidenceSchema,
} from "../schemas/index.js";
import {
  getMarketById,
  insertEvidence,
  insertMarket,
  insertMarketEvent,
  insertPosition,
  listAllEvidence,
  listEvidenceForMarket,
  listEventsForMarket,
  listMarkets,
  listPositionsForMarket,
  requestMarketCancellation,
} from "../db/repositories.js";
import { withTransaction } from "../db/pool.js";
import { cacheGetOrSet } from "../lib/cache.js";
import { env } from "../config.js";
import { genlayerClient } from "../genlayer/client.js";
import { runChainIndexerOnce } from "../jobs/chainIndexer.js";
import { marketIdToBytes32, getEscrowClaimable } from "../services/baseSepolia.js";
import { FUND_KIND_POOL, FUND_KIND_YES, FUND_KIND_NO } from "../lib/escrowAbi.js";

export async function marketsRoutes(fastify: FastifyInstance) {
  // GET /evidence — global feed across every market, newest first. Powers
  // the Evidence Ledger page. Read-only, no auth required.
  fastify.get("/evidence", async (request, reply) => {
    const q = request.query as { sourceType?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(q.limit) || 50, 200);
    const offset = Number(q.offset) || 0;
    const { rows, total } = await listAllEvidence({ sourceType: q.sourceType, limit, offset });
    return reply.send({ evidence: rows, total, limit, offset });
  });

  // POST /sync — on-demand version of the chain indexer's background pass:
  // re-reads chain state for every active market, backfills any market or
  // evidence pointer that's confirmed on-chain but missing from Postgres
  // (mirror-POST failures — expired session, GenLayer's RPC rate limit
  // tripping mid-poll, a closed tab), and reconciles status/financials.
  // Rate-limited well below GenLayer's 30 req/min cap, since one run can
  // itself issue a handful of chain reads — this button is "resync now",
  // not a replacement for the interval job, which keeps running regardless.
  fastify.post(
    "/sync",
    // fastify-rate-limit's default store is per-machine, and this app runs 2
    // machines, so keep this conservative: worst case is roughly double.
    { config: { rateLimit: { max: 2, timeWindow: "1 minute" } } },
    async (_request, reply) => {
      const result = await runChainIndexerOnce();
      return reply.send(result);
    }
  );

  // GET /markets — list + filter by horizon/category/status
  fastify.get("/markets", async (request, reply) => {
    const q = marketsQuerySchema.parse(request.query);
    const cacheKey = `markets:list:${JSON.stringify(q)}`;
    const result = await cacheGetOrSet(cacheKey, env.REDIS_CACHE_TTL_SECONDS, async () => {
      const { rows, total } = await listMarkets({
        horizonMin: q.horizonMin ?? q.horizon,
        horizonMax: q.horizonMax ?? q.horizon,
        category: q.category,
        status: q.status,
        limit: q.limit,
        offset: q.offset,
      });
      return { markets: rows, total, limit: q.limit, offset: q.offset };
    });
    return reply.send(result);
  });

  // POST /markets — creates a 'pending_chain' row BEFORE any chain write.
  // Funding moved to real USDC on Base Sepolia (ChronixEscrow.sol): the
  // frontend derives this row's escrow bytes32 key from its id
  // (services/baseSepolia.ts marketIdToBytes32) and calls
  // ChronixEscrow.fund(marketId, KIND_POOL, amount) directly with the
  // user's own wallet. The relay job (jobs/baseRelay.ts) watches for that
  // confirmed deposit and mirrors it onto GenLayer's create_market, at
  // which point this row flips to 'open' with a real contract_market_id —
  // see jobs/baseRelay.ts and db/repositories.ts markMarketPoolRelayed.
  fastify.post(
    "/markets",
    { preHandler: [fastify.authenticate], config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = createMarketSchema.parse(request.body);
      const wallet = request.walletAddress!;

      const market = await withTransaction(async (client) => {
        const inserted = await insertMarket({
          question: body.question,
          category: body.category,
          horizonYears: body.horizonYears,
          resolutionCriteria: body.resolutionCriteria,
          createdBy: wallet,
          resolvesAt: body.resolvesAt,
          allowedEvidenceTypes: body.allowedEvidenceSources?.join(",") ?? null,
        });

        await insertMarketEvent(
          { marketId: inserted.id, type: "created", payload: { pendingFunding: true }, confirmed: false },
          client
        );

        return inserted;
      });

      return reply.code(201).send({ market });
    }
  );

  // GET /markets/:id
  fastify.get("/markets/:id", async (request, reply) => {
    const { id } = marketIdParamSchema.parse(request.params);
    const market = await cacheGetOrSet(`markets:detail:${id}`, env.REDIS_CACHE_TTL_SECONDS, () =>
      getMarketById(id)
    );
    if (!market) return reply.code(404).send({ error: "not_found", message: "Market not found" });
    return reply.send({ market });
  });

  // GET /markets/:id/positions
  fastify.get("/markets/:id/positions", async (request, reply) => {
    const { id } = marketIdParamSchema.parse(request.params);
    const market = await getMarketById(id);
    if (!market) return reply.code(404).send({ error: "not_found", message: "Market not found" });
    const positions = await listPositionsForMarket(id);
    return reply.send({ positions });
  });

  // POST /markets/:id/positions — creates a pending position row BEFORE the
  // user funds ChronixEscrow.fund(marketId, KIND_YES|KIND_NO, amount) on
  // Base Sepolia (same pending-first pattern as POST /markets — see its
  // docstring). The relay job mirrors the confirmed deposit onto GenLayer's
  // `stake` and sets relayed_at once done.
  fastify.post(
    "/markets/:id/positions",
    { preHandler: [fastify.authenticate], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { id } = marketIdParamSchema.parse(request.params);
      const body = recordStakeSchema.parse(request.body);
      const wallet = request.walletAddress!;

      const market = await getMarketById(id);
      if (!market) return reply.code(404).send({ error: "not_found", message: "Market not found" });

      const position = await withTransaction(async (client) => {
        const inserted = await insertPosition({
          marketId: id,
          walletAddress: wallet,
          side: body.side,
          shares: body.shares,
          avgPrice: body.avgPrice,
        });

        await insertMarketEvent(
          { marketId: id, type: "stake_recorded", payload: { side: body.side, shares: body.shares, pendingFunding: true }, confirmed: false },
          client
        );

        return inserted;
      });

      return reply.code(201).send({ position });
    }
  );

  // GET /markets/:id/escrow — funding target info for the frontend's
  // ChronixEscrow.fund() calls on Base Sepolia: the escrow contract
  // address, USDC token address, and this market's bytes32 key (derived
  // deterministically from its UUID — same derivation the relay job uses).
  fastify.get("/markets/:id/escrow", async (request, reply) => {
    const { id } = marketIdParamSchema.parse(request.params);
    const market = await getMarketById(id);
    if (!market) return reply.code(404).send({ error: "not_found", message: "Market not found" });
    return reply.send({
      escrowAddress: env.CHRONIX_ESCROW_ADDRESS || null,
      usdcAddress: env.BASE_SEPOLIA_USDC_ADDRESS,
      chainId: env.BASE_SEPOLIA_CHAIN_ID,
      marketIdBytes32: marketIdToBytes32(id),
      kinds: { pool: FUND_KIND_POOL, yes: FUND_KIND_YES, no: FUND_KIND_NO },
    });
  });

  // GET /markets/:id/claimable/:wallet — how much USDC a wallet can claim
  // for this market directly from ChronixEscrow.claim() — read straight
  // from the escrow contract, never cached, since this drives a "Claim"
  // button's enabled state and amount.
  fastify.get("/markets/:id/claimable/:wallet", async (request, reply) => {
    const { id } = marketIdParamSchema.parse(request.params);
    const { wallet } = request.params as { wallet: string };
    const market = await getMarketById(id);
    if (!market) return reply.code(404).send({ error: "not_found", message: "Market not found" });
    if (!env.CHRONIX_ESCROW_ADDRESS) return reply.send({ claimable: "0" });
    const claimable = await getEscrowClaimable(id, wallet);
    return reply.send({ claimable });
  });

  // POST /markets/:id/cancel-request — creator-only, pre-participation-only
  // (total_yes/total_no == 0), matching the contract's own pure_can_cancel
  // guard. cancel_market is relayer-gated on GenLayer now (see
  // contracts/chronix.py's class docstring), so the creator's own wallet
  // can't call it directly any more — this records the request instead.
  // If the market never made it past 'pending_chain', nothing is on-chain
  // yet, so it's cancelled immediately; otherwise the relay job
  // (jobs/baseRelay.ts findMarketsPendingCancelRelay) drives the actual
  // cancel_market call + escrow refund on its next pass.
  fastify.post(
    "/markets/:id/cancel-request",
    { preHandler: [fastify.authenticate], config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { id } = marketIdParamSchema.parse(request.params);
      const wallet = request.walletAddress!;

      const market = await getMarketById(id);
      if (!market) return reply.code(404).send({ error: "not_found", message: "Market not found" });
      if (market.created_by.toLowerCase() !== wallet.toLowerCase()) {
        return reply.code(403).send({ error: "forbidden", message: "Only the market creator may cancel this market" });
      }
      if (market.status !== "pending_chain" && market.status !== "open") {
        return reply
          .code(409)
          .send({ error: "invalid_status", message: `Market cannot be cancelled from status '${market.status}'` });
      }
      if (BigInt(market.total_yes_wei) > 0n || BigInt(market.total_no_wei) > 0n) {
        return reply.code(409).send({
          error: "already_staked",
          message: "Market can only be cancelled before any stakes are placed",
        });
      }
      if (market.cancel_requested_at) {
        return reply.send({ market }); // idempotent — already requested
      }

      const updated = await requestMarketCancellation(id);
      await insertMarketEvent({
        marketId: id,
        type: "reconciled",
        payload: { cancelRequested: true, immediate: updated.status === "cancelled" },
        confirmed: updated.status === "cancelled",
      });
      return reply.send({ market: updated });
    }
  );

  // GET /markets/:id/evidence
  fastify.get("/markets/:id/evidence", async (request, reply) => {
    const { id } = marketIdParamSchema.parse(request.params);
    const market = await getMarketById(id);
    if (!market) return reply.code(404).send({ error: "not_found", message: "Market not found" });
    const evidence = await listEvidenceForMarket(id);
    return reply.send({ evidence });
  });

  // POST /markets/:id/evidence — records a pointer AFTER the user's own
  // wallet already called submit_evidence_pointer directly on-chain (see
  // POST /markets docstring for why the backend never submits this itself).
  // The contract's own settle() nondet fetch is the only thing ever treated
  // as authoritative for adjudication — this row is purely a UI convenience.
  fastify.post(
    "/markets/:id/evidence",
    { preHandler: [fastify.authenticate], config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { id } = marketIdParamSchema.parse(request.params);
      const body = submitEvidenceSchema.parse(request.body);
      const wallet = request.walletAddress!;

      const market = await getMarketById(id);
      if (!market) return reply.code(404).send({ error: "not_found", message: "Market not found" });

      const evidence = await withTransaction(async (client) => {
        const inserted = await insertEvidence({
          marketId: id,
          sourceType: body.sourceType,
          url: body.url,
          summary: body.summary ?? null,
          submittedBy: wallet,
        });

        await insertMarketEvent(
          {
            marketId: id,
            type: "evidence_submitted",
            payload: { evidenceId: inserted.id, url: body.url },
            chainTxHash: body.txHash,
            confirmed: true,
          },
          client
        );

        return inserted;
      });

      return reply.code(201).send({ evidence });
    }
  );

  // GET /markets/:id/adjudicate — read-only adjudication status.
  fastify.get("/markets/:id/adjudicate", async (request, reply) => {
    const { id } = marketIdParamSchema.parse(request.params);
    const market = await getMarketById(id);
    if (!market) return reply.code(404).send({ error: "not_found", message: "Market not found" });

    const events = await listEventsForMarket(id);
    const verdictEvent = events.find((e) => e.type === "verdict_settled" && e.confirmed);
    const pendingEvent = events.find((e) => e.type === "verdict_pending");

    return reply.send({
      marketId: id,
      status: market.status,
      resolvesAt: market.resolves_at,
      deadlineEnforcedAt: market.deadline_enforced_at,
      adjudication: {
        requested: Boolean(pendingEvent),
        settled: Boolean(verdictEvent),
        verdict: verdictEvent?.payload ?? null,
      },
    });
  });

  // GET /markets/:id/events — real, ordered market_events history. This is
  // what the Adjudication Result page's timeline is actually built from —
  // genuine recorded lifecycle events, not a fabricated reasoning trace
  // (the contract's own nondet execution trace isn't read/stored anywhere
  // in this backend yet — see MEMORY.md).
  fastify.get("/markets/:id/events", async (request, reply) => {
    const { id } = marketIdParamSchema.parse(request.params);
    const market = await getMarketById(id);
    if (!market) return reply.code(404).send({ error: "not_found", message: "Market not found" });
    const events = await listEventsForMarket(id);
    return reply.send({ events });
  });

  // GET /markets/:id/trace — real GenVM execution trace for this market's
  // settle() transaction (per-validator eq_outputs, return_data, stdout/
  // stderr), read live from the chain via debugTraceTransaction. Returns
  // { trace: null } if no settle tx is recorded yet, or if the runner can't
  // produce a trace for it (e.g. already finalized/pruned) — never fabricated.
  fastify.get("/markets/:id/trace", async (request, reply) => {
    const { id } = marketIdParamSchema.parse(request.params);
    const market = await getMarketById(id);
    if (!market) return reply.code(404).send({ error: "not_found", message: "Market not found" });

    const events = await listEventsForMarket(id);
    const settledEvent = events.find((e) => e.type === "verdict_settled" && e.chain_tx_hash);
    if (!settledEvent?.chain_tx_hash) {
      return reply.send({ trace: null, reason: "Market has not settled yet, or no tx hash was recorded." });
    }

    const trace = await genlayerClient.getTransactionTrace(settledEvent.chain_tx_hash);
    return reply.send({ trace, reason: trace ? null : "Execution trace not available for this transaction." });
  });
}
