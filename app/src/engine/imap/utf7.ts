/**
 * IMAP mailbox names use "modified UTF-7" (RFC 3501 §5.1.3).
 * "&" starts a base64 run of UTF-16BE, "-" ends it, "&-" is a literal "&".
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,'

export function decodeUtf7Imap(s: string): string {
  if (!s.includes('&')) return s
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c !== '&') {
      out += c
      i++
      continue
    }
    const end = s.indexOf('-', i + 1)
    if (end < 0) {
      out += s.slice(i)
      break
    }
    const run = s.slice(i + 1, end)
    if (run === '') out += '&'
    else out += b64ToUtf16(run)
    i = end + 1
  }
  return out
}

export function encodeUtf7Imap(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const code = s.charCodeAt(i)
    if (code >= 0x20 && code <= 0x7e) {
      out += s[i] === '&' ? '&-' : s[i]
      i++
      continue
    }
    // collect a run of non-ASCII
    let j = i
    while (j < s.length) {
      const cc = s.charCodeAt(j)
      if (cc >= 0x20 && cc <= 0x7e) break
      j++
    }
    out += '&' + utf16ToB64(s.slice(i, j)) + '-'
    i = j
  }
  return out
}

function b64ToUtf16(run: string): string {
  const bits: number[] = []
  for (const ch of run) {
    const v = B64.indexOf(ch)
    if (v < 0) continue
    bits.push((v >> 5) & 1, (v >> 4) & 1, (v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1)
  }
  let out = ''
  for (let i = 0; i + 16 <= bits.length; i += 16) {
    let code = 0
    for (let k = 0; k < 16; k++) code = (code << 1) | bits[i + k]!
    out += String.fromCharCode(code)
  }
  return out
}

function utf16ToB64(s: string): string {
  const bits: number[] = []
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    for (let k = 15; k >= 0; k--) bits.push((code >> k) & 1)
  }
  let out = ''
  for (let i = 0; i < bits.length; i += 6) {
    let v = 0
    for (let k = 0; k < 6; k++) v = (v << 1) | (bits[i + k] ?? 0)
    out += B64[v]
  }
  return out
}
