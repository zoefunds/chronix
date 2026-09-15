# Chronix frontend

React 19 + Vite + Tailwind SPA for Chronix. See the [repo root README](../README.md) for the
full project overview (architecture, environment variables, API, deployment) — this file only
covers frontend-specific commands.

## Commands

```bash
cp .env.example .env   # fill in values — see ../README.md#environment-variables
npm install
npm run dev             # vite — http://localhost:5173
npm run build           # tsc -b && vite build
npm run test             # vitest run
npm run lint             # oxlint
npm run preview          # preview a production build locally
```

## Layout

- `src/pages/` — Landing, Discover, MarketDetail, CreateMarket, Portfolio, AdjudicationResult, EvidenceLedger, Docs, Settings, NotFound
- `src/components/` — shared UI components
- `src/lib/` — `api.ts` (backend client), `genlayer.ts` (GenLayer reads + the one wallet-signed write, `submitEvidencePointer`), `escrow.ts` (`ChronixEscrow` fund/claim, the only place real USDC moves), `wagmi.ts` (wallet config for both GenLayer Studio and Base Sepolia), `auth.tsx` (SIWE session), `format.ts` (USDC/GEN formatting helpers)
- `src/types/` — shared TypeScript types

Deployed to Vercel as project `chronix`, serving `https://chronix-app.vercel.app`. Deploy routine: see [`../README.md#frontend-deploy`](../README.md#frontend-deploy).
