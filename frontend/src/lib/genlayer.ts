/**
 * Browser-side GenLayer client. This is the ONLY place in the frontend that
 * should sign and submit money-moving contract calls (create_market, stake,
 * submit_evidence_pointer, claim_payout, claim_timeout_refund, cancel_market)
 * — it always uses the user's own connected wallet (via window.ethereum /
 * EIP-1193), never a backend-held key. The backend's job is only to mirror
 * what already happened here — see backend/src/genlayer/client.ts's
 * trust-model docstring for the matching server-side half of this contract.
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

/** GEN uses 18 decimals, same as native ETH-style value encoding. */
export function genToWei(genAmount: string | number): bigint {
  const [whole, frac = ''] = String(genAmount).split('.')
  const fracPadded = (frac + '0'.repeat(18)).slice(0, 18)
  return BigInt(whole || '0') * 10n ** 18n + BigInt(fracPadded || '0')
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

  /** Payable. Returns { txHash, marketId } — marketId comes from reading get_market_count() after. */
  async createMarket(
    account: Address,
    params: {
      question: string
      category: string
      horizonYears: number
      resolutionCriteria: string
      allowedEvidenceTypes: string
      initialLiquidityGen: string
    }
  ): Promise<{ txHash: string; contractMarketId: number }> {
    const client = getWalletClient(account)
    const value = genToWei(params.initialLiquidityGen)
    const hash = await client.writeContract({
      address: CONTRACT_ADDRESS,
      functionName: 'create_market',
      args: [
        params.question,
        params.category,
        params.horizonYears,
        params.resolutionCriteria,
        params.allowedEvidenceTypes,
      ] as never,
      value,
    })
    await client.waitForTransactionReceipt({ hash, retries: RECEIPT_RETRIES, interval: RECEIPT_INTERVAL_MS })
    // create_market returns the new market's id, but the simplest reliable
    // way to know it from the browser (without depending on decoded return
    // value shape) is: it's always market_count - 1 immediately after our
    // own tx lands, since ids are assigned sequentially and this call just
    // confirmed.
    const count = (await client.readContract({
      address: CONTRACT_ADDRESS,
      functionName: 'get_market_count',
      args: [],
    })) as number
    return { txHash: hash as unknown as string, contractMarketId: Number(count) - 1 }
  },

  /** Payable. */
  async stake(account: Address, contractMarketId: number, side: 'YES' | 'NO', amountGen: string): Promise<string> {
    return write(account, 'stake', [contractMarketId, side], genToWei(amountGen))
  },

  /** Non-payable. */
  async submitEvidencePointer(
    account: Address,
    contractMarketId: number,
    sourceType: string,
    url: string
  ): Promise<string> {
    return write(account, 'submit_evidence_pointer', [contractMarketId, sourceType, url])
  },

  /** Non-payable. Anyone can call once eligible — see contract's claim_payout docstring. */
  async claimPayout(account: Address, contractMarketId: number): Promise<string> {
    return write(account, 'claim_payout', [contractMarketId])
  },

  /** Non-payable. Backstop exit if adjudication stalls past the grace window. */
  async claimTimeoutRefund(account: Address, contractMarketId: number): Promise<string> {
    return write(account, 'claim_timeout_refund', [contractMarketId])
  },

  /** Non-payable. Creator-only, pre-participation-only (enforced by the contract). */
  async cancelMarket(account: Address, contractMarketId: number): Promise<string> {
    return write(account, 'cancel_market', [contractMarketId])
  },
}
