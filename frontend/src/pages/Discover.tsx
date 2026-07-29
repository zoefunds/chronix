import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, EvidenceChip, HorizonBadge, Label, StatusChip } from '../components/ui'
import { mockEvidence, mockMarkets } from '../lib/mockData'
import type { MarketCategory, MarketStatus } from '../types'

const categories: (MarketCategory | 'all')[] = [
  'all',
  'politics',
  'technology',
  'culture',
  'science',
  'economics',
  'geopolitics',
  'sports',
]

const horizons: (3 | 5 | 10 | 'permanent' | 'all')[] = ['all', 3, 5, 10, 'permanent']
const statuses: (MarketStatus | 'all')[] = ['all', 'open', 'awaiting_adjudication', 'resolved', 'undetermined']

export default function Discover() {
  const navigate = useNavigate()
  const [category, setCategory] = useState<(typeof categories)[number]>('all')
  const [horizon, setHorizon] = useState<(typeof horizons)[number]>('all')
  const [status, setStatus] = useState<(typeof statuses)[number]>('all')
  const [search, setSearch] = useState('')

  const filtered = useMemo(
    () =>
      mockMarkets.filter((m) => {
        if (category !== 'all' && m.category !== category) return false
        if (horizon !== 'all' && m.horizonYears !== horizon) return false
        if (status !== 'all' && m.status !== status) return false
        if (search && !m.question.toLowerCase().includes(search.toLowerCase())) return false
        return true
      }),
    [category, horizon, status, search],
  )

  return (
    <div className="flex flex-col lg:flex-row gap-gutter">
      <aside className="lg:w-64 flex-shrink-0 flex flex-col gap-6">
        <Card className="p-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search markets…"
            className="bg-transparent border-none focus:ring-0 focus:outline-none text-body-sm w-full p-0 placeholder:text-on-surface-variant"
          />
        </Card>

        <div>
          <Label className="block mb-2">Category</Label>
          <div className="flex flex-wrap gap-1">
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`font-label text-label-sm px-2 py-1 rounded-sm border uppercase tracking-widest ${
                  category === c
                    ? 'bg-secondary text-on-secondary border-secondary'
                    : 'border-border-slate text-on-surface-variant hover:border-secondary'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div>
          <Label className="block mb-2">Horizon</Label>
          <div className="flex flex-wrap gap-1">
            {horizons.map((h) => (
              <button
                key={String(h)}
                onClick={() => setHorizon(h)}
                className={`font-label text-label-sm px-2 py-1 rounded-sm border uppercase tracking-widest ${
                  horizon === h
                    ? 'bg-secondary text-on-secondary border-secondary'
                    : 'border-border-slate text-on-surface-variant hover:border-secondary'
                }`}
              >
                {h === 'all' ? 'All' : h === 'permanent' ? '∞' : `${h}Y`}
              </button>
            ))}
          </div>
        </div>

        <div>
          <Label className="block mb-2">Status</Label>
          <div className="flex flex-col gap-1">
            {statuses.map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`text-left font-label text-label-sm px-2 py-1.5 rounded-sm uppercase tracking-widest ${
                  status === s ? 'bg-surface-variant text-secondary border-l-2 border-secondary' : 'text-on-surface-variant hover:text-primary'
                }`}
              >
                {s.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        </div>

        <Card className="p-3 flex flex-col gap-2">
          <Label>Platform stats</Label>
          <div className="flex justify-between text-body-sm">
            <span className="text-on-surface-variant">Markets</span>
            <span className="font-label text-label-md text-primary">{mockMarkets.length}</span>
          </div>
          <div className="flex justify-between text-body-sm">
            <span className="text-on-surface-variant">Total staked</span>
            <span className="font-label text-label-md text-primary">
              ${mockMarkets.reduce((a, m) => a + m.totalStaked, 0).toLocaleString()}
            </span>
          </div>
        </Card>
      </aside>

      <div className="flex-1 flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="font-headline text-headline-lg text-primary">Market Discovery</h1>
          <Button variant="secondary" onClick={() => navigate('/create')}>
            + New Market
          </Button>
        </div>

        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((m) => {
            const yesPct = Math.round((m.yesPool / (m.yesPool + m.noPool)) * 100)
            return (
              <Card
                key={m.id}
                onClick={() => navigate(`/markets/${m.id}`)}
                className="p-4 flex flex-col gap-3 cursor-pointer hover:border-secondary transition-colors group"
              >
                <div className="flex items-center justify-between">
                  <Label>{m.category}</Label>
                  <StatusChip status={m.status} />
                </div>
                <p className="font-headline text-headline-md text-primary leading-snug group-hover:text-secondary transition-colors">
                  {m.question}
                </p>
                <div className="flex items-center gap-2">
                  <HorizonBadge horizon={m.horizonYears} />
                  {m.allowedEvidenceSources.slice(0, 2).map((s) => (
                    <EvidenceChip key={s}>{s}</EvidenceChip>
                  ))}
                </div>
                <div className="flex flex-col gap-1">
                  <div className="flex justify-between text-label-sm font-label text-on-surface-variant">
                    <span>YES {yesPct}%</span>
                    <span>NO {100 - yesPct}%</span>
                  </div>
                  <div className="h-1.5 w-full bg-surface-variant rounded-full overflow-hidden flex">
                    <div className="bg-secondary h-full" style={{ width: `${yesPct}%` }} />
                    <div className="bg-pending-amber h-full" style={{ width: `${100 - yesPct}%` }} />
                  </div>
                </div>
                <div className="flex justify-between items-center border-t border-outline-variant/30 pt-3 text-label-sm font-label text-on-surface-variant">
                  <span>${m.totalStaked.toLocaleString()} staked</span>
                  <span>{m.participantCount} participants</span>
                </div>
              </Card>
            )
          })}
          {filtered.length === 0 && (
            <div className="col-span-full text-center text-on-surface-variant text-body-sm py-12">
              No markets match these filters.
            </div>
          )}
        </div>

        <div>
          <h2 className="font-headline text-headline-md text-primary mb-3">Latest evidence</h2>
          <Card className="divide-y divide-outline-variant/30">
            {mockEvidence.map((e) => (
              <div key={e.id} className="flex gap-3 p-3 hover:bg-surface-container-low transition-colors">
                <EvidenceChip>{e.sourceType}</EvidenceChip>
                <p className="text-body-sm text-on-surface-variant flex-1">{e.summary}</p>
                <span className="font-label text-label-sm text-on-surface-variant whitespace-nowrap">
                  {new Date(e.createdAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  )
}
