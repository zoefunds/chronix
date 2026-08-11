# Payout-core review — response and fix log

**Review received (2026-08-11):**

> The payout core needs correction before this can receive project credit: require validator
> agreement on the derived verdict, exclude failed fetches, close staking at the deadline, and
> let every eligible participant complete a timeout refund. Add contract tests for those
> settlement and escrow paths, then strengthen source provenance and deduplication.

**Status: all six items fixed, tested, and live.** Deployed to a new contract address
(GenVM contracts are immutable — a code fix always requires a fresh deployment, never a patch)
and the database has been cleared of markets tied to the previous address. See
[Deployment](#deployment) below for the address and what changed alongside it.

All fixes are in [`contracts/chronix.py`](contracts/chronix.py) unless noted. Every pure-logic
change has a corresponding test in [`contracts/tests/test_settlement_escrow.py`](contracts/tests/test_settlement_escrow.py)
(35 tests, all passing — run with `cd contracts && python3 -m pytest tests/ -v`).

---

## 1. Require validator agreement on the derived verdict

**Before:** `settle()`'s `validator_fn` only checked that the leader's and validator's raw vote
*tallies* were close (each of YES/NO/NEITHER within ±1). It never checked that the two tallies
actually decided to the *same verdict*. Two tallies that are each individually within tolerance
of each other can still land on opposite sides of `SOURCE_AGREEMENT_THRESHOLD_BPS` (60%) and
produce different verdicts — and the verdict, not the raw counts, is what gets written to
`market.verdict` and paid out against.

**Fix:** `validator_fn` now additionally computes `pure_decide_verdict(...)` independently for
both the leader's and the validator's own tally and requires an **exact match**, on top of (not
instead of) the existing tally-closeness check.

```python
leader_verdict = pure_decide_verdict(leader_votes["YES"], leader_votes["NO"], leader_data["total"])
validator_verdict = pure_decide_verdict(validator_votes["YES"], validator_votes["NO"], validator_data["total"])
return leader_verdict == validator_verdict
```

**Tests:** `TestDecideVerdict` (verdict-derivation correctness at every boundary: clear
majority, below-threshold, exact-threshold, tie, too-few-sources).

## 2. Exclude failed fetches

**Before:** `fetch_and_classify`'s exception handler incremented `total` before `continue`ing
on an unreachable source — a dead link was counted toward the agreement *denominator* as a
silent "neither" vote, even though it was never actually consulted. This let one or two broken
links dilute an otherwise-decisive set of real evidence toward SPLIT/UNDETERMINED, and opened a
griefing vector (seed a market with dead links to force a bad outcome).

**Fix:** the exception handler now `continue`s without touching `total` at all — a failed fetch
is excluded entirely, exactly as if it was never attempted. `MIN_EVIDENCE_SOURCE_CATEGORIES`
(the existing floor inside `pure_decide_verdict`) is what correctly still returns
`UNDETERMINED` if too few sources end up *usable* — that's the right place to catch
"not enough real evidence," not by penalizing a good source list for someone else's broken link.

**Tests:** `TestFailedFetchExclusion` (exercises `pure_decide_verdict` with the totals this
behavior actually produces — a market with real evidence isn't sunk by dead links alongside
it, while a genuinely under-evidenced market still correctly comes back `UNDETERMINED`).

## 3. Close staking at the deadline

**Before:** `pure_can_stake(status)` only checked `status == STATUS_ACTIVE`. Since the
`active -> awaiting_adjudication` transition only happens when *someone* calls
`request_adjudication`, staking silently stayed open past `resolves_at` for as long as nobody
bothered to call it — letting late stakers stake with post-deadline information and shift
payout shares for everyone already in.

**Fix:** `pure_can_stake` now takes `(status, now_ts, resolves_at)` and additionally requires
`not pure_is_deadline_passed(now_ts, resolves_at)`. `stake()` calls `self._now()` — the same
cross-validated nondet time read `request_adjudication` already used — before checking it.

**Tests:** `TestCanStake` (active-before-deadline, active-after-deadline, exactly-at-deadline,
non-active-status).

## 4. Let every eligible participant complete a timeout refund

**Before:** `pure_can_claim_timeout_refund` only accepted `status ==
STATUS_AWAITING_ADJUDICATION`. The **first** successful `claim_timeout_refund()` call flips
`market.status` to `STATUS_REFUNDED_TIMEOUT` as a UI signal — which meant every staker who
tried to claim *after* that first call was wrongly rejected by this exact status check, even
though they'd never claimed and were still fully eligible.

**Fix:** now accepts status in `(STATUS_AWAITING_ADJUDICATION, STATUS_REFUNDED_TIMEOUT)`. The
actual double-claim guard was never `market.status` — it's the per-wallet `payout_claimed[]`
flag, which this change doesn't touch.

**Tests:** `TestCanClaimTimeoutRefund` (within grace window, first claimant, **second claimant
after the status flip** — the exact bug — plus cancelled/settled markets correctly excluded).

## 5. Contract tests for settlement and escrow paths

New: [`contracts/tests/`](contracts/tests) — `_pure.py` execs just the pure-logic slice of
`chronix.py` (between the `SECTION 0` and `END PURE LOGIC` banner comments) into an isolated
namespace, since the real `genlayer` package isn't installed locally (GenVM runs inside
GenLayer Studio's own sandbox) and the file's first line is `from genlayer import *`. This
avoids hand-copying the logic into a test-only duplicate that could silently drift from the
real contract. `test_settlement_escrow.py` covers items 1–4 and 6 above, plus payout math
(`TestWinnerPayout`, `TestSplitPayout`) and the reentrancy/double-claim guard
(`TestValidatePositive`). 35 tests, all passing.

## 6. Strengthen source provenance and deduplication

**Before:** `submit_evidence_pointer` accepted any non-empty `source_type` string with no
validation against anything, and never checked for duplicate URLs — anyone could tag a pointer
with an arbitrary category, or submit the same URL repeatedly (by accident or to pad a market's
apparent evidence count / weight a fetch toward one URL by sheer repetition).

**Fix:** two new pure helpers, both enforced in `submit_evidence_pointer`:
- `pure_is_allowed_source_type(allowed_evidence_types, source_type)` — rejects a `source_type`
  that isn't one of the categories the market's creator configured at `create_market` time. An
  empty/unset allow-list is treated as "no restriction" so pre-existing markets aren't broken.
- `pure_is_duplicate_url(existing_urls, url)` — case/whitespace-insensitive exact match against
  every URL already recorded for that market; rejects a repeat submission.

**Consequence this surfaced (fixed alongside it):** `allowed_evidence_types` was only ever
stored on-chain — Postgres never mirrored it, so the frontend's evidence-source dropdown had no
way to know what the contract would now actually accept. Fixed by mirroring it end-to-end:
new migration `database/migrations/007_market_allowed_evidence_types.sql`, threaded
`allowedEvidenceSources` through `POST /markets`'s schema/route/`insertMarket` and the chain
indexer's `insertMarketFromChain` backfill path, and `MarketDetail.tsx`'s evidence-source
`<select>` now filters to `market.allowed_evidence_types` (falling back to the full list when
unset, matching the contract's own "empty = unrestricted" behavior) so the UI can never offer
an option the contract will revert.

**Tests:** `TestSourceProvenance`, `TestEvidenceDeduplication`.

---

## Deployment

- **Contract**: redeployed by the project owner (this repo never deploys the contract — see
  [`contracts/README.md`](contracts/README.md)) to a new address, since GenVM contracts are
  immutable: `0xda22B6c11d3709d8Fb446C2aFf569991fC4ACE39` (GenLayer Studio/StudioNet),
  superseding `0x0a58dAb6DCE66124CE28D79Af4124BaB85A100ED` (v3 — worked correctly, just
  predates these fixes). Wired into every `.env`/`.env.example`, the `chronix-backend` Fly
  secret `CONTRACT_ADDRESS`, and the Vercel production env var `VITE_CONTRACT_ADDRESS`.
- **Database**: fully cleared of markets created against the old address (`DELETE FROM
  markets`, cascading to `positions`/`evidence`/`market_events`/`chain_sync_queue`) — those
  rows' `contract_market_id`s pointed at markets on an abandoned contract and would have
  silently mismatched against v4's fresh `market_count` sequence otherwise.
- **Backend**: redeployed to Fly (`chronix-backend`, both machines) with the code changes
  above plus the new contract address.
- **Frontend**: redeployed to Vercel (`chronix-app.vercel.app`) with the new
  `VITE_CONTRACT_ADDRESS` baked into the build.

See [`MEMORY.md`](MEMORY.md) for the full deployment history and dated session log.
