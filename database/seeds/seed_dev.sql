-- seed_dev.sql
-- Local dev seed data. Not for production use.
-- Run: psql "$DATABASE_URL" -f database/seeds/seed_dev.sql

BEGIN;

INSERT INTO users (wallet_address, nickname) VALUES
    ('0x1111111111111111111111111111111111111111', 'alice.eth'),
    ('0x2222222222222222222222222222222222222222', 'bob.eth'),
    ('0x3333333333333333333333333333333333333333', NULL)
ON CONFLICT (wallet_address) DO NOTHING;

WITH m1 AS (
    INSERT INTO markets (question, category, horizon_years, resolution_criteria, created_by, status, resolves_at)
    VALUES (
        'Will historians of 2075 regard the 2026 AI regulatory framework as effective?',
        'technology',
        10,
        'Resolved by consensus of >=3 independent long-form retrospective sources published within 90 days after the horizon date, weighing academic and major press analysis.',
        '0x1111111111111111111111111111111111111111',
        'open',
        now() + interval '10 years'
    )
    RETURNING id
),
m2 AS (
    INSERT INTO markets (question, category, horizon_years, resolution_criteria, created_by, status, resolves_at)
    VALUES (
        'Will the 2026 Chronix launch be remembered as a milestone in prediction markets?',
        'crypto',
        3,
        'Resolved by majority sentiment across specialist crypto press and academic citation trends 3 years post-launch.',
        '0x2222222222222222222222222222222222222222',
        'open',
        now() + interval '5 minutes'
    )
    RETURNING id
)
INSERT INTO market_events (market_id, type, payload, confirmed)
SELECT id, 'created', '{}'::jsonb, true FROM m1
UNION ALL
SELECT id, 'created', '{}'::jsonb, true FROM m2;

COMMIT;
