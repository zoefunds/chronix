import type { PoolClient } from "pg";
import { pool, query } from "./pool.js";

// ---------------------------------------------------------------------------
// Types mirroring database/schema.sql
// ---------------------------------------------------------------------------

export type MarketStatus =
  | "pending_chain"
  | "open"
  | "awaiting_adjudication"
  | "settled"
  | "cancelled"
  | "failed";

export interface MarketRow {
  id: string;
  question: string;
  category: string;
  horizon_years: string;
  resolution_criteria: string;
  created_by: string;
  contract_market_id: string | null;
  status: MarketStatus;
  resolves_at: string;
  created_at: string;
  deadline_enforced_at: string | null;
  // Live financial figures, mirrored from get_market() by the chain indexer.
  pool_deposited_wei: string;
  total_yes_wei: string;
  total_no_wei: string;
  verdict: string | null;
  // Only present on listMarkets/getMarketById responses (LEFT JOIN count).
  participant_count?: string;
}

export interface PositionRow {
  id: string;
  market_id: string;
  wallet_address: string;
  side: "yes" | "no";
  shares: string;
  avg_price: string;
  tx_hash: string | null;
  created_at: string;
}

export interface EvidenceRow {
  id: string;
  market_id: string;
  source_type: string;
  url: string;
  summary: string | null;
  submitted_by: string;
  weight: string | null;
  created_at: string;
}

export type MarketEventType =
  | "created"
  | "deadline_passed"
  | "evidence_submitted"
  | "stake_recorded"
  | "verdict_pending"
  | "verdict_settled"
  | "payout_claimed"
  | "reconciled";

export interface MarketEventRow {
  id: string;
  market_id: string;
  type: MarketEventType;
  payload: Record<string, unknown>;
  chain_tx_hash: string | null;
  confirmed: boolean;
  created_at: string;
}

export type ChainSyncStatus = "pending" | "confirmed" | "failed";

export interface ChainSyncQueueRow {
  id: string;
  market_id: string | null;
  action: string;
  payload: Record<string, unknown>;
  attempts: number;
  last_error: string | null;
  status: ChainSyncStatus;
  next_retry_at: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export async function upsertUser(walletAddress: string): Promise<void> {
  await query(
    `INSERT INTO users (wallet_address) VALUES ($1)
     ON CONFLICT (wallet_address) DO NOTHING`,
    [walletAddress]
  );
}

// ---------------------------------------------------------------------------
// markets
// ---------------------------------------------------------------------------

export async function insertMarket(params: {
  question: string;
  category: string;
  horizonYears: number;
  resolutionCriteria: string;
  createdBy: string;
  resolvesAt: string;
  /**
   * The on-chain market id, already assigned by a successful create_market
   * call the USER's own wallet submitted directly to GenLayer (never the
   * backend). This route only ever records what already happened on-chain
   * — see routes/markets.ts POST /markets docstring.
   */
  contractMarketId: string;
}): Promise<MarketRow> {
  const res = await query<MarketRow>(
    `INSERT INTO markets
       (question, category, horizon_years, resolution_criteria, created_by, status, resolves_at, contract_market_id)
     VALUES ($1, $2, $3, $4, $5, 'open', $6, $7)
     RETURNING *`,
    [
      params.question,
      params.category,
      params.horizonYears,
      params.resolutionCriteria,
      params.createdBy,
      params.resolvesAt,
      params.contractMarketId,
    ]
  );
  return res.rows[0];
}

/**
 * Re-reads a market's mutable fields from the contract's own get_market()
 * response and syncs them into Postgres. This is the reconciliation path
 * that keeps the DB from silently diverging from chain truth (see
 * MEMORY.md's Event-Weaver lesson) — called by the chain indexer job for
 * every market currently open/awaiting_adjudication.
 */
export async function syncMarketFromChain(
  marketId: string,
  chain: {
    status: MarketStatus;
    verdict?: string;
    poolDepositedWei: string;
    totalYesWei: string;
    totalNoWei: string;
  }
): Promise<void> {
  await query(
    `UPDATE markets
     SET status = $2, pool_deposited_wei = $3, total_yes_wei = $4, total_no_wei = $5,
         verdict = COALESCE($6, verdict)
     WHERE id = $1`,
    [marketId, chain.status, chain.poolDepositedWei, chain.totalYesWei, chain.totalNoWei, chain.verdict ?? null]
  );
}

/** Markets that have an on-chain id and are still in a mutable lifecycle state. */
export async function findActiveChainMarkets(): Promise<MarketRow[]> {
  const res = await query<MarketRow>(
    `SELECT * FROM markets
     WHERE contract_market_id IS NOT NULL
       AND status IN ('open', 'awaiting_adjudication')
     ORDER BY resolves_at ASC
     LIMIT 200`
  );
  return res.rows;
}

const MARKET_WITH_PARTICIPANTS_SELECT = `
  SELECT m.*, COUNT(DISTINCT p.wallet_address)::text AS participant_count
  FROM markets m
  LEFT JOIN positions p ON p.market_id = m.id
`;

export async function getMarketById(id: string): Promise<MarketRow | null> {
  const res = await query<MarketRow>(
    `${MARKET_WITH_PARTICIPANTS_SELECT} WHERE m.id = $1 GROUP BY m.id`,
    [id]
  );
  return res.rows[0] ?? null;
}

export interface MarketFilter {
  horizonMin?: number;
  horizonMax?: number;
  category?: string;
  status?: MarketStatus;
  limit: number;
  offset: number;
}

export async function listMarkets(filter: MarketFilter): Promise<{ rows: MarketRow[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.category) {
    params.push(filter.category);
    conditions.push(`m.category = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    conditions.push(`m.status = $${params.length}`);
  }
  if (filter.horizonMin !== undefined) {
    params.push(filter.horizonMin);
    conditions.push(`m.horizon_years >= $${params.length}`);
  }
  if (filter.horizonMax !== undefined) {
    params.push(filter.horizonMax);
    conditions.push(`m.horizon_years <= $${params.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRes = await query<{ count: string }>(
    `SELECT count(*)::text as count FROM markets m ${whereClause}`,
    params
  );

  params.push(filter.limit);
  const limitIdx = params.length;
  params.push(filter.offset);
  const offsetIdx = params.length;

  const res = await query<MarketRow>(
    `${MARKET_WITH_PARTICIPANTS_SELECT} ${whereClause}
     GROUP BY m.id ORDER BY m.created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  return { rows: res.rows, total: Number(countRes.rows[0]?.count ?? 0) };
}

export async function setMarketContractId(
  marketId: string,
  contractMarketId: string,
  client?: PoolClient
): Promise<void> {
  const runner = client ?? pool;
  await runner.query(`UPDATE markets SET contract_market_id = $2 WHERE id = $1`, [
    marketId,
    contractMarketId,
  ]);
}

export async function setMarketStatus(
  marketId: string,
  status: MarketStatus,
  client?: PoolClient
): Promise<void> {
  const runner = client ?? pool;
  await runner.query(`UPDATE markets SET status = $2 WHERE id = $1`, [marketId, status]);
}

export async function markDeadlineEnforced(marketId: string, client?: PoolClient): Promise<void> {
  const runner = client ?? pool;
  await runner.query(
    `UPDATE markets SET status = 'awaiting_adjudication', deadline_enforced_at = now() WHERE id = $1`,
    [marketId]
  );
}

/** Markets whose resolves_at has passed by wall clock but haven't been chain-confirmed yet. */
export async function findMarketsPastDeadline(): Promise<MarketRow[]> {
  const res = await query<MarketRow>(
    `SELECT * FROM markets
     WHERE status = 'open' AND resolves_at <= now() AND deadline_enforced_at IS NULL
     ORDER BY resolves_at ASC
     LIMIT 100`
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// positions
// ---------------------------------------------------------------------------

export async function listPositionsForMarket(marketId: string): Promise<PositionRow[]> {
  const res = await query<PositionRow>(
    `SELECT * FROM positions WHERE market_id = $1 ORDER BY created_at DESC`,
    [marketId]
  );
  return res.rows;
}

export async function listPositionsForWallet(wallet: string): Promise<PositionRow[]> {
  const res = await query<PositionRow>(
    `SELECT * FROM positions WHERE wallet_address = $1 ORDER BY created_at DESC`,
    [wallet]
  );
  return res.rows;
}

export async function insertPosition(params: {
  marketId: string;
  walletAddress: string;
  side: "yes" | "no";
  shares: string;
  avgPrice: string;
}): Promise<PositionRow> {
  const res = await query<PositionRow>(
    `INSERT INTO positions (market_id, wallet_address, side, shares, avg_price)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [params.marketId, params.walletAddress, params.side, params.shares, params.avgPrice]
  );
  return res.rows[0];
}

// ---------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------

export async function listEvidenceForMarket(marketId: string): Promise<EvidenceRow[]> {
  const res = await query<EvidenceRow>(
    `SELECT * FROM evidence WHERE market_id = $1 ORDER BY created_at DESC`,
    [marketId]
  );
  return res.rows;
}

export async function insertEvidence(params: {
  marketId: string;
  sourceType: string;
  url: string;
  summary: string | null;
  submittedBy: string;
}): Promise<EvidenceRow> {
  const res = await query<EvidenceRow>(
    `INSERT INTO evidence (market_id, source_type, url, summary, submitted_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [params.marketId, params.sourceType, params.url, params.summary, params.submittedBy]
  );
  return res.rows[0];
}

// ---------------------------------------------------------------------------
// market_events
// ---------------------------------------------------------------------------

export async function insertMarketEvent(
  params: {
    marketId: string;
    type: MarketEventType;
    payload?: Record<string, unknown>;
    chainTxHash?: string | null;
    confirmed?: boolean;
  },
  client?: PoolClient
): Promise<MarketEventRow> {
  const runner = client ?? pool;
  const res = await runner.query<MarketEventRow>(
    `INSERT INTO market_events (market_id, type, payload, chain_tx_hash, confirmed)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      params.marketId,
      params.type,
      JSON.stringify(params.payload ?? {}),
      params.chainTxHash ?? null,
      params.confirmed ?? false,
    ]
  );
  return res.rows[0];
}

export async function confirmMarketEvent(eventId: string, chainTxHash: string, client?: PoolClient) {
  const runner = client ?? pool;
  await runner.query(
    `UPDATE market_events SET confirmed = true, chain_tx_hash = $2 WHERE id = $1`,
    [eventId, chainTxHash]
  );
}

export async function listEventsForMarket(marketId: string): Promise<MarketEventRow[]> {
  const res = await query<MarketEventRow>(
    `SELECT * FROM market_events WHERE market_id = $1 ORDER BY created_at DESC`,
    [marketId]
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// chain_sync_queue
// ---------------------------------------------------------------------------

export async function enqueueChainSync(
  params: { marketId: string | null; action: string; payload: Record<string, unknown> },
  client?: PoolClient
): Promise<ChainSyncQueueRow> {
  const runner = client ?? pool;
  const res = await runner.query<ChainSyncQueueRow>(
    `INSERT INTO chain_sync_queue (market_id, action, payload)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [params.marketId, params.action, JSON.stringify(params.payload)]
  );
  return res.rows[0];
}

/**
 * Must be called with a client that is inside an open transaction — uses
 * FOR UPDATE SKIP LOCKED so multiple reconciler instances (2 Fly machines)
 * never double-process the same job.
 */
export async function claimNextPendingSyncJobs(
  client: PoolClient,
  limit = 10
): Promise<ChainSyncQueueRow[]> {
  // Atomically claim jobs by pushing next_retry_at forward inside the same
  // statement as the SKIP LOCKED select, so a second reconciler instance
  // (e.g. the second Fly machine) can't grab the same rows before this
  // transaction commits its outcome. If processing fails without updating the
  // row, the temporary claim window (5 min) simply expires and it's retried.
  const res = await client.query<ChainSyncQueueRow>(
    `WITH claimed AS (
       SELECT id FROM chain_sync_queue
       WHERE status = 'pending' AND next_retry_at <= now()
       ORDER BY next_retry_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE chain_sync_queue
     SET next_retry_at = now() + interval '5 minutes'
     WHERE id IN (SELECT id FROM claimed)
     RETURNING *`,
    [limit]
  );
  return res.rows;
}

export async function markChainSyncConfirmed(id: string): Promise<void> {
  await query(`UPDATE chain_sync_queue SET status = 'confirmed', last_error = NULL WHERE id = $1`, [id]);
}

export async function markChainSyncRetry(
  id: string,
  error: string,
  nextRetryAt: Date
): Promise<void> {
  await query(
    `UPDATE chain_sync_queue
     SET attempts = attempts + 1, last_error = $2, next_retry_at = $3
     WHERE id = $1`,
    [id, error, nextRetryAt.toISOString()]
  );
}

export async function markChainSyncFailed(id: string, error: string): Promise<void> {
  await query(
    `UPDATE chain_sync_queue SET status = 'failed', attempts = attempts + 1, last_error = $2 WHERE id = $1`,
    [id, error]
  );
}

export async function getChainSyncJob(id: string): Promise<ChainSyncQueueRow | null> {
  const res = await query<ChainSyncQueueRow>(`SELECT * FROM chain_sync_queue WHERE id = $1`, [id]);
  return res.rows[0] ?? null;
}
