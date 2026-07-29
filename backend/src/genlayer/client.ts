/**
 * GenLayer client wrapper.
 *
 * Wraps calls to the deployed EchoMarkets Intelligent Contract (contracts/echo_markets.py)
 * over its StudioNet RPC. This module is the ONLY place in the backend that should
 * talk to the chain directly — everything else (routes, jobs) goes through here.
 *
 * IMPORTANT / TODO(contract-wiring):
 *   - CONTRACT_ADDRESS is read from env and may be empty until the user deploys the
 *     contract manually (per PLANNING.md). All methods below throw a clear
 *     GenLayerNotConfiguredError until it is set.
 *   - The exact JSON-RPC method names, param encoding, and receipt polling scheme
 *     for GenLayer StudioNet are best-effort here, mirrored from the documented
 *     public methods in PLANNING.md (create_market, stake, submit_evidence_pointer,
 *     request_adjudication, settle, claim_payout, claim_timeout_refund, cancel_market).
 *     Once contracts/echo_markets.py is finalized and deployed, replace the
 *     `callContractMethod` / `readContractMethod` internals with the real
 *     genlayer-js (or genlayer-py-bridge) client calls and confirm:
 *       * exact method/function selector names on the deployed contract
 *       * payable value units (GEN, base units)
 *       * receipt/tx status field names returned by the StudioNet RPC
 *       * the "on-chain deadline check" read method name (assumed `get_market_state`
 *         returning a `resolves_at_passed: bool` field below — CONFIRM against
 *         actual contract source).
 */
import { env } from "../config.js";
import { logger } from "../lib/logger.js";

export class GenLayerNotConfiguredError extends Error {
  constructor() {
    super("CONTRACT_ADDRESS is not set — GenLayer client wrapper is not configured yet.");
    this.name = "GenLayerNotConfiguredError";
  }
}

export interface TxReceipt {
  txHash: string;
  status: "pending" | "success" | "failed";
  blockNumber?: number;
  raw?: unknown;
}

export interface MarketChainState {
  contractMarketId: string;
  resolvesAtPassed: boolean;
  status: string;
  raw?: unknown;
}

interface RpcCallOptions {
  method: string;
  params: Record<string, unknown>;
  /** payable value in GEN base units, as a decimal string, if this call transfers value */
  value?: string;
}

/**
 * Low-level JSON-RPC call against GenLayer StudioNet.
 * TODO(contract-wiring): replace with genlayer-js SDK call once available/finalized.
 */
async function rpcCall(opts: RpcCallOptions): Promise<unknown> {
  if (!env.CONTRACT_ADDRESS) {
    throw new GenLayerNotConfiguredError();
  }

  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "gen_call", // TODO(contract-wiring): confirm actual StudioNet method name
    params: [
      {
        contract_address: env.CONTRACT_ADDRESS,
        method: opts.method,
        args: opts.params,
        value: opts.value ?? "0",
      },
    ],
  };

  const res = await fetch(env.GENLAYER_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`GenLayer RPC call failed: HTTP ${res.status}`);
  }

  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) {
    throw new Error(`GenLayer RPC error: ${json.error.message}`);
  }
  return json.result;
}

/** Poll a transaction hash until it reaches a terminal state or times out. */
export async function pollReceipt(
  txHash: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<TxReceipt> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = (await rpcCall({
      method: "__internal_get_receipt", // TODO(contract-wiring): confirm real receipt RPC method
      params: { tx_hash: txHash },
    })) as { status?: string; block_number?: number } | null;

    if (result?.status === "success" || result?.status === "failed") {
      return {
        txHash,
        status: result.status,
        blockNumber: result.block_number,
        raw: result,
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  logger.warn({ txHash }, "GenLayer receipt poll timed out; leaving as pending");
  return { txHash, status: "pending" };
}

export const genlayerClient = {
  isConfigured(): boolean {
    return Boolean(env.CONTRACT_ADDRESS);
  },

  async createMarket(params: {
    question: string;
    category: string;
    horizonYears: number;
    resolutionCriteria: string;
    resolvesAt: string;
    initialLiquidityGen: string;
  }): Promise<{ txHash: string }> {
    const result = (await rpcCall({
      method: "create_market",
      params: {
        question: params.question,
        category: params.category,
        horizon_years: params.horizonYears,
        resolution_criteria: params.resolutionCriteria,
        resolves_at: params.resolvesAt,
      },
      value: params.initialLiquidityGen,
    })) as { tx_hash: string };
    return { txHash: result.tx_hash };
  },

  async stake(params: {
    contractMarketId: string;
    side: "yes" | "no";
    amountGen: string;
    wallet: string;
  }): Promise<{ txHash: string }> {
    const result = (await rpcCall({
      method: "stake",
      params: { market_id: params.contractMarketId, side: params.side, wallet: params.wallet },
      value: params.amountGen,
    })) as { tx_hash: string };
    return { txHash: result.tx_hash };
  },

  async submitEvidencePointer(params: {
    contractMarketId: string;
    url: string;
    sourceType: string;
    wallet: string;
  }): Promise<{ txHash: string }> {
    const result = (await rpcCall({
      method: "submit_evidence_pointer",
      params: {
        market_id: params.contractMarketId,
        url: params.url,
        source_type: params.sourceType,
        wallet: params.wallet,
      },
    })) as { tx_hash: string };
    return { txHash: result.tx_hash };
  },

  async requestAdjudication(params: { contractMarketId: string }): Promise<{ txHash: string }> {
    const result = (await rpcCall({
      method: "request_adjudication",
      params: { market_id: params.contractMarketId },
    })) as { tx_hash: string };
    return { txHash: result.tx_hash };
  },

  async settle(params: { contractMarketId: string }): Promise<{ txHash: string }> {
    const result = (await rpcCall({
      method: "settle",
      params: { market_id: params.contractMarketId },
    })) as { tx_hash: string };
    return { txHash: result.tx_hash };
  },

  async claimPayout(params: { contractMarketId: string; wallet: string }): Promise<{ txHash: string }> {
    const result = (await rpcCall({
      method: "claim_payout",
      params: { market_id: params.contractMarketId, wallet: params.wallet },
    })) as { tx_hash: string };
    return { txHash: result.tx_hash };
  },

  async claimTimeoutRefund(params: {
    contractMarketId: string;
    wallet: string;
  }): Promise<{ txHash: string }> {
    const result = (await rpcCall({
      method: "claim_timeout_refund",
      params: { market_id: params.contractMarketId, wallet: params.wallet },
    })) as { tx_hash: string };
    return { txHash: result.tx_hash };
  },

  async cancelMarket(params: { contractMarketId: string }): Promise<{ txHash: string }> {
    const result = (await rpcCall({
      method: "cancel_market",
      params: { market_id: params.contractMarketId },
    })) as { tx_hash: string };
    return { txHash: result.tx_hash };
  },

  /**
   * Read-only on-chain deadline check. Used by the deadline enforcer job so it never
   * trusts wall-clock alone — the contract is the source of truth for whether
   * resolves_at has actually passed from its own perspective.
   *
   * TODO(contract-wiring): contracts/echo_markets.py exposes `get_market(market_id) -> dict`
   * (line ~1048), not a dedicated `get_market_state`/`resolves_at_passed` read method.
   * Once the ABI/dict shape is finalized, call `get_market` here and derive
   * `resolvesAtPassed` client-side via the contract's own `pure_is_deadline_passed`
   * semantics (now_ts vs resolves_at from the returned dict) rather than trusting a
   * field that may not exist. Left as `get_market_state` for now so this wrapper has
   * a stable call site to swap in one place.
   */
  async getMarketChainState(contractMarketId: string): Promise<MarketChainState> {
    const result = (await rpcCall({
      method: "get_market_state", // TODO(contract-wiring): swap to "get_market" per echo_markets.py
      params: { market_id: contractMarketId },
    })) as { resolves_at_passed?: boolean; status?: string };

    return {
      contractMarketId,
      resolvesAtPassed: Boolean(result?.resolves_at_passed),
      status: result?.status ?? "unknown",
      raw: result,
    };
  },

  pollReceipt,
};

export type GenLayerClient = typeof genlayerClient;
