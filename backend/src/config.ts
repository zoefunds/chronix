import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_SSL: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  JWT_EXPIRES_IN: z.string().default("24h"),
  SIWE_DOMAIN: z.string().default("localhost"),
  SIWE_URI: z.string().default("http://localhost:5173"),

  CORS_ORIGIN: z.string().default("http://localhost:5173"),

  CONTRACT_ADDRESS: z.string().default(""),
  GENLAYER_RPC_URL: z.string().default("https://studio.genlayer.com/api"),
  GENLAYER_CHAIN_ID: z.coerce.number().int().default(61999),
  // Backend-held relayer account. Funding moved from native GEN to real USDC
  // on Base Sepolia (see contracts/chronix.py + contracts/base/ChronixEscrow.sol),
  // so this key now does double duty: (a) the same non-payable "keeper" state
  // advances as before (request_adjudication, settle — permissionless, any
  // wallet could call these with the same effect), and (b) every
  // relayer-gated write on GenLayer (create_market, stake, claim_payout,
  // claim_timeout_refund, cancel_market) that mirrors a USDC event already
  // confirmed on Base Sepolia — see genlayer/client.ts's trust-model
  // docstring. It must be the SAME address configured as chronix.py's
  // `relayer_address` constructor arg AND ChronixEscrow.sol's `relayer_`
  // constructor arg. Leave unset to disable the relayer job entirely.
  RELAYER_PRIVATE_KEY: z.string().optional(),
  KEEPER_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  BASE_RELAY_INTERVAL_MS: z.coerce.number().int().positive().default(20000),

  // --- Base Sepolia (USDC funding layer — contracts/base/ChronixEscrow.sol) ---
  BASE_SEPOLIA_RPC_URL: z.string().default("https://sepolia.base.org"),
  BASE_SEPOLIA_CHAIN_ID: z.coerce.number().int().default(84532),
  BASE_SEPOLIA_USDC_ADDRESS: z.string().default("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  CHRONIX_ESCROW_ADDRESS: z.string().default(""),
  // Same key as RELAYER_PRIVATE_KEY above — kept as a distinct env var since
  // it signs transactions on a different chain, but intentionally set to
  // the identical value so both chains trust the one backend-held key.
  BASE_SEPOLIA_RELAYER_PRIVATE_KEY: z.string().optional(),
  // First block to start scanning ChronixEscrow Funded events from if
  // base_relay_watermark is still at its default 0 (i.e. right after the
  // contract's own deployment block) — avoids an expensive full-chain scan.
  BASE_SEPOLIA_ESCROW_DEPLOY_BLOCK: z.coerce.number().int().nonnegative().default(0),

  // Optional. Best-effort read cache only (see src/lib/cache.ts) — never a
  // dependency for correctness. Leave unset to disable caching entirely.
  REDIS_URL: z.string().optional(),
  REDIS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(15),

  DEADLINE_ENFORCER_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  // Drives BOTH the chain-write reconciler (chainReconciler.ts) AND the chain
  // indexer's reconcile/discover/backfill pass (chainIndexer.ts) — each tick
  // of the latter costs at least one gen_call (get_market_count()) even when
  // idle. GenLayer Studio's shared public RPC caps at 5000 gen_call/day; at
  // the old 15s default, 2 Fly machines alone cost 2 * (86400/15) = 11,520
  // calls/day just from idle indexer ticks — over budget before any real
  // market activity, which silently stalls the base relay job (it depends on
  // the same GenLayer RPC for create_market/stake/settle) with no user-visible
  // error. Raised to 180s: 2 * (86400/180) = 960 idle calls/day, leaving
  // headroom for real reconcile/backfill/relay traffic. See MEMORY.md.
  CHAIN_RECONCILER_INTERVAL_MS: z.coerce.number().int().positive().default(180000),
  CHAIN_SYNC_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  CHAIN_SYNC_BASE_BACKOFF_MS: z.coerce.number().int().positive().default(2000),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }
  return parsed.data;
}

export const env = loadEnv();

export const corsOrigins = env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);
