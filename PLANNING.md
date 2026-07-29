# Chronix — Architecture & Planning

Locked decisions (approved by user 2026-07-29):
- **DB**: PostgreSQL, run via Docker locally and in production.
- **Backend host**: Fly.io. Must be 24/7 — `fly.toml` uses `min_machines_running >= 1`, auto_restart, health checks, and a second machine/region for failover. A watchdog cron pings `/health` and restarts on failure.
- **Auth**: Wallet-based only (MetaMask, Rainbow, Zerion, WalletConnect v2). Sign-In-With-Ethereum (SIWE) — no email/password, no social OAuth, no usernames-as-identity.
- **Contract runtime**: GenLayer Studio, StudioNet, gas token GEN. One production Intelligent Contract (Python, genlayer-py), 1000+ lines, deployed manually by the user (backend takes `CONTRACT_ADDRESS` from env once given).
- **Escrow**: real on-chain GEN value transfer — payable writes (`gl.message.value`), ledger fields separate from terms, zero-then-transfer ordering, single `_send_gen` emission chokepoint, explicit exit paths (settle/dispute/timeout-reclaim/cancel).
- **Adjudication**: contract-side web fetch (`gl.nondet` / `gl.web`) against real sources — never judged from user-submitted text alone.
- **Frontend**: React (Vite) + Tailwind, deployed to Vercel. Design language ported (not copy-pasted) from the four reference HTML files — "Chronology Dark" system, Geist + JetBrains Mono, small/compact text sizes per user instruction (base body ~13px, labels ~11px, headings scaled down from the mockups).

## Product architecture
Landing → Discover (market grid) → Market Detail (stake/evidence/adjudication status) → Adjudication Result (resolved evidence + payout) → Portfolio → Market Creation → Wallet connect flow. Admin/mod view for flagged markets.

## Pages to build
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
`markets(id, question, category, horizon_years, resolution_criteria, created_by, contract_market_id, status, resolves_at, created_at, deadline_enforced_at)`
`positions(id, market_id, wallet_address, side, shares, avg_price, tx_hash, created_at)`
`market_events(id, market_id, type[created|deadline_passed|evidence_submitted|verdict_pending|verdict_settled|payout_claimed|reconciled], payload, chain_tx_hash, confirmed boolean, created_at)`
`evidence(id, market_id, source_type, url, summary, submitted_by, weight, created_at)`
`chain_sync_queue(id, market_id, action, payload, attempts, last_error, status[pending|confirmed|failed], next_retry_at)` — reconciliation/retry queue so a failed chain write is retried, never silently dropped, and a user-visible record is only persisted as "confirmed" after the chain write actually lands.

## Backend architecture
Node.js (Fastify) + Postgres + BullMQ-style job queue (Postgres-backed, no Redis dependency) for:
- deadline enforcer (cron every 60s: flips `markets.status` to `awaiting_adjudication` only when `resolves_at` has passed AND on-chain deadline check confirms it — prevents early scoring)
- chain-write reconciler (retries `chain_sync_queue` entries with backoff; marks `market_events.confirmed` only after receipt confirms)
- GenLayer client wrapper (calls contract, polls tx receipt, never marks a payout/verdict as final in Postgres until the contract state itself reports it)
- REST API: `/markets`, `/markets/:id`, `/markets/:id/positions`, `/markets/:id/evidence`, `/markets/:id/adjudicate` (read-only status), `/portfolio/:wallet`, `/health`

## GenLayer contract responsibilities
Single Intelligent Contract, methods: `create_market` (payable, seeds liquidity), `stake` (payable), `submit_evidence_pointer` (stores URL, contract fetches it itself — never trusts submitted summaries as fact), `request_adjudication` (only callable after `resolves_at`, guarded), `settle` (nondet web-fetch across >=3 independent sources, weighted consensus, non-strict equivalence threshold to avoid leader/validator disagreement -> undetermined), `claim_payout`, `claim_timeout_refund` (counterparty recovery if adjudication stalls), `cancel_market` (pre-participation only). All money movement funnels through one `_send_gen` helper; ledger fields zeroed before transfer.

## Security / scalability / deployment
- Backend: Fly.io, Dockerized, Postgres on Fly volumes or managed Postgres, structured logging, `/health`, auto-restart, 2 machines.
- Frontend: Vercel, env-configured `VITE_API_URL`, `VITE_CONTRACT_ADDRESS` (set after user deploys contract), `VITE_CHAIN_RPC`.
- Tests: contract unit tests (pytest + genvm-lint), backend integration tests covering failed-close / submission / dispute / payout transitions (per Event-Weaver review), frontend component smoke tests.

## Folder structure
```
frontend/  backend/  contracts/  shared/  scripts/  configs/  database/  tests/  docs/  MEMORY.md
```
