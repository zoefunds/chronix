-- Chronix funding moved from native GEN (escrowed directly by the GenLayer
-- contract) to real USDC on Base Sepolia, escrowed by ChronixEscrow.sol
-- (contracts/base/). GenLayer no longer moves money at all — see
-- contracts/chronix.py's class docstring. This migration adds the
-- bookkeeping the new backend relay job (jobs/baseRelay.ts) needs to bridge
-- confirmed Base deposits -> GenLayer ledger writes -> settled payouts back
-- onto the escrow, all idempotently.

-- markets.id (UUID) is now the SAME value used to derive the escrow's
-- bytes32 marketId key (keccak256(id), computed identically on both
-- backend and frontend — see backend/src/services/baseSepolia.ts
-- marketIdToBytes32). A market is created as 'pending_chain' the moment a
-- user submits the form (before any chain write at all), so the frontend
-- has an id to fund against; the relay job promotes it once it observes
-- the matching ChronixEscrow Funded(KIND_POOL) event and successfully
-- mirrors it onto GenLayer's create_market.
ALTER TABLE markets ADD COLUMN IF NOT EXISTS pool_fund_tx_hash TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS pool_relayed_at TIMESTAMPTZ;

-- Set once the relay job has pushed this market's settled/cancelled/
-- refunded-timeout payout amounts onto ChronixEscrow.setPayouts. Distinct
-- from the market's on-chain status (which GenLayer's settle()/
-- claim_timeout_refund/cancel_market already tracks) because a market can
-- sit "settled on GenLayer" for a while before the relay batch actually
-- runs — this column is what makes that relay pass idempotent without
-- relying solely on the escrow's own payoutsSet gate (belt and suspenders,
-- same reasoning as chain_sync_queue elsewhere in this schema).
ALTER TABLE markets ADD COLUMN IF NOT EXISTS payouts_relayed_at TIMESTAMPTZ;

-- Same pending -> confirmed -> relayed lifecycle for an individual stake.
-- A position row is now inserted the moment a user submits a stake intent
-- (before funding), so the frontend has something to point its
-- ChronixEscrow.fund(marketId, KIND_YES|KIND_NO, amount) call at.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS fund_tx_hash TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS relayed_at TIMESTAMPTZ;

-- Single-row table tracking the last Base Sepolia block the relay job has
-- fully scanned for ChronixEscrow Funded events, so restarts don't rescan
-- from the contract's deployment block every time.
CREATE TABLE IF NOT EXISTS base_relay_watermark (
    id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_scanned_block NUMERIC(78, 0) NOT NULL DEFAULT 0,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO base_relay_watermark (id, last_scanned_block) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
