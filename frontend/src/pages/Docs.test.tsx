import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Docs from './Docs'

describe('Docs page', () => {
  it('renders the how-it-works heading and key sections', () => {
    render(<Docs />)
    expect(screen.getByText('How EchoMarkets works')).toBeInTheDocument()
    expect(screen.getByText('Wallet-only identity')).toBeInTheDocument()
    expect(screen.getByText('Escrow model')).toBeInTheDocument()
  })
})
