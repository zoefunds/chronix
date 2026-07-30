import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Button, Card, EvidenceChip, Label } from '../components/ui'
import { useAuth } from '../lib/auth'
import { api } from '../lib/api'
import { genlayer } from '../lib/genlayer'
import { formatGen } from '../lib/format'
import type { Address } from 'genlayer-js/types'
import type { AdjudicationStatus, Evidence, Market, MarketEvent } from '../types'

const verdictStyles: Record<string, string> = {
  YES: 'text-resolved-emerald border-resolved-emerald/30 bg-resolved-emerald/10',
  NO: 'text-error border-error/30 bg-error/10',
  SPLIT: 'text-pending-amber border-pending-amber/30 bg-pending-amber/10',
}

export default function AdjudicationResultPage() {
  const { id } = useParams()
  const { wallet } = useAuth()

  const [market, setMarket] = useState<Market | null>(null)
  const [adjudication, setAdjudication] = useState<AdjudicationStatus | null>(null)
  const [events, setEvents] = useState<MarketEvent[]>([])
  const [evidence, setEvidence] = useState<Evidence[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [claiming, setClaiming] = useState(false)
  const [claimError, setClaimError] = useState<string | null>(null)
  const [claimed, setClaimed] = useState(false)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([api.getMarket(id), api.getAdjudication(id), api.getMarketEvents(id), api.getMarketEvidence(id)])
      .then(([m, a, ev, ep]) => {
        if (cancelled) return
        setMarket(m)
        setAdjudication(a)
        setEvents(ev)
        setEvidence(ep)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load adjudication result.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  async function handleClaim() {
    if (!wallet || !market?.contract_market_id) return
    setClaiming(true)
    setClaimError(null)
    try {
      const contractMarketId = Number(market.contract_market_id)
      if (market.status === 'cancelled') {
        await genlayer.claimTimeoutRefund(wallet as Address, contractMarketId)
      } else {
        await genlayer.claimPayout(wallet as Address, contractMarketId)
      }
      setClaimed(true)
    } catch (err) {
      setClaimError(err instanceof Error ? err.message : 'Claim failed — the contract rejected this call.')
    } finally {
      setClaiming(false)
    }
  }

  if (loading) {
    return <div className="text-center text-on-surface-variant text-body-sm py-16">Loading adjudication record…</div>
  }

  if (error || !market || !adjudication) {
    return (
      <Card className="p-6 text-center text-body-sm text-error max-w-lg mx-auto mt-12">
        Couldn't load this market's adjudication record: {error ?? 'not found'}
      </Card>
    )
  }

  const verdictPayload = adjudication.adjudication.verdict as { verdict?: string } | null
  const verdict = verdictPayload?.verdict ?? null
  const isSettled = adjudication.adjudication.settled
  const canClaim = market.status === 'settled' || market.status === 'cancelled'

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-6">
      <div className="flex items-center gap-2 text-label-md font-label text-on-surface-variant">
        <Link to={`/markets/${market.id}`} className="hover:text-secondary">
          {market.question.slice(0, 40)}…
        </Link>
        <span>/</span>
        <span className="text-on-surface">Adjudication Result</span>
      </div>

      <Card
        className={`p-6 flex flex-col items-center text-center gap-3 border ${
          verdict ? verdictStyles[verdict] ?? 'border-outline-variant' : 'border-outline-variant bg-surface-variant'
        }`}
      >
        <Label>{isSettled ? 'Final verdict' : 'Adjudication status'}</Label>
        <div className="font-display text-display-lg uppercase">
          {verdict ?? market.status.replace(/_/g, ' ')}
        </div>
        <p className="text-body-sm text-on-surface-variant max-w-lg">{market.question}</p>
        {market.resolution_criteria && (
          <p className="text-label-sm font-label text-on-surface-variant max-w-lg italic">
            Resolution criteria: {market.resolution_criteria}
          </p>
        )}
      </Card>

      <Card className="p-4">
        <Label className="block mb-4">Lifecycle timeline (real recorded events)</Label>
        <div className="flex flex-col gap-0">
          {events.length === 0 && (
            <p className="text-body-sm text-on-surface-variant">No events recorded for this market yet.</p>
          )}
          {events.map((e, i) => (
            <div key={e.id} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div className={`w-2.5 h-2.5 rounded-full ${e.confirmed ? 'bg-secondary' : 'bg-pending-amber'}`} />
                {i < events.length - 1 && <div className="w-px flex-1 bg-secondary/40" style={{ minHeight: 32 }} />}
              </div>
              <div className="pb-6">
                <div className="font-label text-label-md text-primary uppercase">{e.type.replace(/_/g, ' ')}</div>
                {e.chain_tx_hash && (
                  <p className="text-body-sm text-on-surface-variant font-mono">tx: {e.chain_tx_hash.slice(0, 18)}…</p>
                )}
                <span className="font-label text-label-sm text-on-surface-variant">
                  {new Date(e.created_at).toLocaleString()} · {e.confirmed ? 'confirmed on-chain' : 'pending'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-4">
        <Label className="block mb-3">Evidence artifacts submitted</Label>
        <div className="flex flex-col gap-2">
          {evidence.length === 0 && (
            <p className="text-body-sm text-on-surface-variant">No evidence pointers were submitted.</p>
          )}
          {evidence.map((e) => (
            <div key={e.id} className="flex gap-3 p-3 bg-surface-container-low border-l-4 border-secondary rounded-sm">
              <EvidenceChip>{e.source_type}</EvidenceChip>
              <div className="flex-1">
                {e.summary && <p className="text-body-sm text-on-surface">{e.summary}</p>}
                <a href={e.url} target="_blank" rel="noreferrer" className="font-label text-label-sm text-secondary hover:underline">
                  {e.url}
                </a>
              </div>
            </div>
          ))}
        </div>
        <p className="text-label-sm font-label text-on-surface-variant mt-4 italic">
          Note: these are submitted pointers only. The contract's own settle() nondet web-fetch
          is the sole authoritative evaluation — a detailed reasoning trace isn't surfaced here
          yet (would require reading the contract's GenVM execution trace).
        </p>
      </Card>

      <Card className="p-4 flex items-center justify-between">
        <div>
          <Label>Pool</Label>
          <div className="font-headline text-headline-lg text-primary">
            {formatGen((BigInt(market.pool_deposited_wei || '0') + BigInt(market.total_yes_wei || '0') + BigInt(market.total_no_wei || '0')).toString())} GEN
          </div>
        </div>
        {claimError && <p className="text-body-sm text-error">{claimError}</p>}
        <Button
          variant="secondary"
          disabled={claimed || !wallet || !canClaim || claiming}
          onClick={handleClaim}
        >
          {claimed ? 'Claimed ✓' : !wallet ? 'Connect wallet to claim' : !canClaim ? 'Not yet claimable' : claiming ? 'Claiming…' : 'Claim Payout'}
        </Button>
      </Card>
    </div>
  )
}
