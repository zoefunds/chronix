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
