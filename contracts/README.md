# chronix.py — GenLayer Intelligent Contract

Single Intelligent Contract for Chronix, targeting GenLayer Studio /
StudioNet, gas token GEN. Not yet deployed — deploy manually and set
`CONTRACT_ADDRESS` in `.env` once you have an address.

## File layout

`contracts/chronix.py` is split into two halves:

1. **Pure logic** (top of file, above `# END PURE LOGIC`) — plain Python
   functions with no `gl.*` calls, no storage access, no nondeterminism.
   These implement the state machine, payout math, and key-building
   helpers, and are meant to be imported and unit-tested directly with
   pytest (GenVM itself cannot run inside a normal pytest process).
2. **Contract** — the `Chronix(gl.Contract)` class. Every write method
   is a thin adapter around the pure helpers, plus the `gl.*` calls that
   actually touch storage, `gl.message`, or nondeterministic web/LLM
   primitives.

## State machine

```
created -> active (accepting stakes)
active -> awaiting_adjudication      (request_adjudication, deadline-gated on-chain)
active -> cancelled                  (cancel_market, creator-only, pre-participation only)
awaiting_adjudication -> settled_yes | settled_no | settled_split   (settle)
awaiting_adjudication -> refunded_timeout                            (claim_timeout_refund, after grace window)
```

Every write method validates the current status before acting and reverts
with `gl.vm.UserError` if the action is illegal for that state
(`pure_validate_transition`, `pure_can_stake`, `pure_can_cancel`,
`pure_can_request_adjudication`, `pure_can_settle`,
`pure_can_claim_timeout_refund`).

## Public methods

| Method | Type | Description |
|---|---|---|
| `create_market(question, category, horizon_years, resolution_criteria, allowed_evidence_types)` | payable write | Seeds `pool_deposited` from `gl.message.value`. Rejects `<= 0`. `horizon_years` in `{3, 5, 10, 0}` (0 = permanent). Returns new `market_id`. |
| `stake(market_id, side)` | payable write | Records a YES/NO stake from `gl.message.value` only — never trusts a caller-supplied amount. |
| `submit_evidence_pointer(market_id, source_type, url)` | write | Stores a pointer. Never trusted as fact — only `settle`'s own fetch is authoritative. |
| `request_adjudication(market_id)` | write | Reverts unless `now >= resolves_at`, using a nondet-cross-validated time source (see below). On-chain enforced, not a backend cron. |
| `settle(market_id)` | write | Fetches real evidence across news / academic / financial source categories, classifies each via LLM, and requires a basis-points agreement threshold (not strict equality) across leader/validators. Produces `YES`, `NO`, or `SPLIT`. |
| `claim_payout(market_id)` | write | Pays out a settled market's winnings. Zeroes the caller's stake ledger fields and persists that BEFORE calling `_send_gen`. |
| `claim_timeout_refund(market_id)` | write | Backstop: if `settle` never completes within the grace window, any staker can reclaim their own stake. Same zero-before-transfer ordering. |
| `cancel_market(market_id)` | write | Creator-only, pre-participation-only (`total_yes == total_no == 0`). Refunds `pool_deposited` to creator. |
| `get_market(market_id)` | view | Full market snapshot as a dict. |
| `get_market_count()` | view | Number of markets created. |
| `get_stake(market_id, wallet)` | view | A wallet's YES/NO stake + claimed flag. |
| `get_evidence(market_id, index)` / `get_all_evidence(market_id)` | view | Submitted evidence pointers. |

## Exit paths (money movement)

All five exit paths funnel through the single `_send_gen` helper, and all
five follow the same ordering: **read ledger field(s) into locals → zero
the ledger field(s) in storage → persist that write → only then transfer.**
This is what prevents a second call (reentrant or simply repeated) from
transferring twice: after zeroing, a repeat call reads `0` and reverts via
`pure_validate_positive`.

1. `claim_payout` — settle=YES: winners split principal + losers' pool +
   creator's liquidity pro-rata (`pure_compute_winner_payout`).
2. `claim_payout` — settle=NO: mirror of the above for NO stakers.
3. `claim_payout` — settle=SPLIT: both sides get principal back plus a
   pro-rata share of the creator's liquidity (`pure_compute_split_payout`).
4. `claim_timeout_refund` — adjudication requested but never completed
   within the grace window; any staker reclaims their own stake only.
5. `cancel_market` — creator reclaims `pool_deposited` before any stakes
   exist.

## Notable implementation choices / fallbacks

Docs consulted: `docs.genlayer.com/developers/intelligent-contracts/{introduction,storage,equivalence-principle}`
plus a real contract (`football_bets.py`) generated locally by the
official `genlayer` CLI (v0.39.2, `genlayer new`), used to confirm exact
call spellings (`gl.message.sender_address`, `gl.get_webpage(url, mode="text")`,
`gl.exec_prompt(prompt)`, `TreeMap`, `@allow_storage @dataclass`).

Two things were **not** confirmed in the crawlable docs reached during
research, so this contract uses the documented fallback patterns
specified in the build brief rather than guessing at unconfirmed syntax:

- **Native GEN transfer**: `_send_gen` uses a `@gl.evm.contract_interface`
  shim (`_GenRecipient.emit_transfer(value=amount)`), the standard
  documented GenVM value-transfer chokepoint pattern.
- **Contract-visible time**: no deterministic on-chain clock primitive was
  confirmed, so `_now()` fetches a real UTC time API inside a
  nondeterministic block and requires leader/validator agreement within a
  180-second tolerance (the documented "numeric tolerance" equivalence
  pattern, applied to a timestamp instead of a price). This can only make
  a deadline check *more* conservative — it never trusts a caller-supplied
  timestamp.

Both are called out inline in `chronix.py` with full reasoning; there
are no unresolved TODOs in the file.

## Testing

Pure functions (prefixed `pure_`) in the top half of `chronix.py` are
plain Python and can be imported directly by pytest — no GenVM required.
gl-dependent methods require the GenLayer `gltest` harness / GenLayer
Studio to execute.

`contracts/tests/` covers the settlement and escrow paths this way:
`_pure.py` execs just the pure-logic slice of `chronix.py` (between the
`SECTION 0` and `END PURE LOGIC` banner comments) into an isolated
namespace — no `genlayer` package needed, and no risk of a hand-copied
duplicate of the logic silently drifting from the real contract.
`test_settlement_escrow.py` then exercises verdict derivation and the
agreement threshold, the effect of excluding a failed/unreachable fetch
from the source tally, the staking-deadline cutoff, timeout-refund
eligibility for every claimant (not just the first), winner/split payout
math, the reentrancy/double-claim guard, and evidence provenance
(allowed source types) + URL deduplication. Run with:

```bash
cd contracts && python3 -m pytest tests/ -v
```

gl-dependent behavior that these pure-logic tests can't reach directly —
e.g. that `settle`'s `validator_fn` actually calls `pure_decide_verdict`
on both the leader's and its own tally and rejects a mismatch, or that
`fetch_and_classify`'s `except` branch really does skip incrementing
`total` — is covered by direct unit tests on the underlying pure
functions with the exact inputs those code paths would produce (see
`TestFailedFetchExclusion`, `TestDecideVerdict`), plus needs a real
`gltest`/Studio run before trusting a new deployment, same as any other
nondet-block behavior in this file.
