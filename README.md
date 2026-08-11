# Chronix

Chronix is a decentralized, long-horizon prediction market. Users stake real GEN (the GenLayer gas token) on YES/NO outcomes of real-world questions, and outcomes are adjudicated on-chain by a GenLayer Intelligent Contract that fetches evidence from independent live sources — never from user-submitted claims alone.

- **Live app**: https://chronix-app.vercel.app
- **Backend API**: https://chronix-backend.fly.dev
- **Chain**: GenLayer Studio, StudioNet (chain id `61999`), gas token GEN

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

> **Payout-core review (2026-08-11)**: a team review required six fixes to the settlement/escrow
> logic before the contract could be credited — validator agreement on the derived verdict,
> excluding failed fetches, closing staking at the deadline, timeout refunds for every eligible
> participant (not just the first), contract tests for those paths, and stronger evidence
> provenance/deduplication. All six are fixed, tested (35 passing contract tests), and live on a
> new contract deployment. Full before/after detail: [`REVIEW.md`](REVIEW.md).

## How it works

1. **Create a market** — anyone can propose a question with a resolution horizon, resolution criteria, and initial liquidity (real GEN, sent with the transaction).
2. **Stake** — other users stake GEN on YES or NO. Wallets sign every money-moving transaction directly; the backend never holds a key that can move user funds.
3. **Evidence** — users can point the contract at source URLs during the market's lifetime, but the contract only trusts what it independently fetches from those sources at settlement time (`gl.nondet.web.*`), never the submitted summary text.
4. **Deadline** — once `resolves_at` passes (enforced both on-chain and by a backend cron as a secondary check), the market becomes eligible for adjudication.
5. **Settle** — `request_adjudication` / `settle` fetch from ≥3 independent source categories (news/academic/financial) and reach a non-strict equivalence-principle consensus among GenVM validators (avoids spurious "undetermined" results from near-identical but non-identical fetches).
6. **Claim** — winners call `claim_payout`; if adjudication stalls past a grace window, either side can call `claim_timeout_refund`. Pre-participation markets can be cancelled by their creator via `cancel_market`.

All money movement funnels through a single `_send_gen` chokepoint in the contract, with a strict zero-ledger-then-transfer ordering to prevent double-spend/reentrancy-class bugs.

## Architecture

```
┌─────────────┐      REST      ┌──────────────┐      genlayer-js       ┌──────────────────────┐
│  Frontend    │ ─────────────▶ │  Backend      │ ─────(read-only)─────▶│  GenLayer Contract     │
│  React+Vite  │ ◀───────────── │  Fastify      │                        │  chronix.py (StudioNet)│
│  (Vercel)    │   wallet-signed│  (Fly.io)     │                        │                        │
└─────┬───────┘   writes go     └──────┬───────┘                        └───────────▲────────────┘
      │           direct to chain      │                                            │
      │  genlayer-js (browser wallet)  │ Postgres (mirror/cache)         wallet-signed writes
      └─────────────────────────────────┘                                          │
                                         ▲                                          │
                                         └──────────── user's own wallet ───────────┘
```

- **Frontend**: React 19 + Vite + Tailwind, wallet connection via Reown AppKit (WalletConnect v2, MetaMask, Rainbow, Zerion, injected). Every money-moving call (`create_market`, `stake`, `claim_payout`, `claim_timeout_refund`, `cancel_market`) is signed by the end user's own wallet in-browser via `genlayer-js` — the backend is never in that path.
- **Backend**: Node.js + Fastify + Postgres. Acts as a read cache / indexer over chain state, handles SIWE-based session auth, and runs background jobs:
  - **Deadline enforcer** (60s cron) — flips a market's status to `awaiting_adjudication` only when wall-clock time *and* an on-chain deadline check both agree.
  - **Chain-write reconciler** — retries `chain_sync_queue` entries with backoff; a Postgres row is only marked `confirmed` after a real transaction receipt confirms it.
  - **Chain indexer** — periodically (every `CHAIN_RECONCILER_INTERVAL_MS`, default 15s) re-reads on-chain market state and reconciles Postgres to match chain truth, independent of who triggered the transition. It also **discovers and backfills** markets and evidence pointers that exist on-chain but were never mirrored into Postgres — e.g. a wallet's `create_market`/`submit_evidence_pointer` confirmed on-chain, but the browser's follow-up `POST /markets` or `POST /markets/:id/evidence` failed (expired session token, GenLayer's request-rate limit, a closed tab). Without this, such a market/evidence pointer would be permanently invisible in the UI despite being real on-chain. Triggerable on demand via `POST /sync` (see [API overview](#api-overview)) instead of waiting for the next interval tick.
  - **Keeper** (optional) — a narrow automation key that calls only the non-payable, fully-permissionless `request_adjudication`/`settle` methods. Any wallet could call the same methods with the same effect; the keeper just automates it.
- **Contract**: a single GenLayer Intelligent Contract (`contracts/chronix.py`), Python, deployed manually to GenLayer Studio/StudioNet. GenVM contracts are immutable — any code change requires a new deployment address.
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
│   │   ├── genlayer/    genlayer-js client wrapper (reads + keeper writes)
│   │   ├── jobs/        deadline enforcer, chain reconciler, chain indexer, keeper
│   │   ├── schemas/     Zod request/response validation
│   │   └── plugins/     Fastify plugins (auth, cors, rate-limit, etc.)
│   └── package.json
├── contracts/
│   ├── chronix.py       the Intelligent Contract (pure logic + gl.Contract class)
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
└── .env.example          root-level env reference (see also per-package .env.example)
```

## Prerequisites

- Node.js 20+
- npm
- Docker (for local Postgres, or run Postgres yourself)
- A GenLayer Studio wallet (MetaMask/Rainbow/Zerion/WalletConnect) with StudioNet GEN for any wallet-signed action (staking, creating markets, claiming)
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

Open http://localhost:5173, connect a wallet configured for GenLayer StudioNet, and use the app. Any wallet-signed action (staking, creating a market, claiming) requires the connected wallet to hold GEN on StudioNet — get some from the GenLayer Studio faucet.

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
| `CONTRACT_ADDRESS` | deployed Intelligent Contract address |
| `GENLAYER_RPC_URL`, `GENLAYER_CHAIN_ID` | GenLayer StudioNet RPC + chain id (`61999`) |
| `GENLAYER_KEEPER_PRIVATE_KEY` | optional — see [Trust model](#trust-model--security-notes). Leave blank to disable automated settlement (any wallet can still call the same public methods manually) |
| `KEEPER_INTERVAL_MS` | keeper poll interval |
| `REDIS_URL`, `REDIS_CACHE_TTL_SECONDS` | optional fail-open read cache, never load-bearing — leave blank to disable |
| `DEADLINE_ENFORCER_INTERVAL_MS`, `CHAIN_RECONCILER_INTERVAL_MS`, `CHAIN_SYNC_MAX_ATTEMPTS`, `CHAIN_SYNC_BASE_BACKOFF_MS` | background job tuning |

### Frontend (`frontend/.env`)

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | backend base URL |
| `VITE_CONTRACT_ADDRESS` | deployed Intelligent Contract address (mirrors backend's) |
| `VITE_CHAIN_RPC` | GenLayer StudioNet RPC URL |
| `VITE_WALLETCONNECT_PROJECT_ID` | WalletConnect v2 Cloud project ID (https://cloud.walletconnect.com/) |

**Never commit populated `.env` files.** Only `.env.example` files (with placeholder/non-secret values) belong in git — real `.env` files are gitignored.

## Database

Schema and migrations live in [`database/`](database). `database/schema.sql` is the full reference schema; `database/migrations/*.sql` are the numbered, ordered migrations actually applied to a database.

Core tables:

- `users` — wallet_address (PK), created_at, optional nickname
- `markets` — question, category, horizon, resolution criteria, contract_market_id, status, resolves_at
- `positions` — per-wallet stake per market (side, shares, avg_price, tx_hash)
- `market_events` — append-only event log (created / deadline_passed / evidence_submitted / verdict_pending / verdict_settled / payout_claimed / reconciled), each with a `confirmed` flag tied to an actual chain receipt
- `evidence` — submitted evidence pointers (URL + summary), used only as leads — the contract re-fetches independently at settlement
- `chain_sync_queue` — retry queue so a failed chain write is retried with backoff instead of silently dropped

`markets.contract_market_id` and `evidence.(market_id, url)` both carry unique indexes (migrations `005`, `006`) — required so the chain indexer's discovery/backfill pass (see [Architecture](#architecture)) can safely run concurrently across both backend machines without inserting duplicate rows. `markets.allowed_evidence_types` (migration `007`) mirrors the contract's own field so the evidence-submission UI can filter to only the source types the contract will actually accept (it now enforces this allow-list on-chain).

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

## Smart contract

`contracts/chronix.py` — a single GenLayer Intelligent Contract targeting GenLayer Studio/StudioNet.

**State machine:**

```
created -> active (accepting stakes)
active -> awaiting_adjudication      (request_adjudication, deadline-gated on-chain)
active -> cancelled                  (cancel_market, creator-only, pre-participation only)
awaiting_adjudication -> settled_yes | settled_no | settled_split   (settle)
awaiting_adjudication -> refunded_timeout                            (claim_timeout_refund, after grace window)
```

**Key methods:** `create_market` (payable), `stake` (payable), `submit_evidence_pointer`, `request_adjudication`, `settle` (nondet web-fetch consensus), `claim_payout`, `claim_timeout_refund`, `cancel_market`.

**Deployment**: contract deploys are manual, always by the project owner (this repo never deploys the contract) — GenVM contracts are immutable, so every fix needs a fresh address, never a patch. After a new address is deployed: set `CONTRACT_ADDRESS` / `VITE_CONTRACT_ADDRESS` everywhere (`.env.example`, `backend/.env`, `frontend/.env`, the `chronix-backend` Fly secret, the Vercel production env var — Vercel env vars must be removed and re-added, there's no update-in-place via the CLI), redeploy both backend and frontend, and **clear any Postgres rows tied to the old address** (`DELETE FROM markets`, which cascades to `positions`/`evidence`/`market_events`/`chain_sync_queue`) — their `contract_market_id`s point at markets on the now-abandoned contract and would otherwise silently mismatch against the new one's fresh `market_count` sequence. Full deployment history, the current live address, and gotchas (e.g. the `gl.nondet.web.*` API rename, time-source fallbacks) are logged in [`MEMORY.md`](MEMORY.md); the most recent contract-logic changes and why are in [`REVIEW.md`](REVIEW.md).

Full method reference and design notes: [`contracts/README.md`](contracts/README.md).

## Deployment

Current production deployment:

- **Frontend** — Vercel project `chronix`, serving `https://chronix-app.vercel.app`.
- **Backend** — Fly.io app `chronix-backend`, 2 machines (iad + lhr) for redundancy, `/health` check, auto-restart.
- **Database** — Fly Postgres cluster `chronix-db` (HA: 1 primary + 2 replicas).

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
fly deploy . --config backend/fly.toml --app chronix-backend
```

Or use the helper script:

```bash
./scripts/deploy-fly.sh
```

Run migrations against production after any deploy that adds one:

```bash
fly ssh console -a chronix-backend -C "node dist/db/migrate.js"
```

Set/update secrets:

```bash
fly secrets set CONTRACT_ADDRESS=0x... -a chronix-backend
```

For full deployment history, past incidents, and hard-won gotchas (Dockerfile build-context resolution, Vercel SSO protection, migration path differences between `tsx` and compiled `dist/`, etc.), see [`MEMORY.md`](MEMORY.md) — read it before making deployment changes.

## Trust model / security notes

- **The backend never holds a key that can move user GEN.** All money-moving contract methods (`create_market`, `stake`, `claim_payout`, `claim_timeout_refund`, `cancel_market`) are signed directly by the end user's own wallet in the browser via `genlayer-js`. The backend only records what already happened on-chain — it requires `contractMarketId`/`txHash` as proof before writing a position or market row, it never submits these writes itself.
- **The optional keeper key** (`GENLAYER_KEEPER_PRIVATE_KEY`) only ever calls `request_adjudication` and `settle` — both non-payable and fully permissionless (any wallet could call them with identical effect). It's a convenience automation, not a privileged actor, and cannot move user funds even if compromised. It does need a small GEN balance to pay its own gas.
- **Deadlines are enforced on-chain**, not just in a backend cron — `request_adjudication` checks `now >= resolves_at` itself inside the contract, so a compromised or drifting backend clock can't force early settlement. `stake()` independently re-checks the same deadline (not just `market.status`), so staking actually closes the instant `resolves_at` passes rather than staying open for however long it takes someone to call `request_adjudication`.
- **Adjudication never trusts user-submitted text**, and every eligible participant can always exit. `submit_evidence_pointer` only stores a URL (validated against the market's own configured `allowed_evidence_types`, and deduplicated — a URL can't be submitted twice for the same market); `settle` independently re-fetches from ≥3 real source categories, excludes any source that fails to fetch from the agreement tally entirely (a dead link can't dilute or grief a decision), and requires validators to independently derive the SAME verdict (via `pure_decide_verdict`) from their own fetch, not merely produce similar raw vote counts — GenVM's nondeterministic-block equivalence principle applied to the value that actually gets persisted and paid out against. `claim_timeout_refund` is available to every staker who hasn't yet claimed once the grace window elapses, not just the first caller (a first-claimant flips `market.status` to `refunded_timeout` as a UI signal, but that status is itself still a valid state to claim from — the per-wallet `payout_claimed` flag is what actually prevents a double-claim).
- **Escrow ordering** is strictly read-ledger → zero-ledger → persist → transfer, funneled through a single `_send_gen` chokepoint, to prevent reentrancy/double-spend.
- **A Postgres row is only marked `confirmed`** after a real on-chain transaction receipt confirms it — the DB is a read cache, never a source of truth for money.
- **The frontend never resubmits a wallet-signed write to paper over a mirror failure.** If a market/stake/evidence tx confirms on-chain but the follow-up `POST` to Postgres fails (expired session, rate limit, network blip), the UI holds onto the confirmed `txHash` and offers "Retry recording" rather than re-running the on-chain call — a second on-chain submission would mean actually paying/staking twice. The chain indexer's backfill pass is the real safety net: it independently discovers and mirrors anything confirmed on-chain that Postgres is missing, with or without a retry.

## API overview

Base URL: `http://localhost:8080` (dev) or `https://chronix-backend.fly.dev` (prod).

| Route | Method | Description |
|---|---|---|
| `/health` | GET | liveness/readiness check |
| `/auth/nonce` | POST | issue a SIWE nonce |
| `/auth/verify` | POST | verify a signed SIWE message, issue a session |
| `/markets` | GET | list markets |
| `/markets` | POST | mirror an already-confirmed `create_market` tx into Postgres (requires `txHash`/`contractMarketId`; `allowedEvidenceSources` mirrors the same value already sent on-chain) |
| `/markets/:id` | GET | market detail |
| `/markets/:id/positions` | POST | record a stake already confirmed on-chain (requires `txHash`/`contractMarketId`) |
| `/markets/:id/evidence` | GET/POST | evidence pointers for a market — `GET` paginated (`limit`, default 50/max 200; `offset`) |
| `/markets/:id/events` | GET | market event timeline (from `market_events`) |
| `/markets/:id/trace` | GET | GenVM execution trace for a market's `settle()` tx, when available |
| `/evidence` | GET | global evidence feed across all markets, paginated (`sourceType`, `limit`, `offset`) |
| `/sync` | POST | on-demand chain resync — runs the chain indexer's reconcile + discover/backfill pass immediately instead of waiting for the next interval tick. Rate-limited (2/min per machine) since it costs GenLayer RPC calls; safe to expose as a user-facing "Resync from chain" button (see Discover / MarketDetail pages) |
| `/portfolio/:wallet` | GET | a wallet's positions, joined with market status |

All write routes require proof of an already-confirmed on-chain transaction — the backend does not originate money-moving writes.

## Troubleshooting

- **Blank/crashed page** — check the browser console first; there is currently no top-level error boundary, so an uncaught render error in one page can blank the whole app.
- **"GenLayer not configured" errors** — `CONTRACT_ADDRESS` / `VITE_CONTRACT_ADDRESS` is unset or empty; wallet-signed calls no-op with a clear error until it's set.
- **Wallet won't connect / wrong network** — the app targets GenLayer StudioNet (chain id `61999`), not Ethereum mainnet/Sepolia; make sure `VITE_WALLETCONNECT_PROJECT_ID` is set and the wallet is pointed at StudioNet.
- **Migrations fail locally** — confirm Postgres is up (`docker compose up postgres`) and `DATABASE_URL` in `backend/.env` matches the compose service (`postgres://chronix:chronix@localhost:5432/chronix` when running via Docker).
- **Keeper not settling markets automatically** — `GENLAYER_KEEPER_PRIVATE_KEY` is unset (settlement still works, any wallet can call `request_adjudication`/`settle` manually), or the keeper wallet is out of GEN gas.
- **A market or evidence pointer I just submitted isn't showing up** — the on-chain write almost certainly succeeded (check the tx hash on the GenLayer explorer); what failed is the mirror step into Postgres. Common causes: your session token is >24h old (`JWT_EXPIRES_IN`) and the frontend hadn't noticed yet — it now detects this on a 401 and prompts you to sign in again without resubmitting on-chain; or GenLayer Studio's request-rate limit (30 req/min) tripped while an earlier transaction's receipt was still being polled. Either way, press "Resync from chain" (Discover page, or the Evidence feed on a market page) to trigger `POST /sync` immediately, or just wait — the chain indexer's background pass picks it up within `CHAIN_RECONCILER_INTERVAL_MS` (15s) regardless.
- **401 `"Missing or invalid session token"` on a write** — session JWTs expire after `JWT_EXPIRES_IN` (24h default), but the frontend used to treat "a token exists in `localStorage`" as permanently authenticated with no client-side expiry check, so this could surface deep into a multi-step flow (e.g. after an on-chain tx already confirmed). Fixed: any 401 now clears the stale session (`clearSession()` in `frontend/src/lib/auth.tsx`, which drops the token without disconnecting the wallet) and prompts a re-sign-in; in-flight on-chain results are preserved for retry, never resubmitted.
- **Deploy issues** — see [`MEMORY.md`](MEMORY.md) for a running log of past deployment incidents and fixes (Dockerfile build context, Vercel alias/SSO protection, migration path resolution, contract API renames).
