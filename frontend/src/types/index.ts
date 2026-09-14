export type Horizon = 3 | 5 | 10 | 'permanent'

// Mirrors the backend's real market_status enum (database/schema.sql) exactly.
export type MarketStatus = 'pending_chain' | 'open' | 'awaiting_adjudication' | 'settled' | 'cancelled' | 'failed'

export type MarketCategory =
  | 'politics'
  | 'technology'
  | 'culture'
  | 'science'
  | 'economics'
  | 'geopolitics'
  | 'sports'
  | 'other'

export type EvidenceSourceType = 'news' | 'academic' | 'government' | 'market' | 'social' | 'primary'

/**
 * Matches the backend's real markets row shape (snake_case, as returned by
 * GET /markets and GET /markets/:id — see backend/src/db/repositories.ts
 * MarketRow). The `*_wei` fields are decimal-string USDC base-unit amounts
 * (6 decimals; the name predates the move off native GEN — see
 * contracts/chronix.py) — use baseUnitsToUsdc()/formatUsdc() from
 * lib/format.ts to render them, never parseFloat directly (precision loss
 * on large values).
 */
export interface Market {
  id: string
  question: string
  category: string
  horizon_years: string
  resolution_criteria: string
  created_by: string
  contract_market_id: string | null
  status: MarketStatus
  resolves_at: string
  created_at: string
  deadline_enforced_at: string | null
  pool_deposited_wei: string
  total_yes_wei: string
  total_no_wei: string
  verdict: string | null
  /** Comma-separated; NULL/empty means the contract enforces no restriction. */
  allowed_evidence_types: string | null
  /** Set once the creator requests cancellation — see POST /markets/:id/cancel-request. */
  cancel_requested_at: string | null
  participant_count?: string
}

/** Matches backend PositionRow exactly (see backend/src/db/repositories.ts). */
export interface Position {
  id: string
  market_id: string
  wallet_address: string
  side: 'yes' | 'no'
  shares: string
  avg_price: string
  tx_hash: string | null
  created_at: string
}

export type MarketEventType =
  | 'created'
  | 'deadline_passed'
  | 'evidence_submitted'
  | 'stake_recorded'
  | 'verdict_pending'
  | 'verdict_settled'
  | 'payout_claimed'
  | 'reconciled'

/** Matches backend MarketEventRow exactly. */
export interface MarketEvent {
  id: string
  market_id: string
  type: MarketEventType
  payload: Record<string, unknown>
  chain_tx_hash: string | null
  confirmed: boolean
  created_at: string
}

/** Matches backend EvidenceRow exactly. weight is null until the contract's own adjudication assigns it. */
export interface Evidence {
  id: string
  market_id: string
  source_type: string
  url: string
  summary: string | null
  submitted_by: string
  weight: string | null
  created_at: string
}

/** GET /evidence (global feed) row — Evidence plus the market's question, joined server-side. */
export interface EvidenceWithMarket extends Evidence {
  market_question: string
}

/**
 * Matches the real GET /markets/:id/adjudicate response exactly. There is
 * no confidence score, source-weight breakdown, or reasoning-step timeline
 * here — that data would come from the contract's own nondet execution
 * trace, which nothing in this backend reads or stores yet (see MEMORY.md).
 * The UI builds its timeline from real market_events rows instead (see
 * GET /markets/:id/events) — genuine recorded history, not a fabricated
 * play-by-play.
 */
export interface AdjudicationStatus {
  marketId: string
  status: MarketStatus
  resolvesAt: string
  deadlineEnforcedAt: string | null
  adjudication: {
    requested: boolean
    settled: boolean
    verdict: Record<string, unknown> | null
  }
}

/**
 * Matches backend PortfolioPositionRow (GET /portfolio/:wallet) — a Position
 * joined with its market's question/status/contract_market_id. There is no
 * pre-computed "claimable"/"claimableAmount" here: the contract itself is
 * the only thing that knows whether a specific wallet's stake resolves to a
 * positive payout, so the UI shows a Claim button whenever the market's
 * status makes it *possible* (settled/cancelled) and lets the on-chain call
 * itself succeed or revert with the real reason.
 */
export interface PortfolioPosition extends Position {
  market_question: string
  market_status: MarketStatus
  contract_market_id: string | null
}

export interface Portfolio {
  wallet: string
  positions: PortfolioPosition[]
}

export interface CreateMarketPayload {
  question: string
  category: MarketCategory
  horizonYears: Horizon
  resolutionCriteria: string
  allowedEvidenceSources: EvidenceSourceType[]
  initialLiquidity: number
}
