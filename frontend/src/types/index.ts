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
 * MarketRow). Wei fields are decimal-string GEN amounts (18 decimals) — use
 * weiToGen() from lib/format.ts to render them, never parseFloat directly
 * (precision loss on large values).
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

export interface AdjudicationResult {
  marketId: string
  verdict: 'yes' | 'no' | 'undetermined'
  confidence: number
  sourceWeights: { sourceType: EvidenceSourceType; weight: number; sourcesConsulted: number }[]
  reasoningTimeline: { timestamp: string; step: string; detail: string }[]
  evidenceArtifacts: Evidence[]
  settledAt: string | null
}

export interface PortfolioPosition extends Position {
  marketQuestion: string
  marketStatus: MarketStatus
  currentValue: number
  claimable: boolean
  claimableAmount: number
}

export interface Portfolio {
  wallet: string
  positions: PortfolioPosition[]
  totalStaked: number
  totalClaimable: number
  history: MarketEvent[]
}

export interface CreateMarketPayload {
  question: string
  category: MarketCategory
  horizonYears: Horizon
  resolutionCriteria: string
  allowedEvidenceSources: EvidenceSourceType[]
  initialLiquidity: number
}
