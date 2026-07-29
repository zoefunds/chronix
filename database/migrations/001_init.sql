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
    deadline_enforced_at    TIMESTAMPTZ          -- set only once the on-chain deadline check confirms it
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
