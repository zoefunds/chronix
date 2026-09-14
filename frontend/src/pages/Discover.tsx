import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, HorizonBadge, Label, StatusChip } from '../components/ui'
import { api } from '../lib/api'
import { formatUsdc, baseUnitsToUsdc } from '../lib/format'
import type { Market, MarketStatus } from '../types'

const categories = [
  'all',
  'politics',
  'technology',
  'culture',
  'science',
  'economics',
  'geopolitics',
  'sports',
] as const

const horizons: (3 | 5 | 10 | 100 | 'all')[] = ['all', 3, 5, 10, 100]
const statuses: (MarketStatus | 'all')[] = ['all', 'open', 'awaiting_adjudication', 'settled', 'cancelled']

export default function Discover() {
  const navigate = useNavigate()
  const [category, setCategory] = useState<(typeof categories)[number]>('all')
  const [horizon, setHorizon] = useState<(typeof horizons)[number]>('all')
  const [status, setStatus] = useState<(typeof statuses)[number]>('all')
  const [search, setSearch] = useState('')

  const [markets, setMarkets] = useState<Market[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string | null>(null)

  function loadMarkets() {
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .listMarkets({
        category: category === 'all' ? undefined : category,
        status: status === 'all' ? undefined : status,
        horizon: horizon === 'all' ? undefined : String(horizon),
      })
      .then((rows) => {
        if (!cancelled) setMarkets(rows)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load markets.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }

  useEffect(loadMarkets, [category, horizon, status])

  // Manual trigger for the same reconciliation the backend's chain indexer
  // already runs on a 15s interval — for when a market or evidence pointer
  // confirmed on-chain hasn't shown up yet and you don't want to wait.
  async function handleResync() {
    setSyncing(true)
    setSyncMessage(null)
    try {
      const result = await api.sync()
      setSyncMessage(
        result.discovered > 0 || result.evidenceBackfilled > 0 || result.updated > 0
          ? `Synced: ${result.discovered} market(s) and ${result.evidenceBackfilled} evidence pointer(s) backfilled, ${result.updated} status update(s).`
          : 'Already up to date with chain.'
      )
      loadMarkets()
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : 'Resync failed.')
    } finally {
      setSyncing(false)
    }
  }

  const filtered = markets.filter(
    (m) => !search || m.question.toLowerCase().includes(search.toLowerCase())
  )

  const totalStakedGen = markets.reduce(
    (sum, m) => sum + baseUnitsToUsdc(m.total_yes_wei) + baseUnitsToUsdc(m.total_no_wei) + baseUnitsToUsdc(m.pool_deposited_wei),
    0
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
                {h === 'all' ? 'All' : h === 100 ? '∞' : `${h}Y`}
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
            <span className="font-label text-label-md text-primary">{markets.length}</span>
          </div>
          <div className="flex justify-between text-body-sm">
            <span className="text-on-surface-variant">Total staked</span>
            <span className="font-label text-label-md text-primary">{totalStakedGen.toLocaleString()} USDC</span>
          </div>
        </Card>
      </aside>

      <div className="flex-1 flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="font-headline text-headline-lg text-primary">Market Discovery</h1>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={handleResync} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Resync from chain'}
            </Button>
            <Button variant="secondary" onClick={() => navigate('/create')}>
              + New Market
            </Button>
          </div>
        </div>

        {syncMessage && <p className="text-label-sm font-label text-on-surface-variant">{syncMessage}</p>}

        {error && (
          <Card className="p-4 text-body-sm text-error">
            Couldn't load markets from the backend: {error}
          </Card>
        )}

        {loading && !error && (
          <div className="text-center text-on-surface-variant text-body-sm py-12">Loading live markets…</div>
        )}

        {!loading && !error && (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map((m) => {
              const yesGen = baseUnitsToUsdc(m.total_yes_wei)
              const noGen = baseUnitsToUsdc(m.total_no_wei)
              const total = yesGen + noGen
              const yesPct = total > 0 ? Math.round((yesGen / total) * 100) : 50
              const stakedWei = (
                BigInt(m.total_yes_wei || '0') +
                BigInt(m.total_no_wei || '0') +
                BigInt(m.pool_deposited_wei || '0')
              ).toString()
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
                    <HorizonBadge horizon={Number(m.horizon_years) >= 100 ? 'permanent' : (Number(m.horizon_years) as 3 | 5 | 10)} />
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
                    <span>{formatUsdc(stakedWei)} USDC staked</span>
                    <span>{m.participant_count ?? 0} participants</span>
                  </div>
                </Card>
              )
            })}
            {filtered.length === 0 && (
              <div className="col-span-full text-center text-on-surface-variant text-body-sm py-12">
                No markets match these filters yet.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
