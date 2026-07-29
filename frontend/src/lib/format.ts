/** GEN uses 18 decimals. Converts a decimal-string wei amount to a display GEN number without precision loss on the integer part. */
export function weiToGen(wei: string | null | undefined): number {
  if (!wei) return 0
  const big = BigInt(wei)
  const whole = big / 10n ** 18n
  const frac = big % 10n ** 18n
  return Number(whole) + Number(frac) / 1e18
}

export function formatGen(wei: string | null | undefined, opts: { decimals?: number } = {}): string {
  const value = weiToGen(wei)
  return value.toLocaleString(undefined, { maximumFractionDigits: opts.decimals ?? 2 })
}
