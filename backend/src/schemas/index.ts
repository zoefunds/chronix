import { z } from "zod";

export const walletAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid EVM address")
  .transform((v) => v.toLowerCase());

export const nonceRequestSchema = z.object({
  wallet: walletAddressSchema,
});

export const siweVerifySchema = z.object({
  message: z.string().min(1),
  signature: z.string().min(1),
});

export const marketsQuerySchema = z.object({
  horizon: z.coerce.number().positive().optional(),
  horizonMin: z.coerce.number().nonnegative().optional(),
  horizonMax: z.coerce.number().positive().optional(),
  category: z.string().optional(),
  status: z
    .enum(["pending_chain", "open", "awaiting_adjudication", "settled", "cancelled", "failed"])
    .optional(),
  limit: z.coerce.number().int().positive().max(100).default(25),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export const marketIdParamSchema = z.object({
  id: z.string().uuid(),
});

// Funding moved to real USDC on Base Sepolia (ChronixEscrow.sol) — this
// endpoint creates the 'pending_chain' row BEFORE any chain write, so the
// frontend has a market id to derive the escrow's bytes32 key from and fund
// against. No contractMarketId/txHash yet; the relay job assigns those once
// it observes and mirrors the confirmed ChronixEscrow.fund deposit.
export const createMarketSchema = z.object({
  question: z.string().min(10).max(500),
  category: z.string().min(2).max(64),
  horizonYears: z.number().positive().max(200),
  resolutionCriteria: z.string().min(10).max(2000),
  resolvesAt: z.string().datetime(),
  // Same comma-separated categories that will be sent on-chain to
  // create_market once funded — mirrored here so the frontend can filter
  // the evidence-submission dropdown to what the contract will accept.
  allowedEvidenceSources: z.array(z.string().min(1)).optional(),
});

// Same pattern: submit_evidence_pointer was already signed and sent by the
// user's own wallet; this just mirrors it into Postgres for fast reads.
export const submitEvidenceSchema = z.object({
  sourceType: z.string().min(2).max(64),
  url: z.string().url(),
  summary: z.string().max(2000).optional(),
  txHash: z.string().min(1),
});

export const walletParamSchema = z.object({
  wallet: walletAddressSchema,
});

// Same pending-first pattern as createMarketSchema: this creates the
// position row BEFORE the user funds ChronixEscrow.fund(marketId,
// KIND_YES|KIND_NO, amount) on Base Sepolia. `shares` is the intended USDC
// stake amount (base units, 6 decimals) — the relay job mirrors the
// confirmed deposit onto GenLayer's `stake` once it sees the matching
// Funded event.
export const recordStakeSchema = z.object({
  side: z.enum(["yes", "no"]),
  shares: z.string().regex(/^\d+$/, "Must be a whole-number USDC base-unit amount"),
  avgPrice: z.string().regex(/^\d+(\.\d+)?$/).default("1"),
});
