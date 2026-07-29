import type { FastifyInstance } from "fastify";
import {
  createMarketSchema,
  marketIdParamSchema,
  marketsQuerySchema,
  submitEvidenceSchema,
} from "../schemas/index.js";
import {
  enqueueChainSync,
  getMarketById,
  insertEvidence,
  insertMarket,
  insertMarketEvent,
  listEvidenceForMarket,
  listEventsForMarket,
  listMarkets,
  listPositionsForMarket,
} from "../db/repositories.js";
import { withTransaction } from "../db/pool.js";

export async function marketsRoutes(fastify: FastifyInstance) {
  // GET /markets — list + filter by horizon/category/status
  fastify.get("/markets", async (request, reply) => {
    const q = marketsQuerySchema.parse(request.query);
    const { rows, total } = await listMarkets({
      horizonMin: q.horizonMin ?? q.horizon,
      horizonMax: q.horizonMax ?? q.horizon,
      category: q.category,
      status: q.status,
      limit: q.limit,
      offset: q.offset,
    });
    return reply.send({ markets: rows, total, limit: q.limit, offset: q.offset });
  });

  // POST /markets — record creation intent; never "confirmed" until chain receipt confirms.
  fastify.post(
    "/markets",
    { preHandler: [fastify.authenticate], config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
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
        });

        await insertMarketEvent(
          { marketId: inserted.id, type: "created", payload: { intent: "create_market" }, confirmed: false },
          client
        );

        await enqueueChainSync(
          {
            marketId: inserted.id,
            action: "create_market",
            payload: {
              question: body.question,
              category: body.category,
              horizonYears: body.horizonYears,
              resolutionCriteria: body.resolutionCriteria,
              resolvesAt: body.resolvesAt,
              initialLiquidityGen: body.initialLiquidityGen,
              createdBy: wallet,
            },
          },
          client
        );

        return inserted;
      });

      return reply.code(202).send({
        market,
        message: "Market creation intent recorded; awaiting chain confirmation.",
      });
    }
  );

  // GET /markets/:id
  fastify.get("/markets/:id", async (request, reply) => {
    const { id } = marketIdParamSchema.parse(request.params);
    const market = await getMarketById(id);
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

  // GET /markets/:id/evidence
  fastify.get("/markets/:id/evidence", async (request, reply) => {
    const { id } = marketIdParamSchema.parse(request.params);
    const market = await getMarketById(id);
    if (!market) return reply.code(404).send({ error: "not_found", message: "Market not found" });
    const evidence = await listEvidenceForMarket(id);
    return reply.send({ evidence });
  });

  // POST /markets/:id/evidence — records the pointer; the contract itself fetches
  // and validates it during adjudication (never trusts the submitted summary as fact).
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
            confirmed: false,
          },
          client
        );

        await enqueueChainSync(
          {
            marketId: id,
            action: "submit_evidence_pointer",
            payload: {
              evidenceId: inserted.id,
              url: body.url,
              sourceType: body.sourceType,
              wallet,
              contractMarketId: market.contract_market_id,
            },
          },
          client
        );

        return inserted;
      });

      return reply.code(202).send({ evidence, message: "Evidence pointer recorded; awaiting chain sync." });
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
}
