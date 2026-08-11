-- Mirrors the contract's allowed_evidence_types field into Postgres. The
-- contract now enforces that submit_evidence_pointer's source_type must be
-- one of a market's configured allowed types (provenance hardening), but
-- until now the frontend had no way to know that allow-list without a
-- direct chain read — it only ever set it on-chain, never mirrored it here.
-- NULL/empty is treated as "no restriction" everywhere this is read, so
-- existing rows created before this column existed keep working unchanged.
ALTER TABLE markets ADD COLUMN IF NOT EXISTS allowed_evidence_types TEXT;
