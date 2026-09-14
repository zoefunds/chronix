# ChronixEscrow.sol — Base Sepolia payment layer

Holds real USDC for Chronix prediction markets. GenLayer
(`contracts/chronix.py`) is the adjudication + ledger-of-record layer
only — it never escrows or moves real value. This contract is the only
place real money lives.

- **Funding**: anyone calls `fund(marketId, kind, amount)` after
  approving this contract for `amount` USDC. `kind` is `KIND_POOL` (0,
  creator's initial liquidity), `KIND_YES` (1), or `KIND_NO` (2).
- **Relaying**: the backend relayer watches `Funded` events and mirrors
  confirmed deposits onto GenLayer (`create_market` / `stake`). Once a
  GenLayer market settles (or is cancelled / times out), the relayer
  reads the authoritative payout amounts from GenLayer
  (`claim_payout` / `claim_timeout_refund` / `cancel_market`) and pushes
  them here via `setPayouts(marketId, recipients, amounts)` — relayer-only,
  and idempotent per `marketId` (its own `payoutsSet` gate), so a retry
  after a partial failure is always safe.
- **Claiming**: wallets self-serve `claim(marketId)` or
  `claimMany(marketIds)` directly against this contract — no relayer
  involvement, no GenLayer transaction needed.

`marketId` is a `bytes32` key — the backend hashes its own market UUID
the same way on both sides (`ethers.id(marketId)`), matching the pattern
used for `competitionId` in the meme-olympics reference project.

## Deploy

```bash
cd contracts/base
npm i -D ethers solc   # if not already available from the repo root
DEPLOYER_PRIVATE_KEY=... \
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
BASE_SEPOLIA_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e \
RELAYER_ADDRESS=<backend relayer wallet address> \
node deploy.js
```

Never pass `DEPLOYER_PRIVATE_KEY` as a CLI argument or commit it — set it
as a shell/env var only. After deploying, set in `backend/.env`:

```
CHRONIX_ESCROW_ADDRESS=<deployed address>
BASE_SEPOLIA_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
BASE_SEPOLIA_RELAYER_PRIVATE_KEY=<same key as RELAYER_ADDRESS above>
```

The **same** relayer address/key must also be passed as the
`relayer_address` constructor argument when deploying `chronix.py` on
GenLayer Studio, so both chains trust the one backend-held key.
