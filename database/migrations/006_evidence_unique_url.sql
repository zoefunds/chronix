-- Lets the chain indexer backfill evidence pointers discovered directly
-- on-chain (mirror-POST failures, e.g. hitting GenLayer's request rate
-- limit while a receipt is being polled) without inserting duplicates on
-- every reconciler pass.
CREATE UNIQUE INDEX IF NOT EXISTS evidence_market_url_key
  ON evidence (market_id, url);
