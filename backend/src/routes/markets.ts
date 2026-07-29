import type { FastifyInstance } from "fastify";
import {
  createMarketSchema,
  marketIdParamSchema,
  marketsQuerySchema,
  submitEvidenceSchema,
} from "../schemas/index.js";
import {
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
import { cacheGetOrSet } from "../lib/cache.js";
import { env } from "../config.js";

export async function marketsRoutes(fastify: FastifyInstance) {
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

  // POST /markets — records a market AFTER the user's own wallet has already
  // signed and submitted create_market directly to GenLayer. This backend
  // never holds a key capable of moving a user's GEN, so it cannot submit
  // that write itself — see genlayer/client.ts's trust-model docstring. The
  // chain indexer job independently re-reads get_market() on a schedule, so
  // even if this call is skipped or lies about details, chain truth wins.
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
          contractMarketId: body.contractMarketId,
        });

        await insertMarketEvent(
          {
            marketId: inserted.id,
            type: "created",
            payload: { contractMarketId: body.contractMarketId },
            chainTxHash: body.txHash,
            confirmed: true,
          },
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
}
