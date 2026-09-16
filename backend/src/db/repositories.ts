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
  // Mirrors the contract's allowed_evidence_types field. NULL/empty means
  // no restriction — matches the contract's own treatment of an unset
  // allow-list (see pure_is_allowed_source_type in contracts/chronix.py).
  allowed_evidence_types: string | null;
  // Set once a creator requests pre-participation cancellation — see
  // requestMarketCancellation and jobs/baseRelay.ts findMarketsPendingCancelRelay.
  cancel_requested_at: string | null;
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
  /** Comma-separated, will be mirrored on-chain to create_market once funded. */
  allowedEvidenceTypes?: string | null;
}): Promise<MarketRow> {
  /**
   * Created as 'pending_chain' with no contract_market_id — the caller's
   * wallet has NOT yet funded this market on Base Sepolia. The frontend
   * derives the escrow's bytes32 key from this row's id (see
   * services/baseSepolia.ts marketIdToBytes32) and calls
   * ChronixEscrow.fund(marketId, KIND_POOL, amount) directly; the relay job
   * (jobs/baseRelay.ts) then mirrors the confirmed deposit onto GenLayer's
   * create_market and flips this row to 'open' with a real
   * contract_market_id. See routes/markets.ts POST /markets docstring.
   */
  const res = await query<MarketRow>(
    `INSERT INTO markets
       (question, category, horizon_years, resolution_criteria, created_by, status, resolves_at,
        allowed_evidence_types)
     VALUES ($1, $2, $3, $4, $5, 'pending_chain', $6, $7)
     RETURNING *`,
    [
      params.question,
      params.category,
      params.horizonYears,
      params.resolutionCriteria,
      params.createdBy,
      params.resolvesAt,
      params.allowedEvidenceTypes ?? null,
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

/** Every contract_market_id already mirrored into Postgres, known or not still active. */
export async function findKnownContractMarketIds(): Promise<Set<number>> {
  const res = await query<{ contract_market_id: string }>(
    `SELECT contract_market_id FROM markets WHERE contract_market_id IS NOT NULL`
  );
  return new Set(res.rows.map((r) => Number(r.contract_market_id)));
}

/**
 * Inserts a market discovered directly on-chain that never made it into
 * Postgres via POST /markets (e.g. the browser's mirror call failed after
 * the user's wallet already confirmed create_market on-chain). Unlike
 * insertMarket, this trusts chain state for status/financials too, since
 * there was no prior DB row to reconcile against.
 */
export async function insertMarketFromChain(params: {
  contractMarketId: number;
  question: string;
  category: string;
  horizonYears: number;
  resolutionCriteria: string;
  createdBy: string;
  resolvesAt: string;
  status: MarketStatus;
  verdict?: string;
  poolDepositedWei: string;
  totalYesWei: string;
  totalNoWei: string;
  allowedEvidenceTypes?: string | null;
}): Promise<MarketRow> {
  const res = await query<MarketRow>(
    `INSERT INTO markets
       (question, category, horizon_years, resolution_criteria, created_by, status, resolves_at,
        contract_market_id, verdict, pool_deposited_wei, total_yes_wei, total_no_wei, allowed_evidence_types)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (contract_market_id) WHERE contract_market_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      params.question,
      params.category,
      params.horizonYears,
      params.resolutionCriteria,
      params.createdBy,
      params.status,
      params.resolvesAt,
      String(params.contractMarketId),
      params.verdict ?? null,
      params.poolDepositedWei,
      params.totalYesWei,
      params.totalNoWei,
      params.allowedEvidenceTypes ?? null,
    ]
  );
  return res.rows[0];
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

export interface PortfolioPositionRow extends PositionRow {
  market_question: string;
  market_status: MarketStatus;
  contract_market_id: string | null;
}

/**
 * Same as listPositionsForWallet but joined with markets for the fields the
 * Portfolio page needs to render without an extra round trip per row. Claim
 * *eligibility* is still decided by the contract itself when the user
 * actually calls claim_payout/claim_timeout_refund — this join only drives
 * whether the UI shows a Claim button at all (settled/cancelled markets),
 * never how much or whether it will succeed.
 */
export async function listPortfolioPositionsForWallet(wallet: string): Promise<PortfolioPositionRow[]> {
  const res = await query<PortfolioPositionRow>(
    `SELECT p.*, m.question AS market_question, m.status AS market_status, m.contract_market_id
     FROM positions p
     JOIN markets m ON m.id = p.market_id
     WHERE p.wallet_address = $1
     ORDER BY p.created_at DESC`,
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

export interface EvidenceWithMarket extends EvidenceRow {
  market_question: string;
}

/** Global evidence feed across every market, newest first — powers the Evidence Ledger page. */
export async function listAllEvidence(params: {
  sourceType?: string;
  limit: number;
  offset: number;
}): Promise<{ rows: EvidenceWithMarket[]; total: number }> {
  const conditions: string[] = [];
  const queryParams: unknown[] = [];

  if (params.sourceType) {
    queryParams.push(params.sourceType);
    conditions.push(`e.source_type = $${queryParams.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRes = await query<{ count: string }>(
    `SELECT count(*)::text as count FROM evidence e ${whereClause}`,
    queryParams
  );

  queryParams.push(params.limit);
  const limitIdx = queryParams.length;
  queryParams.push(params.offset);
  const offsetIdx = queryParams.length;

  const res = await query<EvidenceWithMarket>(
    `SELECT e.*, m.question AS market_question
     FROM evidence e
     JOIN markets m ON m.id = e.market_id
     ${whereClause}
     ORDER BY e.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    queryParams
  );

  return { rows: res.rows, total: Number(countRes.rows[0]?.count ?? 0) };
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

/** Every (market_id, url) pair already mirrored, for one market — used to diff against chain state. */
export async function findKnownEvidenceUrls(marketId: string): Promise<Set<string>> {
  const res = await query<{ url: string }>(`SELECT url FROM evidence WHERE market_id = $1`, [marketId]);
  return new Set(res.rows.map((r) => r.url));
}

/**
 * Inserts an evidence pointer discovered directly on-chain that never made
 * it into Postgres via POST /markets/:id/evidence (the browser's mirror
 * call failed after the wallet already confirmed submit_evidence_pointer
 * on-chain — e.g. GenLayer RPC rate-limited the receipt poll). No summary
 * is available from chain (it's a UI-only field, never trusted by
 * adjudication), so it's left null.
 */
export async function insertEvidenceFromChain(params: {
  marketId: string;
  sourceType: string;
  url: string;
  submittedBy: string;
}): Promise<EvidenceRow | undefined> {
  const res = await query<EvidenceRow>(
    `INSERT INTO evidence (market_id, source_type, url, summary, submitted_by)
     VALUES ($1, $2, $3, NULL, $4)
     ON CONFLICT (market_id, url) DO NOTHING
     RETURNING *`,
    [params.marketId, params.sourceType, params.url, params.submittedBy]
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

// ---------------------------------------------------------------------------
// Base Sepolia funding relay (see jobs/baseRelay.ts) — bridges confirmed
// ChronixEscrow deposits <-> GenLayer's now-money-free ledger, and settled
// GenLayer payouts back onto the escrow.
// ---------------------------------------------------------------------------

/** Markets awaiting their initial-liquidity deposit to be confirmed on Base and mirrored onto GenLayer. */
export async function findMarketsPendingPoolRelay(limit = 50): Promise<MarketRow[]> {
  const res = await query<MarketRow>(
    `SELECT * FROM markets WHERE status = 'pending_chain' AND pool_relayed_at IS NULL
     ORDER BY created_at ASC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

/** Positions awaiting their stake deposit to be confirmed on Base and mirrored onto GenLayer. */
export async function findPositionsPendingRelay(limit = 100): Promise<PositionRow[]> {
  const res = await query<PositionRow>(
    `SELECT * FROM positions WHERE relayed_at IS NULL ORDER BY created_at ASC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

export async function markMarketPoolRelayed(
  marketId: string,
  params: { contractMarketId: string; fundTxHash: string },
  client?: PoolClient
): Promise<void> {
  const runner = client ?? pool;
  await runner.query(
    `UPDATE markets SET status = 'open', contract_market_id = $2, pool_fund_tx_hash = $3, pool_relayed_at = now()
     WHERE id = $1`,
    [marketId, params.contractMarketId, params.fundTxHash]
  );
}

export async function markPositionRelayed(
  positionId: string,
  fundTxHash: string,
  client?: PoolClient
): Promise<void> {
  const runner = client ?? pool;
  await runner.query(`UPDATE positions SET fund_tx_hash = $2, relayed_at = now() WHERE id = $1`, [
    positionId,
    fundTxHash,
  ]);
}

/** Settled/cancelled/refunded markets whose payouts haven't been pushed onto the escrow yet. */
export async function findMarketsPendingPayoutRelay(limit = 20): Promise<MarketRow[]> {
  const res = await query<MarketRow>(
    `SELECT * FROM markets
     WHERE status IN ('settled', 'cancelled') AND contract_market_id IS NOT NULL AND payouts_relayed_at IS NULL
     ORDER BY created_at ASC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

export async function markMarketPayoutsRelayed(marketId: string, txHash: string, client?: PoolClient): Promise<void> {
  const runner = client ?? pool;
  await runner.query(`UPDATE markets SET payouts_relayed_at = now() WHERE id = $1`, [marketId]);
  await insertMarketEvent(
    {
      marketId,
      type: "payout_claimed",
      payload: { txHash, relayedToEscrow: true },
      chainTxHash: txHash,
      confirmed: true,
    },
    client
  );
}

/**
 * Records a creator's cancellation request. Pre-participation only
 * (total_yes/total_no == 0), matching the contract's own `pure_can_cancel`
 * guard. If the market never made it past 'pending_chain' (no confirmed
 * Base deposit relayed onto GenLayer yet), there is nothing on-chain to
 * unwind, so it's cancelled immediately. Otherwise this just records the
 * request — the relay job (jobs/baseRelay.ts) drives the actual
 * cancel_market + escrow refund once it next runs.
 */
export async function requestMarketCancellation(marketId: string): Promise<MarketRow> {
  const res = await query<MarketRow>(
    `UPDATE markets
     SET cancel_requested_at = now(),
         status = CASE WHEN contract_market_id IS NULL THEN 'cancelled' ELSE status END
     WHERE id = $1
     RETURNING *`,
    [marketId]
  );
  return res.rows[0];
}

/** Open markets with a pending cancellation request the relay job hasn't driven to completion yet. */
export async function findMarketsPendingCancelRelay(limit = 20): Promise<MarketRow[]> {
  const res = await query<MarketRow>(
    `SELECT * FROM markets
     WHERE cancel_requested_at IS NOT NULL AND status = 'open'
       AND contract_market_id IS NOT NULL AND payouts_relayed_at IS NULL
     ORDER BY cancel_requested_at ASC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

export async function getBaseRelayWatermark(): Promise<number> {
  const res = await query<{ last_scanned_block: string }>(
    `SELECT last_scanned_block FROM base_relay_watermark WHERE id = 1`
  );
  return Number(res.rows[0]?.last_scanned_block ?? 0);
}

export async function setBaseRelayWatermark(blockNumber: number): Promise<void> {
  await query(
    `UPDATE base_relay_watermark SET last_scanned_block = $1, updated_at = now() WHERE id = 1`,
    [blockNumber]
  );
}

/**
 * Persists every ChronixEscrow Funded event scanned this tick, durably and
 * independent of the base_relay_watermark. This is what lets
 * relayPendingPools/relayPendingStakes retry a match on every future pass
 * instead of only the one tick that first saw it — see
 * database/migrations/010_base_relay_events.sql for the bug this fixes.
 * ON CONFLICT DO NOTHING makes re-scanning an overlapping block range safe.
 */
export async function insertFundedEvents(
  events: Array<{ marketId: string; from: string; kind: number; amount: bigint; txHash: string; blockNumber: number }>
): Promise<void> {
  if (events.length === 0) return;
  for (const e of events) {
    await query(
      `INSERT INTO base_relay_events (market_id_bytes32, from_address, kind, amount, tx_hash, block_number)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tx_hash, market_id_bytes32, kind) DO NOTHING`,
      [e.marketId.toLowerCase(), e.from.toLowerCase(), e.kind, e.amount.toString(), e.txHash, e.blockNumber]
    );
  }
}

export interface BaseRelayEventRow {
  id: string;
  market_id_bytes32: string;
  from_address: string;
  kind: number;
  amount: string;
  tx_hash: string;
  block_number: string;
  created_at: Date;
}

/** All persisted Funded events for one market's bytes32 key + kind (KIND_POOL, KIND_YES, or KIND_NO). */
export async function findFundedEventsForMarket(marketIdBytes32: string, kind: number): Promise<BaseRelayEventRow[]> {
  const res = await query<BaseRelayEventRow>(
    `SELECT * FROM base_relay_events WHERE market_id_bytes32 = $1 AND kind = $2 ORDER BY block_number ASC`,
    [marketIdBytes32.toLowerCase(), kind]
  );
  return res.rows;
}
