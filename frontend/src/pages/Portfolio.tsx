import { Link } from 'react-router-dom'
import { Button, Card, Label, StatusChip } from '../components/ui'
import { mockPortfolio } from '../lib/mockData'
import { useAuth } from '../lib/auth'

export default function Portfolio() {
  const { wallet } = useAuth()
  const portfolio = mockPortfolio

  if (!wallet) {
    return (
      <Card className="p-8 text-center flex flex-col items-center gap-3 max-w-md mx-auto mt-12">
        <Label>Portfolio</Label>
        <p className="text-body-md text-on-surface-variant">
          Connect and sign in with your wallet to view your positions, claimable payouts, and history.
        </p>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-headline text-headline-lg text-primary">Portfolio</h1>

      <div className="grid md:grid-cols-3 gap-4">
        <Card className="p-4">
          <Label>Total staked</Label>
          <div className="font-headline text-headline-lg text-primary mt-1">
            ${portfolio.totalStaked.toLocaleString()}
          </div>
        </Card>
        <Card className="p-4">
          <Label>Claimable payouts</Label>
          <div className="font-headline text-headline-lg text-secondary mt-1">
            ${portfolio.totalClaimable.toLocaleString()}
          </div>
        </Card>
        <Card className="p-4">
          <Label>Open positions</Label>
          <div className="font-headline text-headline-lg text-primary mt-1">
            {portfolio.positions.filter((p) => p.marketStatus === 'open').length}
          </div>
        </Card>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-body-sm">
          <thead>
            <tr className="text-label-sm font-label text-on-surface-variant uppercase tracking-widest border-b border-outline-variant">
              <th className="text-left p-3">Market</th>
              <th className="text-left p-3">Side</th>
              <th className="text-right p-3">Shares</th>
              <th className="text-right p-3">Avg. price</th>
              <th className="text-right p-3">Value</th>
              <th className="text-left p-3">Status</th>
              <th className="text-right p-3">Action</th>
            </tr>
          </thead>
          <tbody>
            {portfolio.positions.map((p) => (
              <tr key={p.id} className="border-b border-outline-variant/30 hover:bg-surface-container-low">
                <td className="p-3 max-w-xs">
                  <Link to={`/markets/${p.marketId}`} className="hover:text-secondary line-clamp-1">
                    {p.marketQuestion}
                  </Link>
                </td>
                <td className={`p-3 font-label ${p.side === 'yes' ? 'text-secondary' : 'text-pending-amber'}`}>
                  {p.side.toUpperCase()}
                </td>
                <td className="p-3 text-right font-label">{p.shares.toLocaleString()}</td>
                <td className="p-3 text-right font-label">${p.avgPrice.toFixed(2)}</td>
                <td className="p-3 text-right font-label">${p.currentValue.toLocaleString()}</td>
                <td className="p-3">
                  <StatusChip status={p.marketStatus} />
                </td>
                <td className="p-3 text-right">
                  {p.claimable ? (
                    <Button variant="secondary" onClick={() => alert('Claiming payout (mock)')}>
                      Claim ${p.claimableAmount}
                    </Button>
                  ) : (
                    <span className="text-on-surface-variant text-label-sm">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div>
        <h2 className="font-headline text-headline-md text-primary mb-3">History</h2>
        <Card className="divide-y divide-outline-variant/30">
          {portfolio.history.map((h) => (
            <div key={h.id} className="flex items-center justify-between p-3 text-body-sm">
              <span className="font-label text-label-md text-primary uppercase">{h.type.replace(/_/g, ' ')}</span>
              <span className="text-on-surface-variant">{h.marketId}</span>
              <span className={`font-label text-label-sm ${h.confirmed ? 'text-secondary' : 'text-pending-amber'}`}>
                {h.confirmed ? 'confirmed' : 'pending'}
              </span>
              <span className="font-label text-label-sm text-on-surface-variant">
                {new Date(h.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  )
}
