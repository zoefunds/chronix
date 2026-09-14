-- Supports creator-initiated pre-participation cancellation now that
-- cancel_market is relayer-gated on GenLayer (see contracts/chronix.py's
-- class docstring) — the creator's own wallet can no longer call it
-- directly, so a request is recorded here and the relay job
-- (jobs/baseRelay.ts) drives the actual cancellation + refund.
ALTER TABLE markets ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;
