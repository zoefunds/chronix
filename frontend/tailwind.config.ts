import type { Config } from 'tailwindcss'

// "Chronology Dark" design system — ported from
// /Users/macbook/Documents/design/EchoMarket/DESIGN.md
// Type scale is intentionally scaled DOWN from the reference mockups per
// product direction: this is a financial-terminal density, not a marketing
// page. See src/design-tokens.ts for the source-of-truth values.
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: '#0b1326',
        'surface-dim': '#0b1326',
        'surface-bright': '#31394d',
        'surface-container-lowest': '#060e20',
        'surface-container-low': '#131b2e',
        'surface-container': '#171f33',
        'surface-container-high': '#222a3d',
        'surface-container-highest': '#2d3449',
        'on-surface': '#dae2fd',
        'on-surface-variant': '#c4c7c9',
        'inverse-surface': '#dae2fd',
        'inverse-on-surface': '#283044',
        outline: '#8e9193',
        'outline-variant': '#444749',
        'surface-tint': '#c4c7c9',
        primary: '#ffffff',
        'on-primary': '#2d3133',
        'primary-container': '#e0e3e5',
        'on-primary-container': '#626567',
        'inverse-primary': '#5c5f61',
        secondary: '#4edea3',
        'on-secondary': '#003824',
        'secondary-container': '#00a572',
        'on-secondary-container': '#00311f',
        tertiary: '#ffffff',
        'on-tertiary': '#472a00',
        'tertiary-container': '#ffddb8',
        'on-tertiary-container': '#8d5900',
        error: '#ffb4ab',
        'on-error': '#690005',
        'error-container': '#93000a',
        'on-error-container': '#ffdad6',
        background: '#0b1326',
        'on-background': '#dae2fd',
        'surface-variant': '#2d3449',
        'surface-charcoal': '#1e293b',
        'border-slate': '#334155',
        'text-muted': '#94a3b8',
        'resolved-emerald': '#10b981',
        'pending-amber': '#f59e0b',
      },
      fontFamily: {
        display: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        body: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        headline: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        label: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // Scaled down materially from DESIGN.md per product direction
        // (financial-terminal density, not marketing-page type).
        'display-lg': ['30px', { lineHeight: '36px', letterSpacing: '-0.02em', fontWeight: '700' }],
        'headline-lg': ['20px', { lineHeight: '26px', letterSpacing: '-0.01em', fontWeight: '600' }],
        'headline-md': ['16px', { lineHeight: '22px', fontWeight: '600' }],
        'body-lg': ['14px', { lineHeight: '22px', fontWeight: '400' }],
        'body-md': ['13px', { lineHeight: '20px', fontWeight: '400' }],
        'body-sm': ['12px', { lineHeight: '17px', fontWeight: '400' }],
        'label-md': ['11px', { lineHeight: '15px', letterSpacing: '0.02em', fontWeight: '500' }],
        'label-sm': ['10px', { lineHeight: '13px', letterSpacing: '0.05em', fontWeight: '500' }],
      },
      borderRadius: {
        sm: '0.125rem',
        DEFAULT: '0.25rem',
        md: '0.375rem',
        lg: '0.5rem',
        xl: '0.75rem',
      },
      spacing: {
        gutter: '24px',
        'margin-mobile': '16px',
        'margin-desktop': '40px',
      },
      maxWidth: {
        'container-max': '1280px',
      },
    },
  },
  plugins: [],
} satisfies Config
