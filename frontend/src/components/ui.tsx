import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import type { MarketStatus } from '../types'

export function Card({ className = '', children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`bg-surface-charcoal border border-border-slate rounded-md ${className}`}
      {...rest}
    >
      {children}
    </div>
  )
}

export function Button({
  variant = 'primary',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'outline' }) {
  const base = 'font-label text-label-md px-3 py-1.5 rounded transition-all disabled:opacity-40 disabled:cursor-not-allowed'
  const styles: Record<string, string> = {
    primary: 'bg-primary text-on-primary hover:bg-secondary hover:text-on-secondary',
    secondary: 'bg-secondary text-on-secondary hover:opacity-90',
    outline: 'bg-transparent border border-border-slate text-on-surface hover:border-secondary hover:text-secondary',
    ghost: 'bg-transparent text-on-surface-variant hover:text-secondary',
  }
  return (
    <button className={`${base} ${styles[variant]} ${className}`} {...rest}>
      {children}
    </button>
  )
}

export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`font-label text-label-sm uppercase tracking-widest text-on-surface-variant ${className}`}>
      {children}
    </span>
  )
}

const statusStyles: Record<MarketStatus, string> = {
  open: 'text-secondary border-secondary/20 bg-secondary/10',
  awaiting_adjudication: 'text-pending-amber border-pending-amber/20 bg-pending-amber/10',
  verdict_pending: 'text-pending-amber border-pending-amber/20 bg-pending-amber/10',
  resolved: 'text-resolved-emerald border-resolved-emerald/20 bg-resolved-emerald/10',
  undetermined: 'text-on-surface-variant border-outline-variant bg-surface-variant',
  cancelled: 'text-error border-error/20 bg-error/10',
}

const statusLabels: Record<MarketStatus, string> = {
  open: 'OPEN',
  awaiting_adjudication: 'AWAITING ADJUDICATION',
  verdict_pending: 'VERDICT PENDING',
  resolved: 'RESOLVED',
  undetermined: 'UNDETERMINED',
  cancelled: 'CANCELLED',
}

export function StatusChip({ status }: { status: MarketStatus }) {
  return (
    <span
      className={`font-label text-label-sm uppercase tracking-widest px-2 py-0.5 border rounded-sm ${statusStyles[status]}`}
    >
      {statusLabels[status]}
    </span>
  )
}

export function EvidenceChip({ children }: { children: ReactNode }) {
  return (
    <span className="font-label text-label-sm bg-surface-variant px-1.5 py-0.5 text-on-surface-variant uppercase tracking-widest rounded-sm">
      {children}
    </span>
  )
}

export function HorizonBadge({ horizon }: { horizon: 3 | 5 | 10 | 'permanent' }) {
  return (
    <span className="font-label text-label-sm text-on-surface-variant bg-surface-variant px-1.5 py-0.5 rounded-sm">
      {horizon === 'permanent' ? '∞ PERMANENT' : `${horizon}Y HORIZON`}
    </span>
  )
}
