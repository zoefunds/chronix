import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button, HorizonBadge, StatusChip } from './ui'

describe('ui atoms', () => {
  it('renders button children and respects disabled state', () => {
    render(<Button disabled>Stake YES</Button>)
    const btn = screen.getByRole('button', { name: /stake yes/i })
    expect(btn).toBeDisabled()
  })

  it('renders the correct label per market status', () => {
    render(<StatusChip status="awaiting_adjudication" />)
    expect(screen.getByText('AWAITING ADJUDICATION')).toBeInTheDocument()
  })

  it('renders a permanent horizon badge', () => {
    render(<HorizonBadge horizon="permanent" />)
    expect(screen.getByText(/permanent/i)).toBeInTheDocument()
  })

  it('renders a fixed-year horizon badge', () => {
    render(<HorizonBadge horizon={5} />)
    expect(screen.getByText('5Y HORIZON')).toBeInTheDocument()
  })
})
