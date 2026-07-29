import { useNavigate } from 'react-router-dom'
import { Button, Card, Label } from '../components/ui'
import { mockMarkets } from '../lib/mockData'

const stats = [
  { label: 'Total Value Staked', value: '$4.2M' },
  { label: 'Markets Live', value: '312' },
  { label: 'Adjudications Settled', value: '891' },
  { label: 'Avg. Horizon', value: '6.4 yrs' },
]

const steps = [
  {
    title: '1. Propose',
    body: 'Stake a historical question — how will an event, era, or decision be remembered — and set a resolution horizon of 3, 5, 10 years, or permanent.',
  },
  {
    title: '2. Stake & Evidence',
    body: 'Participants stake YES/NO. Anyone can point to evidence sources — the contract fetches and verifies them itself, never trusting submitted summaries as fact.',
  },
  {
    title: '3. Adjudicate',
    body: 'After the horizon passes, a GenLayer Intelligent Contract runs a nondeterministic web-fetch consensus across independent sources, weighting by source reliability.',
  },
  {
    title: '4. Settle',
    body: 'A verdict is reached — YES, NO, or undetermined — and escrowed GEN is released on-chain to the correct side, in full, automatically.',
  },
]

export default function Landing() {
  const navigate = useNavigate()
  return (
    <div className="flex flex-col gap-16 py-6">
      <section className="flex flex-col gap-6 max-w-2xl">
        <Label>Prediction markets for the long now</Label>
        <h1 className="font-display text-display-lg text-primary leading-tight">
          Bet on how history will remember an event.
        </h1>
        <p className="font-body text-body-lg text-on-surface-variant max-w-xl">
          Chronix is a prediction market adjudicated by a GenLayer Intelligent Contract over
          long time horizons — 3, 5, 10 years, or permanent. No moderators. No editorial board.
          Just weighted, source-verified consensus, settled on-chain.
        </p>
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={() => navigate('/discover')}>
            Explore Markets
          </Button>
          <Button variant="outline" onClick={() => navigate('/create')}>
            Create a Market
          </Button>
        </div>
      </section>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {stats.map((s) => (
          <Card key={s.label} className="p-4">
            <div className="font-label text-label-sm text-on-surface-variant uppercase tracking-widest mb-1">
              {s.label}
            </div>
            <div className="font-headline text-headline-lg text-primary">{s.value}</div>
          </Card>
        ))}
      </section>

      <section>
        <h2 className="font-headline text-headline-lg text-primary mb-6 border-b border-outline-variant pb-2">
          How it works
        </h2>
        <div className="grid md:grid-cols-4 gap-4">
          {steps.map((s) => (
            <Card key={s.title} className="p-4 flex flex-col gap-2">
              <div className="font-label text-label-md text-secondary">{s.title}</div>
              <p className="font-body text-body-sm text-on-surface-variant">{s.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-6">
          <h2 className="font-headline text-headline-lg text-primary">Trending markets</h2>
          <Button variant="ghost" onClick={() => navigate('/discover')}>
            View all →
          </Button>
        </div>
        <div className="grid md:grid-cols-3 gap-4">
          {mockMarkets.slice(0, 3).map((m) => (
            <Card
              key={m.id}
              onClick={() => navigate(`/markets/${m.id}`)}
              className="p-4 flex flex-col gap-3 cursor-pointer hover:border-secondary transition-colors"
            >
              <Label>{m.category}</Label>
              <p className="font-headline text-headline-md text-primary leading-snug">{m.question}</p>
              <div className="flex justify-between text-label-md font-label text-on-surface-variant">
                <span>${m.totalStaked.toLocaleString()} staked</span>
                <span>{m.participantCount} participants</span>
              </div>
            </Card>
          ))}
        </div>
      </section>
    </div>
  )
}
