/**
 * GenLayer client wrapper, backed by the official genlayer-js SDK.
 *
 * Wraps calls to the deployed Chronix Intelligent Contract
 * (contracts/chronix.py), deployed at CONTRACT_ADDRESS on GenLayer
 * Studio/StudioNet — see MEMORY.md for the deployed address.
 *
 * Trust model (read before adding a call here) — CHANGED from the original
 * GEN-native design: this contract now moves no money at all (real USDC
 * lives in ChronixEscrow.sol on Base Sepolia — see services/baseSepolia.ts
 * and chronix.py's class docstring). Every write method on the contract is
 * relayer-gated, so every write call in this file uses the SAME relayer
 * account (RELAYER_PRIVATE_KEY) — there is no separate "user wallet signs
 * directly" path any more, and no separate "keeper" identity either: one
 * backend-held key both advances permissionless state
 * (request_adjudication, settle) and mirrors Base-confirmed funding/payout
 * events (create_market, stake, claim_payout, claim_timeout_refund,
 * cancel_market). This backend still never custodies user funds — it only
 * ever mirrors facts the escrow contract has already confirmed on Base.
 */
import { createClient, chains, createAccount } from "genlayer-js";
import type { Address, Hash } from "genlayer-js/types";
import { env } from "../config.js";
import { logger } from "../lib/logger.js";

type GLClient = ReturnType<typeof createClient>;

export class GenLayerNotConfiguredError extends Error {
  constructor() {
    super("CONTRACT_ADDRESS is not set — GenLayer client wrapper is not configured yet.");
    this.name = "GenLayerNotConfiguredError";
  }
}

let readClient: GLClient | null = null;

function getReadClient(): GLClient {
  if (!env.CONTRACT_ADDRESS) throw new GenLayerNotConfiguredError();
  if (readClient) return readClient;
  readClient = createClient({
    chain: chains.studionet,
    endpoint: env.GENLAYER_RPC_URL,
  });
  return readClient;
}

/** Relayer client: only constructed if RELAYER_PRIVATE_KEY is set. See trust model above. */
let relayerClient: GLClient | null = null;

export function getRelayerClient(): GLClient | null {
  if (!env.RELAYER_PRIVATE_KEY || !env.CONTRACT_ADDRESS) return null;
  if (relayerClient) return relayerClient;
  const account = createAccount(env.RELAYER_PRIVATE_KEY as `0x${string}`);
  relayerClient = createClient({
    chain: chains.studionet,
    endpoint: env.GENLAYER_RPC_URL,
    account,
  });
  return relayerClient;
}

/**
 * A GenVM receipt can resolve (waitForTransactionReceipt returns without
 * throwing) even when the contract call itself errored — e.g. a Python
 * exception inside the method body. genlayer-js surfaces that as a
 * FINALIZED/MAJORITY_AGREE receipt whose consensus_data.leader_receipt
 * entries carry `execution_result` + `genvm_result.stderr` for the actual
 * failure. Found live (2026-09-15): create_market's poolDeposited arg was
 * being sent as a JSON string instead of a numeric type, so the contract's
 * `deposit <= u256(0)` comparison raised `TypeError: '<=' not supported
 * between instances of 'str' and 'int'` — the receipt still "succeeded"
 * confirming, and the caller (relayPendingPools) computed a bogus
 * contractMarketId from a market that was never actually created. Every
 * write whose return value (or side effect) baseRelay.ts persists into
 * Postgres MUST check this before trusting the receipt.
 */
function assertReceiptSucceeded(receipt: unknown, context: string): void {
  const leaderReceipts = (receipt as { consensus_data?: { leader_receipt?: unknown } })?.consensus_data
    ?.leader_receipt;
  const entries = Array.isArray(leaderReceipts) ? leaderReceipts : [];
  for (const entry of entries) {
    const executionResult = String((entry as { execution_result?: unknown })?.execution_result ?? "");
    const stderr = String((entry as { genvm_result?: { stderr?: unknown } })?.genvm_result?.stderr ?? "");
    if (executionResult.toUpperCase().includes("ERROR") || stderr.trim().length > 0) {
      throw new Error(
        `GenVM execution failed for ${context}: ${executionResult || "unknown error"}${stderr ? ` — ${stderr.trim().split("\n").pop()}` : ""}`
      );
    }
  }
}

/**
 * The method's actual decoded return value — confirmed live (2026-09-15)
 * against a real create_market receipt: it lives at
 * consensus_data.leader_receipt[i (mode === "leader")].result.payload.readable,
 * NOT the top-level `receipt.result` (that field is the numeric
 * TransactionResult consensus enum, e.g. 6 = MAJORITY_AGREE — a previously
 * unverified assumption in claimPayout/claimTimeoutRefund/cancelMarket that
 * was silently wrong; `getTransactionTrace`'s debugTraceTransaction fallback
 * these docstrings pointed to doesn't exist on this endpoint either
 * (`Method not found: gen_dbg_traceTransaction`), so this is now the only
 * confirmed way to read a write method's return value).
 */
function getLeaderReturnValue(receipt: unknown): string | null {
  const leaderReceipts = (receipt as { consensus_data?: { leader_receipt?: unknown } })?.consensus_data
    ?.leader_receipt;
  const entries = Array.isArray(leaderReceipts) ? leaderReceipts : [];
  const leader = entries.find((e) => (e as { mode?: unknown })?.mode === "leader") as
    | { result?: { payload?: { readable?: unknown } } }
    | undefined;
  const readable = leader?.result?.payload?.readable;
  return readable === undefined || readable === null ? null : String(readable);
}

export interface ChainMarket {
  id: number;
  creator: string;
  question: string;
  category: string;
  horizonYears: number;
  resolutionCriteria: string;
  allowedEvidenceTypes: string;
  createdAt: number;
  resolvesAt: number;
  status: string;
  poolDeposited: string;
  totalYes: string;
  totalNo: string;
  adjudicationRequestedAt: number;
  verdict: string;
  evidenceCount: number;
}

function mapMarket(raw: Record<string, unknown>): ChainMarket {
  return {
    id: Number(raw.id),
    creator: String(raw.creator),
    question: String(raw.question),
    category: String(raw.category),
    horizonYears: Number(raw.horizon_years),
    resolutionCriteria: String(raw.resolution_criteria),
    allowedEvidenceTypes: String(raw.allowed_evidence_types),
    createdAt: Number(raw.created_at),
    resolvesAt: Number(raw.resolves_at),
    status: String(raw.status),
    poolDeposited: String(raw.pool_deposited),
    totalYes: String(raw.total_yes),
    totalNo: String(raw.total_no),
    adjudicationRequestedAt: Number(raw.adjudication_requested_at),
    verdict: String(raw.verdict ?? ""),
    evidenceCount: Number(raw.evidence_count),
  };
}

export const genlayerClient = {
  isConfigured(): boolean {
    return Boolean(env.CONTRACT_ADDRESS);
  },

  /**
   * Read-only: fetches the market straight from the contract's own
   * `get_market(market_id) -> dict` view method. This is the ONLY source of
   * truth for whether a deadline has actually passed on-chain — the
   * deadline enforcer job derives `resolvesAtPassed` client-side from
   * `resolvesAt` here rather than trusting any separately-cached field.
   */
  async getMarket(contractMarketId: number): Promise<ChainMarket> {
    const client = getReadClient();
    const result = (await client.readContract({
      address: env.CONTRACT_ADDRESS as Address,
      functionName: "get_market",
      args: [contractMarketId],
    })) as Record<string, unknown>;
    return mapMarket(result);
  },

  async getMarketCount(): Promise<number> {
    const client = getReadClient();
    const result = await client.readContract({
      address: env.CONTRACT_ADDRESS as Address,
      functionName: "get_market_count",
      args: [],
    });
    return Number(result);
  },

  async getStake(contractMarketId: number, wallet: string): Promise<{ yes: string; no: string; claimed: boolean }> {
    const client = getReadClient();
    const result = (await client.readContract({
      address: env.CONTRACT_ADDRESS as Address,
      functionName: "get_stake",
      args: [contractMarketId, wallet],
    })) as Record<string, unknown>;
    return {
      yes: String(result.yes ?? "0"),
      no: String(result.no ?? "0"),
      claimed: Boolean(result.claimed),
    };
  },

  async getAllEvidence(
    contractMarketId: number
  ): Promise<Array<{ url: string; sourceType: string; submitter: string }>> {
    const client = getReadClient();
    const result = (await client.readContract({
      address: env.CONTRACT_ADDRESS as Address,
      functionName: "get_all_evidence",
      args: [contractMarketId],
    })) as Array<Record<string, unknown>>;
    return result.map((e) => ({
      url: String(e.url ?? ""),
      sourceType: String(e.source_type ?? ""),
      submitter: String(e.submitter ?? ""),
    }));
  },

  /**
   * Advances a market past its deadline. Non-payable, permissionless
   * on-chain (the contract itself re-checks now >= resolves_at and reverts
   * if called early — this call is never trusted to be correct, only
   * convenient). No-ops with a warning if no relayer key is configured.
   */
  async requestAdjudication(contractMarketId: number): Promise<{ txHash: string } | null> {
    const client = getRelayerClient();
    if (!client) {
      logger.warn("RELAYER_PRIVATE_KEY not set; skipping automated request_adjudication");
      return null;
    }
    const hash = await client.writeContract({
      address: env.CONTRACT_ADDRESS as Address,
      functionName: "request_adjudication",
      args: [contractMarketId],
      value: 0n,
    });
    return { txHash: hash as unknown as string };
  },

  /**
   * Triggers settle() once a market is awaiting_adjudication. Non-payable;
   * the contract's own nondet consensus determines the verdict, this call
   * just initiates it. See trust model at top of file.
   */
  async settle(contractMarketId: number): Promise<{ txHash: string } | null> {
    const client = getRelayerClient();
    if (!client) {
      logger.warn("RELAYER_PRIVATE_KEY not set; skipping automated settle");
      return null;
    }
    const hash = await client.writeContract({
      address: env.CONTRACT_ADDRESS as Address,
      functionName: "settle",
      args: [contractMarketId],
      value: 0n,
    });
    return { txHash: hash as unknown as string };
  },

  /**
   * Relayer-only: mirrors a confirmed ChronixEscrow.fund(marketId,
   * KIND_POOL, amount) deposit onto GenLayer. `amount` is in USDC base
   * units (6 decimals). Returns the new on-chain contract_market_id.
   */
  async createMarket(params: {
    creatorWallet: string;
    poolDeposited: string;
    question: string;
    category: string;
    horizonYears: number;
    resolutionCriteria: string;
    allowedEvidenceTypes: string;
  }): Promise<{ txHash: string; contractMarketId: number }> {
    const client = getRelayerClient();
    if (!client) throw new Error("RELAYER_PRIVATE_KEY not set; cannot relay create_market");
    const hash = await client.writeContract({
      address: env.CONTRACT_ADDRESS as Address,
      functionName: "create_market",
      args: [
        params.creatorWallet,
        // Must be a numeric type (bigint), not a string — genlayer-js
        // encodes a JS string arg as a quoted string in calldata, which
        // GenVM then hands the contract as a Python `str`, not `u256`. See
        // assertReceiptSucceeded's docstring for the real failure this caused.
        BigInt(params.poolDeposited),
        params.question,
        params.category,
        params.horizonYears,
        params.resolutionCriteria,
        params.allowedEvidenceTypes,
      ],
      value: 0n,
    });
    const receipt = await genlayerClient.waitForReceipt(hash as unknown as string);
    assertReceiptSucceeded(receipt, `create_market (question="${params.question.slice(0, 40)}...")`);
    const contractMarketId = (await genlayerClient.getMarketCount()) - 1;
    return { txHash: hash as unknown as string, contractMarketId };
  },

  /** Relayer-only: mirrors a confirmed ChronixEscrow.fund(marketId, KIND_YES|KIND_NO, amount) deposit. */
  async stake(params: {
    contractMarketId: number;
    wallet: string;
    side: "yes" | "no";
    amount: string;
  }): Promise<{ txHash: string }> {
    const client = getRelayerClient();
    if (!client) throw new Error("RELAYER_PRIVATE_KEY not set; cannot relay stake");
    const hash = await client.writeContract({
      address: env.CONTRACT_ADDRESS as Address,
      functionName: "stake",
      // amount must be numeric (bigint) — see create_market's args above.
      args: [params.contractMarketId, params.wallet, params.side.toUpperCase(), BigInt(params.amount)],
      value: 0n,
    });
    const receipt = await genlayerClient.waitForReceipt(hash as unknown as string);
    assertReceiptSucceeded(receipt, `stake (marketId=${params.contractMarketId}, wallet=${params.wallet})`);
    return { txHash: hash as unknown as string };
  },

  // `claimPayout` / `claimTimeoutRefund` / `cancelMarket` below read the
  // method's u256 return value via getLeaderReturnValue() — confirmed live
  // (2026-09-15) against a real create_market receipt. See that function's
  // docstring: the top-level receipt.result field is NOT the return value
  // (it's the consensus-agreement enum), and getTransactionTrace's
  // debugTraceTransaction fallback doesn't exist on this endpoint.

  /** Relayer-only: computes + zeroes wallet's payout ledger, returns the amount to relay onto the escrow. */
  async claimPayout(contractMarketId: number, wallet: string): Promise<{ txHash: string; amount: string }> {
    const client = getRelayerClient();
    if (!client) throw new Error("RELAYER_PRIVATE_KEY not set; cannot relay claim_payout");
    const hash = await client.writeContract({
      address: env.CONTRACT_ADDRESS as Address,
      functionName: "claim_payout",
      args: [contractMarketId, wallet],
      value: 0n,
    });
    const receipt = await genlayerClient.waitForReceipt(hash as unknown as string);
    assertReceiptSucceeded(receipt, `claim_payout (marketId=${contractMarketId}, wallet=${wallet})`);
    const amount = getLeaderReturnValue(receipt) ?? "0";
    return { txHash: hash as unknown as string, amount };
  },

  /** Relayer-only: same as claimPayout, for the timeout-refund backstop path. */
  async claimTimeoutRefund(contractMarketId: number, wallet: string): Promise<{ txHash: string; amount: string }> {
    const client = getRelayerClient();
    if (!client) throw new Error("RELAYER_PRIVATE_KEY not set; cannot relay claim_timeout_refund");
    const hash = await client.writeContract({
      address: env.CONTRACT_ADDRESS as Address,
      functionName: "claim_timeout_refund",
      args: [contractMarketId, wallet],
      value: 0n,
    });
    const receipt = await genlayerClient.waitForReceipt(hash as unknown as string);
    assertReceiptSucceeded(receipt, `claim_timeout_refund (marketId=${contractMarketId}, wallet=${wallet})`);
    const amount = getLeaderReturnValue(receipt) ?? "0";
    return { txHash: hash as unknown as string, amount };
  },

  /** Relayer-only: creator-requested pre-participation cancellation. Returns pool_deposited to relay back. */
  async cancelMarket(contractMarketId: number): Promise<{ txHash: string; amount: string }> {
    const client = getRelayerClient();
    if (!client) throw new Error("RELAYER_PRIVATE_KEY not set; cannot relay cancel_market");
    const hash = await client.writeContract({
      address: env.CONTRACT_ADDRESS as Address,
      functionName: "cancel_market",
      args: [contractMarketId],
      value: 0n,
    });
    const receipt = await genlayerClient.waitForReceipt(hash as unknown as string);
    assertReceiptSucceeded(receipt, `cancel_market (marketId=${contractMarketId})`);
    const amount = getLeaderReturnValue(receipt) ?? "0";
    return { txHash: hash as unknown as string, amount };
  },

  async waitForReceipt(txHash: string) {
    const client = getReadClient();
    return client.waitForTransactionReceipt({
      hash: txHash as Hash,
      retries: 20,
      interval: 3000,
    });
  },

  /**
   * Reads the real GenVM execution trace for a settle() transaction —
   * return_data (the decoded verdict), eq_outputs (each validator's
   * independent nondet-block result, i.e. actual per-validator agreement,
   * not a fabricated summary), and stdout/stderr/genvm_log if present.
   * Best-effort: confirmed live (2026-09-15) that the current GenLayer
   * Studio endpoint doesn't implement `gen_dbg_traceTransaction` at all
   * ("Method not found") — this always returns null there, not just for
   * old/unqueryable transactions as originally assumed. Kept as best-effort
   * rather than removed in case a future runner/endpoint does implement it.
   * A validator's independent agreement is directly observable instead via
   * consensus_data.votes / leader_receipt on the write receipt itself (see
   * assertReceiptSucceeded/getLeaderReturnValue) — callers must treat a
   * null trace as "not available", not as an error condition.
   */
  async getTransactionTrace(txHash: string): Promise<{
    resultCode: number;
    returnData: string;
    stdout: string;
    stderr: string;
    eqOutputs: string[];
    genvmLog: Record<string, unknown>[];
  } | null> {
    try {
      const client = getReadClient();
      const trace = await client.debugTraceTransaction({ hash: txHash as Hash });
      return {
        resultCode: trace.result_code,
        returnData: trace.return_data,
        stdout: trace.stdout,
        stderr: trace.stderr,
        eqOutputs: trace.eq_outputs ?? [],
        genvmLog: trace.genvm_log ?? [],
      };
    } catch (err) {
      logger.warn({ err, txHash }, "Could not read GenVM execution trace for transaction");
      return null;
    }
  },
};

export type GenLayerClientWrapper = typeof genlayerClient;
