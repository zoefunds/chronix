import { useState } from 'react'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { useAuth } from '../lib/auth'
import { Button } from './ui'

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export default function WalletButton() {
  const { address, isConnected } = useAccount()
  const { connectors, connect, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { status, signIn, signOut, wallet } = useAuth()
  const [open, setOpen] = useState(false)

  if (wallet && status === 'authenticated') {
    return (
      <div className="flex items-center gap-2">
        <span className="font-label text-label-md text-secondary">{shortAddr(wallet)}</span>
        <Button variant="ghost" onClick={signOut}>
          Sign out
        </Button>
      </div>
    )
  }

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        <span className="font-label text-label-md text-on-surface-variant">{shortAddr(address)}</span>
        <Button variant="secondary" onClick={signIn} disabled={status === 'requesting-nonce' || status === 'awaiting-signature' || status === 'verifying'}>
          {status === 'awaiting-signature' ? 'Sign message…' : status === 'verifying' ? 'Verifying…' : 'Sign-In With Ethereum'}
        </Button>
        <Button variant="ghost" onClick={() => disconnect()}>
          Disconnect
        </Button>
      </div>
    )
  }

  return (
    <div className="relative">
      <Button variant="outline" onClick={() => setOpen((o) => !o)}>
        Connect Wallet
      </Button>
      {open && (
        <div className="absolute right-0 mt-2 w-56 bg-surface-container-high border border-border-slate rounded-md shadow-lg z-50 p-1">
          {connectors.map((c) => (
            <button
              key={c.uid}
              disabled={isPending}
              onClick={() => {
                connect({ connector: c })
                setOpen(false)
              }}
              className="w-full text-left px-3 py-2 text-body-sm text-on-surface hover:bg-surface-variant hover:text-secondary rounded transition-colors"
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
