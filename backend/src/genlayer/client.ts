/**
 * GenLayer client wrapper, backed by the official genlayer-js SDK.
 *
 * Wraps calls to the deployed Chronix Intelligent Contract
 * (contracts/chronix.py), deployed at CONTRACT_ADDRESS on GenLayer
 * Studio/StudioNet — see MEMORY.md for the deployed address.
 *
 * Trust model (read before adding a call here):
 *   - Money-moving methods (create_market, stake, claim_payout,
 *     claim_timeout_refund, cancel_market) are ALWAYS signed by the end
 *     user's own wallet, in the browser, via the frontend's genlayer-js
 *     client — never here. This backend never holds a key that could move
 *     user funds.
 *   - This wrapper is used for: (a) read-only polling (getMarket, getStake,
 *     getAllEvidence) so the API/DB can stay in sync without a wallet, and
 *     (b) the keeper account (see genlayer/keeper.ts), which ONLY calls the
 *     non-payable, fully-permissionless state-advancing methods
 *     (request_adjudication, settle) once their on-chain preconditions are
 *     already true — it is a convenience automation, not a privileged actor;
 *     any user's wallet could call the exact same methods with the same
 *     effect.
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

/** Keeper client: only constructed if GENLAYER_KEEPER_PRIVATE_KEY is set. See trust model above. */
let keeperClient: GLClient | null = null;

export function getKeeperClient(): GLClient | null {
  if (!env.GENLAYER_KEEPER_PRIVATE_KEY || !env.CONTRACT_ADDRESS) return null;
  if (keeperClient) return keeperClient;
  const account = createAccount(env.GENLAYER_KEEPER_PRIVATE_KEY as `0x${string}`);
  keeperClient = createClient({
    chain: chains.studionet,
    endpoint: env.GENLAYER_RPC_URL,
    account,
  });
  return keeperClient;
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
   * Keeper-only: advances a market past its deadline. Non-payable,
   * permissionless on-chain (the contract itself re-checks now >= resolves_at
   * and reverts if called early — this call is never trusted to be correct,
   * only convenient). No-ops with a warning if no keeper key is configured.
   */
  async requestAdjudication(contractMarketId: number): Promise<{ txHash: string } | null> {
    const client = getKeeperClient();
    if (!client) {
      logger.warn("GENLAYER_KEEPER_PRIVATE_KEY not set; skipping automated request_adjudication");
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
   * Keeper-only: triggers settle() once a market is awaiting_adjudication.
   * Non-payable; the contract's own nondet consensus determines the
   * verdict, this call just initiates it. See trust model at top of file.
   */
  async settle(contractMarketId: number): Promise<{ txHash: string } | null> {
    const client = getKeeperClient();
    if (!client) {
      logger.warn("GENLAYER_KEEPER_PRIVATE_KEY not set; skipping automated settle");
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

  async waitForReceipt(txHash: string) {
    const client = getReadClient();
    return client.waitForTransactionReceipt({
      hash: txHash as Hash,
      retries: 20,
      interval: 3000,
    });
  },
};

export type GenLayerClientWrapper = typeof genlayerClient;
