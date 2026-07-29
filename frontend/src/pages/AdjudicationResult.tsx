import { useParams, Link } from 'react-router-dom'
import { Button, Card, EvidenceChip, Label } from '../components/ui'
import { mockAdjudication, mockMarkets } from '../lib/mockData'
import { useAuth } from '../lib/auth'
import { useState } from 'react'

export default function AdjudicationResultPage() {
  const { id } = useParams()
  const { wallet } = useAuth()
  const market = mockMarkets.find((m) => m.id === id) ?? mockMarkets[4]
  const result = mockAdjudication
  const [claimed, setClaimed] = useState(false)

  const verdictStyles: Record<string, string> = {
    yes: 'text-resolved-emerald border-resolved-emerald/30 bg-resolved-emerald/10',
    no: 'text-error border-error/30 bg-error/10',
    undetermined: 'text-on-surface-variant border-outline-variant bg-surface-variant',
  }

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-6">
      <div className="flex items-center gap-2 text-label-md font-label text-on-surface-variant">
        <Link to={`/markets/${market.id}`} className="hover:text-secondary">
          {market.id}
        </Link>
        <span>/</span>
        <span className="text-on-surface">Adjudication Result</span>
      </div>

      <Card className={`p-6 flex flex-col items-center text-center gap-3 border ${verdictStyles[result.verdict]}`}>
        <Label>Final verdict</Label>
        <div className="font-display text-display-lg uppercase">{result.verdict}</div>
        <p className="text-body-sm text-on-surface-variant max-w-lg">{market.question}</p>
        <div className="font-label text-label-md text-on-surface-variant">
          Confidence: {(result.confidence * 100).toFixed(0)}% · Settled {result.settledAt ? new Date(result.settledAt).toLocaleString() : '—'}
        </div>
      </Card>

      <Card className="p-4">
        <Label className="block mb-4">Source weights</Label>
        <div className="flex flex-col gap-3">
          {result.sourceWeights.map((sw) => (
            <div key={sw.sourceType} className="flex items-center gap-3">
              <div className="w-24">
                <EvidenceChip>{sw.sourceType}</EvidenceChip>
              </div>
              <div className="flex-1 h-2 bg-surface-variant rounded-full overflow-hidden">
                <div className="bg-secondary h-full" style={{ width: `${sw.weight * 100}%` }} />
              </div>
              <span className="font-label text-label-sm text-on-surface-variant w-28 text-right">
                {(sw.weight * 100).toFixed(0)}% · {sw.sourcesConsulted} sources
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-4">
        <Label className="block mb-4">Reasoning timeline</Label>
        <div className="flex flex-col gap-0">
          {result.reasoningTimeline.map((step, i) => (
            <div key={i} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div className="w-2.5 h-2.5 rounded-full bg-secondary" />
                {i < result.reasoningTimeline.length - 1 && (
                  <div className="w-px flex-1 bg-secondary/40" style={{ minHeight: 32 }} />
                )}
              </div>
              <div className="pb-6">
                <div className="font-label text-label-md text-primary">{step.step}</div>
                <p className="text-body-sm text-on-surface-variant">{step.detail}</p>
                <span className="font-label text-label-sm text-on-surface-variant">
                  {new Date(step.timestamp).toLocaleString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-4">
        <Label className="block mb-3">Evidence artifacts</Label>
        <div className="flex flex-col gap-2">
          {result.evidenceArtifacts.map((e) => (
            <div key={e.id} className="flex gap-3 p-3 bg-surface-container-low border-l-4 border-secondary rounded-sm">
              <EvidenceChip>{e.sourceType}</EvidenceChip>
              <div className="flex-1">
                <p className="text-body-sm text-on-surface">{e.summary}</p>
                <a href={e.url} target="_blank" rel="noreferrer" className="font-label text-label-sm text-secondary hover:underline">
                  {e.url}
                </a>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-4 flex items-center justify-between">
        <div>
          <Label>Your payout</Label>
          <div className="font-headline text-headline-lg text-primary">$3,200.00 GEN</div>
        </div>
        <Button
          variant="secondary"
          disabled={claimed || !wallet}
          onClick={() => setClaimed(true)}
        >
          {claimed ? 'Claimed ✓' : wallet ? 'Claim Payout' : 'Connect wallet to claim'}
        </Button>
      </Card>
    </div>
  )
}
