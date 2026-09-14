-- Consolidated reference schema. Generated from migrations/001_init.sql + 002_functions.sql.
-- 001_init.sql
-- Chronix initial schema.
-- Postgres 14+.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    wallet_address  TEXT PRIMARY KEY,           -- lowercase 0x... checksum-normalized
    nickname        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- markets
-- ---------------------------------------------------------------------------
CREATE TYPE market_status AS ENUM (
    'pending_chain',        -- create_market intent recorded, awaiting chain confirmation
    'open',                 -- live, accepting stakes
    'awaiting_adjudication',-- resolves_at passed + chain-confirmed, awaiting settle()
    'settled',              -- contract has produced a verdict
    'cancelled',            -- cancel_market succeeded pre-participation
    'failed'                -- chain write permanently failed (manual review)
);

CREATE TABLE IF NOT EXISTS markets (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question                TEXT NOT NULL,
    category                TEXT NOT NULL,
    horizon_years           NUMERIC(6,2) NOT NULL CHECK (horizon_years > 0),
    resolution_criteria     TEXT NOT NULL,
    created_by              TEXT NOT NULL REFERENCES users(wallet_address),
    contract_market_id      TEXT,                -- id assigned by the GenLayer contract once confirmed
    status                  market_status NOT NULL DEFAULT 'pending_chain',
    resolves_at              TIMESTAMPTZ NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    deadline_enforced_at    TIMESTAMPTZ,         -- set only once the on-chain deadline check confirms it
    -- Live financial figures, mirrored from the contract's own get_market()
    -- by the chain indexer job — Postgres is a read cache, chain is truth.
    pool_deposited_wei      NUMERIC(78, 0) NOT NULL DEFAULT 0,
    total_yes_wei           NUMERIC(78, 0) NOT NULL DEFAULT 0,
    total_no_wei            NUMERIC(78, 0) NOT NULL DEFAULT 0,
    verdict                 TEXT,
    allowed_evidence_types  TEXT                 -- mirrors the contract field; NULL/empty = no restriction
);

CREATE INDEX IF NOT EXISTS idx_markets_status ON markets(status);
CREATE INDEX IF NOT EXISTS idx_markets_category ON markets(category);
CREATE INDEX IF NOT EXISTS idx_markets_resolves_at ON markets(resolves_at);
CREATE INDEX IF NOT EXISTS idx_markets_horizon ON markets(horizon_years);

-- ---------------------------------------------------------------------------
-- positions
-- ---------------------------------------------------------------------------
CREATE TYPE position_side AS ENUM ('yes', 'no');

CREATE TABLE IF NOT EXISTS positions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id       UUID NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    wallet_address  TEXT NOT NULL REFERENCES users(wallet_address),
    side            position_side NOT NULL,
    shares          NUMERIC(38,18) NOT NULL CHECK (shares > 0),
    avg_price       NUMERIC(38,18) NOT NULL CHECK (avg_price >= 0),
    tx_hash         TEXT,                       -- null until chain write confirms
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_positions_market ON positions(market_id);
CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet_address);

-- ---------------------------------------------------------------------------
-- market_events
-- ---------------------------------------------------------------------------
CREATE TYPE market_event_type AS ENUM (
    'created',
    'deadline_passed',
    'evidence_submitted',
    'stake_recorded',
    'verdict_pending',
    'verdict_settled',
    'payout_claimed',
    'reconciled'
);

CREATE TABLE IF NOT EXISTS market_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id       UUID NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    type            market_event_type NOT NULL,
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    chain_tx_hash   TEXT,
    confirmed       BOOLEAN NOT NULL DEFAULT false, -- only true once a tx receipt confirms the state change
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_market_events_market ON market_events(market_id);
CREATE INDEX IF NOT EXISTS idx_market_events_type ON market_events(type);
CREATE INDEX IF NOT EXISTS idx_market_events_confirmed ON market_events(confirmed);

-- ---------------------------------------------------------------------------
-- evidence
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evidence (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id       UUID NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    source_type     TEXT NOT NULL,
    url             TEXT NOT NULL,
    summary         TEXT,                       -- user-submitted summary; contract never trusts this as fact
    submitted_by    TEXT NOT NULL REFERENCES users(wallet_address),
    weight          NUMERIC(5,4),                -- assigned post-hoc by contract's adjudication, null until settled
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evidence_market ON evidence(market_id);

-- ---------------------------------------------------------------------------
-- chain_sync_queue
-- ---------------------------------------------------------------------------
CREATE TYPE chain_sync_status AS ENUM ('pending', 'confirmed', 'failed');

CREATE TABLE IF NOT EXISTS chain_sync_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id       UUID REFERENCES markets(id) ON DELETE CASCADE,
    action          TEXT NOT NULL,               -- e.g. create_market, stake, submit_evidence_pointer, request_adjudication, settle, claim_payout, claim_timeout_refund, cancel_market
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    status          chain_sync_status NOT NULL DEFAULT 'pending',
    next_retry_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chain_sync_status ON chain_sync_queue(status);
CREATE INDEX IF NOT EXISTS idx_chain_sync_next_retry ON chain_sync_queue(next_retry_at);
CREATE INDEX IF NOT EXISTS idx_chain_sync_market ON chain_sync_queue(market_id);

COMMIT;
-- 002_functions.sql
-- Helper trigger to keep chain_sync_queue.updated_at fresh.

BEGIN;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_chain_sync_queue_updated_at ON chain_sync_queue;
CREATE TRIGGER trg_chain_sync_queue_updated_at
    BEFORE UPDATE ON chain_sync_queue
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

COMMIT;

-- 008_base_sepolia_usdc_funding.sql
ALTER TABLE markets ADD COLUMN IF NOT EXISTS pool_fund_tx_hash TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS pool_relayed_at TIMESTAMPTZ;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS payouts_relayed_at TIMESTAMPTZ;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS fund_tx_hash TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS relayed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS base_relay_watermark (
    id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_scanned_block NUMERIC(78, 0) NOT NULL DEFAULT 0,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO base_relay_watermark (id, last_scanned_block) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

-- 009_market_cancel_request.sql
ALTER TABLE markets ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;
