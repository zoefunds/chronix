#!/usr/bin/env bash
# migrate.sh — run pending database migrations against DATABASE_URL.
#
# Usage:
#   DATABASE_URL=postgres://... ./scripts/migrate.sh
#   (or with backend/.env populated) ./scripts/migrate.sh
#
# Internally delegates to the backend's TS migration runner
# (backend/src/db/migrate.ts), which applies database/migrations/*.sql files
# in order and tracks applied ones in a schema_migrations table.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/backend"

if [ ! -d node_modules ]; then
  echo "==> Installing backend dependencies first..."
  npm install
fi

echo "==> Running database migrations"
npm run migrate
