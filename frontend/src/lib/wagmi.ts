import { defineChain } from '@reown/appkit/networks'
import { createAppKit } from '@reown/appkit/react'
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'

const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? ''
const rpcUrl = import.meta.env.VITE_CHAIN_RPC || 'https://studio.genlayer.com/api'

/**
 * GenLayer Studio Network — the ONLY chain this app actually uses. Every
 * transaction (create_market, stake, claim_payout, etc.) goes here, never to
 * Ethereum mainnet or a testnet. The previous wagmi-only config was wired to
 * mainnet/sepolia, so the connected wallet showed the wrong network and SIWE
 * messages were signed with the wrong chainId — fixed by defining the real
 * chain here and driving wallet connection through Reown AppKit (proper
 * multi-wallet modal, QR flow, mobile deep-linking) instead of a bare
 * `walletConnect()` connector with no modal chrome.
 */
export const genlayerStudio = defineChain({
  id: 61999,
  caipNetworkId: 'eip155:61999',
  chainNamespace: 'eip155',
  name: 'GenLayer Studio Network',
  nativeCurrency: { name: 'GEN Token', symbol: 'GEN', decimals: 18 },
  rpcUrls: {
    default: { http: [rpcUrl] },
  },
  blockExplorers: {
    default: { name: 'GenLayer Explorer', url: 'https://genlayer-explorer.vercel.app' },
  },
  testnet: true,
})

const wagmiAdapter = new WagmiAdapter({
  networks: [genlayerStudio],
  projectId: walletConnectProjectId,
  ssr: false,
})

export const wagmiConfig = wagmiAdapter.wagmiConfig

if (walletConnectProjectId) {
  createAppKit({
    adapters: [wagmiAdapter],
    networks: [genlayerStudio],
    projectId: walletConnectProjectId,
    metadata: {
      name: 'Chronix',
      description: 'Bet on how history will remember an event.',
      url: typeof window !== 'undefined' ? window.location.origin : 'https://chronix-app.vercel.app',
      icons: ['https://chronix-app.vercel.app/favicon.svg'],
    },
    features: { analytics: false, email: false, socials: false, swaps: false, onramp: false },
  })
} else {
  // eslint-disable-next-line no-console
  console.warn(
    'VITE_WALLETCONNECT_PROJECT_ID is not set — the Reown wallet-connect modal will not be available. ' +
      'Injected wallets (MetaMask, etc.) still work via the wagmi config.'
  )
}

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
