/**
 * "Chronology Dark" design tokens — ported (not copy-pasted) from
 * /Users/macbook/Documents/design/EchoMarket/DESIGN.md
 *
 * Type scale is deliberately scaled down from the reference mockups: the
 * product direction is a dense, financial-terminal feel, not a marketing
 * page. See tailwind.config.ts for how these are wired into Tailwind's
 * `fontSize` / `colors` theme extension — this file exists so non-Tailwind
 * consumers (e.g. chart libraries, inline styles) can reference the same
 * values as a single source of truth.
 */
export const colors = {
  surface: '#0b1326',
  surfaceContainerLowest: '#060e20',
  surfaceContainerLow: '#131b2e',
  surfaceContainer: '#171f33',
  surfaceContainerHigh: '#222a3d',
  surfaceContainerHighest: '#2d3449',
  onSurface: '#dae2fd',
  onSurfaceVariant: '#c4c7c9',
  outline: '#8e9193',
  outlineVariant: '#444749',
  primary: '#ffffff',
  onPrimary: '#2d3133',
  secondary: '#4edea3',
  onSecondary: '#003824',
  secondaryContainer: '#00a572',
  surfaceVariant: '#2d3449',
  surfaceCharcoal: '#1e293b',
  borderSlate: '#334155',
  textMuted: '#94a3b8',
  resolvedEmerald: '#10b981',
  pendingAmber: '#f59e0b',
  error: '#ffb4ab',
  errorContainer: '#93000a',
} as const

export const typeScale = {
  displayLg: { fontFamily: 'Geist', fontSize: '30px', fontWeight: 700, lineHeight: '36px' },
  headlineLg: { fontFamily: 'Geist', fontSize: '20px', fontWeight: 600, lineHeight: '26px' },
  headlineMd: { fontFamily: 'Geist', fontSize: '16px', fontWeight: 600, lineHeight: '22px' },
  bodyLg: { fontFamily: 'Geist', fontSize: '14px', fontWeight: 400, lineHeight: '22px' },
  bodyMd: { fontFamily: 'Geist', fontSize: '13px', fontWeight: 400, lineHeight: '20px' },
  bodySm: { fontFamily: 'Geist', fontSize: '12px', fontWeight: 400, lineHeight: '17px' },
  labelMd: { fontFamily: 'JetBrains Mono', fontSize: '11px', fontWeight: 500, lineHeight: '15px' },
  labelSm: { fontFamily: 'JetBrains Mono', fontSize: '10px', fontWeight: 500, lineHeight: '13px' },
} as const

export const radii = {
  sm: '0.125rem',
  DEFAULT: '0.25rem',
  md: '0.375rem',
  lg: '0.5rem',
  xl: '0.75rem',
  full: '9999px',
} as const

export const spacingBase = 4
export const containerMax = 1280
