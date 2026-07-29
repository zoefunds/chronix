import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../../../database/migrations");

export function getTestDatabaseUrl(): string {
  return (
    process.env.TEST_DATABASE_URL ??
    "postgres://echomarkets:echomarkets@localhost:5450/echomarkets_test"
  );
}

export function createTestPool(): Pool {
  return new Pool({ connectionString: getTestDatabaseUrl() });
}

export async function applyMigrations(pool: Pool): Promise<void> {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const appliedRes = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations");
  const applied = new Set(appliedRes.rows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    await pool.query(sql);
    await pool.query("INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING", [
      file,
    ]);
  }
}

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      chain_sync_queue,
      market_events,
      evidence,
      positions,
      markets,
      users
    RESTART IDENTITY CASCADE
  `);
}

export async function seedTestUser(pool: Pool, wallet: string): Promise<void> {
  await pool.query(`INSERT INTO users (wallet_address) VALUES ($1) ON CONFLICT DO NOTHING`, [
    wallet,
  ]);
}
