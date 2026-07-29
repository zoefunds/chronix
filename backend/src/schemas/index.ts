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

// The user's own wallet has already called create_market directly on
// GenLayer (payable, signed client-side) by the time this hits the backend
// — this endpoint only records what already happened on-chain, it never
// submits the write itself. contractMarketId + txHash are required as proof
// of that, not optional metadata.
export const createMarketSchema = z.object({
  question: z.string().min(10).max(500),
  category: z.string().min(2).max(64),
  horizonYears: z.number().positive().max(200),
  resolutionCriteria: z.string().min(10).max(2000),
  resolvesAt: z.string().datetime(),
  contractMarketId: z.string().regex(/^\d+$/, "Must be the numeric id returned by create_market"),
  txHash: z.string().min(1),
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
