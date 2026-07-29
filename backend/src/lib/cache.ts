import { Redis } from "ioredis";
import { env } from "../config.js";

/**
 * Optional, fail-open read cache. Redis is NOT load-bearing anywhere in this
 * backend — the deadline enforcer and chain reconciler are Postgres-backed
 * queues (see src/jobs/), so losing Redis never blocks a payout, a chain
 * write, or a market transition. This module exists solely to cut down
 * request volume against a free-tier Upstash instance for hot read endpoints
 * (market list/detail), not as a source of truth.
 *
 * Deliberately minimal command footprint: one GET on a hit, one GET + one
 * SETEX on a miss. No pub/sub, no SCAN, no persistent subscriptions. If
 * REDIS_URL is unset, or any Redis call errors for any reason, callers
 * silently fall through to computing the value directly — an Upstash outage
 * degrades this to "no caching", never to a 500.
 */

let client: Redis | null = null;
let initAttempted = false;

function getClient(): Redis | null {
  if (!env.REDIS_URL) return null;
  if (client) return client;
  if (initAttempted) return null;
  initAttempted = true;

  client = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null, // never auto-reconnect-loop against the free tier
    enableOfflineQueue: false,
  });
  client.on("error", () => {
    // Swallow — this cache is best-effort. Logging every transient Upstash
    // blip would itself be noisy; repositories/routes never see these.
  });
  return client;
}

export async function cacheGetOrSet<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>
): Promise<T> {
  const redis = getClient();
  if (!redis) return compute();

  try {
    if (redis.status === "wait") await redis.connect();
    const cached = await redis.get(key);
    if (cached !== null) return JSON.parse(cached) as T;
  } catch {
    return compute();
  }

  const value = await compute();

  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    // Best-effort write; a failed SETEX just means the next request
    // recomputes too. Never let a cache-write failure surface to the caller.
  }

  return value;
}

export async function cacheInvalidate(key: string): Promise<void> {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.del(key);
  } catch {
    // best-effort
  }
}
