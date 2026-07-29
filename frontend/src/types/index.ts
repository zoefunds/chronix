export type Horizon = 3 | 5 | 10 | 'permanent'

export type MarketStatus =
  | 'open'
  | 'awaiting_adjudication'
  | 'verdict_pending'
  | 'resolved'
  | 'undetermined'
  | 'cancelled'

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

export interface Market {
  id: string
  question: string
  category: MarketCategory
  horizonYears: Horizon
  resolutionCriteria: string
  createdBy: string
  contractMarketId: string | null
  status: MarketStatus
  resolvesAt: string
  createdAt: string
  yesPool: number
  noPool: number
  totalStaked: number
  participantCount: number
  allowedEvidenceSources: EvidenceSourceType[]
}

export interface Position {
  id: string
  marketId: string
  walletAddress: string
  side: 'yes' | 'no'
  shares: number
  avgPrice: number
  txHash: string | null
  createdAt: string
}

export type MarketEventType =
  | 'created'
  | 'deadline_passed'
  | 'evidence_submitted'
  | 'verdict_pending'
  | 'verdict_settled'
  | 'payout_claimed'
  | 'reconciled'

export interface MarketEvent {
  id: string
  marketId: string
  type: MarketEventType
  payload: Record<string, unknown>
  chainTxHash: string | null
  confirmed: boolean
  createdAt: string
}

export interface Evidence {
  id: string
  marketId: string
  sourceType: EvidenceSourceType
  url: string
  summary: string
  submittedBy: string
  weight: number
  createdAt: string
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
