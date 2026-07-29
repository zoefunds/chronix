#!/usr/bin/env bash
# deploy-fly.sh — deploy the Chronix backend to Fly.io.
#
# IMPORTANT: This script is intentionally NOT executed automatically by any
# agent/tooling. Review it and run it yourself once you're ready to deploy.
#
# Prerequisites:
#   - `fly` CLI installed and authenticated (`fly auth login`)
#   - Fly app created once: `fly apps create chronix-backend`
#   - Secrets set (see below) before the first deploy
#   - Build context MUST be the repo root (not backend/) because the backend
#     Dockerfile COPYs ../database/ migrations into the image.
#
# Usage:
#   ./scripts/deploy-fly.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Chronix backend Fly.io deploy"
echo "Repo root (build context): $REPO_ROOT"

if ! command -v fly >/dev/null 2>&1; then
  echo "ERROR: fly CLI not found. Install from https://fly.io/docs/flyctl/install/" >&2
  exit 1
fi

echo
echo "Reminder — set required secrets before first deploy (uncomment/run manually):"
echo "  fly secrets set DATABASE_URL=postgres://... --config backend/fly.toml"
echo "  fly secrets set JWT_SECRET=\$(openssl rand -hex 32) --config backend/fly.toml"
echo "  fly secrets set CONTRACT_ADDRESS=0x... --config backend/fly.toml   # once contract is deployed"
echo "  fly secrets set GENLAYER_RPC_URL=https://studio.genlayer.com/api --config backend/fly.toml"
echo "  fly secrets set CORS_ORIGIN=https://chronix.vercel.app --config backend/fly.toml"
echo

# NOTE: `fly deploy` is deliberately NOT invoked by this script automatically
# when run by an automated agent — uncomment the line below to actually deploy.
#
# fly deploy \
#   --config backend/fly.toml \
#   --dockerfile backend/Dockerfile \
#   --remote-only

echo "Dry run complete. Uncomment the 'fly deploy' block above (or run the command"
echo "directly) once you've verified secrets and are ready to ship:"
echo
echo "  fly deploy --config backend/fly.toml --dockerfile backend/Dockerfile --remote-only"
echo
echo "After first deploy, ensure redundancy per PLANNING.md (24/7, 2 machines/regions):"
echo "  fly scale count 2 --config backend/fly.toml"
echo "  fly regions add lhr --config backend/fly.toml   # pick a second region"
