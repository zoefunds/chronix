import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { Button, Card, EvidenceChip, HorizonBadge, Label, StatusChip } from '../components/ui'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { genlayer } from '../lib/genlayer'
import { formatGen, weiToGen } from '../lib/format'
import type { Address } from 'genlayer-js/types'
import type { Evidence, Market } from '../types'

const stepperStages = [
  { key: 'created', label: 'Event Occurred' },
  { key: 'deadline', label: 'Deadline Reached' },
  { key: 'adjudication', label: 'GenLayer Adjudication' },
  { key: 'settlement', label: 'Final Settlement' },
] as const

function currentStageIndex(status: string) {
  switch (status) {
    case 'open':
    case 'pending_chain':
      return 0
    case 'awaiting_adjudication':
      return 2
    case 'settled':
    case 'cancelled':
    case 'failed':
      return 3
    default:
      return 0
  }
}

export default function MarketDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { wallet, token } = useAuth()

  const [market, setMarket] = useState<Market | null>(null)
  const [evidence, setEvidence] = useState<Evidence[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [side, setSide] = useState<'yes' | 'no'>('yes')
  const [amount, setAmount] = useState('100')
  const [staking, setStaking] = useState(false)
  const [stakeError, setStakeError] = useState<string | null>(null)
  const [stakeStep, setStakeStep] = useState<'idle' | 'signing' | 'recording'>('idle')

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setLoading(true)
    setNotFound(false)
    Promise.all([api.getMarket(id), api.getMarketEvidence(id)])
      .then(([m, e]) => {
        if (cancelled) return
        setMarket(m)
        setEvidence(e)
      })
      .catch(() => {
        if (!cancelled) setNotFound(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  const yesGen = market ? weiToGen(market.total_yes_wei) : 0
  const noGen = market ? weiToGen(market.total_no_wei) : 0
  const totalPool = yesGen + noGen
  const yesPct = totalPool > 0 ? Math.round((yesGen / totalPool) * 100) : 50
  const stageIndex = market ? currentStageIndex(market.status) : 0

  const sentimentPoints = useMemo(() => {
    const seed = (market?.id ?? '').split('').reduce((a, c) => a + c.charCodeAt(0), 0)
    return Array.from({ length: 24 }, (_, i) => {
      const wobble = Math.sin((seed + i) / 3) * 8
      return Math.max(5, Math.min(95, yesPct + wobble - (24 - i) * 0.2))
    })
  }, [market?.id, yesPct])

  async function handleStake() {
    if (!market) return
    if (!wallet || !token) {
      setStakeError('Connect and sign in with your wallet first.')
      return
    }
    if (!market.contract_market_id) {
      setStakeError('This market has no on-chain id yet.')
      return
    }
    setStakeError(null)
    setStaking(true)
    try {
      setStakeStep('signing')
      const txHash = await genlayer.stake(
        wallet as Address,
        Number(market.contract_market_id),
        side.toUpperCase() as 'YES' | 'NO',
        amount
      )
      setStakeStep('recording')
      await api.stake(market.id, { side, shares: amount, avgPrice: '1', txHash }, token)
      const refreshed = await api.getMarket(market.id)
      setMarket(refreshed)
    } catch (err) {
      setStakeError(err instanceof Error ? err.message : 'Stake failed.')
    } finally {
      setStaking(false)
      setStakeStep('idle')
    }
  }

  if (loading) {
    return <div className="text-center py-24 text-body-sm text-on-surface-variant">Loading market…</div>
  }

  if (notFound || !market) {
    return (
      <div className="text-center py-24">
        <p className="text-body-md text-on-surface-variant mb-4">Market not found.</p>
        <Button variant="outline" onClick={() => navigate('/discover')}>
          Back to Discover
        </Button>
      </div>
    )
  }

  const path = sentimentPoints
    .map((p, i) => `${(i / (sentimentPoints.length - 1)) * 100},${100 - p}`)
    .join(' ')

  const horizonYears = Number(market.horizon_years)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 text-label-md font-label text-on-surface-variant">
        <Link to="/discover" className="hover:text-secondary">
          Discover
        </Link>
        <span>/</span>
        <span className="text-on-surface">{market.id}</span>
      </div>

      <div className="grid lg:grid-cols-3 gap-gutter">
        <div className="lg:col-span-2 flex flex-col gap-6">
          <Card className="p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <Label>{market.category}</Label>
              <StatusChip status={market.status} />
            </div>
            <h1 className="font-headline text-headline-lg text-primary leading-snug">{market.question}</h1>
            <div className="flex items-center gap-2">
              <HorizonBadge horizon={horizonYears >= 100 ? 'permanent' : (horizonYears as 3 | 5 | 10)} />
              <span className="font-label text-label-sm text-on-surface-variant">
                Resolves {new Date(market.resolves_at).toLocaleDateString()}
              </span>
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex justify-between items-end mb-2">
              <Label>Sentiment (YES probability)</Label>
              <span className="font-label text-label-md text-secondary">{yesPct}%</span>
            </div>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-32">
              <polyline
                points={path}
                fill="none"
                stroke="#4edea3"
                strokeWidth="1.2"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </Card>

          <Card className="p-4">
            <Label className="block mb-3">Resolution criteria</Label>
            <p className="text-body-sm text-on-surface-variant leading-relaxed">{market.resolution_criteria}</p>
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <Label>Evidence feed</Label>
              <span className="font-label text-label-sm text-on-surface-variant">{evidence.length} items</span>
            </div>
            <div className="flex flex-col gap-2">
              {evidence.length === 0 && (
                <p className="text-body-sm text-on-surface-variant">No evidence submitted yet.</p>
              )}
              {evidence.map((e) => (
                <div key={e.id} className="flex gap-3 p-3 bg-surface-container-low border-l-4 border-secondary rounded-sm">
                  <EvidenceChip>{e.source_type}</EvidenceChip>
                  <div className="flex-1">
                    <p className="text-body-sm text-on-surface">{e.summary}</p>
                    <a href={e.url} target="_blank" rel="noreferrer" className="font-label text-label-sm text-secondary hover:underline">
                      {e.url}
                    </a>
                  </div>
                  <span className="font-label text-label-sm text-on-surface-variant whitespace-nowrap">
                    {new Date(e.created_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-4">
            <Label className="block mb-4">Adjudication engine status</Label>
            <div className="flex flex-col gap-0">
              {stepperStages.map((s, i) => (
                <div key={s.key} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <div
                      className={`w-2.5 h-2.5 rounded-full ${
                        i <= stageIndex ? 'bg-secondary' : 'bg-surface-variant border border-outline-variant'
                      }`}
                    />
                    {i < stepperStages.length - 1 && (
                      <div className={`w-px flex-1 ${i < stageIndex ? 'bg-secondary' : 'bg-outline-variant'}`} style={{ minHeight: 24 }} />
                    )}
                  </div>
                  <div className="pb-6">
                    <div className={`font-label text-label-md ${i <= stageIndex ? 'text-primary' : 'text-on-surface-variant'}`}>
                      {s.label}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {market.status === 'settled' && (
              <Button variant="secondary" onClick={() => navigate(`/markets/${market.id}/result`)}>
                View adjudication result →
              </Button>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card className="p-4 flex flex-col gap-4">
            <Label>Stake a position</Label>
            <div className="flex bg-surface-container p-1 rounded-sm border border-outline-variant">
              <button
                onClick={() => setSide('yes')}
                className={`flex-1 font-label text-label-md py-1.5 rounded-sm ${
                  side === 'yes' ? 'bg-secondary text-on-secondary' : 'text-on-surface-variant'
                }`}
              >
                YES {yesPct}%
              </button>
              <button
                onClick={() => setSide('no')}
                className={`flex-1 font-label text-label-md py-1.5 rounded-sm ${
                  side === 'no' ? 'bg-pending-amber text-on-primary' : 'text-on-surface-variant'
                }`}
              >
                NO {100 - yesPct}%
              </button>
            </div>
            <label className="flex flex-col gap-1">
              <Label>Amount (GEN)</Label>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                type="number"
                min={0}
                className="bg-surface border border-border-slate focus:border-secondary focus:ring-0 outline-none rounded px-3 py-2 text-body-sm"
              />
            </label>
            {stakeError && <p className="text-label-sm font-label text-error">{stakeError}</p>}
            <Button
              variant="secondary"
              disabled={market.status !== 'open' || staking}
              onClick={handleStake}
            >
              {market.status !== 'open'
                ? 'Market closed to staking'
                : stakeStep === 'signing'
                  ? 'Confirm in wallet…'
                  : stakeStep === 'recording'
                    ? 'Recording…'
                    : `Stake ${side.toUpperCase()}`}
            </Button>
            <p className="text-label-sm font-label text-on-surface-variant">
              Escrowed GEN is held on-chain until settlement. No off-chain custody — this transaction is signed
              by your own wallet directly against the GenLayer contract.
            </p>
          </Card>

          <Card className="p-4 flex flex-col gap-2">
            <Label>Contract details</Label>
            <div className="flex justify-between text-body-sm">
              <span className="text-on-surface-variant">Contract market ID</span>
              <span className="font-label text-label-md text-primary">{market.contract_market_id ?? '—'}</span>
            </div>
            <div className="flex justify-between text-body-sm">
              <span className="text-on-surface-variant">Created by</span>
              <span className="font-label text-label-md text-primary">
                {market.created_by.slice(0, 6)}…{market.created_by.slice(-4)}
              </span>
            </div>
            <div className="flex justify-between text-body-sm">
              <span className="text-on-surface-variant">YES pool</span>
              <span className="font-label text-label-md text-secondary">{formatGen(market.total_yes_wei)} GEN</span>
            </div>
            <div className="flex justify-between text-body-sm">
              <span className="text-on-surface-variant">NO pool</span>
              <span className="font-label text-label-md text-pending-amber">{formatGen(market.total_no_wei)} GEN</span>
            </div>
            <div className="flex justify-between text-body-sm">
              <span className="text-on-surface-variant">Initial liquidity</span>
              <span className="font-label text-label-md text-primary">{formatGen(market.pool_deposited_wei)} GEN</span>
            </div>
            <div className="flex justify-between text-body-sm">
              <span className="text-on-surface-variant">Participants</span>
              <span className="font-label text-label-md text-primary">{market.participant_count ?? 0}</span>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
