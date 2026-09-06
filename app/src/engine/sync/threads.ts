/**
 * Very simple conversation grouping: strip reply/forward prefixes and group
 * messages in the same account that share a normalized subject.
 */

export function normalizeSubject(subject: string): string {
  let s = subject.trim()
  let changed = true
  while (changed) {
    changed = false
    const next = s.replace(/^(re|fwd?|aw|wg)\s*(\[\d+\])?\s*:\s*/i, '')
    if (next !== s) {
      s = next
      changed = true
    }
  }
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}
