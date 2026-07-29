import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, Label } from '../components/ui'
import { useAuth } from '../lib/auth'
import type { CreateMarketPayload, EvidenceSourceType, Horizon, MarketCategory } from '../types'

const categories: MarketCategory[] = ['politics', 'technology', 'culture', 'science', 'economics', 'geopolitics', 'sports', 'other']
const horizons: Horizon[] = [3, 5, 10, 'permanent']
const evidenceSourceOptions: EvidenceSourceType[] = ['news', 'academic', 'government', 'market', 'social', 'primary']

export default function CreateMarket() {
  const navigate = useNavigate()
  const { wallet } = useAuth()
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

  function toggleSource(s: EvidenceSourceType) {
    setForm((f) => ({
      ...f,
      allowedEvidenceSources: f.allowedEvidenceSources.includes(s)
        ? f.allowedEvidenceSources.filter((x) => x !== s)
        : [...f.allowedEvidenceSources, s],
    }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      // Structured for a real POST /markets call (see src/lib/api.ts createMarket).
      // The backend isn't live yet, so we simulate success and route to Discover.
      await new Promise((r) => setTimeout(r, 600))
      setSubmitted(true)
      setTimeout(() => navigate('/discover'), 900)
    } finally {
      setSubmitting(false)
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

        <Button type="submit" variant="secondary" disabled={submitting || submitted}>
          {submitted ? 'Market created ✓' : submitting ? 'Submitting…' : 'Create Market'}
        </Button>
      </form>
    </div>
  )
}
