-- Prevent duplicate rows for the same on-chain market. Needed now that the
-- chain indexer can insert markets it discovers directly on-chain (backfill
-- for browser mirror-POST failures), and multiple backend machines run that
-- backfill pass concurrently — this constraint plus ON CONFLICT DO NOTHING
-- is what makes concurrent backfill attempts race-safe.
CREATE UNIQUE INDEX IF NOT EXISTS markets_contract_market_id_key
  ON markets (contract_market_id)
  WHERE contract_market_id IS NOT NULL;
