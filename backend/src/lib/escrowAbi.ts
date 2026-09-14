/** ABI fragments for ChronixEscrow.sol (contracts/base/) and a minimal ERC20 (USDC). */

export const CHRONIX_ESCROW_ABI = [
  "function fund(bytes32 marketId, uint8 kind, uint256 amount) external",
  "function setPayouts(bytes32 marketId, address[] recipients, uint256[] amounts) external",
  "function claim(bytes32 marketId) external",
  "function claimMany(bytes32[] marketIds) external",
  "function getPool(bytes32 marketId) external view returns (uint256 deposited, uint256 allocated, bool payoutsSet)",
  "function getClaimable(bytes32 marketId, address wallet) external view returns (uint256)",
  "function relayer() external view returns (address)",
  "function owner() external view returns (address)",
  "event Funded(bytes32 indexed marketId, address indexed from, uint8 kind, uint256 amount)",
  "event PayoutsSet(bytes32 indexed marketId, uint256 recipientCount, uint256 totalAllocated)",
  "event Claimed(bytes32 indexed marketId, address indexed wallet, uint256 amount)",
] as const;

export const ERC20_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
] as const;

export const FUND_KIND_POOL = 0;
export const FUND_KIND_YES = 1;
export const FUND_KIND_NO = 2;
