import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyJwt from "@fastify/jwt";
import { SiweMessage, generateNonce } from "siwe";
import { env } from "../config.js";
import { upsertUser } from "../db/repositories.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    walletAddress?: string;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { wallet: string };
    user: { wallet: string };
  }
}

// In-memory nonce store. Nonces are short-lived and single-use; a Postgres-backed
// store isn't necessary here since losing a nonce on restart only forces the
// wallet to request a fresh one (no persistent state is lost).
const nonces = new Map<string, { nonce: string; expiresAt: number }>();
const NONCE_TTL_MS = 5 * 60 * 1000;

function pruneExpiredNonces() {
  const now = Date.now();
  for (const [wallet, entry] of nonces.entries()) {
    if (entry.expiresAt < now) nonces.delete(wallet);
  }
}

export const authPlugin = fp(async (fastify: FastifyInstance) => {
  await fastify.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN },
  });

  fastify.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      request.walletAddress = (request.user as { wallet: string }).wallet;
    } catch {
      reply.code(401).send({ error: "unauthorized", message: "Missing or invalid session token" });
    }
  });

  fastify.decorate("issueNonce", (wallet: string): string => {
    pruneExpiredNonces();
    const nonce = generateNonce();
    nonces.set(wallet.toLowerCase(), { nonce, expiresAt: Date.now() + NONCE_TTL_MS });
    return nonce;
  });

  fastify.decorate(
    "verifySiwe",
    async (params: { message: string; signature: string }): Promise<{ wallet: string }> => {
      const siweMessage = new SiweMessage(params.message);
      const wallet = siweMessage.address.toLowerCase();

      const stored = nonces.get(wallet);
      if (!stored || stored.expiresAt < Date.now()) {
        throw new Error("Nonce missing or expired — request a new nonce and try again");
      }
      if (siweMessage.nonce !== stored.nonce) {
        throw new Error("Nonce mismatch");
      }

      const result = await siweMessage.verify({
        signature: params.signature,
        domain: env.SIWE_DOMAIN,
        nonce: stored.nonce,
      });

      if (!result.success) {
        throw new Error(`SIWE verification failed: ${result.error?.type ?? "unknown error"}`);
      }

      // Nonce is single-use.
      nonces.delete(wallet);

      await upsertUser(wallet);
      return { wallet };
    }
  );
});

declare module "fastify" {
  interface FastifyInstance {
    issueNonce: (wallet: string) => string;
    verifySiwe: (params: { message: string; signature: string }) => Promise<{ wallet: string }>;
  }
}
