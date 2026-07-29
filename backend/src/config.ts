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

  // Optional. Best-effort read cache only (see src/lib/cache.ts) — never a
  // dependency for correctness. Leave unset to disable caching entirely.
  REDIS_URL: z.string().optional(),
  REDIS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(15),

  DEADLINE_ENFORCER_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  CHAIN_RECONCILER_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
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
