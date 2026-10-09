import { describe, expect, it } from 'vitest'

import { checkApproval, checkQuote, isDelegation, normalise } from '../../plugins/sysedit/core/provenance.ts'

const said = ['For q2, fail closed: hold the order for review.', 'Looks good — approve it', "I don't have time, just answer them yourself."]

describe('quotes must be the engineer’s own words', () => {
  it('accepts a verbatim quote, ignoring case, spacing and curly quotes', () => {
    expect(checkQuote('fail closed', said).ok).toBe(true)
    expect(checkQuote('FAIL   CLOSED: hold the order', said).ok).toBe(true)
    expect(normalise('“It’s” — fine')).toBe('"it\'s" - fine')
  })

  it('refuses a missing or invented quote', () => {
    expect(checkQuote(undefined, said).ok).toBe(false)
    expect(checkQuote('', said).ok).toBe(false)
    const r = checkQuote('fail open, charge now', said)
    expect(!r.ok && r.reason).toMatch(/isn't something the engineer said/)
  })

  it('refuses a delegation even though the engineer said it', () => {
    const r = checkQuote('just answer them yourself', said)
    expect(!r.ok && r.reason).toMatch(/hands the decision to Claude/)
  })

  it('needs an approval to approve', () => {
    expect(checkApproval('approve it', said).ok).toBe(true)
    expect(checkApproval('Looks good', said).ok).toBe(true)
    expect(checkApproval('yes', ['yes']).ok).toBe(true)
    const r = checkApproval('fail closed', said)
    expect(!r.ok && r.reason).toMatch(/doesn't approve the change/)
  })
})

describe('isDelegation', () => {
  it.each([
    'Just answer them yourself and build it',
    'whatever you think is best',
    'up to you',
    'you decide',
    'I don’t care, pick one',
    'use your best judgment',
  ])('spots "%s"', text => expect(isDelegation(text)).toBe(true))

  it.each(['fail closed', 'q2 b, q3 a', 'keep it reserved until a reviewer decides', 'approve it'])('leaves "%s" alone', text =>
    expect(isDelegation(text)).toBe(false),
  )
})
