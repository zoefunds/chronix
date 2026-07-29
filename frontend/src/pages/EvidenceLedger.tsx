import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, EvidenceChip } from '../components/ui'
import { mockEvidence, mockMarkets } from '../lib/mockData'
import type { EvidenceSourceType } from '../types'

const sourceTypes: (EvidenceSourceType | 'all')[] = ['all', 'news', 'academic', 'government', 'market', 'social', 'primary']

export default function EvidenceLedger() {
  const [filter, setFilter] = useState<(typeof sourceTypes)[number]>('all')

  const items = useMemo(
    () => mockEvidence.filter((e) => filter === 'all' || e.sourceType === filter),
    [filter],
  )

  const marketQuestion = (id: string) => mockMarkets.find((m) => m.id === id)?.question ?? id

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-headline text-headline-lg text-primary mb-1">Evidence Ledger</h1>
        <p className="text-body-sm text-on-surface-variant">
          A global feed of every evidence pointer submitted across all markets. The contract fetches
          and verifies each source itself — this feed is a read-only record, not the source of truth.
        </p>
      </div>

      <div className="flex flex-wrap gap-1">
        {sourceTypes.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`font-label text-label-sm px-2 py-1 rounded-sm border uppercase tracking-widest ${
              filter === s
                ? 'bg-secondary text-on-secondary border-secondary'
                : 'border-border-slate text-on-surface-variant hover:border-secondary'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <Card className="divide-y divide-outline-variant/30">
        {items.map((e) => (
          <div key={e.id} className="flex flex-col gap-2 p-4 hover:bg-surface-container-low transition-colors">
            <div className="flex items-center justify-between">
              <EvidenceChip>{e.sourceType}</EvidenceChip>
              <span className="font-label text-label-sm text-on-surface-variant">
                {new Date(e.createdAt).toLocaleString()}
              </span>
            </div>
            <Link to={`/markets/${e.marketId}`} className="font-headline text-headline-md text-primary hover:text-secondary leading-snug">
              {marketQuestion(e.marketId)}
            </Link>
            <p className="text-body-sm text-on-surface-variant">{e.summary}</p>
            <div className="flex items-center justify-between">
              <a href={e.url} target="_blank" rel="noreferrer" className="font-label text-label-sm text-secondary hover:underline">
                {e.url}
              </a>
              <span className="font-label text-label-sm text-on-surface-variant">
                submitted by {e.submittedBy} · weight {e.weight.toFixed(2)}
              </span>
            </div>
          </div>
        ))}
        {items.length === 0 && (
          <div className="p-8 text-center text-body-sm text-on-surface-variant">No evidence of this type yet.</div>
        )}
      </Card>
    </div>
  )
}
