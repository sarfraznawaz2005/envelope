/**
 * Turn an IMAP BODYSTRUCTURE token tree into a part tree we can show as an
 * attachment list, and fetch parts by their IMAP section id ("1", "2.1", ...).
 */
import { tokList, tokNum, tokStr, type Token } from './parser'

export interface MimePart {
  /** IMAP section id, e.g. "1", "1.2". Empty for the top-level single part ("TEXT" when fetching). */
  partId: string
  type: string // e.g. "text", "multipart", "image"
  subtype: string // e.g. "plain", "mixed"
  params: Record<string, string>
  id: string | null
  description: string | null
  encoding: string | null
  size: number
  disposition: string | null
  dispositionParams: Record<string, string>
  filename: string | null
  children: MimePart[]
}

function paramsOf(t: Token | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  const l = tokList(t)
  for (let i = 0; i + 1 < l.length; i += 2) out[tokStr(l[i]).toLowerCase()] = tokStr(l[i + 1])
  return out
}

export function parseBodyStructure(tok: Token, partId = ''): MimePart {
  const l = tokList(tok)
  // multipart: starts with a list
  if (Array.isArray(l[0])) {
    const children: MimePart[] = []
    let i = 0
    while (i < l.length && Array.isArray(l[i])) {
      children.push(parseBodyStructure(l[i]!, partId ? `${partId}.${i + 1}` : String(i + 1)))
      i++
    }
    const subtype = tokStr(l[i]).toLowerCase()
    const params = paramsOf(l[i + 1])
    const disp = tokList(l[i + 2])
    return {
      partId,
      type: 'multipart',
      subtype,
      params,
      id: null,
      description: null,
      encoding: null,
      size: 0,
      disposition: disp.length ? tokStr(disp[0]).toLowerCase() : null,
      dispositionParams: paramsOf(disp[1]),
      filename: null,
      children,
    }
  }

  // single part: type subtype params id description encoding size [lines | (envelope body lines)] md5 disposition language location
  const type = tokStr(l[0]).toLowerCase()
  const subtype = tokStr(l[1]).toLowerCase()
  const params = paramsOf(l[2])
  const id = l[3] == null ? null : tokStr(l[3])
  const description = l[4] == null ? null : tokStr(l[4])
  const encoding = l[5] == null ? null : tokStr(l[5]).toLowerCase()
  const size = tokNum(l[6]) ?? 0
  let idx = 7
  if (type === 'text') idx = 8 // lines
  else if (type === 'message' && subtype === 'rfc822') idx = 10 // envelope, body, lines
  // optional extension fields: md5, disposition, language, location
  const disp = tokList(l[idx + 1])
  const dispositionParams = paramsOf(disp[1])
  const filename = dispositionParams.filename ?? params.name ?? null

  const part: MimePart = {
    partId: partId || '1',
    type,
    subtype,
    params,
    id,
    description,
    encoding,
    size,
    disposition: disp.length ? tokStr(disp[0]).toLowerCase() : null,
    dispositionParams,
    filename,
    children: [],
  }
  // embedded message: its body is at l[9]
  if (type === 'message' && subtype === 'rfc822' && Array.isArray(l[8])) {
    part.children = [parseBodyStructure(l[8]!, partId ? `${partId}.1` : '1')]
  }
  return part
}

export function flattenParts(p: MimePart, out: MimePart[] = []): MimePart[] {
  out.push(p)
  for (const c of p.children) flattenParts(c, out)
  return out
}

/** Pick the best text and html body parts for display. */
export function pickBodyParts(root: MimePart): { text: MimePart | null; html: MimePart | null; attachments: MimePart[]; inline: MimePart[] } {
  let text: MimePart | null = null
  let html: MimePart | null = null
  const attachments: MimePart[] = []
  const inline: MimePart[] = []

  const walk = (p: MimePart, inAlternative: boolean) => {
    if (p.type === 'multipart') {
      const alt = p.subtype === 'alternative'
      for (const c of p.children) walk(c, inAlternative || alt)
      return
    }
    const isAttachment = p.disposition === 'attachment' || (!!p.filename && p.type !== 'text')
    if (isAttachment) {
      attachments.push(p)
      return
    }
    if (p.type === 'text' && p.subtype === 'plain' && !text && !p.filename) {
      text = p
      return
    }
    if (p.type === 'text' && p.subtype === 'html' && !html && !p.filename) {
      html = p
      return
    }
    if (p.id || p.disposition === 'inline') {
      inline.push(p)
      return
    }
    attachments.push(p)
  }
  walk(root, false)
  return { text, html, attachments, inline }
}
