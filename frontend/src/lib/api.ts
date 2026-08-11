import type {
  AdjudicationStatus,
  CreateMarketPayload,
  Evidence,
  EvidenceWithMarket,
  Market,
  MarketEvent,
  Portfolio,
  Position,
} from '../types'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8080'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit, token?: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      // Only set Content-Type when there's actually a body — Fastify's JSON
      // parser rejects an empty body sent with 'application/json' (this bit
      // POST /sync, which takes no body).
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ApiError(res.status, body || res.statusText)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export type MarketFilters = {
  category?: string
  horizon?: string
  status?: string
  search?: string
  [key: string]: string | undefined
}

function toQuery(params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v) usp.set(k, v)
  }
  const qs = usp.toString()
  return qs ? `?${qs}` : ''
}

export const api = {
  /** GET /markets */
  async listMarkets(filters: MarketFilters = {}) {
    const res = await request<{ markets: Market[]; total: number }>(`/markets${toQuery(filters)}`)
    return res.markets
  },

  /** GET /markets/:id */
  async getMarket(id: string) {
    const res = await request<{ market: Market }>(`/markets/${id}`)
    return res.market
  },

  /**
   * POST /markets — records a market AFTER the user's own wallet already
   * signed and submitted create_market directly on GenLayer (see
   * src/lib/genlayer.ts). onChain proof (contractMarketId + txHash) is
   * required — this never submits the on-chain write itself.
   */
  async createMarket(
    payload: CreateMarketPayload,
    onChain: { contractMarketId: string; txHash: string; resolvesAt: string },
    token: string,
  ) {
    const res = await request<{ market: Market }>(
      '/markets',
      {
        method: 'POST',
        body: JSON.stringify({
          question: payload.question,
          category: payload.category,
          horizonYears: payload.horizonYears === 'permanent' ? 100 : payload.horizonYears,
          resolutionCriteria: payload.resolutionCriteria,
          resolvesAt: onChain.resolvesAt,
          contractMarketId: onChain.contractMarketId,
          txHash: onChain.txHash,
          allowedEvidenceSources: payload.allowedEvidenceSources,
        }),
      },
      token,
    )
    return res.market
  },

  /** GET /markets/:id/positions */
  async getMarketPositions(id: string) {
    const res = await request<{ positions: Position[] }>(`/markets/${id}/positions`)
    return res.positions
  },

  /**
   * POST /markets/:id/positions — records a stake AFTER the user's own
   * wallet already called the payable `stake` method directly on GenLayer.
   */
  async stake(
    id: string,
    payload: { side: 'yes' | 'no'; shares: string; avgPrice: string; txHash: string },
    token: string,
  ) {
    const res = await request<{ position: Position }>(
      `/markets/${id}/positions`,
      { method: 'POST', body: JSON.stringify(payload) },
      token,
    )
    return res.position
  },

  /** GET /evidence — global feed across every market, paginated (backend caps limit at 200). */
  async listAllEvidence(filters: { sourceType?: string; limit?: number; offset?: number } = {}) {
    return request<{ evidence: EvidenceWithMarket[]; total: number; limit: number; offset: number }>(
      `/evidence${toQuery({
        sourceType: filters.sourceType,
        limit: filters.limit !== undefined ? String(filters.limit) : undefined,
        offset: filters.offset !== undefined ? String(filters.offset) : undefined,
      })}`
    )
  },

  /** GET /markets/:id/evidence */
  async getMarketEvidence(id: string) {
    const res = await request<{ evidence: Evidence[] }>(`/markets/${id}/evidence`)
    return res.evidence
  },

  /**
   * POST /markets/:id/evidence — records a pointer AFTER the user's own
   * wallet already called submit_evidence_pointer directly on GenLayer.
   */
  async submitEvidence(
    id: string,
    payload: { sourceType: string; url: string; summary: string; txHash: string },
    token: string,
  ) {
    const res = await request<{ evidence: Evidence }>(
      `/markets/${id}/evidence`,
      { method: 'POST', body: JSON.stringify(payload) },
      token,
    )
    return res.evidence
  },

  /** GET /markets/:id/adjudicate — read-only adjudication status/result */
  getAdjudication: (id: string) => request<AdjudicationStatus>(`/markets/${id}/adjudicate`),

  /** GET /markets/:id/events — real, ordered market_events history */
  async getMarketEvents(id: string) {
    const res = await request<{ events: MarketEvent[] }>(`/markets/${id}/events`)
    return res.events
  },

  /** GET /markets/:id/trace — real GenVM execution trace for the settle() tx, if available */
  getTrace: (id: string) =>
    request<{
      trace: {
        resultCode: number
        returnData: string
        stdout: string
        stderr: string
        eqOutputs: string[]
        genvmLog: Record<string, unknown>[]
      } | null
      reason: string | null
    }>(`/markets/${id}/trace`),

  /** GET /portfolio/:wallet */
  getPortfolio: (wallet: string) => request<Portfolio>(`/portfolio/${wallet}`),

  /** GET /health */
  health: () => request<{ status: string }>('/health'),

  /**
   * POST /sync — on-demand chain resync: re-reads every active market from
   * GenLayer directly and backfills anything confirmed on-chain but missing
   * from Chronix's index (a mirror-POST that failed after the on-chain
   * write already succeeded). Rate-limited server-side; safe to expose as a
   * user-facing button.
   */
  sync: () =>
    request<{ checked: number; updated: number; discovered: number; evidenceBackfilled: number }>('/sync', {
      method: 'POST',
    }),

  // --- Auth: SIWE nonce + verify (backend endpoints per PLANNING.md auth flow) ---
  getNonce: (wallet: string) =>
    request<{ nonce: string }>('/auth/nonce', { method: 'POST', body: JSON.stringify({ wallet }) }),

  verifySiwe: (payload: { message: string; signature: string }) =>
    request<{ token: string; wallet: string }>('/auth/verify', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
}
