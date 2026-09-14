// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ChronixEscrow
/// @notice Payment layer for Chronix prediction markets, deployed on Base
///         Sepolia. Holds real USDC (initial liquidity + YES/NO stakes) per
///         market and lets stakers self-claim once a payout is credited.
///         Adjudication (verdict, pro-rata payout math) happens entirely
///         off this chain, on GenLayer (contracts/chronix.py) — that
///         contract never touches money any more. This contract only ever
///         sees a market id, funding deposits, and a wallet/amount payout
///         list pushed here by a trusted relayer once GenLayer settles.
/// @dev No external dependencies (no OpenZeppelin import) so it can be
///      compiled/deployed with nothing more than solc, mirroring
///      MemeOlympicsEscrow.sol's pattern.
// ----------------------------------------------------------------------
// Minimal ERC20 interface (USDC on Base Sepolia).
// ----------------------------------------------------------------------
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

contract ChronixEscrow {
    // ------------------------------------------------------------------
    // Funding kinds — mirrored 1:1 onto GenLayer's pool_deposited /
    // total_yes / total_no ledger fields by the relayer, off-chain.
    // ------------------------------------------------------------------
    uint8 public constant KIND_POOL = 0; // creator's initial liquidity
    uint8 public constant KIND_YES = 1;
    uint8 public constant KIND_NO = 2;

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------
    struct Pool {
        uint256 deposited;   // total USDC ever deposited under this market id (all kinds)
        uint256 allocated;   // total USDC committed to claimants via setPayouts
        bool payoutsSet;     // true once setPayouts has run for this market (idempotency gate)
    }

    IERC20 public immutable usdc;
    address public owner;
    address public relayer; // backend service authorized to push confirmed payouts

    mapping(bytes32 => Pool) public pools;                            // marketId => pool
    mapping(bytes32 => mapping(address => uint256)) public claimable; // marketId => wallet => USDC owed
    mapping(address => uint256) public totalClaimable;                 // wallet => USDC owed across ALL markets

    bool private _locked; // reentrancy guard

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------
    event Funded(bytes32 indexed marketId, address indexed from, uint8 kind, uint256 amount);
    event PayoutsSet(bytes32 indexed marketId, uint256 recipientCount, uint256 totalAllocated);
    event Claimed(bytes32 indexed marketId, address indexed wallet, uint256 amount);
    event RelayerUpdated(address indexed newRelayer);
    event OwnerUpdated(address indexed newOwner);
    event UnallocatedWithdrawn(bytes32 indexed marketId, address indexed to, uint256 amount);

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------
    modifier onlyOwner() {
        require(msg.sender == owner, "ChronixEscrow: not owner");
        _;
    }

    modifier onlyRelayer() {
        require(msg.sender == relayer, "ChronixEscrow: not relayer");
        _;
    }

    modifier nonReentrant() {
        require(!_locked, "ChronixEscrow: reentrant call");
        _locked = true;
        _;
        _locked = false;
    }

    /// @param usdcToken USDC contract address on Base Sepolia.
    /// @param relayer_ Backend service wallet allowed to call setPayouts.
    constructor(address usdcToken, address relayer_) {
        require(usdcToken != address(0), "ChronixEscrow: zero usdc");
        require(relayer_ != address(0), "ChronixEscrow: zero relayer");
        usdc = IERC20(usdcToken);
        owner = msg.sender;
        relayer = relayer_;
    }

    // ------------------------------------------------------------------
    // Funding — anyone can fund a market's initial liquidity pool or place
    // a YES/NO stake. Caller must have approved this contract for `amount`
    // beforehand. The relayer watches Funded events and mirrors confirmed
    // deposits onto the GenLayer contract's ledger (create_market's
    // pool_deposited param, or record_stake) before that market's terms
    // become usable for staking/settlement there.
    // ------------------------------------------------------------------
    function fund(bytes32 marketId, uint8 kind, uint256 amount) external nonReentrant {
        require(amount > 0, "ChronixEscrow: amount must be > 0");
        require(kind == KIND_POOL || kind == KIND_YES || kind == KIND_NO, "ChronixEscrow: invalid kind");
        bool ok = usdc.transferFrom(msg.sender, address(this), amount);
        require(ok, "ChronixEscrow: USDC transferFrom failed");
        pools[marketId].deposited += amount;
        emit Funded(marketId, msg.sender, kind, amount);
    }

    // ------------------------------------------------------------------
    // Relayer — pushes the GenLayer-finalized payout list exactly once per
    // market (covers claim_payout, claim_timeout_refund and cancel_market
    // refunds alike — all three just become "credit these wallets these
    // amounts" from the relayer's perspective). Amounts are only credited
    // as claimable, never pushed directly to wallets, mirroring
    // MemeOlympicsEscrow's setWinners pattern.
    // ------------------------------------------------------------------
    function setPayouts(
        bytes32 marketId,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external onlyRelayer {
        require(recipients.length == amounts.length, "ChronixEscrow: length mismatch");
        require(recipients.length > 0, "ChronixEscrow: no recipients");

        Pool storage pool = pools[marketId];
        require(!pool.payoutsSet, "ChronixEscrow: payouts already set");

        uint256 total = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            require(recipients[i] != address(0), "ChronixEscrow: zero recipient address");
            total += amounts[i];
        }
        require(
            total <= pool.deposited - pool.allocated,
            "ChronixEscrow: total exceeds undeposited/unallocated pool"
        );

        pool.payoutsSet = true;
        pool.allocated += total;

        for (uint256 i = 0; i < recipients.length; i++) {
            if (amounts[i] == 0) continue;
            claimable[marketId][recipients[i]] += amounts[i];
            totalClaimable[recipients[i]] += amounts[i];
        }

        emit PayoutsSet(marketId, recipients.length, total);
    }

    // ------------------------------------------------------------------
    // Claims — self-serve pull pattern, checks-effects-interactions.
    // ------------------------------------------------------------------
    function claim(bytes32 marketId) external nonReentrant {
        uint256 amount = claimable[marketId][msg.sender];
        require(amount > 0, "ChronixEscrow: nothing claimable");

        claimable[marketId][msg.sender] = 0;
        totalClaimable[msg.sender] -= amount;

        bool ok = usdc.transfer(msg.sender, amount);
        require(ok, "ChronixEscrow: USDC transfer failed");

        emit Claimed(marketId, msg.sender, amount);
    }

    /// @notice Claim across several markets in one transaction.
    function claimMany(bytes32[] calldata marketIds) external nonReentrant {
        uint256 total = 0;
        for (uint256 i = 0; i < marketIds.length; i++) {
            bytes32 id = marketIds[i];
            uint256 amount = claimable[id][msg.sender];
            if (amount == 0) continue;
            claimable[id][msg.sender] = 0;
            total += amount;
            emit Claimed(id, msg.sender, amount);
        }
        require(total > 0, "ChronixEscrow: nothing claimable");
        totalClaimable[msg.sender] -= total;
        bool ok = usdc.transfer(msg.sender, total);
        require(ok, "ChronixEscrow: USDC transfer failed");
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------
    function setRelayer(address newRelayer) external onlyOwner {
        require(newRelayer != address(0), "ChronixEscrow: zero relayer");
        relayer = newRelayer;
        emit RelayerUpdated(newRelayer);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ChronixEscrow: zero owner");
        owner = newOwner;
        emit OwnerUpdated(newOwner);
    }

    /// @notice Owner can pull back USDC that was deposited under a market
    ///         but never allocated (e.g. a cancelled-pre-participation
    ///         market, or leftover dust below integer rounding). Cannot
    ///         touch anything already allocated/claimable.
    function withdrawUnallocated(bytes32 marketId, address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "ChronixEscrow: zero recipient");
        Pool storage pool = pools[marketId];
        uint256 available = pool.deposited - pool.allocated;
        require(amount <= available, "ChronixEscrow: exceeds unallocated amount");
        pool.deposited -= amount;
        bool ok = usdc.transfer(to, amount);
        require(ok, "ChronixEscrow: USDC transfer failed");
        emit UnallocatedWithdrawn(marketId, to, amount);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------
    function getPool(bytes32 marketId) external view returns (uint256 deposited, uint256 allocated, bool payoutsSet) {
        Pool storage pool = pools[marketId];
        return (pool.deposited, pool.allocated, pool.payoutsSet);
    }

    function getClaimable(bytes32 marketId, address wallet) external view returns (uint256) {
        return claimable[marketId][wallet];
    }
}
