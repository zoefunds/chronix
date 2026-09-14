/**
 * Base Sepolia payment layer — the ONLY place in the frontend that moves
 * real money. GenLayer (lib/genlayer.ts) is adjudication + ledger only; it
 * never escrows or moves value any more (see contracts/chronix.py's class
 * docstring). Every stake, initial-liquidity deposit, and claim happens
 * here, directly against ChronixEscrow.sol on Base Sepolia, always signed
 * by the user's own connected wallet — the backend relayer only ever
 * mirrors what already happened here (see backend/src/jobs/baseRelay.ts).
 */
import { getWalletClient, waitForTransactionReceipt, switchChain, readContract } from '@wagmi/core'
import { parseAbi, type Address, type Hash } from 'viem'
import { wagmiConfig, baseSepolia } from './wagmi'

export const CHRONIX_ESCROW_ABI = parseAbi([
  'function fund(bytes32 marketId, uint8 kind, uint256 amount) external',
  'function claim(bytes32 marketId) external',
  'function claimMany(bytes32[] marketIds) external',
  'function getPool(bytes32 marketId) external view returns (uint256 deposited, uint256 allocated, bool payoutsSet)',
  'function getClaimable(bytes32 marketId, address wallet) external view returns (uint256)',
])

export const ERC20_ABI = parseAbi([
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
])

export const FUND_KIND_POOL = 0
export const FUND_KIND_YES = 1
export const FUND_KIND_NO = 2

/** USDC uses 6 decimals on Base Sepolia. */
export function usdcToBaseUnits(amount: string | number): bigint {
  const [whole, frac = ''] = String(amount).split('.')
  const fracPadded = (frac + '0'.repeat(6)).slice(0, 6)
  return BigInt(whole || '0') * 10n ** 6n + BigInt(fracPadded || '0')
}

export function baseUnitsToUsdc(amount: string | bigint): string {
  const v = BigInt(amount)
  const whole = v / 10n ** 6n
  const frac = (v % 10n ** 6n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

async function ensureBaseSepolia(account: Address) {
  await switchChain(wagmiConfig, { chainId: baseSepolia.id }).catch(() => {
    // Some wallets no-op an already-current chain rather than resolving
    // cleanly — re-check via the wallet client below instead of trusting
    // this promise's rejection alone.
  })
  const client = await getWalletClient(wagmiConfig, { account, chainId: baseSepolia.id })
  const chainId = (client as { chain?: { id?: number } }).chain?.id
  if (chainId !== baseSepolia.id) {
    throw new Error('Please switch your wallet to the Base Sepolia network to continue.')
  }
  return client
}

/**
 * Approves ChronixEscrow for `amountBaseUnits` USDC (only if the current
 * allowance is insufficient — skips a redundant approve tx otherwise), then
 * calls fund(marketId, kind, amount). Two wallet confirmations on a fresh
 * approval, one on repeat funding once allowance is already sufficient.
 */
export async function approveAndFund(params: {
  account: Address
  escrowAddress: Address
  usdcAddress: Address
  marketIdBytes32: `0x${string}`
  kind: number
  amountBaseUnits: bigint
}): Promise<{ approveTxHash: Hash | null; fundTxHash: Hash }> {
  const client = await ensureBaseSepolia(params.account)

  const allowance = (await readContract(wagmiConfig, {
    address: params.usdcAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [params.account, params.escrowAddress],
    chainId: baseSepolia.id,
  })) as bigint

  let approveTxHash: Hash | null = null
  if (allowance < params.amountBaseUnits) {
    approveTxHash = await client.writeContract({
      address: params.usdcAddress,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [params.escrowAddress, params.amountBaseUnits],
      chain: baseSepolia,
      account: params.account,
    })
    await waitForTransactionReceipt(wagmiConfig, { hash: approveTxHash, chainId: baseSepolia.id })
  }

  const fundTxHash = await client.writeContract({
    address: params.escrowAddress,
    abi: CHRONIX_ESCROW_ABI,
    functionName: 'fund',
    args: [params.marketIdBytes32, params.kind, params.amountBaseUnits],
    chain: baseSepolia,
    account: params.account,
  })
  await waitForTransactionReceipt(wagmiConfig, { hash: fundTxHash, chainId: baseSepolia.id })

  return { approveTxHash, fundTxHash }
}

/** Self-serve claim — no relayer involvement, no GenLayer transaction needed. */
export async function claim(params: {
  account: Address
  escrowAddress: Address
  marketIdBytes32: `0x${string}`
}): Promise<Hash> {
  const client = await ensureBaseSepolia(params.account)
  const hash = await client.writeContract({
    address: params.escrowAddress,
    abi: CHRONIX_ESCROW_ABI,
    functionName: 'claim',
    args: [params.marketIdBytes32],
    chain: baseSepolia,
    account: params.account,
  })
  await waitForTransactionReceipt(wagmiConfig, { hash, chainId: baseSepolia.id })
  return hash
}

export async function getUsdcBalance(account: Address, usdcAddress: Address): Promise<bigint> {
  return (await readContract(wagmiConfig, {
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account],
    chainId: baseSepolia.id,
  })) as bigint
}
