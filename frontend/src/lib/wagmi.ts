import { defineChain } from '@reown/appkit/networks'
import { createAppKit } from '@reown/appkit/react'
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'

const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? ''
const rpcUrl = import.meta.env.VITE_CHAIN_RPC || 'https://studio.genlayer.com/api'
const baseSepoliaRpcUrl = import.meta.env.VITE_BASE_SEPOLIA_RPC || 'https://sepolia.base.org'

/**
 * Two chains, one wallet — see contracts/chronix.py + contracts/base/ for
 * the full split: GenLayer Studio is adjudication + ledger only (it moves
 * no money any more); every real USDC stake/claim happens on Base Sepolia
 * against ChronixEscrow.sol (see lib/escrow.ts). The connected wallet
 * switches between the two depending on which action the user is taking —
 * `submit_evidence_pointer` reads/writes GenLayer directly, while
 * staking/funding/claiming go through lib/escrow.ts on Base Sepolia.
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

export const baseSepolia = defineChain({
  id: 84532,
  caipNetworkId: 'eip155:84532',
  chainNamespace: 'eip155',
  name: 'Base Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [baseSepoliaRpcUrl] },
  },
  blockExplorers: {
    default: { name: 'BaseScan', url: 'https://sepolia.basescan.org' },
  },
  testnet: true,
})

const wagmiAdapter = new WagmiAdapter({
  networks: [baseSepolia, genlayerStudio],
  projectId: walletConnectProjectId,
  ssr: false,
})

export const wagmiConfig = wagmiAdapter.wagmiConfig

if (walletConnectProjectId) {
  createAppKit({
    adapters: [wagmiAdapter],
    networks: [baseSepolia, genlayerStudio],
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
