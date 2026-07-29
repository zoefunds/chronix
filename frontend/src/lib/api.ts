import type {
  AdjudicationResult,
  CreateMarketPayload,
  Evidence,
  Market,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
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
  listMarkets: (filters: MarketFilters = {}) =>
    request<Market[]>(`/markets${toQuery(filters)}`),

  /** GET /markets/:id */
  getMarket: (id: string) => request<Market>(`/markets/${id}`),

  /** POST /markets */
  createMarket: (payload: CreateMarketPayload) =>
    request<Market>('/markets', { method: 'POST', body: JSON.stringify(payload) }),

  /** GET /markets/:id/positions */
  getMarketPositions: (id: string) => request<Position[]>(`/markets/${id}/positions`),

  /** POST /markets/:id/positions — stake YES/NO */
  stake: (id: string, payload: { side: 'yes' | 'no'; amount: number; wallet: string }) =>
    request<Position>(`/markets/${id}/positions`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /** GET /markets/:id/evidence */
  getMarketEvidence: (id: string) => request<Evidence[]>(`/markets/${id}/evidence`),

  /** POST /markets/:id/evidence — submit an evidence pointer (URL only) */
  submitEvidence: (
    id: string,
    payload: { sourceType: string; url: string; summary: string; wallet: string },
  ) => request<Evidence>(`/markets/${id}/evidence`, { method: 'POST', body: JSON.stringify(payload) }),

  /** GET /markets/:id/adjudicate — read-only adjudication status/result */
  getAdjudication: (id: string) => request<AdjudicationResult>(`/markets/${id}/adjudicate`),

  /** GET /portfolio/:wallet */
  getPortfolio: (wallet: string) => request<Portfolio>(`/portfolio/${wallet}`),

  /** GET /health */
  health: () => request<{ status: string }>('/health'),

  // --- Auth: SIWE nonce + verify (backend endpoints per PLANNING.md auth flow) ---
  getNonce: (wallet: string) => request<{ nonce: string }>(`/auth/nonce${toQuery({ wallet })}`),

  verifySiwe: (payload: { message: string; signature: string }) =>
    request<{ token: string; wallet: string }>('/auth/verify', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
}
