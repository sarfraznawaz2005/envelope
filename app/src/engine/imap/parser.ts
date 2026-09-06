/**
 * IMAP response reader + tokenizer (RFC 3501 / 9051).
 *
 * A response can span several lines because of literals:
 *   * 12 FETCH (UID 99 BODY[HEADER] {345}\r\n<345 bytes>)\r\n
 * readResponse() collects the text pieces and literal byte chunks.
 * tokenize() turns them into a small tree:
 *   atoms and quoted strings -> string, numbers -> number, NIL -> null,
 *   literals -> Uint8Array, parenthesised lists -> Token[]
 */
import type { LineReader } from '../net/socket'

export type Token = string | number | null | Uint8Array | Token[]
export type RawParts = Array<string | Uint8Array>

export type Response =
  | { kind: 'tagged'; tag: string; status: 'OK' | 'NO' | 'BAD'; code: Token[] | null; text: string }
  | { kind: 'untagged'; num: number | null; type: string; tokens: Token[]; code: Token[] | null; text: string }
  | { kind: 'continuation'; text: string }

const STATUS_TYPES = new Set(['OK', 'NO', 'BAD', 'BYE', 'PREAUTH'])

/** Read one complete response (with any literals) from the socket. */
export async function readResponse(reader: LineReader): Promise<RawParts | null> {
  const parts: RawParts = []
  let line = await reader.readLine()
  if (line === null) return null
  for (;;) {
    parts.push(line)
    const m = /\{(\d+)\}$/.exec(line)
    if (!m) break
    parts.push(await reader.readBytes(Number(m[1])))
    line = (await reader.readLine()) ?? ''
  }
  return parts
}

export function parseResponse(parts: RawParts): Response {
  const first = String(parts[0] ?? '')

  if (first.startsWith('+')) return { kind: 'continuation', text: first.slice(1).trim() }

  const sp = first.indexOf(' ')
  const tag = sp < 0 ? first : first.slice(0, sp)
  const rest = sp < 0 ? '' : first.slice(sp + 1)

  if (tag === '*') {
    // untagged: "* 12 EXISTS", "* 5 FETCH (...)", "* LIST (...) ...", "* OK [CODE] text"
    let num: number | null = null
    let body = rest
    const m = /^(\d+) (\S+)(.*)$/s.exec(rest)
    let type: string
    if (m) {
      num = Number(m[1])
      type = m[2]!.toUpperCase()
      body = m[3]!.trimStart()
    } else {
      const sp2 = rest.indexOf(' ')
      type = (sp2 < 0 ? rest : rest.slice(0, sp2)).toUpperCase()
      body = sp2 < 0 ? '' : rest.slice(sp2 + 1)
    }
    if (STATUS_TYPES.has(type)) {
      const { code, text } = parseStatusText(body)
      return { kind: 'untagged', num, type, tokens: [], code, text }
    }
    const tokenParts: RawParts = [body, ...parts.slice(1)]
    return { kind: 'untagged', num, type, tokens: tokenize(tokenParts), code: null, text: '' }
  }

  // tagged
  const sp2 = rest.indexOf(' ')
  const status = (sp2 < 0 ? rest : rest.slice(0, sp2)).toUpperCase() as 'OK' | 'NO' | 'BAD'
  const { code, text } = parseStatusText(sp2 < 0 ? '' : rest.slice(sp2 + 1))
  return { kind: 'tagged', tag, status, code, text }
}

function parseStatusText(s: string): { code: Token[] | null; text: string } {
  if (s.startsWith('[')) {
    const end = s.indexOf(']')
    if (end > 0) {
      return { code: tokenize([s.slice(1, end)]), text: s.slice(end + 1).trim() }
    }
  }
  return { code: null, text: s.trim() }
}

// ---------- tokenizer ----------

const ATOM_SPECIALS = new Set([' ', '(', ')', '{', '"', '\r', '\n'])

export function tokenize(parts: RawParts): Token[] {
  let pi = 0
  let text = typeof parts[0] === 'string' ? parts[0] : ''
  let i = 0

  const advancePart = () => {
    // current text part is done; if next part is a literal it is consumed by the caller
    pi++
    text = typeof parts[pi] === 'string' ? (parts[pi] as string) : ''
    i = 0
  }

  function skipWs() {
    while (i < text.length && text[i] === ' ') i++
  }

  function parseList(): Token[] {
    const out: Token[] = []
    for (;;) {
      skipWs()
      if (i >= text.length) {
        // list continues on the next text part only if a literal was in between
        if (pi + 1 < parts.length) {
          const tok = takeLiteralIfPending()
          if (tok !== undefined) {
            out.push(tok)
            continue
          }
        }
        return out
      }
      const c = text[i]!
      if (c === ')') {
        i++
        return out
      }
      const tok = next()
      if (tok === undefined) return out
      out.push(tok)
    }
  }

  /** If the current text ends with {n} and a literal part follows, consume it. */
  function takeLiteralIfPending(): Token | undefined {
    const lit = parts[pi + 1]
    if (lit instanceof Uint8Array) {
      pi++ // move onto the literal
      advancePart() // and onto the text after it
      return lit
    }
    return undefined
  }

  function next(): Token | undefined {
    skipWs()
    if (i >= text.length) {
      if (pi + 1 < parts.length) return takeLiteralIfPending()
      return undefined
    }
    const c = text[i]!
    if (c === '(') {
      i++
      return parseList()
    }
    if (c === ')') {
      // stray close — treat as end
      i++
      return undefined
    }
    if (c === '"') {
      i++
      let s = ''
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) i++
        s += text[i]
        i++
      }
      i++ // closing quote
      return s
    }
    if (c === '{') {
      // literal marker — the bytes are the next part
      const close = text.indexOf('}', i)
      if (close < 0) {
        // Malformed/truncated marker with no closing '}'. Bailing out here (rather than
        // setting i = close + 1 = 0) is required — resetting to the start of this text
        // would make the caller re-parse the same bytes forever, freezing the worker.
        i = text.length
        return undefined
      }
      i = close + 1
      return takeLiteralIfPending() ?? new Uint8Array(0)
    }
    // atom (with optional [section] and <partial>)
    let s = ''
    while (i < text.length) {
      const ch = text[i]!
      if (ch === '[') {
        let depth = 0
        do {
          const d = text[i]!
          if (d === '[') depth++
          else if (d === ']') depth--
          s += d
          i++
        } while (i < text.length && depth > 0)
        continue
      }
      if (ch === '<' && s.toUpperCase().startsWith('BODY')) {
        const close = text.indexOf('>', i)
        s += text.slice(i, close + 1)
        i = close + 1
        continue
      }
      if (ATOM_SPECIALS.has(ch)) break
      s += ch
      i++
    }
    if (s === 'NIL') return null
    if (/^\d+$/.test(s)) return Number(s)
    return s
  }

  const out: Token[] = []
  for (;;) {
    const t = next()
    if (t === undefined) {
      if (pi + 1 < parts.length) {
        // a literal may still be pending at the end of this text
        const lit = takeLiteralIfPending()
        if (lit !== undefined) {
          out.push(lit)
          continue
        }
        advancePart()
        continue
      }
      break
    }
    out.push(t)
  }
  return out
}

// ---------- helpers for reading token trees ----------

export const td = new TextDecoder('utf-8', { fatal: false })

export function tokStr(t: Token | undefined): string {
  if (t === undefined || t === null) return ''
  if (typeof t === 'string') return t
  if (typeof t === 'number') return String(t)
  if (t instanceof Uint8Array) return td.decode(t)
  return ''
}

export function tokNum(t: Token | undefined): number | null {
  if (typeof t === 'number') return t
  if (typeof t === 'string' && /^\d+$/.test(t)) return Number(t)
  return null
}

export function tokList(t: Token | undefined): Token[] {
  return Array.isArray(t) ? t : []
}

export function tokBytes(t: Token | undefined): Uint8Array {
  if (t instanceof Uint8Array) return t
  if (typeof t === 'string') return new TextEncoder().encode(t)
  return new Uint8Array(0)
}

/** Turn a FETCH attribute list (KEY value KEY value ...) into a map with upper-case keys. */
export function pairsToMap(list: Token[]): Map<string, Token> {
  const m = new Map<string, Token>()
  for (let i = 0; i + 1 < list.length; i += 2) {
    const k = tokStr(list[i]).toUpperCase()
    m.set(k, list[i + 1]!)
  }
  return m
}
