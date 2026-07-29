# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

import json
from dataclasses import dataclass
from genlayer import *


# ==========================================================================
# SECTION 0 — CONSTANTS
# ==========================================================================

# Market lifecycle states (explicit state machine — see Section 1).
STATUS_ACTIVE = "active"
STATUS_AWAITING_ADJUDICATION = "awaiting_adjudication"
STATUS_SETTLED_YES = "settled_yes"
STATUS_SETTLED_NO = "settled_no"
STATUS_SETTLED_SPLIT = "settled_split"
STATUS_CANCELLED = "cancelled"
STATUS_REFUNDED_TIMEOUT = "refunded_timeout"

# Stake sides.
SIDE_YES = "YES"
SIDE_NO = "NO"

# Verdicts a settle() can produce.
VERDICT_YES = "YES"
VERDICT_NO = "NO"
VERDICT_SPLIT = "SPLIT"
VERDICT_UNDETERMINED = "UNDETERMINED"

# Horizon codes accepted by create_market (years; 0 == permanent).
VALID_HORIZONS = (3, 5, 10, 0)
SECONDS_PER_YEAR = 365 * 24 * 60 * 60
# "Permanent" markets still need a concrete resolves_at so the on-chain
# deadline guard has something to compare against. We use a long horizon
# (100 years) rather than "never", so a permanent market can still,
# eventually, be adjudicated instead of locking funds forever.
PERMANENT_HORIZON_YEARS = 100

# Grace window (seconds) after adjudication is requested during which the
# nondet settle() is expected to complete. If it hasn't completed by then,
# any staker may reclaim their own stake via claim_timeout_refund.
ADJUDICATION_GRACE_SECONDS = 7 * 24 * 60 * 60  # 7 days

# Tolerance (seconds) allowed between the leader's and each validator's
# independently-fetched wall-clock reading when cross-validating "has the
# deadline passed" in request_adjudication. See module docstring: this is
# the documented "numeric tolerance" equivalence pattern applied to time.
TIME_CONSENSUS_TOLERANCE_SECONDS = 180

# Minimum number of independent evidence source categories settle() must
# consult. Required categories: news, academic/reports, financial/market
# data (per product brief). A market may have more, never fewer.
MIN_EVIDENCE_SOURCE_CATEGORIES = 3
REQUIRED_SOURCE_CATEGORIES = ("news", "academic", "financial")

# Consensus threshold: fraction of consulted sources that must agree with
# the leader's proposed outcome for that outcome to be accepted. This is a
# percentage-threshold comparator, not strict equality, so validators that
# reach a similar-but-not-word-for-word conclusion still reach consensus.
SOURCE_AGREEMENT_THRESHOLD_BPS = 6000  # 60.00%, expressed in basis points

BPS_DENOMINATOR = 10000


# ==========================================================================
# SECTION 1 — PURE LOGIC (no gl.* dependency; unit-testable with plain pytest)
# ==========================================================================
#
# Everything below this banner and above the "END PURE LOGIC" banner must
# stay free of gl.*, storage access, and nondeterminism. A future test
# suite should import this module and call these functions directly.

def pure_make_stake_key(market_id: int, wallet_hex: str) -> str:
    """Build the composite TreeMap key used for a wallet's stake on a market."""
    return f"{market_id}:{wallet_hex.lower()}"


def pure_make_evidence_key(market_id: int, index: int) -> str:
    """Build the composite TreeMap key for the Nth evidence pointer on a market."""
    return f"{market_id}:{index}"


def pure_resolve_horizon_years(horizon_years: int) -> int:
    """
    Normalize the horizon code a creator passes in. 0 means "permanent",
    which we map to a long-but-finite horizon so resolves_at is always a
    concrete, comparable timestamp (see PERMANENT_HORIZON_YEARS).
    """
    if horizon_years not in VALID_HORIZONS:
        raise ValueError(
            f"invalid horizon_years {horizon_years}; must be one of {VALID_HORIZONS}"
        )
    if horizon_years == 0:
        return PERMANENT_HORIZON_YEARS
    return horizon_years


def pure_compute_resolves_at(created_at: int, horizon_years: int) -> int:
    """Deterministic resolves_at computation, given a creation timestamp."""
    years = pure_resolve_horizon_years(horizon_years)
    return created_at + years * SECONDS_PER_YEAR


def pure_is_deadline_passed(now_ts: int, resolves_at: int) -> bool:
    """True once contract/consensus time has reached or passed resolves_at."""
    return now_ts >= resolves_at


def pure_is_within_grace_window(
    now_ts: int, adjudication_requested_at: int, grace_seconds: int = ADJUDICATION_GRACE_SECONDS
) -> bool:
    """True while settle() is still expected to complete on time."""
    if adjudication_requested_at <= 0:
        return False
    return now_ts < (adjudication_requested_at + grace_seconds)


def pure_timestamps_agree(a_ts: int, b_ts: int, tolerance_seconds: int = TIME_CONSENSUS_TOLERANCE_SECONDS) -> bool:
    """
    Numeric-tolerance comparator for cross-validating two independently
    fetched wall-clock readings (leader vs. validator). Mirrors the
    documented equivalence-principle "numeric tolerance" pattern
    (`abs(a - b) / abs(a) <= tolerance`), specialized for timestamps where
    an absolute-seconds tolerance is more meaningful than a relative one.
    """
    return abs(a_ts - b_ts) <= tolerance_seconds


# ---- Explicit state machine -------------------------------------------

# Maps current status -> set of statuses it may legally transition to.
# Anything not listed is illegal and must raise.
ALLOWED_TRANSITIONS = {
    STATUS_ACTIVE: {STATUS_AWAITING_ADJUDICATION, STATUS_CANCELLED},
    STATUS_AWAITING_ADJUDICATION: {
        STATUS_SETTLED_YES,
        STATUS_SETTLED_NO,
        STATUS_SETTLED_SPLIT,
        STATUS_REFUNDED_TIMEOUT,
    },
    STATUS_SETTLED_YES: set(),
    STATUS_SETTLED_NO: set(),
    STATUS_SETTLED_SPLIT: set(),
    STATUS_CANCELLED: set(),
    STATUS_REFUNDED_TIMEOUT: set(),
}


def pure_validate_transition(current_status: str, next_status: str) -> bool:
    """
    Pure state-machine validator. Returns True iff `current_status ->
    next_status` is a legal transition under the lifecycle:
      created -> active(accepting stakes) -> awaiting_adjudication
        -> settled_{yes,no,split} | refunded_timeout
      active -> cancelled (pre-participation only; enforced by caller,
        not by this function, since "zero stakes" is a storage fact)
    """
    allowed = ALLOWED_TRANSITIONS.get(current_status)
    if allowed is None:
        return False
    return next_status in allowed


def pure_can_stake(status: str) -> bool:
    """Stakes are only accepted while a market is active."""
    return status == STATUS_ACTIVE


def pure_can_cancel(status: str, total_yes: int, total_no: int) -> bool:
    """cancel_market is creator-only AND pre-participation-only."""
    return status == STATUS_ACTIVE and total_yes == 0 and total_no == 0


def pure_can_request_adjudication(status: str, now_ts: int, resolves_at: int) -> bool:
    """request_adjudication requires active status AND deadline passed."""
    return status == STATUS_ACTIVE and pure_is_deadline_passed(now_ts, resolves_at)


def pure_can_settle(status: str) -> bool:
    return status == STATUS_AWAITING_ADJUDICATION


def pure_can_claim_timeout_refund(status: str, now_ts: int, adjudication_requested_at: int) -> bool:
    """
    Timeout refund is only legal once the grace window has elapsed WITHOUT
    a completed settle() — i.e. the market is still awaiting_adjudication
    and the grace window is over.
    """
    if status != STATUS_AWAITING_ADJUDICATION:
        return False
    return not pure_is_within_grace_window(now_ts, adjudication_requested_at)


# ---- Payout math --------------------------------------------------------

def pure_validate_positive(amount: int, label: str = "amount") -> None:
    """
    Shared positive-amount guard used at the top of every payout path.
    Raising here on a non-positive amount is what makes a *second* call to
    a payout method (after the ledger field has already been zeroed by the
    first call) cleanly revert instead of silently transferring 0 GEN —
    closing the reentrancy / double-claim window.
    """
    if amount <= 0:
        raise ValueError(f"{label} must be > 0, got {amount}")


def pure_compute_winner_payout(user_stake: int, winning_total: int, losing_total: int, pool_deposited: int) -> int:
    """
    Pro-rata payout for a staker on the WINNING side of a binary settle.
    The winning pool splits: (a) its own principal back, plus (b) the
    losing pool's funds, plus (c) the creator's initial liquidity pool,
    all distributed proportionally to each winner's share of the winning
    total. If, degenerately, winning_total is 0 (shouldn't happen if this
    user has a stake > 0, but guarded anyway), the user simply gets their
    stake back with no share of anything else.
    """
    pure_validate_positive(user_stake, "user_stake")
    if winning_total <= 0:
        return user_stake
    distributable = winning_total + losing_total + pool_deposited
    # Integer pro-rata share: floor division is intentional — any dust
    # left un-distributed by rounding simply remains in the contract's
    # balance rather than being over-paid to any single claimant.
    return (user_stake * distributable) // winning_total


def pure_compute_split_payout(
    user_yes: int, user_no: int, total_yes: int, total_no: int, pool_deposited: int
) -> int:
    """
    Payout for a SPLIT verdict (ambiguous evidence: neither side clearly
    wins). Everyone gets their own principal back, plus a pro-rata share
    of the creator's initial liquidity pool, split across the two sides
    in proportion to each side's total stake. A user who staked both YES
    and NO (unusual but not disallowed) gets both legs combined.
    """
    total_pool = total_yes + total_no
    if total_pool <= 0:
        # No stakes at all — nothing to distribute beyond principal
        # (which is also 0 in this branch).
        return 0
    # This user's share of pool_deposited is proportional to their total
    # stake (yes+no) over the total stake across both sides.
    user_total_stake = user_yes + user_no
    pure_validate_positive(user_total_stake, "user_total_stake")
    bonus_share = (user_total_stake * pool_deposited) // total_pool
    return user_yes + user_no + bonus_share


def pure_compute_source_agreement_bps(agreeing_sources: int, total_sources: int) -> int:
    """Basis-points agreement ratio used against SOURCE_AGREEMENT_THRESHOLD_BPS."""
    if total_sources <= 0:
        return 0
    return (agreeing_sources * BPS_DENOMINATOR) // total_sources


def pure_decide_verdict(
    yes_votes: int, no_votes: int, total_sources: int,
    threshold_bps: int = SOURCE_AGREEMENT_THRESHOLD_BPS,
) -> str:
    """
    Majority-of-N-sources comparator. Rather than requiring every fetched
    source to say the exact same thing (strict equality, which would make
    validators disagree constantly on natural-language evidence), we
    require a bps-threshold share of sources to agree on a directional
    outcome. If neither side clears the threshold, the market is SPLIT
    (ambiguous) rather than left UNDETERMINED forever, so funds are never
    permanently stuck — see claim_timeout_refund as the final backstop
    for the case where sources cannot even be fetched.
    """
    if total_sources < MIN_EVIDENCE_SOURCE_CATEGORIES:
        return VERDICT_UNDETERMINED
    yes_bps = pure_compute_source_agreement_bps(yes_votes, total_sources)
    no_bps = pure_compute_source_agreement_bps(no_votes, total_sources)
    if yes_bps >= threshold_bps and yes_bps > no_bps:
        return VERDICT_YES
    if no_bps >= threshold_bps and no_bps > yes_bps:
        return VERDICT_NO
    return VERDICT_SPLIT


# ==========================================================================
# END PURE LOGIC
# ==========================================================================


@allow_storage
@dataclass
class Market:
    """
    On-chain market record. Kept as one dataclass (rather than N parallel
    TreeMaps) so a single storage read/write gives an atomic, consistent
    view of a market's ledger + terms + status.

    NOTE the deliberate separation the brief requires: `pool_deposited`
    (creator's initial liquidity, a LEDGER field) is never the same field
    as `resolution_criteria` (a TERMS field). Conflating "how much money is
    escrowed" with "what the market is about" is exactly the kind of bug
    that turns an accounting error into a security bug, so they are kept
    as clearly distinct fields with distinct names throughout this file.
    """

    id: u256
    creator: Address
    question: str
    category: str
    horizon_years: u256
    resolution_criteria: str
    allowed_evidence_types: str  # comma-separated, e.g. "news,academic,financial"
    created_at: u256
    resolves_at: u256
    status: str

    # --- LEDGER fields (money only; never conflate with terms above) ---
    pool_deposited: u256  # creator's initial liquidity, in GEN wei
    total_yes: u256       # sum of all YES stakes, in GEN wei
    total_no: u256        # sum of all NO stakes, in GEN wei

    # --- adjudication bookkeeping ---
    adjudication_requested_at: u256  # 0 == never requested
    verdict: str                      # "" until settle() completes
    evidence_count: u256


class EchoMarkets(gl.Contract):
    """
    Single Intelligent Contract backing every EchoMarkets prediction
    market. Public method surface matches PLANNING.md's "GenLayer contract
    responsibilities" list exactly: create_market, stake,
    submit_evidence_pointer, request_adjudication, settle, claim_payout,
    claim_timeout_refund, cancel_market, plus read-only view methods for
    the backend/frontend to poll status without needing a write tx.
    """

    markets: TreeMap[u256, Market]
    market_counter: u256

    # Stakes are stored OUTSIDE the Market dataclass, keyed by
    # "{market_id}:{wallet_hex}", so adding a stake never requires
    # rewriting the (larger) Market record and so a user's own stake can
    # be zeroed independently of anyone else's — this is what makes the
    # zero-before-transfer step in claim_payout / claim_timeout_refund a
    # single, cheap, targeted write instead of a read-modify-write of the
    # whole market.
    stake_yes: TreeMap[str, u256]
    stake_no: TreeMap[str, u256]

    # Guards against a claim being processed twice even in the (should be
    # impossible, since we zero the stake) case where the stake ledger
    # somehow still reads > 0. Defense in depth, not a replacement for the
    # zero-before-transfer ordering.
    payout_claimed: TreeMap[str, bool]

    # Evidence pointers: any user may submit one, but the contract's own
    # settle() nondet fetch is the only thing that is ever treated as
    # authoritative (see submit_evidence_pointer docstring).
    evidence_url: TreeMap[str, str]
    evidence_source_type: TreeMap[str, str]
    evidence_submitter: TreeMap[str, Address]

    def __init__(self):
        """
        GenVM storage fields default to their zero-equivalent (0 / "" /
        empty map) automatically; no explicit initialization needed beyond
        making the constructor a no-op, matching the documented pattern.
        """
        pass

    # ======================================================================
    # Internal helpers (gl-dependent)
    # ======================================================================

    def _require_market(self, market_id: u256) -> Market:
        """Fetch a market or revert; centralizes the "unknown market" check."""
        if market_id not in self.markets:
            raise gl.vm.UserError(f"unknown market_id {market_id}")
        return self.markets[market_id]

    def _now(self) -> int:
        """
        Contract-visible current time, cross-validated across
        leader/validators. See module docstring Section on time: no
        deterministic on-chain clock primitive was confirmed in the
        crawlable docs reachable during research, so — per this task's
        explicit fallback instruction — we fetch a real UTC time source
        inside a nondeterministic block and require leader/validator
        agreement within TIME_CONSENSUS_TOLERANCE_SECONDS (the documented
        "numeric tolerance" equivalence-principle pattern, applied to a
        timestamp instead of a price). This can only ever make a deadline
        check MORE conservative (validators must agree the deadline has
        passed); it can never be tricked into accepting a caller-supplied
        timestamp, because the caller never supplies one.
        """

        def fetch_epoch_seconds() -> int:
            # worldtimeapi-style JSON: {"unixtime": 1234567890, ...}
            raw = gl.get_webpage("https://worldtimeapi.org/api/timezone/Etc/UTC", mode="text")
            data = json.loads(raw)
            return int(data["unixtime"])

        def validator_fn(leader_result) -> bool:
            if not isinstance(leader_result, gl.vm.Return):
                return False
            validator_epoch = fetch_epoch_seconds()
            leader_epoch = leader_result.calldata
            return pure_timestamps_agree(int(leader_epoch), int(validator_epoch))

        return int(gl.vm.run_nondet(fetch_epoch_seconds, validator_fn))

    def _send_gen(self, to: Address, amount: u256) -> None:
        """
        SINGLE chokepoint for every outbound GEN transfer in this
        contract. Every payout path in this file calls this method last,
        after the relevant ledger field(s) have already been zeroed and
        that zeroed state persisted — see the docstring on each payout
        method for why that ordering is a deliberate security invariant,
        not an accident:

            1. read ledger field(s) into locals
            2. zero the ledger field(s) in storage
            3. (storage write is committed as part of this same call frame)
            4. ONLY THEN call `_send_gen`

        If step 4 happened before steps 1-3, a reentrant or duplicate call
        into the same payout method could read the still-nonzero ledger
        field again and drain the contract twice for one stake. Zeroing
        first means a second call sees `amount <= 0` and reverts via
        `pure_validate_positive` before any second transfer is attempted.

        Implementation follows the documented GenVM fallback pattern for
        native value transfer via an EVM-interface shim, since a more
        specific "send GEN" primitive was not confirmed in the crawlable
        docs reached during research.
        """
        if amount <= u256(0):
            # Nothing to send; treat as a no-op rather than an error so
            # callers that pass a legitimately-zero remainder don't revert.
            return
        recipient = _GenRecipient(to)
        recipient.emit_transfer(value=amount)

    def _wallet_hex(self, addr: Address) -> str:
        return addr.as_hex

    # ======================================================================
    # Public WRITE methods
    # ======================================================================

    @gl.public.write.payable
    def create_market(
        self,
        question: str,
        category: str,
        horizon_years: u256,
        resolution_criteria: str,
        allowed_evidence_types: str,
    ) -> u256:
        """
        Create a new market and seed it with initial liquidity.

        Payable: `gl.message.value` is read as the initial liquidity
        deposit and stored in `pool_deposited` — a LEDGER field, kept
        entirely separate from `resolution_criteria` (a TERMS field).
        Any non-positive deposit is rejected; a market must always start
        with real, positive escrowed value.

        Returns the new market's id.
        """
        deposit = u256(gl.message.value)
        if deposit <= u256(0):
            raise gl.vm.UserError("initial liquidity (gl.message.value) must be > 0")

        # Validate horizon_years is one of the accepted codes before we do
        # any further work; pure_resolve_horizon_years raises ValueError
        # on bad input, translate to a UserError so callers get a revert
        # instead of an opaque VM error.
        try:
            pure_resolve_horizon_years(int(horizon_years))
        except ValueError as exc:
            raise gl.vm.UserError(str(exc))

        if not question or not question.strip():
            raise gl.vm.UserError("question must not be empty")
        if not resolution_criteria or not resolution_criteria.strip():
            raise gl.vm.UserError("resolution_criteria must not be empty")

        created_at = self._now()
        resolves_at = pure_compute_resolves_at(created_at, int(horizon_years))

        market_id = self.market_counter
        self.market_counter = u256(int(self.market_counter) + 1)

        market = Market(
            id=market_id,
            creator=gl.message.sender_address,
            question=question,
            category=category,
            horizon_years=horizon_years,
            resolution_criteria=resolution_criteria,
            allowed_evidence_types=allowed_evidence_types,
            created_at=u256(created_at),
            resolves_at=u256(resolves_at),
            status=STATUS_ACTIVE,
            pool_deposited=deposit,
            total_yes=u256(0),
            total_no=u256(0),
            adjudication_requested_at=u256(0),
            verdict="",
            evidence_count=u256(0),
        )
        self.markets[market_id] = market
        return market_id

    @gl.public.write.payable
    def stake(self, market_id: u256, side: str) -> bool:
        """
        Place a stake on YES or NO for an active market.

        Payable: only `gl.message.value` is ever trusted as the staked
        amount — any numeric "amount" parameter supplied by the caller
        would be untrustworthy (the caller could lie about it), so this
        method deliberately does not accept one at all.
        """
        market = self._require_market(market_id)

        if not pure_can_stake(market.status):
            raise gl.vm.UserError(
                f"market {market_id} is not accepting stakes (status={market.status})"
            )
        if side not in (SIDE_YES, SIDE_NO):
            raise gl.vm.UserError(f"side must be '{SIDE_YES}' or '{SIDE_NO}', got {side!r}")

        amount = u256(gl.message.value)
        if amount <= u256(0):
            raise gl.vm.UserError("stake amount (gl.message.value) must be > 0")

        wallet_hex = self._wallet_hex(gl.message.sender_address)
        key = pure_make_stake_key(int(market_id), wallet_hex)

        if side == SIDE_YES:
            existing = self.stake_yes.get(key, u256(0))
            self.stake_yes[key] = u256(int(existing) + int(amount))
            market.total_yes = u256(int(market.total_yes) + int(amount))
        else:
            existing = self.stake_no.get(key, u256(0))
            self.stake_no[key] = u256(int(existing) + int(amount))
            market.total_no = u256(int(market.total_no) + int(amount))

        self.markets[market_id] = market
        return True

    @gl.public.write
    def submit_evidence_pointer(self, market_id: u256, source_type: str, url: str) -> u256:
        """
        Record a pointer (URL + declared source_type) that anyone believes
        is relevant to this market's resolution_criteria.

        IMPORTANT: this method never evaluates the URL's content, and it
        never trusts any summary the submitter might claim about it. It
        only stores the pointer. The ONLY authoritative evaluation of
        evidence content happens inside `settle`, via the contract's own
        nondeterministic fetch — see that method's docstring. This is
        exactly what prevents a malicious submitter from just asserting
        "this proves YES" and having that assertion count for anything.
        """
        market = self._require_market(market_id)
        if market.status not in (STATUS_ACTIVE, STATUS_AWAITING_ADJUDICATION):
            raise gl.vm.UserError(
                f"cannot submit evidence once market is {market.status}"
            )
        if not url or not url.strip():
            raise gl.vm.UserError("url must not be empty")
        if not source_type or not source_type.strip():
            raise gl.vm.UserError("source_type must not be empty")

        idx = int(market.evidence_count)
        key = pure_make_evidence_key(int(market_id), idx)
        self.evidence_url[key] = url
        self.evidence_source_type[key] = source_type
        self.evidence_submitter[key] = gl.message.sender_address

        market.evidence_count = u256(idx + 1)
        self.markets[market_id] = market
        return u256(idx)

    @gl.public.write
    def request_adjudication(self, market_id: u256) -> bool:
        """
        Move a market from active -> awaiting_adjudication.

        CRITICAL: this is an ON-CHAIN deadline guard, not a backend cron
        job. A prior project ("Event-Weaver") shipped a version of this
        idea that only checked deadlines in a backend scheduler, which
        meant nothing prevented an adversarial or buggy client from
        calling the equivalent of `settle` early by going straight to the
        contract. Here, `now < resolves_at` reverts unconditionally,
        regardless of what any off-chain caller believes the time is —
        `self._now()` is cross-validated via nondet consensus (see that
        method's docstring), not supplied by the caller.
        """
        market = self._require_market(market_id)
        now_ts = self._now()

        if not pure_can_request_adjudication(market.status, now_ts, int(market.resolves_at)):
            if market.status != STATUS_ACTIVE:
                raise gl.vm.UserError(
                    f"market {market_id} is not active (status={market.status})"
                )
            raise gl.vm.UserError(
                f"market {market_id} has not reached its resolves_at deadline yet "
                f"(now={now_ts}, resolves_at={int(market.resolves_at)})"
            )

        if not pure_validate_transition(market.status, STATUS_AWAITING_ADJUDICATION):
            raise gl.vm.UserError("illegal state transition")

        market.status = STATUS_AWAITING_ADJUDICATION
        market.adjudication_requested_at = u256(now_ts)
        self.markets[market_id] = market
        return True

    @gl.public.write
    def settle(self, market_id: u256) -> str:
        """
        Adjudicate a market by fetching REAL evidence from at least
        MIN_EVIDENCE_SOURCE_CATEGORIES independent source categories
        (news, academic/reports, financial/market data — see
        REQUIRED_SOURCE_CATEGORIES) and deciding a verdict based on what
        the fetched CONTENT actually says, not on submitted summaries and
        not merely on whether a response parses as well-formed JSON.

        Consensus mechanism: each source is independently classified by
        the leader as supporting YES / NO / neither, and validators must
        reach a similar-but-not-necessarily-identical classification for
        the SAME source content (a comparative equivalence check, not
        strict string equality) — this is what lets validators that
        phrase their reasoning slightly differently still agree, instead
        of every tiny wording difference producing "undetermined". The
        final verdict then requires a percentage-of-sources threshold
        (`SOURCE_AGREEMENT_THRESHOLD_BPS`) rather than unanimous or exact
        agreement — see `pure_decide_verdict`.
        """
        market = self._require_market(market_id)
        if not pure_can_settle(market.status):
            raise gl.vm.UserError(
                f"market {market_id} is not awaiting adjudication (status={market.status})"
            )

        criteria = market.resolution_criteria
        question = market.question

        # Gather submitted evidence pointers (URLs only — never their
        # submitters' claims about what they show).
        evidence_count = int(market.evidence_count)
        pointers = []
        for i in range(evidence_count):
            key = pure_make_evidence_key(int(market_id), i)
            pointers.append(
                {
                    "url": self.evidence_url.get(key, ""),
                    "source_type": self.evidence_source_type.get(key, ""),
                }
            )

        # Always consult the required categories even if no user submitted
        # a pointer for one of them, by falling back to a generic search
        # query per category. This guarantees settle() never skips a
        # required category just because nobody happened to submit a URL
        # for it.
        search_targets = list(REQUIRED_SOURCE_CATEGORIES)
        for cat in REQUIRED_SOURCE_CATEGORIES:
            if not any(p["source_type"] == cat for p in pointers):
                search_targets.append(cat)  # ensures category is represented

        candidate_sources = pointers + [
            {"url": "", "source_type": cat} for cat in REQUIRED_SOURCE_CATEGORIES
            if not any(p["source_type"] == cat for p in pointers)
        ]

        def fetch_and_classify() -> str:
            """
            Leader-side nondet work: for every candidate source, fetch its
            real content (or a category search if no URL was submitted)
            and ask the model whether that CONTENT indicates the
            resolution_criteria came true (YES), came false (NO), or is
            inconclusive (NEITHER). Returns a canonical JSON string:
              {"votes": {"YES": int, "NO": int, "NEITHER": int}, "total": int}
            """
            votes = {"YES": 0, "NO": 0, "NEITHER": 0}
            total = 0
            for src in candidate_sources:
                url = src["url"]
                category = src["source_type"] or "general"
                try:
                    if url:
                        web_text = gl.get_webpage(url, mode="text")
                    else:
                        # No submitted pointer for a required category —
                        # fall back to a live web search proxy so the
                        # category is still genuinely consulted rather
                        # than skipped.
                        search_url = (
                            "https://duckduckgo.com/html/?q="
                            + question.replace(" ", "+") + "+" + category
                        )
                        web_text = gl.get_webpage(search_url, mode="text")
                except Exception:
                    # Unreachable source: counts toward total (so a market
                    # with too many dead links correctly fails to reach
                    # the agreement threshold) but contributes no vote.
                    total += 1
                    continue

                prompt = f"""
You are adjudicating a prediction market as an impartial fact-checker.

Question: {question}
Resolution criteria (what must be true for YES): {criteria}
Source category: {category}

Web content (may be truncated):
{web_text[:4000]}

Based ONLY on the content above, does it indicate the resolution
criteria has come true (YES), come false (NO), or is inconclusive
(NEITHER)? Respond with strict JSON only:
{{"vote": "YES" | "NO" | "NEITHER", "reason": str}}
No other text, no markdown fences.
"""
                raw = gl.exec_prompt(prompt).replace("```json", "").replace("```", "").strip()
                try:
                    parsed = json.loads(raw)
                    vote = str(parsed.get("vote", "NEITHER")).upper()
                except Exception:
                    vote = "NEITHER"
                if vote not in votes:
                    vote = "NEITHER"
                votes[vote] += 1
                total += 1

            return json.dumps({"votes": votes, "total": total}, sort_keys=True)

        def validator_fn(leader_result) -> bool:
            """
            Comparative (non-strict) equivalence check: the validator does
            NOT just check that the leader's calldata is valid JSON shape
            — per the equivalence-principle docs, that alone "is not
            performing consensus". Instead the validator independently
            re-fetches and re-classifies every source and requires the
            resulting vote TALLIES to be close (each vote count within one
            of the leader's), which tolerates minor LLM wording
            differences while still requiring the validator to have
            actually looked at the same real evidence and reached a
            compatible conclusion.
            """
            if not isinstance(leader_result, gl.vm.Return):
                return False
            try:
                leader_data = json.loads(leader_result.calldata)
            except Exception:
                return False
            validator_raw = fetch_and_classify()
            validator_data = json.loads(validator_raw)
            if leader_data.get("total", 0) != validator_data.get("total", 0):
                return False
            leader_votes = leader_data.get("votes", {})
            validator_votes = validator_data.get("votes", {})
            for side_key in ("YES", "NO", "NEITHER"):
                if abs(int(leader_votes.get(side_key, 0)) - int(validator_votes.get(side_key, 0))) > 1:
                    return False
            return True

        result_json = gl.vm.run_nondet(fetch_and_classify, validator_fn)
        result = json.loads(result_json)
        votes = result.get("votes", {"YES": 0, "NO": 0, "NEITHER": 0})
        total_sources = int(result.get("total", 0))

        verdict = pure_decide_verdict(int(votes.get("YES", 0)), int(votes.get("NO", 0)), total_sources)

        if verdict == VERDICT_UNDETERMINED:
            # Not enough usable sources to decide anything at all. Do NOT
            # transition state — leave the market awaiting_adjudication so
            # a future settle() retry (with more evidence submitted, or
            # once dead links are replaced) can still succeed, and so that
            # claim_timeout_refund remains available as the ultimate
            # backstop once the grace window elapses.
            raise gl.vm.UserError(
                "insufficient usable evidence sources to reach consensus; "
                "submit additional evidence_pointers and retry, or wait "
                "for the timeout grace window to claim a refund"
            )

        next_status = {
            VERDICT_YES: STATUS_SETTLED_YES,
            VERDICT_NO: STATUS_SETTLED_NO,
            VERDICT_SPLIT: STATUS_SETTLED_SPLIT,
        }[verdict]

        if not pure_validate_transition(market.status, next_status):
            raise gl.vm.UserError("illegal state transition")

        market.status = next_status
        market.verdict = verdict
        self.markets[market_id] = market
        return verdict

    @gl.public.write
    def claim_payout(self, market_id: u256) -> u256:
        """
        Claim this caller's payout after a market has settled (YES, NO,
        or SPLIT). Safe to call exactly once per wallet per market: the
        stake ledger fields are zeroed BEFORE any transfer, in this exact
        order, which is the core reentrancy/double-spend invariant of
        this whole contract:

            1. read stake_yes[key] / stake_no[key] into locals
            2. zero stake_yes[key] / stake_no[key] in storage
            3. (write committed as part of this call)
            4. compute payout from the LOCAL copies, then call _send_gen

        A second call after step 2 reads 0 for both stakes, and
        `pure_validate_positive` (invoked indirectly through the payout
        math paths below) causes it to revert instead of silently
        no-op'ing or, worse, paying out again.
        """
        market = self._require_market(market_id)
        if market.status not in (STATUS_SETTLED_YES, STATUS_SETTLED_NO, STATUS_SETTLED_SPLIT):
            raise gl.vm.UserError(
                f"market {market_id} has not been settled yet (status={market.status})"
            )

        wallet = gl.message.sender_address
        wallet_hex = self._wallet_hex(wallet)
        key = pure_make_stake_key(int(market_id), wallet_hex)

        if self.payout_claimed.get(key, False):
            raise gl.vm.UserError("payout already claimed for this wallet on this market")

        # --- Step 1: read into locals ---
        user_yes = int(self.stake_yes.get(key, u256(0)))
        user_no = int(self.stake_no.get(key, u256(0)))

        if user_yes <= 0 and user_no <= 0:
            raise gl.vm.UserError("no stake found for this wallet on this market")

        # --- Step 2 + 3: zero the ledger fields and persist BEFORE transfer ---
        self.stake_yes[key] = u256(0)
        self.stake_no[key] = u256(0)
        self.payout_claimed[key] = True

        total_yes = int(market.total_yes)
        total_no = int(market.total_no)
        pool_deposited = int(market.pool_deposited)

        if market.status == STATUS_SETTLED_YES:
            pure_validate_positive(user_yes if user_yes > 0 else 1, "user_yes")
            payout = pure_compute_winner_payout(user_yes, total_yes, total_no, pool_deposited) if user_yes > 0 else 0
        elif market.status == STATUS_SETTLED_NO:
            payout = pure_compute_winner_payout(user_no, total_no, total_yes, pool_deposited) if user_no > 0 else 0
        else:  # STATUS_SETTLED_SPLIT
            payout = pure_compute_split_payout(user_yes, user_no, total_yes, total_no, pool_deposited)

        if payout <= 0:
            raise gl.vm.UserError("computed payout is 0; nothing to claim (wrong side of a decisive verdict)")

        # --- Step 4: transfer LAST, after ledger is already zeroed+saved ---
        self._send_gen(wallet, u256(payout))
        return u256(payout)

    @gl.public.write
    def claim_timeout_refund(self, market_id: u256) -> u256:
        """
        Backstop exit path: if adjudication was requested but `settle`
        never completed within ADJUDICATION_GRACE_SECONDS (e.g. because
        evidence sources are unreachable or consensus can't be reached),
        any staker may reclaim their OWN stake — no one else's, and never
        the creator's pool_deposited (that would let a single staker drain
        funds belonging to the whole market). Same zero-before-transfer
        ordering as claim_payout.
        """
        market = self._require_market(market_id)
        now_ts = self._now()

        if not pure_can_claim_timeout_refund(market.status, now_ts, int(market.adjudication_requested_at)):
            raise gl.vm.UserError(
                f"market {market_id} is not eligible for a timeout refund yet "
                f"(status={market.status}, now={now_ts}, "
                f"requested_at={int(market.adjudication_requested_at)}, "
                f"grace={ADJUDICATION_GRACE_SECONDS})"
            )

        wallet = gl.message.sender_address
        wallet_hex = self._wallet_hex(wallet)
        key = pure_make_stake_key(int(market_id), wallet_hex)

        if self.payout_claimed.get(key, False):
            raise gl.vm.UserError("refund already claimed for this wallet on this market")

        # --- Step 1: read ---
        user_yes = int(self.stake_yes.get(key, u256(0)))
        user_no = int(self.stake_no.get(key, u256(0)))
        refund_amount = user_yes + user_no
        pure_validate_positive(refund_amount, "refund_amount")

        # --- Step 2 + 3: zero + persist BEFORE transfer ---
        self.stake_yes[key] = u256(0)
        self.stake_no[key] = u256(0)
        self.payout_claimed[key] = True

        # First staker to claim a timeout refund flips the market to
        # refunded_timeout so the UI can reflect it; this is idempotent —
        # later claimants just skip the (now illegal) transition check.
        if pure_validate_transition(market.status, STATUS_REFUNDED_TIMEOUT):
            market.status = STATUS_REFUNDED_TIMEOUT
            self.markets[market_id] = market

        # --- Step 4: transfer last ---
        self._send_gen(wallet, u256(refund_amount))
        return u256(refund_amount)

    @gl.public.write
    def cancel_market(self, market_id: u256) -> u256:
        """
        Creator-only cancellation, PRE-PARTICIPATION ONLY: legal only
        while total_yes == total_no == 0, i.e. before anyone has staked.
        Refunds pool_deposited to the creator. Same zero-before-transfer
        ordering as every other payout path in this file.
        """
        market = self._require_market(market_id)

        if gl.message.sender_address != market.creator:
            raise gl.vm.UserError("only the market creator may cancel this market")

        if not pure_can_cancel(market.status, int(market.total_yes), int(market.total_no)):
            raise gl.vm.UserError(
                "market can only be cancelled while active and before any stakes are placed"
            )

        if not pure_validate_transition(market.status, STATUS_CANCELLED):
            raise gl.vm.UserError("illegal state transition")

        # --- Step 1: read ---
        refund_amount = int(market.pool_deposited)
        pure_validate_positive(refund_amount, "pool_deposited")

        # --- Step 2 + 3: zero the ledger field and persist BEFORE transfer ---
        market.pool_deposited = u256(0)
        market.status = STATUS_CANCELLED
        self.markets[market_id] = market

        # --- Step 4: transfer last ---
        self._send_gen(market.creator, u256(refund_amount))
        return u256(refund_amount)

    # ======================================================================
    # Public VIEW methods (read-only; GenVM-serializable return types only)
    # ======================================================================

    @gl.public.view
    def get_market(self, market_id: u256) -> dict:
        """Return a plain-dict snapshot of a market for the backend/frontend to poll."""
        if market_id not in self.markets:
            raise gl.vm.UserError(f"unknown market_id {market_id}")
        m = self.markets[market_id]
        return {
            "id": int(m.id),
            "creator": m.creator.as_hex,
            "question": m.question,
            "category": m.category,
            "horizon_years": int(m.horizon_years),
            "resolution_criteria": m.resolution_criteria,
            "allowed_evidence_types": m.allowed_evidence_types,
            "created_at": int(m.created_at),
            "resolves_at": int(m.resolves_at),
            "status": m.status,
            "pool_deposited": int(m.pool_deposited),
            "total_yes": int(m.total_yes),
            "total_no": int(m.total_no),
            "adjudication_requested_at": int(m.adjudication_requested_at),
            "verdict": m.verdict,
            "evidence_count": int(m.evidence_count),
        }

    @gl.public.view
    def get_market_count(self) -> u256:
        return self.market_counter

    @gl.public.view
    def get_stake(self, market_id: u256, wallet: str) -> dict:
        """Return a wallet's current YES/NO stake amounts on a market."""
        key = pure_make_stake_key(int(market_id), wallet.lower())
        return {
            "yes": int(self.stake_yes.get(key, u256(0))),
            "no": int(self.stake_no.get(key, u256(0))),
            "claimed": bool(self.payout_claimed.get(key, False)),
        }

    @gl.public.view
    def get_evidence(self, market_id: u256, index: u256) -> dict:
        """Return one submitted evidence pointer (URL + declared source type + submitter)."""
        key = pure_make_evidence_key(int(market_id), int(index))
        if key not in self.evidence_url:
            raise gl.vm.UserError(f"no evidence at index {index} for market {market_id}")
        return {
            "url": self.evidence_url[key],
            "source_type": self.evidence_source_type[key],
            "submitter": self.evidence_submitter[key].as_hex,
        }

    @gl.public.view
    def get_all_evidence(self, market_id: u256) -> list:
        """Return every submitted evidence pointer for a market, in submission order."""
        market = self._require_market(market_id)
        out = []
        for i in range(int(market.evidence_count)):
            key = pure_make_evidence_key(int(market_id), i)
            out.append(
                {
                    "url": self.evidence_url.get(key, ""),
                    "source_type": self.evidence_source_type.get(key, ""),
                    "submitter": self.evidence_submitter[key].as_hex if key in self.evidence_submitter else "",
                }
            )
        return out


@gl.evm.contract_interface
class _GenRecipient:
    """
    Thin EVM-interface shim used only by `_send_gen` to perform the actual
    native GEN value transfer. This is the documented GenVM fallback
    pattern for outbound value transfer (payable "emit_transfer" call on a
    recipient interface) referenced in the task brief, used here because a
    more specific "native send" primitive was not confirmed in the
    crawlable docs reached during research. All money leaves this contract
    through exactly one call site (`EchoMarkets._send_gen`), which is what
    makes the zero-before-transfer ordering auditable in one place.
    """

    class transact:
        def emit_transfer(self, value: u256) -> None: ...