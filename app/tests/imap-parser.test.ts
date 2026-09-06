import { describe, expect, it } from 'vitest'
import { parseResponse, tokenize, pairsToMap, tokStr } from '@/engine/imap/parser'
import { parseBodyStructure, pickBodyParts } from '@/engine/imap/bodystructure'
import { decodeUtf7Imap, encodeUtf7Imap } from '@/engine/imap/utf7'
import { seqSet } from '@/engine/imap/client'

describe('tokenize', () => {
  it('parses atoms, numbers, strings, NIL and lists', () => {
    expect(tokenize(['(\\HasNoChildren) "/" "INBOX"'])).toEqual([['\\HasNoChildren'], '/', 'INBOX'])
    expect(tokenize(['UID 12 FLAGS (\\Seen \\Flagged) NIL'])).toEqual(['UID', 12, 'FLAGS', ['\\Seen', '\\Flagged'], null])
    expect(tokenize(['"quoted \\"inner\\" text"'])).toEqual(['quoted "inner" text'])
  })

  it('keeps BODY[...] sections as one atom', () => {
    const t = tokenize(['(BODY[HEADER.FIELDS (FROM TO)] "x" BODY[1]<0.100> "y")'])
    expect(t).toEqual([['BODY[HEADER.FIELDS (FROM TO)]', 'x', 'BODY[1]<0.100>', 'y']])
  })

  it('handles literals in the middle of a list', () => {
    const lit = new TextEncoder().encode('Subject: hi\r\n\r\n')
    const t = tokenize(['(UID 5 BODY[HEADER] {15}', lit, ' FLAGS (\\Seen))'])
    expect(t).toHaveLength(1)
    const m = pairsToMap(t[0] as never)
    expect(m.get('UID')).toBe(5)
    expect(tokStr(m.get('BODY[HEADER]'))).toBe('Subject: hi\r\n\r\n')
    expect(m.get('FLAGS')).toEqual(['\\Seen'])
  })
})

describe('parseResponse', () => {
  it('tagged with code', () => {
    const r = parseResponse(['A3 OK [READ-WRITE] SELECT completed'])
    expect(r).toEqual({ kind: 'tagged', tag: 'A3', status: 'OK', code: ['READ-WRITE'], text: 'SELECT completed' })
  })
  it('untagged numeric', () => {
    expect(parseResponse(['* 172 EXISTS'])).toMatchObject({ kind: 'untagged', num: 172, type: 'EXISTS' })
  })
  it('untagged OK with code', () => {
    const r = parseResponse(['* OK [UIDVALIDITY 3857529045] UIDs valid'])
    expect(r).toMatchObject({ kind: 'untagged', type: 'OK', code: ['UIDVALIDITY', 3857529045], text: 'UIDs valid' })
  })
  it('greeting with capability', () => {
    const r = parseResponse(['* OK [CAPABILITY IMAP4rev1 IDLE AUTH=PLAIN] ready'])
    expect(r).toMatchObject({ type: 'OK', code: ['CAPABILITY', 'IMAP4rev1', 'IDLE', 'AUTH=PLAIN'] })
  })
  it('continuation', () => {
    expect(parseResponse(['+ idling'])).toEqual({ kind: 'continuation', text: 'idling' })
  })
  it('FETCH', () => {
    const r = parseResponse(['* 7 FETCH (UID 99 FLAGS (\\Seen) RFC822.SIZE 1234)'])
    expect(r).toMatchObject({ kind: 'untagged', num: 7, type: 'FETCH' })
    if (r.kind !== 'untagged') throw new Error()
    const m = pairsToMap(r.tokens[0] as never)
    expect(m.get('UID')).toBe(99)
    expect(m.get('RFC822.SIZE')).toBe(1234)
  })
})

describe('bodystructure', () => {
  it('single text part', () => {
    const t = tokenize(['("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 2279 48 NIL NIL NIL)'])
    const p = parseBodyStructure(t[0]!)
    expect(p).toMatchObject({ partId: '1', type: 'text', subtype: 'plain', params: { charset: 'UTF-8' }, encoding: '7bit', size: 2279 })
  })
  it('mixed with alternative and attachment', () => {
    const t = tokenize([
      '((("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 10 1 NIL NIL NIL)("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 20 1 NIL NIL NIL) "ALTERNATIVE" ("BOUNDARY" "b1") NIL NIL)("APPLICATION" "PDF" ("NAME" "inv.pdf") NIL NIL "BASE64" 5000 NIL ("ATTACHMENT" ("FILENAME" "inv.pdf")) NIL) "MIXED" ("BOUNDARY" "b0") NIL NIL)',
    ])
    const p = parseBodyStructure(t[0]!)
    expect(p.type).toBe('multipart')
    expect(p.subtype).toBe('mixed')
    expect(p.children[0]!.subtype).toBe('alternative')
    expect(p.children[0]!.children[0]!.partId).toBe('1.1')
    expect(p.children[0]!.children[1]!.partId).toBe('1.2')
    expect(p.children[1]).toMatchObject({ partId: '2', type: 'application', subtype: 'pdf', filename: 'inv.pdf', disposition: 'attachment', size: 5000 })
    const picked = pickBodyParts(p)
    expect(picked.text?.partId).toBe('1.1')
    expect(picked.html?.partId).toBe('1.2')
    expect(picked.attachments.map(a => a.partId)).toEqual(['2'])
  })
})

describe('utf7', () => {
  it('round trips', () => {
    for (const s of ['INBOX', 'Entwürfe', '日本語', 'A&B', 'Sent Items', 'Boîte de réception']) {
      expect(decodeUtf7Imap(encodeUtf7Imap(s))).toBe(s)
    }
    expect(encodeUtf7Imap('A&B')).toBe('A&-B')
    expect(decodeUtf7Imap('Entw&APw-rfe')).toBe('Entwürfe')
  })
})

describe('seqSet', () => {
  it('compresses ranges', () => {
    expect(seqSet([1, 2, 3, 7, 9, 10, 10])).toBe('1:3,7,9:10')
    expect(seqSet([5])).toBe('5')
  })
})
