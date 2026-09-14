import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, Label } from '../components/ui'
import { useAuth } from '../lib/auth'
import { api } from '../lib/api'
import { approveAndFund, usdcToBaseUnits, FUND_KIND_POOL } from '../lib/escrow'
import type { Address } from 'viem'
import type { CreateMarketPayload, EvidenceSourceType, Horizon, MarketCategory } from '../types'

const categories: MarketCategory[] = ['politics', 'technology', 'culture', 'science', 'economics', 'geopolitics', 'sports', 'other']
const horizons: Horizon[] = [3, 5, 10, 'permanent']
const evidenceSourceOptions: EvidenceSourceType[] = ['news', 'academic', 'government', 'market', 'social', 'primary']

export default function CreateMarket() {
  const navigate = useNavigate()
  const { wallet, token } = useAuth()
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
  const [step, setStep] = useState<'idle' | 'creating' | 'approving' | 'funding'>('idle')
  // Set once the pending-chain market row exists in Postgres. If funding on
  // Base Sepolia then fails partway, we must NOT let the user hit "Create
  // Market" again — that would create a second, orphaned pending row.
  // Instead "Retry funding" resumes against this already-created market id.
  const [pendingMarketId, setPendingMarketId] = useState<string | null>(null)

  function toggleSource(s: EvidenceSourceType) {
    setForm((f) => ({
      ...f,
      allowedEvidenceSources: f.allowedEvidenceSources.includes(s)
        ? f.allowedEvidenceSources.filter((x) => x !== s)
        : [...f.allowedEvidenceSources, s],
    }))
  }

  async function fundPendingMarket(marketId: string) {
    if (!wallet) return
    try {
      const escrowInfo = await api.getMarketEscrow(marketId)
      if (!escrowInfo.escrowAddress) {
        setError('The Base Sepolia escrow contract is not configured on the backend yet. Try again later.')
        setPendingMarketId(marketId)
        return
      }

      setStep('approving')
      await approveAndFund({
        account: wallet as Address,
        escrowAddress: escrowInfo.escrowAddress as Address,
        usdcAddress: escrowInfo.usdcAddress as Address,
        marketIdBytes32: escrowInfo.marketIdBytes32,
        kind: FUND_KIND_POOL,
        amountBaseUnits: usdcToBaseUnits(form.initialLiquidity),
      })
      setStep('funding')

      setPendingMarketId(null)
      setSubmitted(true)
      setTimeout(() => navigate('/discover'), 900)
    } catch (err) {
      // The pending-chain row already exists — never treat this as "failed
      // to create market" (that would invite a duplicate submission). The
      // backend relay job also mirrors the deposit automatically once it
      // lands, even if the user never retries.
      setPendingMarketId(marketId)
      setError(
        `Your market was created, but funding it with USDC on Base Sepolia failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }. Press "Retry funding" once your wallet is ready.`
      )
    } finally {
      setStep('idle')
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (pendingMarketId) {
      setSubmitting(true)
      await fundPendingMarket(pendingMarketId)
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
      // Step 1: create the 'pending_chain' row in Postgres — no chain write
      // yet, just gets us a market id to derive the escrow's bytes32 key.
      setStep('creating')
      const resolvesAt = new Date(
        Date.now() +
          (form.horizonYears === 'permanent' ? 100 : form.horizonYears) * 365 * 24 * 60 * 60 * 1000
      ).toISOString()

      const market = await api.createMarket(form, resolvesAt, token)

      // Step 2: the user's OWN wallet approves + funds USDC directly on
      // Base Sepolia (see src/lib/escrow.ts) — the backend relayer then
      // mirrors this confirmed deposit onto GenLayer automatically.
      await fundPendingMarket(market.id)
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
            <Label>Initial liquidity (USDC)</Label>
            <input
              type="number"
              min={1}
              step="0.01"
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
            : step === 'creating'
              ? 'Creating…'
              : step === 'approving'
                ? 'Approve USDC in wallet…'
                : step === 'funding'
                  ? 'Confirm funding in wallet…'
                  : pendingMarketId
                    ? 'Retry funding'
                    : 'Create Market'}
        </Button>
      </form>
    </div>
  )
}
