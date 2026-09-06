import { describe, expect, it } from 'vitest'
import { normalizeSubject } from '../src/engine/sync/threads'
import { matchesRule, type Rule, type RuleMatchable } from '../src/engine/sync/rules'
import { hashUidl } from '../src/engine/sync/pop3'

describe('normalizeSubject', () => {
  it('strips one reply/forward prefix', () => {
    expect(normalizeSubject('Re: Hello')).toBe('hello')
    expect(normalizeSubject('Fwd: Hello')).toBe('hello')
    expect(normalizeSubject('Fw: Hello')).toBe('hello')
  })
  it('strips repeated and mixed-case prefixes', () => {
    expect(normalizeSubject('RE: Fwd: re: Hello')).toBe('hello')
    expect(normalizeSubject('re[2]: Hello')).toBe('hello')
  })
  it('collapses whitespace and case', () => {
    expect(normalizeSubject('  Hello    World  ')).toBe('hello world')
  })
  it('leaves an unprefixed subject alone (lowercased)', () => {
    expect(normalizeSubject('Quarterly Report')).toBe('quarterly report')
  })
})

describe('matchesRule', () => {
  const m: RuleMatchable = {
    subject: 'Invoice #42 due',
    from: 'Billing billing@example.com',
    to: 'Me me@mailclient.test',
    fromAddresses: ['billing@example.com'],
    toAddresses: ['me@mailclient.test'],
    hasAttachments: true,
  }

  function rule(matchMode: 'any' | 'all', conditions: Rule['conditions']): Rule {
    return { id: 1, name: 't', matchMode, conditions, actions: [] }
  }

  it('matches "contains" case-insensitively', () => {
    expect(matchesRule(m, rule('any', [{ field: 'subject', op: 'contains', value: 'invoice' }]))).toBe(true)
    expect(matchesRule(m, rule('any', [{ field: 'subject', op: 'contains', value: 'refund' }]))).toBe(false)
  })
  it('respects "all" vs "any"', () => {
    const conds: Rule['conditions'] = [
      { field: 'subject', op: 'contains', value: 'invoice' },
      { field: 'from', op: 'contains', value: 'nope' },
    ]
    expect(matchesRule(m, rule('any', conds))).toBe(true)
    expect(matchesRule(m, rule('all', conds))).toBe(false)
  })
  it('a rule with no conditions matches everything', () => {
    expect(matchesRule(m, rule('all', []))).toBe(true)
  })
  it('supports equals/startsWith/endsWith/notContains', () => {
    expect(matchesRule(m, rule('any', [{ field: 'to', op: 'equals', value: 'me me@mailclient.test' }]))).toBe(true)
    expect(matchesRule(m, rule('any', [{ field: 'subject', op: 'startsWith', value: 'invoice' }]))).toBe(true)
    expect(matchesRule(m, rule('any', [{ field: 'subject', op: 'endsWith', value: 'due' }]))).toBe(true)
    expect(matchesRule(m, rule('any', [{ field: 'subject', op: 'notContains', value: 'refund' }]))).toBe(true)
  })

  it('supports "matches regex", case-insensitively, and never throws on a bad pattern', () => {
    expect(matchesRule(m, rule('any', [{ field: 'subject', op: 'regex', value: '^invoice #\\d+' }]))).toBe(true)
    expect(matchesRule(m, rule('any', [{ field: 'subject', op: 'regex', value: 'REFUND' }]))).toBe(false)
    expect(matchesRule(m, rule('any', [{ field: 'subject', op: 'regex', value: '(unterminated' }]))).toBe(false)
  })

  it('matches the hasAttachment condition on the boolean flag, not text', () => {
    expect(matchesRule(m, rule('any', [{ field: 'hasAttachment', op: 'equals', value: 'true' }]))).toBe(true)
    expect(matchesRule(m, rule('any', [{ field: 'hasAttachment', op: 'equals', value: 'false' }]))).toBe(false)
    expect(matchesRule({ ...m, hasAttachments: false }, rule('any', [{ field: 'hasAttachment', op: 'equals', value: 'false' }]))).toBe(true)
  })
})

describe('hashUidl', () => {
  it('is deterministic', () => {
    expect(hashUidl('abc-123')).toBe(hashUidl('abc-123'))
  })
  it('is always a non-negative integer', () => {
    for (const s of ['a', 'abc', '', 'a very long uidl string with spaces and 日本語']) {
      const h = hashUidl(s)
      expect(Number.isInteger(h)).toBe(true)
      expect(h).toBeGreaterThanOrEqual(0)
    }
  })
  it('differs for different inputs (no trivial collisions in a small sample)', () => {
    const hashes = new Set(['a', 'b', 'c', '1', '2', '3', 'uid-1', 'uid-2'].map(hashUidl))
    expect(hashes.size).toBe(8)
  })
})
