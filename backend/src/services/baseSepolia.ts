/**
 * Base Sepolia payment layer.
 *
 * GenLayer (genlayer/client.ts) is the adjudication + ledger layer only —
 * it never escrows or moves real value any more (see contracts/chronix.py's
 * class docstring). Real USDC (initial liquidity + YES/NO stakes) lives in
 * ChronixEscrow.sol (contracts/base/) on Base Sepolia. This module is the
 * only place that talks to that contract: turning a Postgres market UUID
 * into the escrow's bytes32 key, scanning confirmed Funded deposits, and
 * pushing a settled market's payout list back onto the escrow exactly once.
 */
import { ethers } from "ethers";
import { env } from "../config.js";
import { logger } from "../lib/logger.js";
import { CHRONIX_ESCROW_ABI, ERC20_ABI } from "../lib/escrowAbi.js";

let provider: ethers.JsonRpcProvider | null = null;
let relayerWallet: ethers.Wallet | null = null;
let escrowContract: ethers.Contract | null = null;

function getProvider(): ethers.JsonRpcProvider {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(env.BASE_SEPOLIA_RPC_URL);
  }
  return provider;
}

export function isEscrowConfigured(): boolean {
  return Boolean(env.CHRONIX_ESCROW_ADDRESS && env.BASE_SEPOLIA_RELAYER_PRIVATE_KEY);
}

function getRelayerContract(): ethers.Contract {
  if (!env.CHRONIX_ESCROW_ADDRESS) throw new Error("CHRONIX_ESCROW_ADDRESS is not configured");
  if (!env.BASE_SEPOLIA_RELAYER_PRIVATE_KEY) throw new Error("BASE_SEPOLIA_RELAYER_PRIVATE_KEY is not configured");
  if (!escrowContract) {
    relayerWallet = new ethers.Wallet(env.BASE_SEPOLIA_RELAYER_PRIVATE_KEY, getProvider());
    escrowContract = new ethers.Contract(env.CHRONIX_ESCROW_ADDRESS, CHRONIX_ESCROW_ABI, relayerWallet);
  }
  return escrowContract;
}

/** Read-only contract instance, no signer required. */
function getReadContract(): ethers.Contract {
  if (!env.CHRONIX_ESCROW_ADDRESS) throw new Error("CHRONIX_ESCROW_ADDRESS is not configured");
  return new ethers.Contract(env.CHRONIX_ESCROW_ADDRESS, CHRONIX_ESCROW_ABI, getProvider());
}

/** Chronix market ids are UUIDs; the escrow keys pools by bytes32, so hash
 * the id deterministically the same way on both the backend and frontend. */
export function marketIdToBytes32(marketId: string): string {
  return ethers.id(marketId);
}

export interface FundedLog {
  marketId: string; // bytes32
  from: string;
  kind: number;
  amount: bigint;
  txHash: string;
  blockNumber: number;
}

/** Scans ChronixEscrow Funded events in [fromBlock, toBlock]. Used by the
 * relay job's deposit-discovery pass — see jobs/baseRelay.ts. */
export async function getFundedEvents(fromBlock: number, toBlock: number): Promise<FundedLog[]> {
  const contract = getReadContract();
  const filter = contract.filters.Funded();
  const logs = await contract.queryFilter(filter, fromBlock, toBlock);
  return logs
    .filter((l): l is ethers.EventLog => "args" in l)
    .map((l) => ({
      marketId: l.args.marketId as string,
      from: (l.args.from as string).toLowerCase(),
      kind: Number(l.args.kind),
      amount: l.args.amount as bigint,
      txHash: l.transactionHash,
      blockNumber: l.blockNumber,
    }));
}

export async function getCurrentBlock(): Promise<number> {
  return getProvider().getBlockNumber();
}

export interface PayoutRecipient {
  wallet: string;
  amountBaseUnits: string;
}

/**
 * Push a GenLayer-finalized market's payouts onto the Base Sepolia escrow.
 * Idempotent from the caller's perspective: the contract itself rejects a
 * second setPayouts call for the same marketId, so a retry after a partial
 * failure (e.g. this succeeding but marking `payouts_relayed_at` in
 * Postgres failing) is always safe to just call again.
 */
export async function relayPayoutsToEscrow(marketId: string, recipients: PayoutRecipient[]): Promise<string> {
  const contract = getRelayerContract();
  const nonZero = recipients.filter((r) => BigInt(r.amountBaseUnits || "0") > BigInt(0));
  if (nonZero.length === 0) {
    throw new Error(`No non-zero payouts to relay for market ${marketId}`);
  }
  const wallets = nonZero.map((r) => r.wallet);
  const amounts = nonZero.map((r) => BigInt(r.amountBaseUnits));
  const key = marketIdToBytes32(marketId);

  const tx = await contract.setPayouts(key, wallets, amounts);
  logger.info({ marketId, txHash: tx.hash, recipientCount: wallets.length }, "relaying payouts to Base Sepolia escrow");
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`setPayouts transaction failed for market ${marketId}`);
  }
  return tx.hash as string;
}

export async function getEscrowPool(marketId: string) {
  const contract = getReadContract();
  const key = marketIdToBytes32(marketId);
  const [deposited, allocated, payoutsSet] = await contract.getPool(key);
  return {
    deposited: (deposited as bigint).toString(),
    allocated: (allocated as bigint).toString(),
    payoutsSet: payoutsSet as boolean,
  };
}

export async function getEscrowClaimable(marketId: string, address: string) {
  const contract = getReadContract();
  const key = marketIdToBytes32(marketId);
  const amount = await contract.getClaimable(key, address);
  return (amount as bigint).toString();
}

/** The wallet's own real USDC balance on Base Sepolia (base units, 6
 * decimals) — works even if the escrow contract isn't configured yet,
 * since it only needs the USDC address and an RPC connection. */
export async function getWalletUsdcBalance(address: string): Promise<string> {
  if (!env.BASE_SEPOLIA_USDC_ADDRESS) throw new Error("BASE_SEPOLIA_USDC_ADDRESS is not configured");
  const usdc = new ethers.Contract(env.BASE_SEPOLIA_USDC_ADDRESS, ERC20_ABI, getProvider());
  const balance = await usdc.balanceOf(address);
  return (balance as bigint).toString();
}
