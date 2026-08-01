import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Card, Label, StatusChip } from '../components/ui'
import { useAuth } from '../lib/auth'
import { api } from '../lib/api'
import { formatGen, weiToGen } from '../lib/format'
import { genlayer } from '../lib/genlayer'
import type { Address } from 'genlayer-js/types'
import type { PortfolioPosition } from '../types'

/** Markets in these states have *some* exit path available (payout or refund/cancel). */
const CLAIMABLE_STATUSES = new Set(['settled', 'cancelled'])

export default function Portfolio() {
  const { wallet } = useAuth()
  const [positions, setPositions] = useState<PortfolioPosition[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [claiming, setClaiming] = useState<string | null>(null)
  const [claimError, setClaimError] = useState<string | null>(null)

  useEffect(() => {
    if (!wallet) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .getPortfolio(wallet)
      .then((p) => {
        if (!cancelled) setPositions(p.positions)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load portfolio.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [wallet])

  async function handleClaim(p: PortfolioPosition) {
    if (!wallet || !p.contract_market_id) return
    setClaiming(p.id)
    setClaimError(null)
    try {
      const contractMarketId = Number(p.contract_market_id)
      if (p.market_status === 'cancelled') {
        await genlayer.claimTimeoutRefund(wallet as Address, contractMarketId)
      } else {
        await genlayer.claimPayout(wallet as Address, contractMarketId)
      }
      // Refresh from the backend mirror; the contract is the real source of
      // truth for whether the claim actually succeeded.
      const refreshed = await api.getPortfolio(wallet)
      setPositions(refreshed.positions)
    } catch (err) {
      setClaimError(err instanceof Error ? err.message : 'Claim failed — the contract rejected this call.')
    } finally {
      setClaiming(null)
    }
  }

  if (!wallet) {
    return (
      <Card className="p-8 text-center flex flex-col items-center gap-3 max-w-md mx-auto mt-12">
        <Label>Portfolio</Label>
        <p className="text-body-md text-on-surface-variant">
          Connect and sign in with your wallet to view your positions and claim payouts.
        </p>
      </Card>
    )
  }

  const totalStaked = positions.reduce((sum, p) => sum + weiToGen(p.shares), 0)
  const openCount = positions.filter((p) => p.market_status === 'open').length

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-headline text-headline-lg text-primary">Portfolio</h1>

      {error && <Card className="p-4 text-body-sm text-error">Couldn't load your portfolio: {error}</Card>}
      {claimError && <Card className="p-4 text-body-sm text-error">Claim failed: {claimError}</Card>}

      <div className="grid md:grid-cols-3 gap-4">
        <Card className="p-4">
          <Label>Total staked</Label>
          <div className="font-headline text-headline-lg text-primary mt-1">
            {totalStaked.toLocaleString(undefined, { maximumFractionDigits: 2 })} GEN
          </div>
        </Card>
        <Card className="p-4">
          <Label>Positions</Label>
          <div className="font-headline text-headline-lg text-primary mt-1">{positions.length}</div>
        </Card>
        <Card className="p-4">
          <Label>Open positions</Label>
          <div className="font-headline text-headline-lg text-primary mt-1">{openCount}</div>
        </Card>
      </div>

      {loading && <div className="text-center text-on-surface-variant text-body-sm py-8">Loading your positions…</div>}

      {!loading && (
        <Card className="overflow-x-auto">
          <table className="w-full text-body-sm">
            <thead>
              <tr className="text-label-sm font-label text-on-surface-variant uppercase tracking-widest border-b border-outline-variant">
                <th className="text-left p-3">Market</th>
                <th className="text-left p-3">Side</th>
                <th className="text-right p-3">Staked</th>
                <th className="text-left p-3">Status</th>
                <th className="text-right p-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.id} className="border-b border-outline-variant/30 hover:bg-surface-container-low">
                  <td className="p-3 max-w-xs">
                    <Link to={`/markets/${p.market_id}`} className="hover:text-secondary line-clamp-1">
                      {p.market_question}
                    </Link>
                  </td>
                  <td className={`p-3 font-label ${p.side === 'yes' ? 'text-secondary' : 'text-pending-amber'}`}>
                    {p.side.toUpperCase()}
                  </td>
                  <td className="p-3 text-right font-label">{formatGen(p.shares)} GEN</td>
                  <td className="p-3">
                    <StatusChip status={p.market_status} />
                  </td>
                  <td className="p-3 text-right">
                    {CLAIMABLE_STATUSES.has(p.market_status) && p.contract_market_id ? (
                      <Button variant="secondary" disabled={claiming === p.id} onClick={() => handleClaim(p)}>
                        {claiming === p.id ? 'Claiming…' : 'Claim'}
                      </Button>
                    ) : (
                      <span className="text-on-surface-variant text-label-sm">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {positions.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-on-surface-variant text-body-sm py-8">
                    No positions yet — stake on a market to see it here.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
