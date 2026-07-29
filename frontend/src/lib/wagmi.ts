import { createConfig, http } from 'wagmi'
import { mainnet, sepolia } from 'wagmi/chains'
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors'

const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? ''
const rpcUrl = import.meta.env.VITE_CHAIN_RPC

export const wagmiConfig = createConfig({
  chains: [mainnet, sepolia],
  connectors: [
    // MetaMask, Rainbow, Zerion, and other injected browser-extension wallets
    // all surface through EIP-1193 `injected()`.
    injected(),
    ...(walletConnectProjectId
      ? [walletConnect({ projectId: walletConnectProjectId, showQrModal: true })]
      : []),
    coinbaseWallet({ appName: 'Chronix' }),
  ],
  transports: {
    [mainnet.id]: http(rpcUrl || undefined),
    [sepolia.id]: http(rpcUrl || undefined),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
