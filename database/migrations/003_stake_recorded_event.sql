-- Adds a dedicated event type for "a stake was recorded after an on-chain
-- confirmation" (POST /markets/:id/positions), distinct from
-- verdict_pending/verdict_settled which are adjudication-lifecycle events.
ALTER TYPE market_event_type ADD VALUE IF NOT EXISTS 'stake_recorded';
