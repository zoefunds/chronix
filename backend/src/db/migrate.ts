/**
 * Simple, dependency-free migration runner.
 * Applies numbered .sql files under database/migrations/ in order,
 * tracking applied migrations in a `schema_migrations` table.
 *
 * Usage: npm run migrate  (reads DATABASE_URL from env)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve both the local-dev layout (tsx runs straight from backend/src/db,
// so repo-root/database is 3 levels up) and the production Docker layout
// (compiled to /app/dist/db, and the Dockerfile COPYs database/ to
// /app/database — only 2 levels up from dist/db). Try both rather than
// hardcoding one, since this file runs unchanged in both contexts.
const candidates = [
  path.resolve(__dirname, "../../../database/migrations"), // local: backend/src/db -> repo root
  path.resolve(__dirname, "../../database/migrations"), // prod: /app/dist/db -> /app
];
const migrationsDir = candidates.find((p) => fs.existsSync(p)) ?? candidates[0];

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const res = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations");
  return new Set(res.rows.map((r) => r.filename));
}

async function run() {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let ranAny = false;
  for (const file of files) {
    if (applied.has(file)) continue;
    const fullPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(fullPath, "utf8");
    // eslint-disable-next-line no-console
    console.log(`Applying migration: ${file}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      ranAny = true;
    } catch (err) {
      await client.query("ROLLBACK");
      // eslint-disable-next-line no-console
      console.error(`Migration failed: ${file}`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  if (!ranAny) {
    // eslint-disable-next-line no-console
    console.log("No pending migrations. Database is up to date.");
  } else {
    // eslint-disable-next-line no-console
    console.log("Migrations complete.");
  }

  await pool.end();
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
