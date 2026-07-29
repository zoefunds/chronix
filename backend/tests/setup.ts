// Global test setup: point the app's DB config at the test database and
// supply required env vars before any application module is imported.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://echomarkets:echomarkets@localhost:5450/echomarkets_test";
process.env.JWT_SECRET = "test-secret";
process.env.CORS_ORIGIN = "http://localhost:5173";
process.env.CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS ?? ""; // unset by default in tests
process.env.GENLAYER_RPC_URL = "http://localhost:9999/mock-rpc";
process.env.DEADLINE_ENFORCER_INTERVAL_MS = "60000";
process.env.CHAIN_RECONCILER_INTERVAL_MS = "15000";
process.env.CHAIN_SYNC_MAX_ATTEMPTS = "3";
process.env.CHAIN_SYNC_BASE_BACKOFF_MS = "50";
