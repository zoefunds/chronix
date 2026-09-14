/**
 * GEN uses 18 decimals. Converts a wei amount to a display GEN number without
 * precision loss on the integer part. Accepts both plain wei-integer strings
 * and decimal-string GEN amounts (e.g. NUMERIC columns from Postgres return
 * "3.000000000000000000"), since BigInt() throws on any string with a '.'.
 */
export function weiToGen(wei: string | null | undefined): number {
  if (!wei) return 0
  if (wei.includes('.')) return Number(wei)
  const big = BigInt(wei)
  const whole = big / 10n ** 18n
  const frac = big % 10n ** 18n
  return Number(whole) + Number(frac) / 1e18
}

export function formatGen(wei: string | null | undefined, opts: { decimals?: number } = {}): string {
  const value = weiToGen(wei)
  return value.toLocaleString(undefined, { maximumFractionDigits: opts.decimals ?? 2 })
}

/**
 * USDC uses 6 decimals. Funding moved from native GEN to real USDC on Base
 * Sepolia (see contracts/chronix.py + contracts/base/ChronixEscrow.sol) —
 * the DB/API fields are still named *_wei for backward compatibility, but
 * their values are now USDC base units, not GEN wei. Same string/BigInt
 * handling as weiToGen above.
 */
export function baseUnitsToUsdc(units: string | null | undefined): number {
  if (!units) return 0
  if (units.includes('.')) return Number(units)
  const big = BigInt(units)
  const whole = big / 10n ** 6n
  const frac = big % 10n ** 6n
  return Number(whole) + Number(frac) / 1e6
}

export function formatUsdc(units: string | null | undefined, opts: { decimals?: number } = {}): string {
  const value = baseUnitsToUsdc(units)
  return value.toLocaleString(undefined, { maximumFractionDigits: opts.decimals ?? 2 })
}
