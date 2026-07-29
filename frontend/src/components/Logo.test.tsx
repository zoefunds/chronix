import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Logo from './Logo'

describe('Logo', () => {
  it('renders an accessible svg mark', () => {
    render(<Logo />)
    expect(screen.getByRole('img', { name: /echomarkets logo/i })).toBeInTheDocument()
  })
})
