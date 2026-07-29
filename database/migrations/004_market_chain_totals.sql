-- Live financial figures (yes/no pool totals, creator liquidity) live
-- on-chain, not in Postgres's terms-only markets row. The chain indexer
-- needs somewhere to mirror them so the Discover/MarketDetail UI can render
-- real numbers without a chain read on every page view.
ALTER TABLE markets
    ADD COLUMN IF NOT EXISTS pool_deposited_wei NUMERIC(78, 0) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_yes_wei       NUMERIC(78, 0) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_no_wei        NUMERIC(78, 0) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS verdict             TEXT;
