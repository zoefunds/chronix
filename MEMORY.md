# Chronix — Project Memory

Read this file first in any new session. It is the living memory of architecture decisions,
deployment state, gotchas, and open TODOs for the Chronix project.

> Project name is **Chronix** (renamed from "EchoMarkets" on 2026-07-29 at the user's direct
> request in chat). Repo/package names, contract file (`contracts/chronix.py`, class
> `Chronix`), docs, env defaults (`chronix.xyz`, `chronix.vercel.app` placeholders), and page
> titles were all updated in one pass. The frontend UI wordmark/favicon/logo component
> (`frontend/src/components/Logo.tsx`) still needs a visual pass to match — its text content
> was renamed but the mark itself hasn't been redesigned around the new name.
> An earlier sub-agent had mistakenly treated this same request as a prompt injection and
> refused it — noted here only so a future session doesn't repeat that mistake if the request
> is relayed again through a tool/system channel rather than typed directly by the user.

## Locked architecture decisions (from PLANNING.md, approved 2026-07-29)

- **Database**: PostgreSQL, Docker locally and in production.
- **Backend host**: Fly.io, 24/7 (`min_machines_running>=2`, `auto_restart=true`, `/health`
  check, 2 regions/machines for redundancy).
- **Auth**: Wallet-only, Sign-In-With-Ethereum (SIWE). MetaMask / WalletConnect v2 / Rainbow /
  Zerion. No email/password, no social OAuth.
- **Contract**: One Python GenLayer Intelligent Contract, `contracts/chronix.py`,
  1000+ lines, deployed by the user manually in GenLayer Studio (StudioNet, GEN gas token).
  The user deploys it — this repo never runs a deploy for the contract.
- **Escrow**: Real GEN value transfer. Payable writes read `gl.message.value` only (never a
  caller-supplied amount param). Ledger fields separate from "terms" fields. Zero-then-transfer
  ordering on every payout path. Single `_send_gen` emission chokepoint. Explicit exit paths:
  settle (YES/NO/split), `claim_timeout_refund`, `cancel_market` (pre-participation only).
- **Adjudication**: Contract-side nondeterministic web fetch against >=3 real source
  categories (news/academic/financial), non-strict equivalence-principle consensus so
  validators don't diverge into "undetermined." Never trusts user-submitted evidence summaries
  as fact — only the contract's own fetch is authoritative.
- **Frontend**: React + Vite + Tailwind, Vercel. "Chronology Dark" design system ported from
  the reference HTML files in `/Users/macbook/Documents/design/EchoMarket/`, with all type
  sizes scaled down materially per explicit user instruction (dense financial-terminal feel,
  not marketing-page-sized type).
- **Backend**: Node.js + Fastify + Postgres. Deadline enforcer (60s cron, only flips status
  after BOTH wall-clock AND on-chain deadline check agree — never races ahead of chain truth).
  Chain-write reconciler (`chain_sync_queue` table + worker, retry with backoff, marks
  `market_events.confirmed` only after a real tx receipt).
- **Trust model correction (2026-07-29, important)**: the backend NEVER holds a key that can
  move user GEN. All money-moving contract methods (`create_market`, `stake`, `claim_payout`,
  `claim_timeout_refund`, `cancel_market`) are signed directly by the end user's own wallet in
  the frontend, using `genlayer-js` in the browser — the backend only records what already
  happened on-chain (`POST /markets` and `POST /markets/:id/evidence` now require
  `contractMarketId`/`txHash` as proof, they don't submit writes). The backend DOES hold one
  narrow "keeper" key (`GENLAYER_KEEPER_PRIVATE_KEY`, optional) used only for two non-payable,
  fully-permissionless automation calls: `request_adjudication` and `settle`. Any user's own
  wallet could call those same methods with the same effect — the keeper is a convenience, not
  a privileged actor. A separate `chainIndexer` job (`backend/src/jobs/chainIndexer.ts`)
  periodically re-reads `get_market()` for every active market and reconciles Postgres to match
  chain truth, independent of whether this backend was the one that triggered the transition.

## Deployment state

- **Contract address**: **DEPLOYED** — `0xF0308C069Fb536D334926A01d2d625467fe77b0e` on
  GenLayer Studio/StudioNet. Deployed successfully by the user after two contract fixes (see
  gotchas below). Wired into `.env.example`, `backend/.env.example`, `backend/.env`,
  `frontend/.env.example`, `frontend/.env`.
- **Contract header** (do not touch again): the file that actually deployed successfully uses
  `# v0.2.16` + `# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }`
  as the first two lines — this is the user's own edit, confirmed working. An earlier attempt
  to "fix" this to `py-genlayer:test` (matching the local CLI's scaffold default) was wrong;
  the pinned-hash + version-line form is what actually works against this deployment target.
- **Redis**: optional fail-open read cache (`backend/src/lib/cache.ts`), Upstash-backed, real
  URL only in gitignored `backend/.env`, never committed. Not load-bearing.
- **Backend**: Fly.io config ready (`backend/fly.toml`), not yet deployed — in progress.
- **Frontend**: Vercel config ready (`frontend/vercel.json`), not yet deployed — in progress.
- **Database**: local dev via `docker-compose.yml` (Postgres + backend). Production Postgres
  target TBD — `DATABASE_URL` env var is the integration point either way.

## Known gotchas / hard-won lessons

- **Event-Weaver lesson (do not repeat)**: a prior project only enforced resolution deadlines
  in a backend cron job, not on-chain. This let markets be scored early if the backend clock
  drifted or was compromised, and left the DB and chain able to silently diverge. Chronix'
  contract enforces `now >= resolves_at` itself inside `request_adjudication`, and the backend
  never marks a Postgres record "confirmed" until a real chain receipt confirms it — see
  `chain_sync_queue` and the reconciler worker.
- GenLayer nondeterministic blocks require a comparator-based consensus (equivalence
  principle / percentage threshold), not strict equality, or validators reaching
  similar-but-not-identical conclusions will produce "undetermined" status and force leader
  rotation. This is implemented in `contracts/chronix.py`'s `settle` method.
- Escrow money-safety ordering is: read ledger field -> zero it -> persist -> only then
  transfer. Reversing this order (transfer-then-zero) is a reentrancy/double-spend bug class;
  every payout path must follow the same order and guard against `amount <= 0` at entry so a
  replayed call after zeroing reverts cleanly instead of silently doing nothing.

## Open TODOs

- [x] User deploys `contracts/chronix.py` via GenLayer Studio and provides the address.
- [x] Wire `CONTRACT_ADDRESS` into `backend/.env` and `frontend/.env`.
- [x] Rewrote `backend/src/genlayer/client.ts` on the real `genlayer-js` SDK (`createClient`,
      `readContract`/`writeContract`/`waitForTransactionReceipt`, `chains.studionet`), fixed
      the `get_market_state` -> `get_market` drift, and corrected the backend/frontend trust
      model (see note above). Added `chainIndexer.ts` job. All 17 backend integration tests
      pass against a fresh Postgres.
- [~] Frontend GenLayer wallet wiring — PARTIAL, be precise about this with the user:
      - [x] `frontend/src/lib/genlayer.ts` built: browser-side genlayer-js client bound to
        the connected wallet's EIP-1193 provider (`chains.studionet`), covering
        createMarket/stake/submitEvidencePointer/claimPayout/claimTimeoutRefund/cancelMarket.
      - [x] `frontend/src/lib/api.ts` updated to match the backend's real response envelopes
        (`{market}`, `{markets,total}`, `{positions}`, `{evidence}`) and the new
        contractMarketId+txHash "record what already happened on-chain" contract.
      - [x] `CreateMarket.tsx` fully wired end-to-end as the reference implementation: user's
        wallet signs create_market -> waits for receipt -> reads market id -> POSTs to backend.
      - [ ] NOT yet wired: `MarketDetail.tsx`'s Stake YES/NO buttons, evidence submission,
        claim payout / claim timeout refund / cancel market buttons, and the Discover /
        Portfolio / EvidenceLedger / AdjudicationResult pages still render `mockData.ts`
        instead of calling the (now-correct) `api.ts`. The pattern to follow for each is
        exactly what `CreateMarket.tsx` now does — sign via `genlayer.ts`, wait for receipt,
        then POST the proof to the matching backend endpoint.
- [ ] Provision production Postgres and set `DATABASE_URL` for the Fly deploy.
- [ ] Run `fly deploy` from `backend/`.
- [ ] Run `vercel --prod` from `frontend/` (target project name: `chronix` or `chronix-app`,
      per user request 2026-07-29).
- [x] Chronix rename applied across repo/docs/env defaults. Frontend logo mark still needs a
      visual redesign pass (currently just renamed text, not a new mark).
- [ ] Review contract test coverage once `contracts/tests/` lands — GenVM likely can't run
      under pytest directly, so tests target the pure-logic helpers (bps math, ledger-zeroing
      order, state-machine transitions) extracted for testability.

## Reference materials

- `/Users/macbook/EchoMarket/PLANNING.md` — locked architecture (read first).
- `/Users/macbook/Documents/design/EchoMarket/DESIGN.md` — full "Chronology Dark" design
  system (colors, type scale, spacing, components). Frontend type sizes are intentionally
  scaled down from these values per user instruction.
- `/Users/macbook/Documents/design/EchoMarket/LandingPage.html`,
  `market-discovery.html`, `market-details.html`, `adjudication-result.html` — UI prototypes,
  reinterpreted (not copy-pasted) into the React app.
- `/Users/macbook/Documents/README/Prediction Market/Echo Market.md` — original production
  rules brief (no toy code, full folder structure, phased delivery).
