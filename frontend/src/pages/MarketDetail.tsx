import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { Button, Card, EvidenceChip, HorizonBadge, Label, StatusChip } from '../components/ui'
import { api, ApiError } from '../lib/api'
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
  const { wallet, token, clearSession } = useAuth()

  const [market, setMarket] = useState<Market | null>(null)
  const [evidence, setEvidence] = useState<Evidence[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [side, setSide] = useState<'yes' | 'no'>('yes')
  const [amount, setAmount] = useState('100')
  const [staking, setStaking] = useState(false)
  const [stakeError, setStakeError] = useState<string | null>(null)
  const [stakeStep, setStakeStep] = useState<'idle' | 'signing' | 'recording'>('idle')
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [evidenceUrl, setEvidenceUrl] = useState('')
  const [evidenceSourceType, setEvidenceSourceType] = useState<'news' | 'academic' | 'government' | 'market' | 'social' | 'primary'>('news')
  const [evidenceSummary, setEvidenceSummary] = useState('')
  const [submittingEvidence, setSubmittingEvidence] = useState(false)
  const [evidenceError, setEvidenceError] = useState<string | null>(null)
  const [evidenceStep, setEvidenceStep] = useState<'idle' | 'signing' | 'recording'>('idle')
  // Set once submit_evidence_pointer lands on-chain. If the follow-up POST
  // (mirroring into Postgres) then fails — commonly GenLayer's 30 req/min
  // RPC cap tripping mid-poll — we must not let the user resubmit on-chain.
  // Keep the confirmed tx around so "Retry recording" just retries the
  // mirror call.
  const [pendingEvidence, setPendingEvidence] = useState<{
    txHash: string
    sourceType: typeof evidenceSourceType
    url: string
    summary: string
  } | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string | null>(null)

  async function handleResync() {
    if (!id) return
    setSyncing(true)
    setSyncMessage(null)
    try {
      const result = await api.sync()
      setSyncMessage(
        result.evidenceBackfilled > 0 || result.updated > 0 || result.discovered > 0
          ? `Synced: ${result.evidenceBackfilled} evidence pointer(s) backfilled.`
          : 'Already up to date with chain.'
      )
      const [m, e] = await Promise.all([api.getMarket(id), api.getMarketEvidence(id)])
      setMarket(m)
      setEvidence(e)
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : 'Resync failed.')
    } finally {
      setSyncing(false)
    }
  }

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

  // The contract now rejects submit_evidence_pointer calls whose source_type
  // isn't in the market's own allowed_evidence_types (provenance hardening)
  // — mirror that restriction here so the dropdown can't offer an option
  // that would just revert on-chain. Empty/unset means "no restriction",
  // matching the contract's own treatment of that case.
  const allowedSourceTypes = useMemo<typeof evidenceSourceType[]>(() => {
    const all: typeof evidenceSourceType[] = ['news', 'academic', 'government', 'market', 'social', 'primary']
    if (!market?.allowed_evidence_types) return all
    const allowed = new Set(
      market.allowed_evidence_types.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    )
    const filtered = all.filter((t) => allowed.has(t))
    return filtered.length > 0 ? filtered : all
  }, [market?.allowed_evidence_types])

  useEffect(() => {
    if (!allowedSourceTypes.includes(evidenceSourceType)) {
      setEvidenceSourceType(allowedSourceTypes[0])
    }
    // Only re-run when the allowed set itself changes (i.e. once market
    // loads) — not on every evidenceSourceType keystroke/selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedSourceTypes])

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

  async function handleCancel() {
    if (!market || !market.contract_market_id || !wallet) return
    setCancelError(null)
    setCancelling(true)
    try {
      await genlayer.cancelMarket(wallet as Address, Number(market.contract_market_id))
      const refreshed = await api.getMarket(market.id)
      setMarket(refreshed)
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : 'Cancel failed — the contract rejected this call.')
    } finally {
      setCancelling(false)
    }
  }

  async function recordEvidence(pending: {
    txHash: string
    sourceType: typeof evidenceSourceType
    url: string
    summary: string
  }) {
    if (!market) return
    if (!token) {
      setPendingEvidence(pending)
      setEvidenceError(
        'Your session expired while the transaction was confirming on-chain. Sign in again, then press "Retry recording" — the evidence is already live on-chain and will not be submitted twice.'
      )
      return
    }
    setEvidenceStep('recording')
    try {
      await api.submitEvidence(
        market.id,
        { sourceType: pending.sourceType, url: pending.url, summary: pending.summary, txHash: pending.txHash },
        token
      )
      setPendingEvidence(null)
      const refreshed = await api.getMarketEvidence(market.id)
      setEvidence(refreshed)
      setEvidenceUrl('')
      setEvidenceSummary('')
    } catch (err) {
      // The on-chain write already succeeded — never treat this as "failed"
      // in a way that would invite a second, paid resubmission. The backend
      // chain indexer also backfills missing evidence on its own within
      // ~15s even if the user never retries.
      setPendingEvidence(pending)
      if (err instanceof ApiError && err.status === 401) {
        clearSession()
        setEvidenceError(
          'Your session expired, so this evidence could not be saved to Chronix\'s index (it is still live on-chain). Sign in again, then press "Retry recording".'
        )
      } else if (err instanceof ApiError && err.status === 429) {
        setEvidenceError(
          'GenLayer\'s request rate limit was hit while recording this evidence (it is still live on-chain). Wait a minute and press "Retry recording", or it will appear automatically.'
        )
      } else {
        setEvidenceError(
          `Your evidence is live on-chain, but saving it to Chronix's index failed: ${
            err instanceof Error ? err.message : 'unknown error'
          }. It will appear automatically within a minute, or press "Retry recording".`
        )
      }
    } finally {
      setEvidenceStep('idle')
    }
  }

  async function handleSubmitEvidence() {
    if (!market) return
    if (pendingEvidence) {
      setSubmittingEvidence(true)
      await recordEvidence(pendingEvidence)
      setSubmittingEvidence(false)
      return
    }
    if (!wallet || !token) {
      setEvidenceError('Connect and sign in with your wallet first.')
      return
    }
    if (!market.contract_market_id) {
      setEvidenceError('This market has no on-chain id yet.')
      return
    }
    if (!evidenceUrl.trim()) {
      setEvidenceError('Enter a URL.')
      return
    }
    setEvidenceError(null)
    setSubmittingEvidence(true)
    try {
      setEvidenceStep('signing')
      // Only the URL + source type go on-chain — the contract's own settle()
      // fetches and evaluates the page itself, it never trusts a submitter's
      // summary as fact. The summary here is purely a local Postgres mirror
      // field for the UI, not evidence the adjudication logic reads.
      const txHash = await genlayer.submitEvidencePointer(
        wallet as Address,
        Number(market.contract_market_id),
        evidenceSourceType,
        evidenceUrl.trim()
      )
      await recordEvidence({
        txHash,
        sourceType: evidenceSourceType,
        url: evidenceUrl.trim(),
        summary: evidenceSummary.trim(),
      })
    } catch (err) {
      setEvidenceError(err instanceof Error ? err.message : 'Evidence submission failed.')
    } finally {
      setSubmittingEvidence(false)
      setEvidenceStep('idle')
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
              <div className="flex items-center gap-3">
                <span className="font-label text-label-sm text-on-surface-variant">{evidence.length} items</span>
                <Button variant="outline" onClick={handleResync} disabled={syncing}>
                  {syncing ? 'Syncing…' : 'Resync from chain'}
                </Button>
              </div>
            </div>
            {syncMessage && (
              <p className="text-label-sm font-label text-on-surface-variant mb-2">{syncMessage}</p>
            )}
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

            {(market.status === 'open' || market.status === 'awaiting_adjudication') && (
              <div className="mt-4 pt-4 border-t border-outline-variant flex flex-col gap-2">
                <Label>Submit evidence pointer</Label>
                <p className="text-label-sm font-label text-on-surface-variant">
                  Point the contract at a source. The contract fetches and evaluates the page itself during
                  settlement — it never trusts any summary you attach as fact.
                </p>
                <div className="flex gap-2">
                  <select
                    value={evidenceSourceType}
                    onChange={(e) => setEvidenceSourceType(e.target.value as typeof evidenceSourceType)}
                    className="bg-surface border border-border-slate focus:border-secondary focus:ring-0 outline-none rounded px-2 py-2 text-body-sm"
                  >
                    {allowedSourceTypes.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <input
                    value={evidenceUrl}
                    onChange={(e) => setEvidenceUrl(e.target.value)}
                    type="url"
                    placeholder="https://example.com/article"
                    className="flex-1 bg-surface border border-border-slate focus:border-secondary focus:ring-0 outline-none rounded px-3 py-2 text-body-sm"
                  />
                </div>
                <input
                  value={evidenceSummary}
                  onChange={(e) => setEvidenceSummary(e.target.value)}
                  type="text"
                  placeholder="Optional note for other users (not read by the contract)"
                  className="bg-surface border border-border-slate focus:border-secondary focus:ring-0 outline-none rounded px-3 py-2 text-body-sm"
                />
                {evidenceError && <p className="text-label-sm font-label text-error">{evidenceError}</p>}
                <Button variant="outline" disabled={submittingEvidence} onClick={handleSubmitEvidence}>
                  {evidenceStep === 'signing'
                    ? 'Confirm in wallet…'
                    : evidenceStep === 'recording'
                      ? 'Recording…'
                      : pendingEvidence
                        ? 'Retry recording'
                        : 'Submit Evidence'}
                </Button>
              </div>
            )}
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

          {wallet &&
            market.created_by.toLowerCase() === wallet.toLowerCase() &&
            market.status === 'open' &&
            market.total_yes_wei === '0' &&
            market.total_no_wei === '0' && (
              <Card className="p-4 flex flex-col gap-2">
                <Label>Creator actions</Label>
                <p className="text-body-sm text-on-surface-variant">
                  No one has staked yet — you can still cancel this market and reclaim your initial liquidity.
                </p>
                {cancelError && <p className="text-label-sm font-label text-error">{cancelError}</p>}
                <Button variant="outline" disabled={cancelling} onClick={handleCancel}>
                  {cancelling ? 'Cancelling…' : 'Cancel Market & Reclaim Liquidity'}
                </Button>
              </Card>
            )}
        </div>
      </div>
    </div>
  )
}
