# Chronix — Architecture & Planning

Locked decisions (approved by user 2026-07-29, escrow/funding decision superseded 2026-09-14 —
see [`v1-milestone.md`](v1-milestone.md) for the full migration writeup and
[`MEMORY.md`](MEMORY.md) for the dated session log):

- **DB**: PostgreSQL, run via Docker locally and in production.
- **Backend host**: Fly.io. Must be 24/7 — `fly.toml` uses `min_machines_running >= 1`, auto_restart, health checks, and a second machine/region for failover. A watchdog cron pings `/health` and restarts on failure.
- **Auth**: Wallet-based only (MetaMask, Rainbow, Zerion, WalletConnect v2). Sign-In-With-Ethereum (SIWE) — no email/password, no social OAuth, no usernames-as-identity.
- **Adjudication contract**: GenLayer Studio, StudioNet. One production Intelligent Contract (Python, genlayer-py), `contracts/chronix.py`, deployed manually by the user (backend takes `CONTRACT_ADDRESS` from env once given). **As of 2026-09-14 this contract moves no money at all** — it is adjudication + ledger-of-record only, and every write method is gated by a single `relayer_address` (constructor arg) instead of trusting the caller's own wallet directly.
- **Escrow / funding**: real USDC on Base Sepolia, held by `contracts/base/ChronixEscrow.sol` (new contract, deployed 2026-09-14). Anyone can `fund()`/`claim()`/`claimMany()` self-serve, checks-effects-interactions, reentrancy-guarded; `setPayouts()` is relayer-only and idempotent per market. A backend relayer (`backend/src/jobs/baseRelay.ts`) bridges confirmed Base Sepolia deposits onto GenLayer and GenLayer's settlement outcomes back onto the escrow. This replaces the original design (real on-chain native-GEN value transfer via `gl.message.value`/payable writes/a single `_send_gen` chokepoint on `chronix.py` itself) — GenLayer still keeps the same zero-then-persist ledger ordering and explicit exit paths (settle/timeout-refund/cancel), just as accounting only, never a real transfer.
- **Adjudication**: contract-side web fetch (`gl.nondet.web.*` / `gl.nondet.exec_prompt`) against real sources — never judged from user-submitted text alone.
- **Frontend**: React (Vite) + Tailwind, deployed to Vercel. Design language ported (not copy-pasted) from the four reference HTML files — "Chronology Dark" system, Geist + JetBrains Mono, small/compact text sizes per user instruction (base body ~13px, labels ~11px, headings scaled down from the mockups). Wallet connection via Reown AppKit, wired to both chains (GenLayer StudioNet for adjudication reads/evidence submission, Base Sepolia for all funding/claiming).

## Product architecture
Landing → Discover (market grid) → Market Detail (stake/evidence/adjudication status) → Adjudication Result (resolved evidence + payout) → Portfolio → Market Creation → Wallet connect flow. Admin/mod view for flagged markets.

## Pages built
1. Landing / marketing
2. Market Discovery (grid, filters, timeframes, evidence feed, platform stats)
3. Market Detail (sentiment, stake, evidence feed, adjudication engine live status)
4. Market Creation (form: question, category, horizon, resolution criteria, evidence sources allowed, initial liquidity)
5. Adjudication Result (verdict, source weights, reasoning timeline, evidence artifacts, payout/claim)
6. Portfolio (positions, claimable payouts, history)
7. Wallet connect / account settings
8. Evidence Ledger (global feed)
9. Docs/how-it-works (static)

## Database schema (Postgres)
`users(wallet_address pk, created_at, nickname?)`
`markets(id, question, category, horizon_years, resolution_criteria, created_by, contract_market_id, status, resolves_at, created_at, deadline_enforced_at, pool_fund_tx_hash, pool_relayed_at, payouts_relayed_at, cancel_requested_at, allowed_evidence_types)`
`positions(id, market_id, wallet_address, side, shares, avg_price, fund_tx_hash, relayed_at, created_at)`
`market_events(id, market_id, type[created|deadline_passed|evidence_submitted|verdict_pending|verdict_settled|payout_claimed|reconciled], payload, chain_tx_hash, confirmed boolean, created_at)`
`evidence(id, market_id, source_type, url, summary, submitted_by, weight, created_at)`
`chain_sync_queue(id, market_id, action, payload, attempts, last_error, status[pending|confirmed|failed], next_retry_at)` — reconciliation/retry queue so a failed chain write is retried, never silently dropped, and a user-visible record is only persisted as "confirmed" after the chain write actually lands.
`base_relay_watermark(id, last_scanned_block)` — single-row table tracking the last Base Sepolia block the relay job has fully scanned for `ChronixEscrow` `Funded` events.

Full reference schema (current, all 9 migrations applied): [`database/schema.sql`](database/schema.sql).

## Backend architecture
Node.js (Fastify) + Postgres, no Redis dependency for correctness (an optional fail-open Redis read cache exists, never load-bearing). Background jobs:
- deadline enforcer (cron every 60s: flips `markets.status` to `awaiting_adjudication` only when `resolves_at` has passed AND on-chain deadline check confirms it — prevents early scoring)
- chain-write reconciler (retries `chain_sync_queue` entries with backoff; marks `market_events.confirmed` only after receipt confirms)
- chain indexer (periodically re-reads on-chain market state, reconciles Postgres to match chain truth, and discovers/backfills markets and evidence pointers that exist on-chain but were never mirrored)
- Base relay (`backend/src/jobs/baseRelay.ts`) — scans `ChronixEscrow` `Funded` events and mirrors confirmed deposits onto GenLayer's `create_market`/`stake`; once GenLayer settles/cancels a market, computes the authoritative payout list and pushes it onto `ChronixEscrow.setPayouts`
- GenLayer client wrapper (calls contract, polls tx receipt, never marks a payout/verdict as final in Postgres until the contract state itself reports it)
- REST API: see [`README.md`](README.md#api-overview) for the full, current route table.

## GenLayer contract responsibilities
Single Intelligent Contract (`contracts/chronix.py`), adjudication + ledger-of-record only — moves no money. Methods: `create_market` (relayer-only, mirrors a confirmed Base Sepolia pool deposit), `stake` (relayer-only, mirrors a confirmed Base Sepolia stake deposit), `submit_evidence_pointer` (any wallet — stores a URL, the contract fetches it itself at settlement, never trusts submitted summaries as fact), `request_adjudication` (any wallet/keeper, only callable after `resolves_at`, enforced on-chain), `settle` (any wallet/keeper, nondet web-fetch across ≥3 independent source categories, non-strict equivalence-principle consensus to avoid leader/validator disagreement → undetermined), `claim_payout` / `claim_timeout_refund` (relayer-only, return the authoritative amount for the relayer to credit on the escrow), `cancel_market` (relayer-only, pre-participation only). Every payout path follows read-ledger → zero-ledger → persist → return ordering; the actual USDC transfer happens on `ChronixEscrow.sol` on Base Sepolia, not here. Full method reference: [`contracts/README.md`](contracts/README.md).

## Security / scalability / deployment
- Backend: Fly.io, Dockerized, Fly Postgres, structured logging, `/health`, auto-restart, 2 machines.
- Frontend: Vercel, env-configured `VITE_API_URL`, `VITE_CONTRACT_ADDRESS`, `VITE_CHRONIX_ESCROW_ADDRESS`, `VITE_CHAIN_RPC`, Base Sepolia chain/RPC vars.
- Tests: contract pure-logic unit tests (pytest, 35 passing) + `genvm-lint`, backend integration tests (17 passing) covering the pending-first market/position flow and payout transitions, frontend component tests (7 passing) + `oxlint`.

## Folder structure
```
frontend/  backend/  contracts/ (chronix.py + base/ChronixEscrow.sol)  database/  scripts/
PLANNING.md  MEMORY.md  REVIEW.md  v1-milestone.md  README.md
```

See [`README.md`](README.md) for the full, current repository layout, environment variables, and deployment routine — this file records the locked *decisions*, not the day-to-day operational detail.
