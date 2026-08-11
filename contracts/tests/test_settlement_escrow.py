"""
Contract tests for the settlement and escrow paths flagged in code review:

  - verdict derivation requires source agreement (pure_decide_verdict)
  - failed/unreachable fetches must not count toward the source total
    (simulated here at the pure layer: a failed fetch = simply absent
    from the tally, since that's what the gl-dependent fetch_and_classify
    now does — see chronix.py's fetch_and_classify exception handler)
  - staking closes at the deadline (pure_can_stake)
  - every eligible participant can complete a timeout refund, not just
    the first claimant (pure_can_claim_timeout_refund)
  - payout math for winner-take and split-verdict payouts
  - evidence provenance (allowed source types) and deduplication

These import only the pure_* helpers and constants from chronix.py (via
_pure.py, which execs the gl-free slice of the real file directly — see
its docstring) — no GenVM/genlayer package required. gl-dependent methods
(stake, settle, claim_payout, claim_timeout_refund themselves) need the
`gltest` harness / GenLayer Studio to execute; this file only covers the
decision logic they delegate to.
"""

import pytest

from _pure import (
    ADJUDICATION_GRACE_SECONDS,
    MIN_EVIDENCE_SOURCE_CATEGORIES,
    SOURCE_AGREEMENT_THRESHOLD_BPS,
    STATUS_ACTIVE,
    STATUS_AWAITING_ADJUDICATION,
    STATUS_CANCELLED,
    STATUS_REFUNDED_TIMEOUT,
    STATUS_SETTLED_YES,
    VERDICT_NO,
    VERDICT_SPLIT,
    VERDICT_UNDETERMINED,
    VERDICT_YES,
    pure_can_claim_timeout_refund,
    pure_can_stake,
    pure_compute_source_agreement_bps,
    pure_compute_split_payout,
    pure_compute_winner_payout,
    pure_decide_verdict,
    pure_is_allowed_source_type,
    pure_is_duplicate_url,
    pure_validate_positive,
)


# ---------------------------------------------------------------------------
# Verdict derivation requires validator agreement
# ---------------------------------------------------------------------------

class TestDecideVerdict:
    def test_clear_yes_majority(self):
        assert pure_decide_verdict(yes_votes=3, no_votes=0, total_sources=3) == VERDICT_YES

    def test_clear_no_majority(self):
        assert pure_decide_verdict(yes_votes=0, no_votes=3, total_sources=3) == VERDICT_NO

    def test_below_threshold_is_split_not_a_forced_winner(self):
        # 1 of 3 for YES (~33%) is below the 60% threshold, and NO's 1 of 3
        # is too — neither side clears the bar, so this must not be forced
        # to a winner just because YES > NO numerically.
        assert pure_decide_verdict(yes_votes=1, no_votes=1, total_sources=3) == VERDICT_SPLIT

    def test_exact_threshold_boundary_wins(self):
        # 6000 bps (60%) is defined as inclusive ("yes_bps >= threshold_bps").
        assert SOURCE_AGREEMENT_THRESHOLD_BPS == 6000
        assert pure_decide_verdict(yes_votes=3, no_votes=0, total_sources=5) == VERDICT_YES  # 60%

    def test_tie_is_split(self):
        assert pure_decide_verdict(yes_votes=2, no_votes=2, total_sources=4) == VERDICT_SPLIT

    def test_too_few_sources_is_undetermined_regardless_of_agreement(self):
        assert MIN_EVIDENCE_SOURCE_CATEGORIES == 3
        # Even 100% agreement can't produce a real verdict below the floor —
        # this is the backstop that protects against a market being decided
        # off one or two sources.
        assert pure_decide_verdict(yes_votes=2, no_votes=0, total_sources=2) == VERDICT_UNDETERMINED

    def test_all_neither_is_split_once_floor_is_met(self):
        assert pure_decide_verdict(yes_votes=0, no_votes=0, total_sources=3) == VERDICT_SPLIT


class TestSourceAgreementBps:
    def test_zero_total_is_zero_not_a_crash(self):
        assert pure_compute_source_agreement_bps(agreeing_sources=0, total_sources=0) == 0

    def test_full_agreement_is_10000_bps(self):
        assert pure_compute_source_agreement_bps(agreeing_sources=4, total_sources=4) == 10000


class TestFailedFetchExclusion:
    """
    fetch_and_classify (gl-dependent, not directly testable here) now
    `continue`s WITHOUT incrementing `total` on a fetch exception — a dead
    link is excluded from the tally entirely rather than counted as a
    silent "neither" vote. These cases exercise pure_decide_verdict with
    the totals that behavior actually produces, proving a market with
    strong real evidence isn't sunk by unrelated dead links, while a
    market that's ACTUALLY under-evidenced still correctly comes back
    UNDETERMINED.
    """

    def test_two_dead_links_excluded_leaves_a_clean_yes_verdict(self):
        # 5 sources submitted, 2 fail to fetch (excluded, not counted) and
        # never reach fetch_and_classify's vote-casting step, leaving 3
        # real, unanimous YES sources — the OLD behavior (counting failures
        # toward total) would have produced total=5, agreement=60% exactly
        # on the boundary; excluding them makes intent unambiguous instead
        # of accidentally boundary-dependent.
        assert pure_decide_verdict(yes_votes=3, no_votes=0, total_sources=3) == VERDICT_YES

    def test_all_but_one_source_dead_is_undetermined(self):
        # Only 1 source actually resolved — below the floor, must not
        # produce a decisive verdict off a single fetch.
        assert pure_decide_verdict(yes_votes=1, no_votes=0, total_sources=1) == VERDICT_UNDETERMINED


# ---------------------------------------------------------------------------
# Staking closes at the deadline
# ---------------------------------------------------------------------------

class TestCanStake:
    def test_active_before_deadline_can_stake(self):
        assert pure_can_stake(STATUS_ACTIVE, now_ts=100, resolves_at=200) is True

    def test_active_after_deadline_cannot_stake(self):
        # This is the exact bug fixed: status alone (still "active" because
        # nobody has called request_adjudication yet) must not be enough —
        # wall-clock time past resolves_at closes staking regardless.
        assert pure_can_stake(STATUS_ACTIVE, now_ts=300, resolves_at=200) is False

    def test_active_exactly_at_deadline_cannot_stake(self):
        assert pure_can_stake(STATUS_ACTIVE, now_ts=200, resolves_at=200) is False

    def test_non_active_status_cannot_stake_even_before_deadline(self):
        assert pure_can_stake(STATUS_AWAITING_ADJUDICATION, now_ts=100, resolves_at=200) is False


# ---------------------------------------------------------------------------
# Every eligible participant can complete a timeout refund
# ---------------------------------------------------------------------------

class TestCanClaimTimeoutRefund:
    def test_within_grace_window_cannot_claim(self):
        assert pure_can_claim_timeout_refund(
            STATUS_AWAITING_ADJUDICATION, now_ts=100, adjudication_requested_at=50
        ) is False

    def test_first_claimant_after_grace_window_can_claim(self):
        now = 50 + ADJUDICATION_GRACE_SECONDS + 1
        assert pure_can_claim_timeout_refund(
            STATUS_AWAITING_ADJUDICATION, now_ts=now, adjudication_requested_at=50
        ) is True

    def test_second_claimant_after_status_flips_to_refunded_timeout_can_still_claim(self):
        # This is the exact bug: claim_timeout_refund() flips market.status
        # to refunded_timeout after the FIRST successful claim. Every
        # subsequent eligible staker calling this must still be accepted —
        # payout_claimed[] (per-wallet, checked separately by the caller)
        # is what actually prevents a double-claim, not market.status.
        now = 50 + ADJUDICATION_GRACE_SECONDS + 1
        assert pure_can_claim_timeout_refund(
            STATUS_REFUNDED_TIMEOUT, now_ts=now, adjudication_requested_at=50
        ) is True

    def test_cancelled_market_never_eligible(self):
        now = 50 + ADJUDICATION_GRACE_SECONDS + 1
        assert pure_can_claim_timeout_refund(
            STATUS_CANCELLED, now_ts=now, adjudication_requested_at=50
        ) is False

    def test_settled_market_never_eligible(self):
        # A real verdict was reached — claim_payout is the correct path,
        # not a timeout refund, even long after the grace window.
        now = 50 + ADJUDICATION_GRACE_SECONDS + 1
        assert pure_can_claim_timeout_refund(
            STATUS_SETTLED_YES, now_ts=now, adjudication_requested_at=50
        ) is False


# ---------------------------------------------------------------------------
# Payout math (escrow correctness)
# ---------------------------------------------------------------------------

class TestWinnerPayout:
    def test_pro_rata_share_of_losing_pool_and_deposit(self):
        # 2 winners split 100 YES 50/50; 100 NO all goes to winners; +20 pool.
        payout = pure_compute_winner_payout(
            user_stake=50, winning_total=100, losing_total=100, pool_deposited=20
        )
        assert payout == (50 * 220) // 100  # 110

    def test_zero_amount_raises(self):
        with pytest.raises(ValueError):
            pure_compute_winner_payout(user_stake=0, winning_total=100, losing_total=0, pool_deposited=0)

    def test_degenerate_zero_winning_total_returns_principal(self):
        # Guarded branch: shouldn't happen if this user has stake > 0 on the
        # winning side, but must never divide by zero.
        assert pure_compute_winner_payout(
            user_stake=50, winning_total=0, losing_total=0, pool_deposited=0
        ) == 50


class TestSplitPayout:
    def test_principal_plus_pro_rata_pool_share(self):
        payout = pure_compute_split_payout(
            user_yes=30, user_no=20, total_yes=300, total_no=200, pool_deposited=100
        )
        # principal back (50) + pro-rata share of pool_deposited (50/500 * 100 = 10)
        assert payout == 60

    def test_zero_stake_raises(self):
        with pytest.raises(ValueError):
            pure_compute_split_payout(user_yes=0, user_no=0, total_yes=100, total_no=100, pool_deposited=10)

    def test_no_stakes_at_all_returns_zero_not_a_crash(self):
        assert pure_compute_split_payout(user_yes=0, user_no=0, total_yes=0, total_no=0, pool_deposited=10) == 0


class TestValidatePositive:
    def test_second_claim_after_zeroing_reverts(self):
        # This is the core reentrancy/double-claim guard: after a payout
        # path zeros the ledger field, a replayed call reads 0 and must
        # revert here rather than silently no-op or transfer twice.
        with pytest.raises(ValueError):
            pure_validate_positive(0)


# ---------------------------------------------------------------------------
# Evidence provenance + deduplication
# ---------------------------------------------------------------------------

class TestSourceProvenance:
    def test_allowed_type_passes(self):
        assert pure_is_allowed_source_type("news,academic", "news") is True

    def test_case_and_whitespace_insensitive(self):
        assert pure_is_allowed_source_type("news, Academic ", "ACADEMIC") is True

    def test_disallowed_type_rejected(self):
        assert pure_is_allowed_source_type("news,academic", "social") is False

    def test_empty_allow_list_means_unrestricted(self):
        # Markets created before this field existed, or with a blank value,
        # must not be retroactively broken.
        assert pure_is_allowed_source_type("", "anything") is True


class TestEvidenceDeduplication:
    def test_exact_duplicate_rejected(self):
        existing = ["https://example.com/a"]
        assert pure_is_duplicate_url(existing, "https://example.com/a") is True

    def test_case_and_whitespace_insensitive_duplicate(self):
        existing = ["https://example.com/a"]
        assert pure_is_duplicate_url(existing, "  HTTPS://EXAMPLE.COM/A  ") is True

    def test_distinct_url_not_a_duplicate(self):
        existing = ["https://example.com/a"]
        assert pure_is_duplicate_url(existing, "https://example.com/b") is False

    def test_empty_existing_list_never_flags_duplicate(self):
        assert pure_is_duplicate_url([], "https://example.com/a") is False
