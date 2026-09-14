/**
 * Base Sepolia <-> GenLayer funding relay.
 *
 * This is the bridge that makes the USDC-on-Base / adjudication-on-GenLayer
 * split (see contracts/chronix.py + contracts/base/ChronixEscrow.sol) work:
 *
 *   1. Deposit direction: scans ChronixEscrow `Funded` events, matches them
 *      to 'pending_chain' markets / not-yet-relayed positions by their
 *      bytes32 key (services/baseSepolia.ts marketIdToBytes32), and mirrors
 *      each confirmed deposit onto GenLayer via create_market/stake. This
 *      is what flips a market from 'pending_chain' to 'open' with a real
 *      contract_market_id — the existing chain indexer (jobs/chainIndexer.ts)
 *      takes over from there for status/financials sync, unchanged.
 *   2. Payout direction: once the chain indexer observes a market reach
 *      'settled' or 'cancelled' on GenLayer, this job computes every
 *      staker's authoritative payout (claim_payout / claim_timeout_refund /
 *      cancel_market — all relayer-gated, all now money-free on GenLayer's
 *      side) and pushes the resulting list onto
 *      ChronixEscrow.setPayouts in one batched call, so every wallet can
 *      self-serve `claim()` there.
 *
 * Both directions are idempotent: the deposit side only ever advances a
 * market/position past its NULL relayed-at marker once a write succeeds;
 * the payout side is guarded by both this job's own `payouts_relayed_at`
 * column AND the escrow contract's own `payoutsSet` gate, so a retry after
 * a partial failure (crash between the GenLayer write and the escrow push)
 * is always safe to just re-run.
 */
import { env } from "../config.js";
import { logger } from "../lib/logger.js";
import { withTransaction } from "../db/pool.js";
import {
  findMarketsPendingPoolRelay,
  findPositionsPendingRelay,
  findMarketsPendingPayoutRelay,
  findMarketsPendingCancelRelay,
  markMarketPoolRelayed,
  markPositionRelayed,
  markMarketPayoutsRelayed,
  getBaseRelayWatermark,
  setBaseRelayWatermark,
  listPositionsForMarket,
  getMarketById,
  insertMarketEvent,
} from "../db/repositories.js";
import { genlayerClient, GenLayerNotConfiguredError } from "../genlayer/client.js";
import {
  getFundedEvents,
  getCurrentBlock,
  marketIdToBytes32,
  relayPayoutsToEscrow,
  isEscrowConfigured,
  type FundedLog,
  type PayoutRecipient,
} from "../services/baseSepolia.js";
import { FUND_KIND_POOL, FUND_KIND_YES, FUND_KIND_NO } from "../lib/escrowAbi.js";

const MAX_BLOCK_RANGE = 2000; // conservative window per pass to stay within RPC log-range limits

async function scanFundedEvents(): Promise<FundedLog[]> {
  const currentBlock = await getCurrentBlock();
  let fromBlock = await getBaseRelayWatermark();
  if (fromBlock === 0) fromBlock = env.BASE_SEPOLIA_ESCROW_DEPLOY_BLOCK;
  if (fromBlock >= currentBlock) return [];

  const toBlock = Math.min(fromBlock + MAX_BLOCK_RANGE, currentBlock);
  const events = await getFundedEvents(fromBlock + 1, toBlock);
  await setBaseRelayWatermark(toBlock);
  return events;
}

/** Relays confirmed pool-liquidity deposits onto GenLayer's create_market. */
async function relayPendingPools(events: FundedLog[]): Promise<number> {
  const poolEvents = events.filter((e) => e.kind === FUND_KIND_POOL);
  if (poolEvents.length === 0) return 0;

  const pending = await findMarketsPendingPoolRelay();
  let relayed = 0;

  for (const market of pending) {
    const key = marketIdToBytes32(market.id);
    const match = poolEvents.find((e) => e.marketId.toLowerCase() === key.toLowerCase());
    if (!match) continue;

    try {
      const { txHash, contractMarketId } = await genlayerClient.createMarket({
        creatorWallet: market.created_by,
        poolDeposited: match.amount.toString(),
        question: market.question,
        category: market.category,
        horizonYears: Number(market.horizon_years),
        resolutionCriteria: market.resolution_criteria,
        allowedEvidenceTypes: market.allowed_evidence_types ?? "",
      });

      await withTransaction(async (client) => {
        await markMarketPoolRelayed(
          market.id,
          { contractMarketId: String(contractMarketId), fundTxHash: match.txHash },
          client
        );
        await insertMarketEvent(
          {
            marketId: market.id,
            type: "created",
            payload: { contractMarketId, baseFundTxHash: match.txHash },
            chainTxHash: txHash,
            confirmed: true,
          },
          client
        );
      });
      relayed += 1;
      logger.info({ marketId: market.id, contractMarketId }, "Relayed pool funding to GenLayer create_market");
    } catch (err) {
      logger.error({ err, marketId: market.id }, "Failed to relay pool funding onto GenLayer");
    }
  }

  return relayed;
}

/** Relays confirmed YES/NO stake deposits onto GenLayer's stake. */
async function relayPendingStakes(events: FundedLog[]): Promise<number> {
  const stakeEvents = events.filter((e) => e.kind === FUND_KIND_YES || e.kind === FUND_KIND_NO);
  if (stakeEvents.length === 0) return 0;

  const pending = await findPositionsPendingRelay();
  let relayed = 0;

  for (const position of pending) {
    const market = await getMarketById(position.market_id);
    if (!market || !market.contract_market_id) continue; // market itself not relayed yet

    const key = marketIdToBytes32(position.market_id);
    const wantedKind = position.side === "yes" ? FUND_KIND_YES : FUND_KIND_NO;
    const match = stakeEvents.find(
      (e) =>
        e.marketId.toLowerCase() === key.toLowerCase() &&
        e.kind === wantedKind &&
        e.from.toLowerCase() === position.wallet_address.toLowerCase() &&
        e.amount.toString() === position.shares
    );
    if (!match) continue;

    try {
      const { txHash } = await genlayerClient.stake({
        contractMarketId: Number(market.contract_market_id),
        wallet: position.wallet_address,
        side: position.side,
        amount: match.amount.toString(),
      });
      await markPositionRelayed(position.id, match.txHash);
      await insertMarketEvent({
        marketId: position.market_id,
        type: "stake_recorded",
        payload: { side: position.side, shares: position.shares, baseFundTxHash: match.txHash },
        chainTxHash: txHash,
        confirmed: true,
      });
      relayed += 1;
      logger.info({ positionId: position.id, marketId: position.market_id }, "Relayed stake to GenLayer");
    } catch (err) {
      logger.error({ err, positionId: position.id }, "Failed to relay stake onto GenLayer");
    }
  }

  return relayed;
}

/**
 * Drives creator-requested cancellations for markets that already made it
 * onto GenLayer (contract_market_id set) before the cancellation request
 * landed — see routes/markets.ts POST /markets/:id/cancel-request and
 * db/repositories.ts requestMarketCancellation. Calls cancel_market
 * (relayer-gated, pre-participation-only — reverts harmlessly if a stake
 * slipped in between the request and this pass) and pushes the refunded
 * pool_deposited onto the escrow for the creator to self-serve claim.
 */
async function relayRequestedCancellations(): Promise<number> {
  const markets = await findMarketsPendingCancelRelay();
  let relayed = 0;

  for (const market of markets) {
    if (!market.contract_market_id) continue;
    try {
      const { amount } = await genlayerClient.cancelMarket(Number(market.contract_market_id));
      if (BigInt(amount) > 0n) {
        const txHash = await relayPayoutsToEscrow(market.id, [
          { wallet: market.created_by, amountBaseUnits: amount },
        ]);
        await markMarketPayoutsRelayed(market.id, txHash);
      } else {
        await markMarketPayoutsRelayed(market.id, "no-op");
      }
      await insertMarketEvent({
        marketId: market.id,
        type: "reconciled",
        payload: { cancelled: true, refundAmount: amount },
        confirmed: true,
      });
      relayed += 1;
      logger.info({ marketId: market.id, amount }, "Relayed creator-requested cancellation");
    } catch (err) {
      logger.error({ err, marketId: market.id }, "Failed to relay requested cancellation");
    }
  }

  return relayed;
}

/** For every settled/cancelled market not yet relayed, computes payouts and pushes them onto the escrow. */
async function relayPendingPayouts(): Promise<number> {
  const markets = await findMarketsPendingPayoutRelay();
  let relayed = 0;

  for (const market of markets) {
    if (!market.contract_market_id) continue;
    const contractMarketId = Number(market.contract_market_id);

    try {
      const recipients: PayoutRecipient[] = [];

      if (market.status === "cancelled") {
        const { amount } = await genlayerClient.cancelMarket(contractMarketId);
        if (BigInt(amount) > 0n) recipients.push({ wallet: market.created_by, amountBaseUnits: amount });
      } else {
        const positions = await listPositionsForMarket(market.id);
        const wallets = [...new Set(positions.map((p) => p.wallet_address))];
        for (const wallet of wallets) {
          try {
            const { amount } = await genlayerClient.claimPayout(contractMarketId, wallet);
            if (BigInt(amount) > 0n) recipients.push({ wallet, amountBaseUnits: amount });
          } catch (err) {
            // A wallet on the losing side of a decisive verdict has a
            // legitimate 0-payout revert — not an error worth failing the
            // whole batch over. Try the timeout-refund path only if the
            // market never actually reached a verdict.
            if (!market.verdict) {
              try {
                const { amount } = await genlayerClient.claimTimeoutRefund(contractMarketId, wallet);
                if (BigInt(amount) > 0n) recipients.push({ wallet, amountBaseUnits: amount });
              } catch (refundErr) {
                logger.debug({ err: refundErr, wallet, marketId: market.id }, "No payout/refund for wallet");
              }
            } else {
              logger.debug({ err, wallet, marketId: market.id }, "No payout for wallet (expected on losing side)");
            }
          }
        }
      }

      if (recipients.length === 0) {
        // Nothing to relay (e.g. a cancelled market with 0 deposited, or
        // every wallet already claimed) — still mark relayed so this pass
        // doesn't retry forever.
        await markMarketPayoutsRelayed(market.id, "no-op");
        continue;
      }

      const txHash = await relayPayoutsToEscrow(market.id, recipients);
      await markMarketPayoutsRelayed(market.id, txHash);
      relayed += 1;
      logger.info({ marketId: market.id, recipientCount: recipients.length, txHash }, "Relayed payouts to escrow");
    } catch (err) {
      logger.error({ err, marketId: market.id }, "Failed to relay payouts onto escrow");
    }
  }

  return relayed;
}

export async function runBaseRelayOnce(): Promise<{
  eventsScanned: number;
  poolsRelayed: number;
  stakesRelayed: number;
  payoutsRelayed: number;
  cancellationsRelayed: number;
}> {
  const empty = { eventsScanned: 0, poolsRelayed: 0, stakesRelayed: 0, payoutsRelayed: 0, cancellationsRelayed: 0 };
  if (!genlayerClient.isConfigured() || !isEscrowConfigured()) {
    return empty;
  }

  try {
    const events = await scanFundedEvents();
    const poolsRelayed = await relayPendingPools(events);
    const stakesRelayed = await relayPendingStakes(events);
    const cancellationsRelayed = await relayRequestedCancellations();
    const payoutsRelayed = await relayPendingPayouts();
    return { eventsScanned: events.length, poolsRelayed, stakesRelayed, payoutsRelayed, cancellationsRelayed };
  } catch (err) {
    if (err instanceof GenLayerNotConfiguredError) {
      return empty;
    }
    throw err;
  }
}

let running = false;

export function startBaseRelay(): () => void {
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const result = await runBaseRelayOnce();
      if (
        result.eventsScanned > 0 ||
        result.poolsRelayed > 0 ||
        result.stakesRelayed > 0 ||
        result.payoutsRelayed > 0 ||
        result.cancellationsRelayed > 0
      ) {
        logger.info(result, "Base Sepolia relay pass complete");
      }
    } catch (err) {
      logger.error({ err }, "Base Sepolia relay pass failed");
    } finally {
      running = false;
    }
  }, env.BASE_RELAY_INTERVAL_MS);

  timer.unref();
  return () => clearInterval(timer);
}
