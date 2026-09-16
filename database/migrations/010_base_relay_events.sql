-- Fixes a reliability bug in jobs/baseRelay.ts found during a live E2E test
-- (2026-09-15): scanFundedEvents() advances the base_relay_watermark every
-- tick unconditionally, and relayPendingPools()/relayPendingStakes() only
-- ever matched a pending market/position against the CURRENT tick's
-- freshly-fetched event array. If the tick that first saw a market's
-- Funded event also hit a transient failure downstream (e.g. GenLayer's
-- RPC quota/rate limit), the create_market/stake call threw, the error was
-- only logged, and the watermark had already moved past that block — so no
-- future tick could ever see that event again. The market/position was
-- permanently stranded in 'pending_chain' with its USDC already sitting in
-- ChronixEscrow, with no automated recovery.
--
-- Fix: persist every scanned Funded event durably here as soon as it's
-- seen, independent of whether relaying it succeeds. relayPendingPools/
-- relayPendingStakes now match pending markets/positions against this
-- table (which never loses a row) instead of the ephemeral per-tick array,
-- so a transient downstream failure is retried on every subsequent pass
-- until it succeeds — exactly the same retry guarantee chain_sync_queue
-- already gives the request_adjudication/settle keeper actions.
CREATE TABLE IF NOT EXISTS base_relay_events (
    id                BIGSERIAL PRIMARY KEY,
    market_id_bytes32 TEXT NOT NULL,
    from_address      TEXT NOT NULL,
    kind              SMALLINT NOT NULL,
    amount            NUMERIC(78, 0) NOT NULL,
    tx_hash           TEXT NOT NULL,
    block_number      NUMERIC(78, 0) NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One Funded log per (tx_hash, market_id_bytes32, kind) — a single tx
    -- only ever emits one Funded event for the escrow's `fund()` call, but
    -- this keeps a re-scanned/overlapping block range from ever inserting
    -- a duplicate row and being matched/relayed twice.
    UNIQUE (tx_hash, market_id_bytes32, kind)
);

CREATE INDEX IF NOT EXISTS base_relay_events_market_kind_idx
    ON base_relay_events (market_id_bytes32, kind);
