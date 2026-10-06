# Chronix v1 milestone — USDC funding migration & infrastructure reset

**Date: 2026-09-14 (migration), 2026-09-15 → 2026-09-16 (live E2E verification and fixes)**

**V1 head: [`0f7a572fa26610631b6d78cd244afab42046e727`](https://github.com/zoefunds/chronix/commit/0f7a572fa26610631b6d78cd244afab42046e727)**

Full comparison from the last pre-migration commit (`657e906`, the payout-core review fixes) to
the V1 head — 4 commits, 50 files, +3,045/−667:
[`657e906…0f7a572`](https://github.com/zoefunds/chronix/compare/657e906b2fae594ee6d2e075d93a844b72094ce3...0f7a572fa26610631b6d78cd244afab42046e727)

| Commit | Date | What |
|---|---|---|
| `1944e35` | 2026-09-14 | USDC/Base Sepolia migration: GenLayer contract, Base escrow, relay, cancellation, frontend, infra reset |
| `97a6126` | 2026-09-15 | `PLANNING.md` and `frontend/README.md` brought in line with the migration |
| `0465feb` | 2026-09-16 | Five relay/client bugs found by live E2E testing (see [Post-migration fixes](#post-migration-fixes-found-by-live-e2e-testing)) |
| `0f7a572` | 2026-09-16 | Advisory-lock fix for a double-relay race across the 2 Fly machines |

This milestone moved Chronix's entire funding layer off native GEN and onto real USDC on Base
Sepolia, stood up a new backend on a fresh Fly.io account after the original account was lost,
deployed everything fresh end-to-end, and then verified two full market lifecycles on the live
deployment, which surfaced and fixed six bugs the migration commit alone did not. This document
is the comprehensive record of what changed, why, and what's still open.

Where to look in the comparison for each area:

| Area | Files |
|---|---|
| GenLayer contract | `contracts/chronix.py`, `contracts/README.md` |
| Base escrow | `contracts/base/ChronixEscrow.sol`, `deploy.js`, `README.md` |
| Relay | `backend/src/jobs/baseRelay.ts`, `services/baseSepolia.ts`, `genlayer/client.ts`, migrations `008` and `010` |
| Cancellation | migration `009`, `POST /markets/:id/cancel-request` in `routes/markets.ts`, `relayRequestedCancellations()` in `baseRelay.ts` |
| Application | `frontend/src/lib/escrow.ts` (new), `wagmi.ts`, `api.ts`, `genlayer.ts`, and the `CreateMarket` / `MarketDetail` / `Portfolio` / `AdjudicationResult` pages |

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
  `DATABASE_URL`. Migrations `001`–`009` applied at migration time; `010` was added and applied
  on 2026-09-16 (see below).
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
  run against a real Postgres container with all migrations applied (`001`–`009` at migration
  time; re-run at 17/17 after each of the 2026-09-16 fixes with `010` included). Frontend and
  contract suites were not re-run after the 2026-09-16 commits, which didn't touch them.
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

## Live E2E verification (2026-09-15 → 2026-09-16)

Run against the live deployment (`chronix-markets-api.fly.dev`, GenLayer contract
`0x9e09470D7e3D0cf044E27060Db57f39517b76984`, escrow `0xeCA7236a62bf3c17e31B168692CA1871eCee91eB`)
using two throwaway wallets, with every user-facing step signed by the user wallet: SIWE login,
`POST /markets`, `ChronixEscrow.fund()`, `submit_evidence_pointer`, `claim()`. No owner or admin
call was part of either flow. The relayer's own GenLayer writes (`create_market`, `stake`,
`cancel_market`) were driven by the backend relay job, not by hand.

**Test 1 — create → fund pool → stake YES → evidence.** Market `da72b8a0-02ea-4e88-b55f-4d48fa08aa0d`
("Will a fusion power plant achieve sustained net energy gain at commercial scale before
2030?"), GenLayer id `1`.
- Pool: 1 USDC `fund(KIND_POOL)` (`0xcedc16dc…`, block 46852001) → relayed to `create_market`;
  on-chain `get_market(1)` shows `pool_deposited: 1000000`, `status: active`.
- Stake: 1 USDC `fund(KIND_YES)` from a second wallet (`0x55070e1f…`, block 46888381) → relayed to
  `stake`; on-chain `total_yes: 1000000`.
- Evidence: `submit_evidence_pointer` signed directly by the creator wallet
  (`0x81b88b7c…`, `execution_result: SUCCESS`), then mirrored to Postgres.

**Test 2 — create → fund pool → cancel request → refund claim.** Market
`3dd818c9-9dbf-464b-afe4-fed632cbc8af` ("…room-temperature ambient-pressure superconductor…"),
GenLayer id `4`.
- Pool: 1 USDC `fund(KIND_POOL)` (`0x411be85d…`, block 46888675) → relayed to `create_market`.
- Creator called `POST /markets/:id/cancel-request`; the relay job drove `cancel_market` on
  GenLayer and pushed the refund onto `ChronixEscrow.setPayouts`; market reached `cancelled`.
- `GET /markets/:id/claimable/:wallet` returned `1000000`; the creator called
  `ChronixEscrow.claim()` directly (`0xbac47f74…`, block 46888776, status 1). Escrow
  `getClaimable` afterwards: `0`. This exercised the full payout round trip, including reading
  `cancel_market`'s return value from the receipt.

**What the E2E runs did not cover.** The minimum market horizon is 3 years
(`VALID_HORIZONS = (3, 5, 10, 0)`), so `request_adjudication` → `settle` → `claim_payout` for a
decided verdict, and `claim_timeout_refund`, were not run live. Those paths are covered by the 35
pure-logic contract tests only.

## Post-migration fixes found by live E2E testing

Commits `0465feb` and `0f7a572`. The migration commit passed lint, typecheck and all tests; these
were only visible against real chain behaviour. The contract logic itself was not the problem —
all six are in the backend's relay/client layer or its configuration.

1. **GenLayer RPC daily quota exhausted by idle polling.** `CHAIN_RECONCILER_INTERVAL_MS` drives
   both the chain-write reconciler and the chain indexer; each indexer tick costs at least one
   `gen_call` (`get_market_count()`). At the 15s default, 2 machines cost ~11,520 calls/day idle
   against GenLayer Studio's shared 5,000/day cap, so relay writes failed with `Rate limit
   exceeded: 5000 requests per day`. Default raised to 180s (≈960 idle calls/day) in
   `backend/src/config.ts` and `.env.example`, and set as a Fly secret on `chronix-markets-api`.
2. **Deposits stranded forever by the scan watermark.** `baseRelay.ts` advanced
   `base_relay_watermark` every tick regardless of downstream success and only matched pending
   markets/positions against that tick's freshly fetched events, so one transient GenLayer
   failure permanently lost a deposit. New migration
   [`010_base_relay_events.sql`](database/migrations/010_base_relay_events.sql) persists every
   scanned `Funded` event in `base_relay_events`, and `relayPendingPools`/`relayPendingStakes`
   match against that table on every pass, so failures retry until they succeed.
3. **Numeric arguments sent as strings.** `create_market`'s `poolDeposited` and `stake`'s `amount`
   were passed to `genlayer-js` as JS strings, encoded as quoted strings in calldata, so GenVM
   raised `TypeError: '<=' not supported between instances of 'str' and 'int'` inside the
   contract on every real call. Now passed as `BigInt`. Verified: `create_market` succeeded and
   `get_market` returned `pool_deposited: 1000000`.
4. **Wrong receipt field, and silent execution failures.** `claimPayout`/`claimTimeoutRefund`/
   `cancelMarket` read `receipt.result` as the payout amount; that field is the consensus enum
   (`6` = `MAJORITY_AGREE`). The real return value is at
   `consensus_data.leader_receipt[mode=leader].result.payload.readable`
   (`getLeaderReturnValue`). A receipt that resolved with a GenVM execution error was also
   treated as success, which persisted a bogus `contract_market_id: -1`; every write whose result
   is stored now goes through `assertReceiptSucceeded`. The documented
   `getTransactionTrace` fallback does not work on this endpoint (see follow-ups).
5. **Stake deposits never matched their position.** `positions.shares` is `NUMERIC(38,18)`, so
   `pg` returns `"1000000.000000000000000000"`; the match against the event's plain integer
   amount used string equality and never succeeded. Compared as `BigInt` now.
6. **Double-relay race across the 2 Fly machines.** `baseRelay.ts` runs on every machine with no
   coordination, so both could submit a real `create_market` for the same pending market and only
   one Postgres update would win, leaving a duplicate on-chain market with no matching row. Each
   row's full GenLayer write + Postgres update now runs inside a transaction-scoped advisory lock
   (`pg_try_advisory_xact_lock(hashtext(id))`, non-blocking, in `withRowLock`), applied to pool,
   stake, requested-cancellation and payout relays. This holds one pooled DB connection for the
   duration of an on-chain write, which is acceptable at this system's volume and should be
   revisited under real load.

## Test-data cleanup

- Three markets stranded by bug 2 (`4fe0087f…`, `559ab01b…`, `661a81c0…`) held 11 USDC in the
  escrow with no GenLayer market. Recovered with `ChronixEscrow.withdrawUnallocated`
  (owner-only; the relayer key is also the escrow owner): `0x229049d2…`, `0xe9390fcb…`,
  `0x324d0cbb…`. Their Postgres rows were deleted; they never reached GenLayer, so nothing
  re-creates them.
- GenLayer contracts are immutable, so the duplicate/diagnostic on-chain markets (ids `0`, `2`,
  `3`: one manual diagnostic `create_market` call and two duplicates from bug 6) cannot be removed.
  The chain indexer treats on-chain state as truth and re-backfills them as Postgres rows if
  deleted. They carry no escrow deposit under their own keys, so no funds are involved. Production
  currently has 5 market rows: the 2 E2E markets above plus these 3 backfilled artifacts. Test 1's
  market still holds its live 2 USDC (pool + stake) in the escrow.
- The throwaway test wallets' keys were discarded after the runs.

## Known follow-up work

- **Settlement and timeout-refund paths unverified live.** See "What the E2E runs did not cover"
  above. `claim_payout` and `claim_timeout_refund` use the same `getLeaderReturnValue` helper as
  the verified `cancel_market` path, but have not been run against a settled market.
- **`getTransactionTrace` always returns `null`.** The GenLayer Studio endpoint does not
  implement `gen_dbg_traceTransaction` (`Method not found`), so `GET /markets/:id/trace` and the
  execution-trace panel on the Adjudication Result page never have data. Failures are handled
  gracefully, but the feature is effectively inactive on this endpoint.
- **SIWE nonces are in-memory per machine.** With 2 machines behind the load balancer,
  `/auth/nonce` and `/auth/verify` can land on different machines, giving an intermittent
  `401 Nonce missing or expired`, seen repeatedly during E2E runs (a retry succeeds). Needs a
  shared nonce store (Postgres) or sticky routing.
- **`KEEPER_INTERVAL_MS` is dead config.** Defined in `config.ts` and `.env.example`, referenced
  nowhere; the keeper actions run via the chain reconciler.
- **`VITE_CHRONIX_ESCROW_ADDRESS` appears unused in frontend source.** The escrow address comes
  from `GET /markets/:id/escrow` at funding time; the variable is set in Vercel and
  `.env.example` but nothing reads it.
- **Pending+funded+cancelled edge case.** If a user funds a `pending_chain` market and the creator
  requests cancellation before the relay job mirrors that deposit onto GenLayer, the deposit has no
  GenLayer market to compute a refund against. Narrow race, no automated recovery; the owner-only
  `withdrawUnallocated` is the manual escape hatch (used for real in the cleanup above).
- **Relay holds a DB connection across an on-chain write** (the advisory-lock tradeoff in bug 6);
  revisit if pending volume grows.

Resolved since the original write-up of this milestone: the `genlayer-js` write-receipt
return-value shape (bug 4), the missing full relay dry-run (the E2E runs above), and the Vercel
production env vars/deployment (all `VITE_*` variables were updated on 2026-09-14 and the live
`chronix-app.vercel.app` bundle references the current GenLayer contract and backend).
