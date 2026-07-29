import type { EvidenceSourceType, MarketCategory } from '../types'

/**
 * Mock data for pages whose full backend support doesn't exist yet
 * (Portfolio claimable amounts, AdjudicationResult reasoning timelines —
 * these need real on-chain reads / GenVM trace data the backend doesn't
 * compute today). Discover, MarketDetail, and CreateMarket are wired to
 * live data via src/lib/api.ts + src/lib/genlayer.ts — see MEMORY.md for
 * exactly which pages still need this wiring.
 *
 * Deliberately typed with LOCAL interfaces below, not the real API types
 * in ../types, since those now mirror the backend's actual (leaner) row
 * shapes and no longer have fields like yesPool/claimableAmount that only
 * this mock data provides.
 */

interface MockMarket {
  id: string
  question: string
  category: MarketCategory
  horizonYears: 3 | 5 | 10 | 'permanent'
  resolutionCriteria: string
  createdBy: string
  contractMarketId: string | null
  status: 'open' | 'awaiting_adjudication' | 'verdict_pending' | 'resolved' | 'undetermined' | 'cancelled'
  resolvesAt: string
  createdAt: string
  yesPool: number
  noPool: number
  totalStaked: number
  participantCount: number
  allowedEvidenceSources: EvidenceSourceType[]
}

interface MockEvidence {
  id: string
  marketId: string
  sourceType: EvidenceSourceType
  url: string
  summary: string
  submittedBy: string
  weight: number
  createdAt: string
}

interface MockAdjudicationResult {
  marketId: string
  verdict: 'yes' | 'no' | 'undetermined'
  confidence: number
  sourceWeights: { sourceType: EvidenceSourceType; weight: number; sourcesConsulted: number }[]
  reasoningTimeline: { timestamp: string; step: string; detail: string }[]
  evidenceArtifacts: MockEvidence[]
  settledAt: string | null
}

interface MockPortfolioPosition {
  id: string
  marketId: string
  walletAddress: string
  side: 'yes' | 'no'
  shares: number
  avgPrice: number
  txHash: string | null
  createdAt: string
  marketQuestion: string
  marketStatus: MockMarket['status']
  currentValue: number
  claimable: boolean
  claimableAmount: number
}

interface MockPortfolio {
  wallet: string
  positions: MockPortfolioPosition[]
  totalStaked: number
  totalClaimable: number
  history: {
    id: string
    marketId: string
    type: string
    payload: Record<string, unknown>
    chainTxHash: string | null
    confirmed: boolean
    createdAt: string
  }[]
}

export const mockMarkets: MockMarket[] = [
  {
    id: 'mkt-001',
    question: 'Will the 2020s be remembered as the decade AI surpassed human-level reasoning?',
    category: 'technology',
    horizonYears: 5,
    resolutionCriteria:
      'Resolves YES if a consensus of >=3 independent academic and press sources by Dec 31 2029 characterize the 2020s as the decade general reasoning parity was reached.',
    createdBy: '0x7a2f...9c31',
    contractMarketId: 'gl-mkt-0091',
    status: 'open',
    resolvesAt: '2029-12-31T00:00:00Z',
    createdAt: '2026-01-14T00:00:00Z',
    yesPool: 84210,
    noPool: 51340,
    totalStaked: 135550,
    participantCount: 412,
    allowedEvidenceSources: ['news', 'academic', 'market'],
  },
  {
    id: 'mkt-002',
    question: 'Will historians credit the 2024-2028 period with reversing global democratic backsliding?',
    category: 'politics',
    horizonYears: 10,
    resolutionCriteria:
      'Resolves YES if Freedom House / V-Dem aggregate indices by 2036 show net global improvement attributable to this period, per academic consensus.',
    createdBy: '0x11ab...44de',
    contractMarketId: 'gl-mkt-0088',
    status: 'awaiting_adjudication',
    resolvesAt: '2026-07-01T00:00:00Z',
    createdAt: '2025-02-02T00:00:00Z',
    yesPool: 22100,
    noPool: 68900,
    totalStaked: 91000,
    participantCount: 208,
    allowedEvidenceSources: ['news', 'government', 'academic'],
  },
  {
    id: 'mkt-003',
    question: 'Will the James Webb era (2022-2032) be remembered as astronomy\'s greatest decade of discovery?',
    category: 'science',
    horizonYears: 10,
    resolutionCriteria:
      'Resolves YES if peer-reviewed retrospectives and major science bodies by 2032 rank this decade as astronomy\'s most significant on record.',
    createdBy: '0x99cd...12aa',
    contractMarketId: 'gl-mkt-0072',
    status: 'open',
    resolvesAt: '2032-01-01T00:00:00Z',
    createdAt: '2024-11-20T00:00:00Z',
    yesPool: 61200,
    noPool: 14800,
    totalStaked: 76000,
    participantCount: 301,
    allowedEvidenceSources: ['academic', 'news', 'primary'],
  },
  {
    id: 'mkt-004',
    question: 'Will the 2026 World Cup expansion be remembered as a turning point for the sport\'s global reach?',
    category: 'sports',
    horizonYears: 3,
    resolutionCriteria:
      'Resolves YES if viewership and participation data plus sports-historian consensus by 2029 credit the 48-team format as the inflection point.',
    createdBy: '0x55ff...ab90',
    contractMarketId: 'gl-mkt-0110',
    status: 'open',
    resolvesAt: '2029-01-01T00:00:00Z',
    createdAt: '2026-03-05T00:00:00Z',
    yesPool: 33400,
    noPool: 29800,
    totalStaked: 63200,
    participantCount: 155,
    allowedEvidenceSources: ['news', 'market', 'social'],
  },
  {
    id: 'mkt-005',
    question: 'Will the current stablecoin regulatory framework be remembered as the moment crypto went mainstream?',
    category: 'economics',
    horizonYears: 'permanent',
    resolutionCriteria:
      'Resolves YES if, in perpetuity re-checked every 5 years, financial historians attribute mainstream fiat-parity adoption of crypto to this framework.',
    createdBy: '0x22bc...77f1',
    contractMarketId: 'gl-mkt-0065',
    status: 'resolved',
    resolvesAt: '2031-01-01T00:00:00Z',
    createdAt: '2025-05-19T00:00:00Z',
    yesPool: 142000,
    noPool: 38000,
    totalStaked: 180000,
    participantCount: 640,
    allowedEvidenceSources: ['news', 'government', 'market', 'academic'],
  },
  {
    id: 'mkt-006',
    question: 'Will the 2025-2027 Red Sea shipping crisis be remembered as the catalyst for supply-chain reshoring?',
    category: 'geopolitics',
    horizonYears: 5,
    resolutionCriteria:
      'Resolves YES if trade-flow data and economic historian consensus by 2031 attribute a durable reshoring trend to this crisis.',
    createdBy: '0x88de...31ba',
    contractMarketId: null,
    status: 'undetermined',
    resolvesAt: '2031-06-01T00:00:00Z',
    createdAt: '2025-08-12T00:00:00Z',
    yesPool: 40200,
    noPool: 39800,
    totalStaked: 80000,
    participantCount: 190,
    allowedEvidenceSources: ['news', 'government', 'market'],
  },
]

export const mockEvidence: MockEvidence[] = [
  {
    id: 'ev-001',
    marketId: 'mkt-001',
    sourceType: 'academic',
    url: 'https://arxiv.org/abs/2601.00001',
    summary: 'Stanford HAI 2026 index shows a 40% jump in reasoning-benchmark parity year-over-year.',
    submittedBy: '0x7a2f...9c31',
    weight: 0.9,
    createdAt: '2026-06-01T00:00:00Z',
  },
  {
    id: 'ev-002',
    marketId: 'mkt-001',
    sourceType: 'news',
    url: 'https://www.ft.com/content/example',
    summary: 'Financial Times: "Reasoning models cross a threshold long thought a decade away."',
    submittedBy: '0x11ab...44de',
    weight: 0.6,
    createdAt: '2026-06-10T00:00:00Z',
  },
  {
    id: 'ev-003',
    marketId: 'mkt-002',
    sourceType: 'government',
    url: 'https://freedomhouse.org/report/example',
    summary: 'Freedom House 2026 report shows mixed global trend, no clear reversal yet.',
    submittedBy: '0x99cd...12aa',
    weight: 0.7,
    createdAt: '2026-05-22T00:00:00Z',
  },
  {
    id: 'ev-004',
    marketId: 'mkt-003',
    sourceType: 'primary',
    url: 'https://webb.nasa.gov/example',
    summary: 'JWST direct imaging of an exoplanet atmosphere confirmed biosignature candidate molecule.',
    submittedBy: '0x55ff...ab90',
    weight: 0.95,
    createdAt: '2026-04-18T00:00:00Z',
  },
]

export const mockAdjudication: MockAdjudicationResult = {
  marketId: 'mkt-005',
  verdict: 'yes',
  confidence: 0.87,
  sourceWeights: [
    { sourceType: 'government', weight: 0.35, sourcesConsulted: 4 },
    { sourceType: 'news', weight: 0.3, sourcesConsulted: 6 },
    { sourceType: 'academic', weight: 0.25, sourcesConsulted: 3 },
    { sourceType: 'market', weight: 0.1, sourcesConsulted: 2 },
  ],
  reasoningTimeline: [
    {
      timestamp: '2031-01-02T00:00:00Z',
      step: 'Deadline confirmed',
      detail: 'On-chain deadline check confirmed resolves_at had passed; market flipped to awaiting_adjudication.',
    },
    {
      timestamp: '2031-01-02T00:05:00Z',
      step: 'Evidence fetch initiated',
      detail: 'gl.nondet web-fetch dispatched against 15 independent sources across 4 evidence-source types.',
    },
    {
      timestamp: '2031-01-02T00:07:00Z',
      step: 'Cross-validator consensus',
      detail: 'Weighted consensus across validator set reached non-strict equivalence above threshold.',
    },
    {
      timestamp: '2031-01-02T00:08:00Z',
      step: 'Verdict settled',
      detail: 'Verdict: YES, confidence 0.87. Escrow ledger zeroed and payout funds released via _send_gen.',
    },
  ],
  evidenceArtifacts: mockEvidence.slice(0, 2),
  settledAt: '2031-01-02T00:08:00Z',
}

export const mockPortfolio: MockPortfolio = {
  wallet: '0x7a2f1c9d4e8b3f0a5d6c7e8f9a0b1c2d3e4f9c31',
  totalStaked: 24500,
  totalClaimable: 3200,
  positions: [
    {
      id: 'pos-001',
      marketId: 'mkt-005',
      walletAddress: '0x7a2f...9c31',
      side: 'yes',
      shares: 1200,
      avgPrice: 0.62,
      txHash: '0xabc123...',
      createdAt: '2025-06-01T00:00:00Z',
      marketQuestion: mockMarkets[4].question,
      marketStatus: 'resolved',
      currentValue: 1935,
      claimable: true,
      claimableAmount: 3200,
    },
    {
      id: 'pos-002',
      marketId: 'mkt-001',
      walletAddress: '0x7a2f...9c31',
      side: 'yes',
      shares: 800,
      avgPrice: 0.55,
      txHash: '0xdef456...',
      createdAt: '2026-02-10T00:00:00Z',
      marketQuestion: mockMarkets[0].question,
      marketStatus: 'open',
      currentValue: 1455,
      claimable: false,
      claimableAmount: 0,
    },
    {
      id: 'pos-003',
      marketId: 'mkt-004',
      walletAddress: '0x7a2f...9c31',
      side: 'no',
      shares: 500,
      avgPrice: 0.47,
      txHash: null,
      createdAt: '2026-03-06T00:00:00Z',
      marketQuestion: mockMarkets[3].question,
      marketStatus: 'open',
      currentValue: 235,
      claimable: false,
      claimableAmount: 0,
    },
  ],
  history: [
    {
      id: 'evt-001',
      marketId: 'mkt-005',
      type: 'verdict_settled',
      payload: { verdict: 'yes' },
      chainTxHash: '0x9f8e...1122',
      confirmed: true,
      createdAt: '2031-01-02T00:08:00Z',
    },
    {
      id: 'evt-002',
      marketId: 'mkt-001',
      type: 'evidence_submitted',
      payload: { sourceType: 'academic' },
      chainTxHash: null,
      confirmed: true,
      createdAt: '2026-06-01T00:00:00Z',
    },
  ],
}
