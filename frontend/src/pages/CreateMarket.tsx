import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, Label } from '../components/ui'
import { useAuth } from '../lib/auth'
import { api, ApiError } from '../lib/api'
import { genlayer } from '../lib/genlayer'
import type { Address } from 'genlayer-js/types'
import type { CreateMarketPayload, EvidenceSourceType, Horizon, MarketCategory } from '../types'

const categories: MarketCategory[] = ['politics', 'technology', 'culture', 'science', 'economics', 'geopolitics', 'sports', 'other']
const horizons: Horizon[] = [3, 5, 10, 'permanent']
const evidenceSourceOptions: EvidenceSourceType[] = ['news', 'academic', 'government', 'market', 'social', 'primary']

export default function CreateMarket() {
  const navigate = useNavigate()
  const { wallet, token, clearSession } = useAuth()
  const [form, setForm] = useState<CreateMarketPayload>({
    question: '',
    category: 'technology',
    horizonYears: 5,
    resolutionCriteria: '',
    allowedEvidenceSources: ['news', 'academic'],
    initialLiquidity: 100,
  })
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<'idle' | 'signing' | 'recording'>('idle')
  // Set once create_market lands on-chain. If the follow-up POST /markets
  // (mirroring into Postgres) then fails, we must NOT let the user hit
  // "Create Market" again — that would sign and pay for a second on-chain
  // market. Instead we keep this around so "Retry recording" can just
  // retry the mirror call against the already-confirmed transaction.
  const [onChainResult, setOnChainResult] = useState<{
    txHash: string
    contractMarketId: number
    resolvesAt: string
  } | null>(null)

  function toggleSource(s: EvidenceSourceType) {
    setForm((f) => ({
      ...f,
      allowedEvidenceSources: f.allowedEvidenceSources.includes(s)
        ? f.allowedEvidenceSources.filter((x) => x !== s)
        : [...f.allowedEvidenceSources, s],
    }))
  }

  async function recordOnChainResult(result: { txHash: string; contractMarketId: number; resolvesAt: string }) {
    if (!token) {
      setError(
        'Your session expired while the transaction was confirming on-chain. Sign in again, then press "Retry recording" — the market is already live on-chain and will not be created twice.'
      )
      setOnChainResult(result)
      return
    }
    setStep('recording')
    try {
      await api.createMarket(
        {
          question: form.question,
          category: form.category,
          horizonYears: form.horizonYears,
          resolutionCriteria: form.resolutionCriteria,
          allowedEvidenceSources: form.allowedEvidenceSources,
          initialLiquidity: form.initialLiquidity,
        },
        { contractMarketId: String(result.contractMarketId), txHash: result.txHash, resolvesAt: result.resolvesAt },
        token
      )
      setOnChainResult(null)
      setSubmitted(true)
      setTimeout(() => navigate('/discover'), 900)
    } catch (err) {
      // The on-chain write already succeeded — never treat this as "failed
      // to create market" (that would invite a second, paid resubmission).
      // A background chain-indexer pass on the backend will also pick this
      // market up on its own within ~15s even if the user never retries.
      setOnChainResult(result)
      if (err instanceof ApiError && err.status === 401) {
        // The stored session token is stale (expired, or invalidated by a
        // backend redeploy) but the AuthProvider has no way to detect that
        // client-side — it just trusts whatever is in localStorage. Clear it
        // now so the UI stops claiming the wallet is signed in and the user
        // can re-sign without losing the on-chain result above.
        clearSession()
        setError(
          'Your session expired, so this market could not be saved to Chronix\'s index (it is still live on-chain). Sign in again, then press "Retry recording".'
        )
      } else {
        setError(
          `Your market is live on-chain, but saving it to Chronix's index failed: ${
            err instanceof Error ? err.message : 'unknown error'
          }. It will appear automatically within a minute, or press "Retry recording".`
        )
      }
    } finally {
      setStep('idle')
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (onChainResult) {
      setSubmitting(true)
      await recordOnChainResult(onChainResult)
      setSubmitting(false)
      return
    }
    if (!wallet || !token) {
      setError('Connect and sign in with your wallet first.')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      // Step 1: the user's OWN wallet signs and submits create_market
      // directly to GenLayer — the backend never holds a key that could do
      // this on their behalf (see backend/src/genlayer/client.ts).
      setStep('signing')
      const resolvesAt = new Date(
        Date.now() +
          (form.horizonYears === 'permanent' ? 100 : form.horizonYears) * 365 * 24 * 60 * 60 * 1000
      ).toISOString()

      const { txHash, contractMarketId } = await genlayer.createMarket(wallet as Address, {
        question: form.question,
        category: form.category,
        horizonYears: form.horizonYears === 'permanent' ? 0 : form.horizonYears,
        resolutionCriteria: form.resolutionCriteria,
        allowedEvidenceTypes: form.allowedEvidenceSources.join(','),
        initialLiquidityGen: String(form.initialLiquidity),
      })

      // Step 2: mirror the now-confirmed on-chain market into Postgres so
      // it shows up in fast reads (Discover, search) without polling chain.
      await recordOnChainResult({ txHash, contractMarketId, resolvesAt })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create market.')
    } finally {
      setSubmitting(false)
      setStep('idle')
    }
  }

  return (
    <div className="max-w-2xl mx-auto flex flex-col gap-6">
      <div>
        <h1 className="font-headline text-headline-lg text-primary mb-1">Create a Market</h1>
        <p className="text-body-sm text-on-surface-variant">
          Propose a historical question. Once the resolution horizon passes, a GenLayer Intelligent
          Contract settles it against independently-fetched evidence.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        <Card className="p-4 flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <Label>Question</Label>
            <textarea
              required
              value={form.question}
              onChange={(e) => setForm((f) => ({ ...f, question: e.target.value }))}
              rows={2}
              placeholder="Will [event] be remembered as [outcome]?"
              className="bg-surface border border-border-slate focus:border-secondary focus:ring-0 outline-none rounded px-3 py-2 text-body-sm resize-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <Label>Category</Label>
            <select
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as MarketCategory }))}
              className="bg-surface border border-border-slate focus:border-secondary focus:ring-0 outline-none rounded px-3 py-2 text-body-sm"
            >
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-col gap-1">
            <Label>Resolution horizon</Label>
            <div className="flex gap-2">
              {horizons.map((h) => (
                <button
                  type="button"
                  key={String(h)}
                  onClick={() => setForm((f) => ({ ...f, horizonYears: h }))}
                  className={`flex-1 font-label text-label-md py-2 rounded border ${
                    form.horizonYears === h
                      ? 'bg-secondary text-on-secondary border-secondary'
                      : 'border-border-slate text-on-surface-variant hover:border-secondary'
                  }`}
                >
                  {h === 'permanent' ? '∞ Permanent' : `${h} years`}
                </button>
              ))}
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <Label>Resolution criteria</Label>
            <textarea
              required
              value={form.resolutionCriteria}
              onChange={(e) => setForm((f) => ({ ...f, resolutionCriteria: e.target.value }))}
              rows={4}
              placeholder="Describe precisely what evidence and consensus threshold resolves this market YES vs NO."
              className="bg-surface border border-border-slate focus:border-secondary focus:ring-0 outline-none rounded px-3 py-2 text-body-sm resize-none"
            />
          </label>

          <div className="flex flex-col gap-1">
            <Label>Allowed evidence source types</Label>
            <div className="grid grid-cols-2 gap-2">
              {evidenceSourceOptions.map((s) => (
                <label key={s} className="flex items-center gap-2 text-body-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.allowedEvidenceSources.includes(s)}
                    onChange={() => toggleSource(s)}
                    className="accent-emerald-400"
                  />
                  {s}
                </label>
              ))}
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <Label>Initial liquidity (GEN)</Label>
            <input
              type="number"
              min={1}
              required
              value={form.initialLiquidity}
              onChange={(e) => setForm((f) => ({ ...f, initialLiquidity: Number(e.target.value) }))}
              className="bg-surface border border-border-slate focus:border-secondary focus:ring-0 outline-none rounded px-3 py-2 text-body-sm"
            />
          </label>
        </Card>

        {!wallet && (
          <p className="text-label-sm font-label text-pending-amber">
            You'll need to connect and sign in with your wallet before this can be submitted on-chain.
          </p>
        )}
        {error && <p className="text-label-sm font-label text-error">{error}</p>}

        <Button type="submit" variant="secondary" disabled={submitting || submitted}>
          {submitted
            ? 'Market created ✓'
            : step === 'signing'
              ? 'Confirm in wallet…'
              : step === 'recording'
                ? 'Recording…'
                : onChainResult
                  ? 'Retry recording'
                  : 'Create Market'}
        </Button>
      </form>
    </div>
  )
}
