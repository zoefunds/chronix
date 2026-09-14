# Chronix

Chronix is a decentralized, long-horizon prediction market. Users stake real USDC on YES/NO outcomes of real-world questions; outcomes are adjudicated on-chain by a GenLayer Intelligent Contract that fetches evidence from independent live sources — never from user-submitted claims alone. Money and adjudication are deliberately split across two chains (see [Architecture](#architecture)): GenLayer holds no funds at all, it's pure adjudication + ledger-of-record logic, while every real USDC deposit, stake, and payout is held by `ChronixEscrow.sol` on Base Sepolia. A backend relayer bridges confirmed events between the two chains.

- **Live app**: https://chronix-app.vercel.app
- **Backend API**: https://chronix-markets-api.fly.dev
- **Adjudication chain**: GenLayer Studio, StudioNet (chain id `61999`)
- **Funding chain**: Base Sepolia (chain id `84532`), USDC — escrow contract `contracts/base/ChronixEscrow.sol`

## Table of contents

- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Local development setup](#local-development-setup)
- [Environment variables](#environment-variables)
- [Database](#database)
- [Running tests](#running-tests)
- [Smart contract](#smart-contract)
- [Deployment](#deployment)
- [Trust model / security notes](#trust-model--security-notes)
- [API overview](#api-overview)
- [Troubleshooting](#troubleshooting)

> **USDC/Base Sepolia funding migration (2026-09-14)**: money moved off native GEN entirely.
> GenLayer (`contracts/chronix.py`) is now adjudication + ledger-of-record only — every write on
> it is relayer-gated, and it never escrows a token itself. Real USDC lives in
> `contracts/base/ChronixEscrow.sol` on Base Sepolia. A backend relayer bridges confirmed
> deposits/payouts between the two chains. Full detail: [`v1-milestone.md`](v1-milestone.md).
>
> **Payout-core review (2026-08-11)**: a team review required six fixes to the settlement
> logic before the contract could be credited — validator agreement on the derived verdict,
> excluding failed fetches, closing staking at the deadline, timeout refunds for every eligible
> participant (not just the first), contract tests for those paths, and stronger evidence
> provenance/deduplication. All six are fixed and tested (35 passing contract tests). Full
> before/after detail: [`REVIEW.md`](REVIEW.md).

## How it works

1. **Create a market** — anyone can propose a question with a resolution horizon, resolution criteria, and initial liquidity. The frontend first records the market's terms with the backend (no chain write yet), then the creator's wallet funds it with real USDC directly on Base Sepolia (`ChronixEscrow.fund`).
2. **Stake** — other users stake USDC on YES or NO, the same fund-on-Base-Sepolia way. A backend relayer watches confirmed deposits and mirrors them onto GenLayer's ledger automatically — no GenLayer transaction is ever signed by an end user for funding.
3. **Evidence** — users can point the contract at source URLs during the market's lifetime (this one write, `submit_evidence_pointer`, stays directly wallet-signed on GenLayer since it never moves money), but the contract only trusts what it independently fetches from those sources at settlement time (`gl.nondet.web.*`), never the submitted summary text.
4. **Deadline** — once `resolves_at` passes (enforced both on-chain and by a backend cron as a secondary check), the market becomes eligible for adjudication.
5. **Settle** — `request_adjudication` / `settle` fetch from ≥3 independent source categories (news/academic/financial) and reach a non-strict equivalence-principle consensus among GenVM validators (avoids spurious "undetermined" results from near-identical but non-identical fetches).
6. **Claim** — once GenLayer settles (or a timeout/cancellation refund becomes eligible), the relayer computes the authoritative payout and credits it as claimable on the Base Sepolia escrow. Winners then self-serve `ChronixEscrow.claim()` directly — no GenLayer transaction needed to receive funds.

Every payout path on GenLayer still follows a strict zero-ledger-then-return ordering (the same invariant that used to guard the direct `_send_gen` transfer) to prevent the relayer from ever being tricked into crediting the escrow twice for one stake; `ChronixEscrow.setPayouts` itself is idempotent per market as a second guard.

## Architecture

```
┌─────────────┐      REST       ┌──────────────┐   genlayer-js / viem   ┌────────────────────────┐
│  Frontend    │ ──────────────▶ │  Backend      │ ──(reads + relayer)──▶│  GenLayer Contract       │
│  React+Vite  │ ◀────────────── │  Fastify      │                        │  chronix.py (StudioNet)  │
│  (Vercel)    │                 │  (Fly.io)     │                        │  adjudication + ledger   │
└─────┬───────┘                  └──────┬───────┘                        │  only — moves no money   │
      │                                 │ Postgres (mirror/cache)        └────────────▲─────────────┘
      │  wallet-signed fund()/claim()   │                                             │ relayer mirrors
      ▼                                 ▼                                             │ confirmed deposits/
┌──────────────────────────┐   watches Funded events,                                 │ payouts both ways
│  ChronixEscrow.sol         │◀── pushes setPayouts ─────────────────────────────────┘
│  Base Sepolia — real USDC  │
└──────────────▲─────────────┘
               │ user's own wallet, directly
               └── fund() to stake/fund a market, claim() to receive a payout
```

- **Frontend**: React 19 + Vite + Tailwind, wallet connection via Reown AppKit (WalletConnect v2, MetaMask, Rainbow, Zerion, injected), wired to both chains (`frontend/src/lib/wagmi.ts`). Every money-moving call (`fund`, `claim`) is signed by the end user's own wallet in-browser directly against `ChronixEscrow.sol` on Base Sepolia (`frontend/src/lib/escrow.ts`) — the backend is never in that path. `submit_evidence_pointer` is the one remaining GenLayer write signed directly by the user (`frontend/src/lib/genlayer.ts`), since it never moves money.
- **Backend**: Node.js + Fastify + Postgres. Acts as a read cache / indexer over chain state, handles SIWE-based session auth, and runs background jobs:
  - **Deadline enforcer** (60s cron) — flips a market's status to `awaiting_adjudication` only when wall-clock time *and* an on-chain deadline check both agree.
  - **Chain-write reconciler** — retries `chain_sync_queue` entries (the permissionless keeper actions, `request_adjudication`/`settle`) with backoff; a Postgres row is only marked `confirmed` after a real transaction receipt confirms it.
  - **Chain indexer** — periodically (every `CHAIN_RECONCILER_INTERVAL_MS`, default 15s) re-reads on-chain market state and reconciles Postgres to match chain truth, independent of who triggered the transition. It also **discovers and backfills** markets and evidence pointers that exist on-chain but were never mirrored into Postgres.
  - **Base relay** (`backend/src/jobs/baseRelay.ts`, every `BASE_RELAY_INTERVAL_MS`, default 20s) — the bridge between the two chains: scans `ChronixEscrow` `Funded` events and mirrors confirmed deposits onto GenLayer's `create_market`/`stake`; once GenLayer settles/cancels a market, computes the authoritative payout list and pushes it onto `ChronixEscrow.setPayouts`. All relayer-gated writes on GenLayer (and `setPayouts` on Base) use one backend-held key, `RELAYER_PRIVATE_KEY`.
  - **Relayer/keeper** — one backend-held key does double duty: it's the only account allowed to call GenLayer's relayer-gated writes (`create_market`, `stake`, `claim_payout`, `claim_timeout_refund`, `cancel_market` — all money-free ledger mirrors now), and it also automates the two permissionless "keeper" actions (`request_adjudication`, `settle` — any wallet could call these with identical effect).
- **Contracts**: `contracts/chronix.py` — a single GenLayer Intelligent Contract, Python, deployed manually to GenLayer Studio/StudioNet, adjudication + ledger only. `contracts/base/ChronixEscrow.sol` — Solidity, deployed to Base Sepolia, holds all real USDC. GenVM contracts are immutable — any code change requires a new deployment address.
- **Database**: PostgreSQL — a read mirror/cache of chain state plus app-level metadata (evidence pointers, market questions/categories), never the source of truth for money.

## Repository layout

```
chronix/
├── frontend/          React + Vite + Tailwind SPA
│   ├── src/
│   │   ├── pages/     Landing, Discover, MarketDetail, CreateMarket, Portfolio,
│   │   │              AdjudicationResult, EvidenceLedger, Docs, Settings, NotFound
│   │   ├── components/
│   │   ├── lib/        api client, genlayer-js wrapper, auth/SIWE, format helpers, wagmi config
│   │   └── types/
│   └── package.json
├── backend/           Fastify REST API
│   ├── src/
│   │   ├── routes/     auth, markets, portfolio, health
│   │   ├── db/          repositories, migration runner
│   │   ├── genlayer/    genlayer-js client wrapper (reads + relayer/keeper writes)
│   │   ├── services/    baseSepolia.ts — ChronixEscrow read/write helpers
│   │   ├── jobs/        deadline enforcer, chain reconciler, chain indexer, baseRelay
│   │   ├── schemas/     Zod request/response validation
│   │   └── plugins/     Fastify plugins (auth, cors, rate-limit, etc.)
│   └── package.json
├── contracts/
│   ├── chronix.py       the GenLayer Intelligent Contract — adjudication + ledger only
│   ├── base/            ChronixEscrow.sol + deploy.js — real USDC on Base Sepolia
│   ├── tests/           pytest suite against the pure-logic slice (no genlayer package needed)
│   └── README.md        contract-specific docs (state machine, method reference)
├── database/
│   ├── schema.sql        full schema reference
│   ├── migrations/       001_init.sql … numbered, applied in order
│   └── seeds/
├── scripts/
│   ├── deploy-fly.sh     backend deploy helper
│   └── migrate.sh        run migrations against a target DATABASE_URL
├── docker-compose.yml    local Postgres + backend stack
├── PLANNING.md           locked architecture decisions
├── MEMORY.md             deployment state, gotchas, and history (read before deploying)
├── REVIEW.md             latest team code-review response — what was flagged, what changed
├── v1-milestone.md       what shipped in the v1 milestone (USDC/Base Sepolia funding migration)
└── .env.example          root-level env reference (see also per-package .env.example)
```

## Prerequisites

- Node.js 20+
- npm
- Docker (for local Postgres, or run Postgres yourself)
- A wallet (MetaMask/Rainbow/Zerion/WalletConnect) that can hold Base Sepolia ETH (gas) and
  test USDC for any wallet-signed action (staking, creating markets, claiming) — get Base
  Sepolia ETH from a public faucet, and see [`contracts/base/README.md`](contracts/base/README.md)
  for the USDC token address
- (Deploy only) `flyctl` and `vercel` CLIs, authenticated

## Local development setup

```bash
git clone https://github.com/zoefunds/chronix.git
cd chronix
```

### 1. Start Postgres (and optionally the backend) via Docker

```bash
docker compose up --build
```

This starts Postgres on `localhost:5432` and the backend on `localhost:8080`. If you'd rather run the backend outside Docker (faster iteration, hot reload), just start Postgres:

```bash
docker compose up postgres
```

### 2. Backend (outside Docker)

```bash
cd backend
cp .env.example .env   # fill in values, see Environment variables below
npm install
npm run migrate        # applies database/migrations in order
npm run dev             # tsx watch — http://localhost:8080
```

### 3. Frontend

```bash
cd frontend
cp .env.example .env   # fill in values, see Environment variables below
npm install
npm run dev             # vite — http://localhost:5173
```

Open http://localhost:5173, connect a wallet, and use the app. Any wallet-signed action (staking, creating a market, claiming) requires the connected wallet to hold Base Sepolia ETH (gas) and USDC — the app prompts a network switch to Base Sepolia automatically when needed.

## Environment variables

There's a root-level `.env.example` for reference, plus package-specific ones that are the actual source of truth (`backend/.env.example`, `frontend/.env.example`).

### Backend (`backend/.env`)

| Variable | Purpose |
|---|---|
| `NODE_ENV`, `PORT`, `HOST`, `LOG_LEVEL` | server basics |
| `DATABASE_URL`, `DATABASE_SSL` | Postgres connection |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | session signing (SIWE-issued sessions) |
| `SIWE_DOMAIN`, `SIWE_URI` | Sign-In-With-Ethereum domain binding |
| `CORS_ORIGIN` | comma-separated list of allowed frontend origins |
| `CONTRACT_ADDRESS` | deployed GenLayer Intelligent Contract address (adjudication + ledger only) |
| `GENLAYER_RPC_URL`, `GENLAYER_CHAIN_ID` | GenLayer StudioNet RPC + chain id (`61999`) |
| `RELAYER_PRIVATE_KEY` | gates every write on `chronix.py` AND automates the permissionless keeper actions — see [Trust model](#trust-model--security-notes). Leave blank to disable both |
| `KEEPER_INTERVAL_MS`, `BASE_RELAY_INTERVAL_MS` | keeper / Base relay poll intervals |
| `BASE_SEPOLIA_RPC_URL`, `BASE_SEPOLIA_CHAIN_ID` | Base Sepolia RPC + chain id (`84532`) |
| `BASE_SEPOLIA_USDC_ADDRESS` | USDC token address on Base Sepolia |
| `CHRONIX_ESCROW_ADDRESS` | deployed `ChronixEscrow.sol` address |
| `BASE_SEPOLIA_RELAYER_PRIVATE_KEY` | same key as `RELAYER_PRIVATE_KEY`, signs `setPayouts` on Base Sepolia |
| `BASE_SEPOLIA_ESCROW_DEPLOY_BLOCK` | first block to scan `Funded` events from on a cold start |
| `REDIS_URL`, `REDIS_CACHE_TTL_SECONDS` | optional fail-open read cache, never load-bearing — leave blank to disable |
| `DEADLINE_ENFORCER_INTERVAL_MS`, `CHAIN_RECONCILER_INTERVAL_MS`, `CHAIN_SYNC_MAX_ATTEMPTS`, `CHAIN_SYNC_BASE_BACKOFF_MS` | background job tuning |

### Frontend (`frontend/.env`)

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | backend base URL |
| `VITE_CONTRACT_ADDRESS` | deployed GenLayer Intelligent Contract address (mirrors backend's) |
| `VITE_CHAIN_RPC` | GenLayer StudioNet RPC URL |
| `VITE_BASE_SEPOLIA_CHAIN_ID`, `VITE_BASE_SEPOLIA_RPC` | Base Sepolia chain id (`84532`) + RPC URL |
| `VITE_BASE_SEPOLIA_USDC_ADDRESS` | USDC token address on Base Sepolia |
| `VITE_CHRONIX_ESCROW_ADDRESS` | deployed `ChronixEscrow.sol` address |
| `VITE_WALLETCONNECT_PROJECT_ID` | WalletConnect v2 Cloud project ID (https://cloud.walletconnect.com/) |

**Never commit populated `.env` files.** Only `.env.example` files (with placeholder/non-secret values) belong in git — real `.env` files are gitignored.

## Database

Schema and migrations live in [`database/`](database). `database/schema.sql` is the full reference schema; `database/migrations/*.sql` are the numbered, ordered migrations actually applied to a database.

Core tables:

- `users` — wallet_address (PK), created_at, optional nickname
- `markets` — question, category, horizon, resolution criteria, contract_market_id, status, resolves_at, plus USDC funding/relay bookkeeping (`pool_fund_tx_hash`, `pool_relayed_at`, `payouts_relayed_at`, `cancel_requested_at`)
- `positions` — per-wallet stake per market (side, shares [USDC base units], avg_price, `fund_tx_hash`, `relayed_at`)
- `market_events` — append-only event log (created / deadline_passed / evidence_submitted / verdict_pending / verdict_settled / payout_claimed / reconciled), each with a `confirmed` flag tied to an actual chain receipt
- `evidence` — submitted evidence pointers (URL + summary), used only as leads — the contract re-fetches independently at settlement
- `chain_sync_queue` — retry queue so a failed permissionless keeper action (`request_adjudication`/`settle`) is retried with backoff instead of silently dropped
- `base_relay_watermark` — single-row table tracking the last Base Sepolia block the relay job has fully scanned for `ChronixEscrow` `Funded` events, so a restart doesn't rescan from the contract's deployment block every time

`markets.contract_market_id` and `evidence.(market_id, url)` both carry unique indexes (migrations `005`, `006`) — required so the chain indexer's discovery/backfill pass (see [Architecture](#architecture)) can safely run concurrently across both backend machines without inserting duplicate rows. `markets.allowed_evidence_types` (migration `007`) mirrors the contract's own field so the evidence-submission UI can filter to only the source types the contract will actually accept. Migrations `008`/`009` added the USDC funding-relay and cancellation-request bookkeeping above.

Run migrations:

```bash
cd backend
npm run migrate
```

or, against an arbitrary target:

```bash
DATABASE_URL=postgres://... ./scripts/migrate.sh
```

## Running tests

```bash
# Backend
cd backend && npm run test

# Frontend
cd frontend && npm run test

# Type-check only
cd backend && npm run lint    # tsc --noEmit
cd frontend && npx tsc --noEmit

# Contract (pure logic only — no genlayer package or GenVM needed)
cd contracts && python3 -m pytest tests/ -v
```

Contract logic (`contracts/chronix.py`) is split into pure Python helpers (state machine, payout math, key-building, verdict derivation, escrow math) above `# END PURE LOGIC`, and a thin `Chronix(gl.Contract)` adapter class below it — GenVM itself cannot run inside pytest, so `contracts/tests/` targets the pure helpers directly (via `_pure.py`, which execs just that slice of the real file rather than a hand-copied duplicate). Covers settlement (verdict agreement, failed-fetch exclusion) and escrow (staking-deadline cutoff, timeout-refund eligibility for every claimant, payout math, provenance/dedup). See [`contracts/README.md`](contracts/README.md).

## Smart contracts

Two contracts, two chains — see [Architecture](#architecture) for why.

### `contracts/chronix.py` — GenLayer Studio/StudioNet, adjudication + ledger only

Moves no money. Every write is gated by a single `relayer_address` (constructor arg) — the
backend relayer mirrors confirmed Base Sepolia USDC activity onto it, and mirrors its
settlement outcomes back onto the escrow. The one exception is `submit_evidence_pointer`,
which stays directly wallet-signed since it never touches money.

**State machine:**

```
created -> active (accepting stakes)
active -> awaiting_adjudication      (request_adjudication, deadline-gated on-chain)
active -> cancelled                  (cancel_market, relayer-gated, pre-participation only)
awaiting_adjudication -> settled_yes | settled_no | settled_split   (settle)
awaiting_adjudication -> refunded_timeout                            (claim_timeout_refund, after grace window)
```

**Key methods:** `create_market` (relayer-only), `stake` (relayer-only), `submit_evidence_pointer` (any wallet), `request_adjudication`, `settle` (nondet web-fetch consensus), `claim_payout` (relayer-only), `claim_timeout_refund` (relayer-only), `cancel_market` (relayer-only). Full method reference: [`contracts/README.md`](contracts/README.md).

### `contracts/base/ChronixEscrow.sol` — Base Sepolia, real USDC custody

Holds every initial-liquidity deposit and YES/NO stake. `fund()` and `claim()`/`claimMany()`
are open to any wallet, self-serve; `setPayouts()` is relayer-only and idempotent per market.
Full reference: [`contracts/base/README.md`](contracts/base/README.md).

**Deployment**: GenLayer contract deploys are manual, always by the project owner (this repo
never deploys it) — GenVM contracts are immutable, so every fix needs a fresh address, never a
patch; it must be deployed with `relayer_address` set to the same wallet as the escrow's
`relayer_` constructor arg. `ChronixEscrow.sol` can be redeployed via `contracts/base/deploy.js`.
After either address changes: update `CONTRACT_ADDRESS`/`CHRONIX_ESCROW_ADDRESS` (and their
`VITE_` frontend equivalents) everywhere (`.env.example`, `backend/.env`, `frontend/.env`, the
`chronix-markets-api` Fly secrets, the Vercel production env vars — Vercel env vars must be
removed and re-added, there's no update-in-place via the CLI), redeploy both backend and
frontend, and **clear any Postgres rows tied to the old GenLayer address** (`DELETE FROM
markets`, which cascades to `positions`/`evidence`/`market_events`/`chain_sync_queue`) — their
`contract_market_id`s point at markets on the now-abandoned contract. Full deployment history
and gotchas are logged in [`MEMORY.md`](MEMORY.md) and [`v1-milestone.md`](v1-milestone.md); the
most recent contract-logic changes and why are in [`REVIEW.md`](REVIEW.md).

## Deployment

Current production deployment:

- **Frontend** — Vercel project `chronix`, serving `https://chronix-app.vercel.app`.
- **Backend** — Fly.io app `chronix-markets-api` (on the currently-connected Fly.io account — the
  earlier `chronix-backend` app was on a different account the project lost access to), 2
  machines in `iad`, `/health` check, auto-restart.
- **Database** — Fly Postgres app `chronix-markets-db`, attached to `chronix-markets-api`.
- **Funding** — `ChronixEscrow.sol` on Base Sepolia, currently at
  `0xeCA7236a62bf3c17e31B168692CA1871eCee91eB`.

### Frontend deploy

```bash
cd frontend
vercel --prod --yes
```

`vercel --prod` does not automatically move the `chronix-app.vercel.app` alias to the new build in all cases — verify the alias points at the new deployment and, if not, run:

```bash
vercel alias set <new-deployment-url> chronix-app.vercel.app
```

### Backend deploy

Run from the **repo root** (build context must be root so the Dockerfile can `COPY database ./database`):

```bash
fly deploy . --config backend/fly.toml --app chronix-markets-api
```

Or use the helper script:

```bash
./scripts/deploy-fly.sh
```

Run migrations against production after any deploy that adds one:

```bash
fly ssh console -a chronix-markets-api -C "node dist/db/migrate.js"
```

Set/update secrets:

```bash
fly secrets set CONTRACT_ADDRESS=0x... -a chronix-markets-api
```

For full deployment history, past incidents, and hard-won gotchas (Dockerfile build-context resolution, Vercel SSO protection, migration path differences between `tsx` and compiled `dist/`, etc.), see [`MEMORY.md`](MEMORY.md) — read it before making deployment changes.

## Trust model / security notes

- **The backend never holds a key that can move a user's own funds without their say-so.** Every USDC-moving call (`fund`, `claim`, `claimMany`) is signed directly by the end user's own wallet against `ChronixEscrow.sol` on Base Sepolia (`frontend/src/lib/escrow.ts`) — the backend is never in that path. The one GenLayer write still directly wallet-signed, `submit_evidence_pointer`, never moves money either.
- **The relayer key** (`RELAYER_PRIVATE_KEY` / `BASE_SEPOLIA_RELAYER_PRIVATE_KEY` — intentionally the same key on both chains) is the only account allowed to write to `chronix.py` and to call `ChronixEscrow.setPayouts`. It can only ever *mirror* facts already confirmed on-chain (a deposit the escrow already received, a payout amount GenLayer's own settlement math already computed) — it cannot fabricate a deposit or credit an amount GenLayer didn't compute, and it never custodies funds itself (the escrow, not the relayer, holds USDC; `claim`/`claimMany` are self-serve). It also automates the two permissionless "keeper" actions (`request_adjudication`, `settle`) — any wallet could call those with identical effect.
- **Deadlines are enforced on-chain**, not just in a backend cron — `request_adjudication` checks `now >= resolves_at` itself inside the contract, so a compromised or drifting backend clock can't force early settlement. `stake()` independently re-checks the same deadline (not just `market.status`), so staking actually closes the instant `resolves_at` passes.
- **Adjudication never trusts user-submitted text**, and every eligible participant can always exit. `submit_evidence_pointer` only stores a URL (validated against the market's own configured `allowed_evidence_types`, and deduplicated); `settle` independently re-fetches from ≥3 real source categories, excludes any source that fails to fetch from the agreement tally entirely, and requires validators to independently derive the SAME verdict (via `pure_decide_verdict`) from their own fetch — GenVM's nondeterministic-block equivalence principle applied to the value that actually gets persisted and paid out against. `claim_timeout_refund` is available to every staker who hasn't yet claimed once the grace window elapses, not just the first caller.
- **Payout ordering** is strictly read-ledger → zero-ledger → persist → return, on both `chronix.py` (returns the authoritative amount, moves nothing) and `ChronixEscrow.setPayouts` (credits `claimable`, idempotent per market via its own `payoutsSet` gate) — together these prevent the relayer from ever crediting the same stake twice, even across a crash-and-retry.
- **A Postgres row is only marked `confirmed`** after a real on-chain transaction receipt confirms it — the DB is a read cache, never a source of truth for money.
- **The frontend never resubmits a wallet-signed write to paper over a mirror failure.** If a fund/claim tx confirms on Base Sepolia but the follow-up relay to GenLayer is still pending, the UI shows the market/position as pending rather than prompting a second on-chain submission. The relay job and chain indexer are the real safety net: they independently discover and mirror anything confirmed on-chain that Postgres or GenLayer is missing.
- **Market cancellation is creator-requested, not creator-executed.** Since `cancel_market` is relayer-gated now, a creator's wallet can no longer call it directly — `POST /markets/:id/cancel-request` records the request (verified server-side against `created_by`) and the relay job drives the actual on-chain cancellation + refund.

## API overview

Base URL: `http://localhost:8080` (dev) or `https://chronix-markets-api.fly.dev` (prod).

| Route | Method | Description |
|---|---|---|
| `/health` | GET | liveness/readiness check |
| `/auth/nonce` | POST | issue a SIWE nonce |
| `/auth/verify` | POST | verify a signed SIWE message, issue a session |
| `/markets` | GET | list markets |
| `/markets` | POST | create a `pending_chain` market row BEFORE any chain write — returns an id the frontend derives an escrow bytes32 key from to fund on Base Sepolia (`allowedEvidenceSources` becomes the contract's `allowed_evidence_types` once relayed) |
| `/markets/:id` | GET | market detail |
| `/markets/:id/escrow` | GET | `ChronixEscrow` address, USDC address, this market's bytes32 key, and `fund()` kind constants — everything the frontend needs to build a funding tx |
| `/markets/:id/claimable/:wallet` | GET | USDC claimable directly from `ChronixEscrow.claim()` for a wallet on this market |
| `/markets/:id/cancel-request` | POST | creator-only, pre-participation-only — records (or immediately executes, if still `pending_chain`) a cancellation request; the relay job drives the rest |
| `/markets/:id/positions` | POST | create a pending position row BEFORE the user funds `ChronixEscrow` with a YES/NO stake |
| `/markets/:id/evidence` | GET/POST | evidence pointers for a market — `GET` paginated (`limit`, default 50/max 200; `offset`); `POST` still requires an already-confirmed `submit_evidence_pointer` tx hash, since that write stays directly wallet-signed |
| `/markets/:id/events` | GET | market event timeline (from `market_events`) |
| `/markets/:id/trace` | GET | GenVM execution trace for a market's `settle()` tx, when available |
| `/evidence` | GET | global evidence feed across all markets, paginated (`sourceType`, `limit`, `offset`) |
| `/sync` | POST | on-demand chain resync — runs the chain indexer's reconcile + discover/backfill pass immediately instead of waiting for the next interval tick. Rate-limited (2/min per machine) since it costs GenLayer RPC calls; safe to expose as a user-facing "Resync from chain" button (see Discover / MarketDetail pages) |
| `/portfolio/:wallet` | GET | a wallet's positions, joined with market status |

Market/position creation and cancellation are the backend recording *intent* before a chain write, not proof after one — the backend relay job (`jobs/baseRelay.ts`) is what actually mirrors confirmed Base Sepolia activity onto GenLayer and back. The backend itself never originates a USDC-moving write.

## Troubleshooting

- **Blank/crashed page** — check the browser console first; there is currently no top-level error boundary, so an uncaught render error in one page can blank the whole app.
- **"GenLayer not configured" / relay-related errors** — `CONTRACT_ADDRESS` / `VITE_CONTRACT_ADDRESS` is unset or empty; GenLayer reads no-op with a clear error until it's set. Funding/claiming (`fund`/`claim`) doesn't depend on this at all — it only needs `CHRONIX_ESCROW_ADDRESS` / `VITE_CHRONIX_ESCROW_ADDRESS`.
- **Wallet won't connect / wrong network** — funding/claiming needs Base Sepolia (chain id `84532`); the app prompts a network switch automatically, but some wallets need Base Sepolia added manually first. Make sure `VITE_WALLETCONNECT_PROJECT_ID` is set for the WalletConnect modal.
- **Migrations fail locally** — confirm Postgres is up (`docker compose up postgres`) and `DATABASE_URL` in `backend/.env` matches the compose service (`postgres://chronix:chronix@localhost:5432/chronix` when running via Docker).
- **Markets aren't settling / cancelling automatically** — `RELAYER_PRIVATE_KEY` is unset (permissionless `request_adjudication`/`settle` still work if any wallet calls them manually, but relayer-gated `create_market`/`stake`/`claim_*`/`cancel_market` do not — those literally cannot be called any other way), or the relayer wallet is out of GEN gas on GenLayer or ETH gas on Base Sepolia.
- **A funded market/stake isn't showing up on GenLayer yet** — check the Base Sepolia tx confirmed first (BaseScan); if it did, the relay job (`jobs/baseRelay.ts`, runs every `BASE_RELAY_INTERVAL_MS`) may not have scanned that block range yet, or `CHRONIX_ESCROW_ADDRESS`/`RELAYER_PRIVATE_KEY` isn't configured on the backend. Press "Resync from chain" to trigger the GenLayer-side reconcile pass immediately; the Base relay itself runs on its own interval, not via `/sync`.
- **401 `"Missing or invalid session token"` on a write** — session JWTs expire after `JWT_EXPIRES_IN` (24h default); any 401 now clears the stale session (`clearSession()` in `frontend/src/lib/auth.tsx`, which drops the token without disconnecting the wallet) and prompts a re-sign-in.
- **Deploy issues** — see [`MEMORY.md`](MEMORY.md) for a running log of past deployment incidents and fixes, and [`v1-milestone.md`](v1-milestone.md) for the USDC/Base Sepolia migration specifically.
