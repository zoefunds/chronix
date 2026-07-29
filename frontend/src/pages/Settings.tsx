import { useState } from 'react'
import { useAccount } from 'wagmi'
import { Button, Card, Label } from '../components/ui'
import { useAuth } from '../lib/auth'

export default function Settings() {
  const { address, chainId, connector } = useAccount()
  const { wallet, signOut } = useAuth()
  const [notifyResolved, setNotifyResolved] = useState(true)
  const [notifyEvidence, setNotifyEvidence] = useState(false)

  return (
    <div className="max-w-2xl mx-auto flex flex-col gap-6">
      <h1 className="font-headline text-headline-lg text-primary">Settings</h1>

      <Card className="p-4 flex flex-col gap-3">
        <Label>Wallet</Label>
        {wallet ? (
          <>
            <div className="flex justify-between text-body-sm">
              <span className="text-on-surface-variant">Address</span>
              <span className="font-label text-label-md text-primary">{address}</span>
            </div>
            <div className="flex justify-between text-body-sm">
              <span className="text-on-surface-variant">Connector</span>
              <span className="font-label text-label-md text-primary">{connector?.name ?? '—'}</span>
            </div>
            <div className="flex justify-between text-body-sm">
              <span className="text-on-surface-variant">Chain ID</span>
              <span className="font-label text-label-md text-primary">{chainId ?? '—'}</span>
            </div>
            <Button variant="outline" onClick={signOut}>
              Disconnect wallet
            </Button>
          </>
        ) : (
          <p className="text-body-sm text-on-surface-variant">No wallet connected.</p>
        )}
      </Card>

      <Card className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Label>Notification preferences</Label>
          <span className="font-label text-label-sm text-pending-amber uppercase tracking-widest">
            not yet backed
          </span>
        </div>
        <p className="text-label-sm font-label text-on-surface-variant">
          These toggles are UI-only placeholders — no backend endpoint persists them yet.
        </p>
        <label className="flex items-center justify-between text-body-sm cursor-pointer">
          Notify me when a market I've staked in resolves
          <input type="checkbox" checked={notifyResolved} onChange={() => setNotifyResolved((v) => !v)} className="accent-emerald-400" />
        </label>
        <label className="flex items-center justify-between text-body-sm cursor-pointer">
          Notify me on new evidence in markets I follow
          <input type="checkbox" checked={notifyEvidence} onChange={() => setNotifyEvidence((v) => !v)} className="accent-emerald-400" />
        </label>
      </Card>
    </div>
  )
}
