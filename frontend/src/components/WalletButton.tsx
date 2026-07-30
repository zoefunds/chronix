import { useAccount, useDisconnect } from 'wagmi'
import { useAppKit } from '@reown/appkit/react'
import { useAuth } from '../lib/auth'
import { Button } from './ui'

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export default function WalletButton() {
  const { address, isConnected } = useAccount()
  const { disconnect } = useDisconnect()
  const { open } = useAppKit()
  const { status, signIn, signOut, wallet } = useAuth()

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
        <Button
          variant="secondary"
          onClick={signIn}
          disabled={status === 'requesting-nonce' || status === 'awaiting-signature' || status === 'verifying'}
        >
          {status === 'awaiting-signature' ? 'Sign message…' : status === 'verifying' ? 'Verifying…' : 'Verify Wallet'}
        </Button>
        <Button variant="ghost" onClick={() => disconnect()}>
          Disconnect
        </Button>
      </div>
    )
  }

  // Opens Reown's real connect modal (MetaMask/injected, WalletConnect QR +
  // mobile deep-links, Coinbase — a proper wallet picker, not a bare list).
  return (
    <Button variant="outline" onClick={() => open()}>
      Connect Wallet
    </Button>
  )
}
