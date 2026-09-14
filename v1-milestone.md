# Chronix v1 milestone — USDC funding migration & infrastructure reset

**Date: 2026-09-14**

This milestone moved Chronix's entire funding layer off native GEN and onto real USDC on Base
Sepolia, stood up a new backend on a fresh Fly.io account after the original account was lost,
and deployed everything fresh end-to-end. This document is the comprehensive record of what
changed, why, and what's still open.

## Why

1. Funding needed to move from the GenLayer native gas token (GEN) to USDC on Base Sepolia.
2. The Fly.io account holding the original backend (`chronix-backend`) was lost — no access,
   no recovery path. A new backend needed to be created on the currently-connected account,
   with every reference to the old account removed, and the frontend repointed at it.
3. A new GenLayer contract was deployed by the project owner and needed wiring in, with all
   stale/prior-contract data cleared so the app starts fresh against it.

## Architecture change

**Before**: `contracts/chronix.py` was a single GenLayer Intelligent Contract that escrowed
GEN directly — `create_market`/`stake` were `payable` and read `gl.message.value`, and every
payout path called a single `_send_gen` chokepoint to transfer GEN out. Every money-moving
write was signed directly by the end user's own wallet against GenLayer.

**After**: money and adjudication are split across two chains, mirroring the pattern used in
the meme-olympics/event-weaver reference projects:

- **GenLayer (`contracts/chronix.py`)** is adjudication + ledger-of-record only. It holds no
  money and never did a native value transfer since this revision — `_send_gen` and its
  `@gl.evm.contract_interface` shim (`_GenRecipient`) were removed entirely. Every write method
  is gated by a single `relayer_address` (a new constructor argument) instead of trusting
  `gl.message.sender_address` directly, since the relayer — not the end user — is now the only
  party able to have confirmed a matching USDC event on Base Sepolia. The one exception is
  `submit_evidence_pointer`, which never moved money and stays directly wallet-signed and
  permissionless.
- **Base Sepolia (`contracts/base/ChronixEscrow.sol`, new)** holds every real USDC deposit —
  a market's initial liquidity, every YES/NO stake — and every payout/refund. `fund()` and
  `claim()`/`claimMany()` are open to any wallet, self-serve, checks-effects-interactions,
  reentrancy-guarded. `setPayouts()` is relayer-only, idempotent per market (its own
  `payoutsSet` gate), mirroring `MemeOlympicsEscrow.setWinners`'s pattern exactly.
- **A backend relayer** (`backend/src/jobs/baseRelay.ts`, new) bridges the two chains:
  - Scans `ChronixEscrow`'s `Funded` events and mirrors confirmed deposits onto GenLayer's
    `create_market`/`stake`.
  - Once GenLayer settles/cancels a market (or a timeout refund becomes eligible), computes
    the authoritative payout list (via the existing `claim_payout`/`claim_timeout_refund`/
    `cancel_market` methods — now relayer-only, and returning the amount instead of moving it)
    and pushes it onto `ChronixEscrow.setPayouts` in one batched call.
  - One backend-held key (`RELAYER_PRIVATE_KEY` / `BASE_SEPOLIA_RELAYER_PRIVATE_KEY` —
    intentionally the same value) does this AND the pre-existing "keeper" duty of automating
    the two permissionless GenLayer actions (`request_adjudication`, `settle`).

This preserves the original trust-model property that mattered — the backend never custodies
user funds — while changing *how* that's true: previously because the user's own wallet signed
every money-moving GenLayer call directly; now because the user's own wallet signs every
money-moving call directly against the escrow on Base Sepolia, and the relayer can only ever
mirror facts already confirmed on-chain, never fabricate them.

## What was built

### Contracts

- **`contracts/chronix.py`** (rewritten) — removed `_send_gen`/`_GenRecipient` and every
  `@gl.public.write.payable` decorator. `create_market`/`stake`/`claim_payout`/
  `claim_timeout_refund`/`cancel_market` are now relayer-gated (`_require_relayer`), take
  explicit `wallet`/`creator_wallet` parameters (since the caller is now always the relayer,
  not the end user), and the three payout methods return the authoritative amount instead of
  transferring it. Added `relayer_address: Address` storage field, a constructor argument, and
  a `get_relayer_address()` view. Passes `genvm-lint check` clean and all 35 existing pure-logic
  pytest tests unchanged (the payout math itself didn't change, only who moves the money).
- **`contracts/base/ChronixEscrow.sol`** (new) — USDC custody contract for Base Sepolia. `fund`,
  `setPayouts`, `claim`, `claimMany`, `withdrawUnallocated` (owner-only, unallocated dust only),
  `setRelayer`/`transferOwnership` (owner-only). No external dependencies (no OpenZeppelin),
  compiles with plain `solc`, matching the reference project's pattern.
- **`contracts/base/deploy.js`** (new) — deploy script; reads `DEPLOYER_PRIVATE_KEY` from env
  only, never a CLI argument or committed file.
- **`contracts/README.md`** / **`contracts/base/README.md`** — rewritten / new to document the
  above.

### Backend

- **`backend/src/services/baseSepolia.ts`** (new) — `ChronixEscrow` read/write helpers:
  `marketIdToBytes32` (keccak of the Postgres market UUID — the shared key between both
  systems), `getFundedEvents`, `relayPayoutsToEscrow`, `getEscrowPool`/`getEscrowClaimable`,
  `getWalletUsdcBalance`.
- **`backend/src/lib/escrowAbi.ts`** (new) — `ChronixEscrow`/ERC20 ABI fragments + fund-kind
  constants.
- **`backend/src/jobs/baseRelay.ts`** (new) — the relay job described above: deposit-relay
  (pool + stake), payout-relay, and creator-requested-cancellation-relay passes, run on
  `BASE_RELAY_INTERVAL_MS` (default 20s). Idempotent throughout: a market/position only
  advances past its `NULL` relayed-at marker once a write actually succeeds, and the payout
  pass is guarded by both a Postgres column and the escrow's own `payoutsSet` gate.
- **`backend/src/genlayer/client.ts`** — renamed the "keeper" client to "relayer" client
  (`getRelayerClient`, was `getKeeperClient`); added `createMarket`, `stake`, `claimPayout`,
  `claimTimeoutRefund`, `cancelMarket` wrapper methods calling the new relayer-gated contract
  methods. **Flagged for verification**: the amount-return-value reads on
  `claimPayout`/`claimTimeoutRefund`/`cancelMarket` use a best-effort `.result` field on the tx
  receipt that has not been confirmed against a real `genlayer-js` write-call receipt shape —
  `getTransactionTrace(txHash).returnData` is the confirmed fallback if `.result` turns out to
  be wrong.
- **`backend/src/config.ts`** — `GENLAYER_KEEPER_PRIVATE_KEY` renamed `RELAYER_PRIVATE_KEY`;
  added `BASE_SEPOLIA_RPC_URL`, `BASE_SEPOLIA_CHAIN_ID`, `BASE_SEPOLIA_USDC_ADDRESS`,
  `CHRONIX_ESCROW_ADDRESS`, `BASE_SEPOLIA_RELAYER_PRIVATE_KEY`,
  `BASE_SEPOLIA_ESCROW_DEPLOY_BLOCK`, `BASE_RELAY_INTERVAL_MS`.
- **`backend/src/routes/markets.ts`** / **`backend/src/schemas/index.ts`** — `POST /markets`
  and `POST /markets/:id/positions` now create a `pending_chain` row / unrelayed position
  BEFORE any chain write (previously they recorded an already-confirmed on-chain tx). Added
  `GET /markets/:id/escrow` (escrow address, USDC address, this market's bytes32 key, fund-kind
  constants — everything the frontend needs to build a funding tx) and
  `GET /markets/:id/claimable/:wallet` (live read from the escrow). Added
  `POST /markets/:id/cancel-request` (see below).
- **`backend/src/db/repositories.ts`** — `insertMarket` no longer takes `contractMarketId`
  (rows start `pending_chain`, no on-chain id yet). New helpers:
  `findMarketsPendingPoolRelay`/`findPositionsPendingRelay`/`markMarketPoolRelayed`/
  `markPositionRelayed`, `findMarketsPendingPayoutRelay`/`markMarketPayoutsRelayed`,
  `getBaseRelayWatermark`/`setBaseRelayWatermark`, `requestMarketCancellation`/
  `findMarketsPendingCancelRelay`.
- **Database migrations**:
  - `008_base_sepolia_usdc_funding.sql` — `markets.pool_fund_tx_hash`/`pool_relayed_at`/
    `payouts_relayed_at`, `positions.fund_tx_hash`/`relayed_at`, and the single-row
    `base_relay_watermark` table (tracks the last Base Sepolia block fully scanned for
    `Funded` events, so a restart doesn't rescan from the contract's deployment block).
  - `009_market_cancel_request.sql` — `markets.cancel_requested_at`.
- **Creator-initiated cancellation** (new, added as a same-day follow-up once the core
  migration was live): `cancel_market` being relayer-gated meant a creator's own wallet could
  no longer call it directly, so `POST /markets/:id/cancel-request` was added — verifies the
  caller is the creator, pre-participation-only (mirrors the contract's own
  `pure_can_cancel` guard), cancels immediately if the market never made it past
  `pending_chain` (nothing on-chain yet), otherwise records the request for
  `jobs/baseRelay.ts`'s new `relayRequestedCancellations()` pass to drive on its next tick.

### Frontend

- **`frontend/src/lib/escrow.ts`** (new) — the only place in the frontend that moves real
  money: `approveAndFund` (checks USDC allowance, approves only if insufficient, then calls
  `fund`) and `claim`, both via viem + `@wagmi/core` against `wagmiConfig`, always signed by
  the connected wallet, always on Base Sepolia (auto network-switch).
- **`frontend/src/lib/wagmi.ts`** — now configures both chains: `baseSepolia` (id `84532`, new)
  and `genlayerStudio` (id `61999`, existing), so the wallet can switch between them depending
  on the action.
- **`frontend/src/lib/genlayer.ts`** — trimmed to just `submitEvidencePointer` (the one write
  that stayed permissionless); `createMarket`/`stake`/`claimPayout`/`claimTimeoutRefund`/
  `cancelMarket` were removed since the contract no longer accepts direct wallet calls for
  those.
- **`frontend/src/lib/api.ts`** — `createMarket`/`stake` simplified to the pending-first
  pattern (no `contractMarketId`/`txHash` params); added `getMarketEscrow`, `getClaimable`,
  `requestCancel`.
- **`frontend/src/lib/format.ts`** — added `baseUnitsToUsdc`/`formatUsdc` (6 decimals);
  `weiToGen`/`formatGen` (18 decimals) kept, unused, for reference.
- **`CreateMarket.tsx` / `MarketDetail.tsx` / `Portfolio.tsx` / `AdjudicationResult.tsx`** —
  rewired to: create a pending row via the API → `escrow.approveAndFund` on Base Sepolia (the
  backend relay job mirrors the rest automatically) → for claims, `escrow.claim` directly, no
  GenLayer transaction needed. `MarketDetail.tsx`'s cancel button now calls
  `api.requestCancel` and shows a pending-request state once `cancel_requested_at` is set.
  Every GEN-denominated label/unit across these pages (and `Discover.tsx`, `Landing.tsx`,
  `Docs.tsx`) was updated to USDC.
- **`frontend/.claude/launch.json`** (new, repo root) — dev-server preview config used to
  verify the app in-browser during this migration.

### Infrastructure

- **New Fly.io app `chronix-markets-api`** created on the currently-connected account (the
  original `chronix-backend` app's account was lost). Deployed, 2 machines in `iad`, IPv4 +
  IPv6 allocated, `/health` passing.
- **New Fly Postgres `chronix-markets-db`**, attached to `chronix-markets-api` via
  `DATABASE_URL`. All 9 migrations applied.
- **`ChronixEscrow.sol` deployed to Base Sepolia** at
  `0xeCA7236a62bf3c17e31B168692CA1871eCee91eB` (deploy block `46811025`), using a
  throwaway/testnet-only key supplied by the project owner in chat as both deployer and
  relayer (`0x7401c129EDfc26E68FE19309fE461eb3Db1058Eb`).
- **New GenLayer contract** deployed by the project owner at
  `0x9e09470D7e3D0cf044E27060Db57f39517b76984` — its on-chain `relayer_address` was verified
  (via a live `get_relayer_address()` read) to match the backend's relayer key exactly.
- Every reference to the old `chronix-backend` app name updated across `backend/fly.toml`,
  `scripts/deploy-fly.sh`, `backend/src/lib/logger.ts`'s service name, and `README.md`.
- All secrets set via `fly secrets set` on `chronix-markets-api`: `JWT_SECRET`,
  `DATABASE_SSL`, `SIWE_DOMAIN`/`SIWE_URI`, `CORS_ORIGIN`, `GENLAYER_RPC_URL`/
  `GENLAYER_CHAIN_ID`, `BASE_SEPOLIA_RPC_URL`/`BASE_SEPOLIA_CHAIN_ID`/
  `BASE_SEPOLIA_USDC_ADDRESS`, `RELAYER_PRIVATE_KEY`/`BASE_SEPOLIA_RELAYER_PRIVATE_KEY`,
  `CHRONIX_ESCROW_ADDRESS`/`BASE_SEPOLIA_ESCROW_DEPLOY_BLOCK`, and finally `CONTRACT_ADDRESS`
  once the new GenLayer contract was deployed.

## Data reset

- The production `markets` table was cleared (0 rows — it was already empty, since no market
  had ever been created against the old contract/account through this app) and the Base relay
  watermark reset to `0`, so the relay job scans fresh from `BASE_SEPOLIA_ESCROW_DEPLOY_BLOCK`
  going forward.
- `backend/.env`, `frontend/.env`, and both `.env.example` files were refreshed to the new
  contract/escrow/backend addresses; the root-level `.env.example` (which had drifted out of
  sync with the per-package ones — wrong port, old GEN-era variables) was rewritten to match.
- `MEMORY.md`'s "Locked architecture decisions" and "Deployment state" sections — both
  living/current-state summaries, not dated log entries — were updated in place to point at
  the current contract/backend/escrow addresses, with the prior GEN-era content kept
  underneath as explicitly-marked historical record (dead contract addresses and the reasoning
  behind past incidents remain useful even though the live addresses changed).
- `README.md` was rewritten throughout (architecture diagram, how-it-works, prerequisites, env
  var tables, DB table list, smart contract section split in two, trust model, API overview,
  deployment section, troubleshooting) to describe the current USDC/Base Sepolia architecture
  rather than the superseded native-GEN one.
- `.gitignore` — added `.DS_Store` (was previously untracked but not ignored, so macOS junk
  files kept showing up in `git status`); `contracts/base/.gitignore` added for its
  `node_modules/` (installed locally to run the deploy script).

## Verification

- **Contract**: `genvm-lint check contracts/chronix.py` clean; `cd contracts && python3 -m
  pytest tests/ -v` — 35/35 passing, unchanged (payout math wasn't touched, only who calls it).
- **Backend**: `npx tsc --noEmit` clean; `npm test` — 17/17 passing (three pre-existing tests
  updated to match the new pending-first `POST /markets` contract; the rest pass unchanged),
  run against a real Postgres container with all 9 migrations applied.
- **Frontend**: `npx tsc -b` / `vite build` clean; `npm test` — 7/7 passing; `oxlint` clean
  (one pre-existing, unrelated warning). Verified live in-browser (Create Market page renders
  "Initial liquidity (USDC)"; Discover/Portfolio pages correctly show an empty state — "0
  Markets", "0 USDC" — matching the freshly-cleared production database, with no console
  errors, confirming the deployed frontend build actually talks to the live
  `chronix-markets-api.fly.dev` backend).
- **End-to-end on live infrastructure**: `chronix-markets-api.fly.dev/health` returns
  `{"status":"ok","db":"up","genlayerConfigured":true}`; `/markets` returns an empty list
  against the cleared database; the new GenLayer contract's `relayer_address` was read live
  and confirmed to match the backend's configured relayer key.

## Known follow-up work (not done in this milestone)

- **`genlayer-js` write-receipt return-value shape unverified** — `claimPayout`/
  `claimTimeoutRefund`/`cancelMarket` in `backend/src/genlayer/client.ts` read the method's
  u256 return value via a best-effort `.result` field on the tx receipt that hasn't been
  confirmed against a real SDK response for a *write* call. Verify against a real
  settle()+claim flow on GenLayer Studio before relying on this in a live payout; the
  documented fallback is `getTransactionTrace(txHash).returnData`.
- **No full production dry-run of the relay loop yet** — the relay job, escrow contract, and
  new GenLayer contract have each been verified individually (contract linted/tested, escrow
  deployed and reachable, backend healthy, relayer address matched), but no market has yet been
  created → funded → staked → settled → claimed end-to-end against the live deployment. Do
  that as the first real smoke test before directing real users at it.
- **Vercel frontend production env vars** — `VITE_API_URL`/`VITE_CONTRACT_ADDRESS`/
  `VITE_CHRONIX_ESCROW_ADDRESS`/etc. were updated in local `frontend/.env`, but this milestone
  did not touch the Vercel production deployment's env vars or trigger a production redeploy —
  `chronix-app.vercel.app` may still be serving the pre-migration build. Needs a Vercel env var
  update (remove + re-add, no update-in-place via the CLI) and `vercel --prod --yes` +
  `vercel alias set` per the existing [`README.md`](README.md#deployment) deploy routine.
- **`withdrawUnallocated` manual fallback for the pending+funded+cancelled edge case** — if a
  user funds a `pending_chain` market on Base Sepolia and the creator requests cancellation
  before the relay job mirrors that deposit onto GenLayer, the deposit is stuck in the escrow
  with no GenLayer market ever created to compute a refund against. This is a narrow race
  (requires cancellation between deposit and the next ~20s relay tick) with no automated
  recovery yet — the owner-only `ChronixEscrow.withdrawUnallocated` is the manual escape hatch.
