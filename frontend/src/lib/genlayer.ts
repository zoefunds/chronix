/**
 * Browser-side GenLayer client. GenLayer is adjudication + ledger only now
 * — it moves no money at all (see contracts/chronix.py's class docstring).
 * Every write that used to be signed here directly (create_market, stake,
 * claim_payout, claim_timeout_refund, cancel_market) is now relayer-gated
 * on-chain: the backend's relayer mirrors confirmed Base Sepolia USDC
 * activity (see src/lib/escrow.ts, which is where those actions live now)
 * onto GenLayer itself. The ONE write that stays here, directly signed by
 * the user's own wallet, is `submit_evidence_pointer` — it never moves
 * money, so it was never relayer-gated (see chronix.py's README table).
 */
import { createClient, chains } from 'genlayer-js'
import type { Address } from 'genlayer-js/types'

const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS as Address

// GenLayer Studio currently caps requests at 30/min. Each receipt poll is
// one request, so back-to-back writes (e.g. submitting several evidence
// pointers in a row) can trip that cap purely from polling — the on-chain
// tx still succeeds, but the poll throws before the frontend gets to mirror
// it into Postgres, and the market/evidence goes missing from the UI until
// the backend's chain-indexer backfill catches it. Spacing polls out
// further keeps a single submission's own polling well under the cap.
const RECEIPT_RETRIES = 15
const RECEIPT_INTERVAL_MS = 5000

export class GenLayerNotConfiguredError extends Error {
  constructor() {
    super('VITE_CONTRACT_ADDRESS is not set.')
    this.name = 'GenLayerNotConfiguredError'
  }
}

interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

function getProvider(): Eip1193Provider {
  const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum
  if (!eth) {
    throw new Error(
      'No injected wallet found. Connect MetaMask (or another EIP-1193 wallet) before staking or creating a market.'
    )
  }
  return eth
}

/**
 * Builds a fresh genlayer-js client bound to the currently connected wallet.
 * Built per-call rather than cached, since the active account can change
 * between calls (wallet switch, disconnect/reconnect).
 */
function getWalletClient(account: Address) {
  if (!CONTRACT_ADDRESS) throw new GenLayerNotConfiguredError()
  return createClient({
    chain: chains.studionet,
    provider: getProvider(),
    account,
  })
}

async function write(
  account: Address,
  functionName: string,
  args: unknown[],
  value: bigint = 0n
): Promise<string> {
  const client = getWalletClient(account)
  const hash = await client.writeContract({
    address: CONTRACT_ADDRESS,
    functionName,
    args: args as never,
    value,
  })
  await client.waitForTransactionReceipt({ hash, retries: RECEIPT_RETRIES, interval: RECEIPT_INTERVAL_MS })
  return hash as unknown as string
}

export const genlayer = {
  isConfigured: () => Boolean(CONTRACT_ADDRESS),

  /**
   * Non-payable, directly wallet-signed — the one write method that never
   * moved money, so it stayed permissionless (see chronix.py's README
   * table). Never trusted as fact by adjudication; only settle()'s own
   * fetch is authoritative — this just stores a pointer.
   */
  async submitEvidencePointer(
    account: Address,
    contractMarketId: number,
    sourceType: string,
    url: string
  ): Promise<string> {
    return write(account, 'submit_evidence_pointer', [contractMarketId, sourceType, url])
  },
}
