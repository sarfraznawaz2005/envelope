import { describe, expect, it } from 'vitest'
import { withPrefix } from '../src/lib/quote-mail'

describe('withPrefix', () => {
  it('adds the prefix when missing', () => {
    expect(withPrefix('Hello', 'Re')).toBe('Re: Hello')
    expect(withPrefix('Hello', 'Fwd')).toBe('Fwd: Hello')
  })
  it('does not double an existing same prefix', () => {
    expect(withPrefix('Re: Hello', 'Re')).toBe('Re: Hello')
    expect(withPrefix('re:Hello', 'Re')).toBe('re:Hello')
  })
  it('stacks a different prefix rather than replacing it', () => {
    expect(withPrefix('Fwd: Hello', 'Re')).toBe('Re: Fwd: Hello')
  })
})
