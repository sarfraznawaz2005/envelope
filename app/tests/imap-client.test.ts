import { describe, expect, it } from 'vitest'
import { ImapClient } from '@/engine/imap/client'
import { tokStr } from '@/engine/imap/parser'
import { FakeSocket } from './fake-socket'

const base = { relayUrl: 'ws://x', host: 'h', port: 993, security: 'tls' as const }

describe('ImapClient', () => {
  it('logs in, lists, selects, fetches, searches', async () => {
    const hdr = 'Subject: Hello\r\nFrom: A <a@example.com>\r\n\r\n'
    const sock = new FakeSocket([
      { reply: '* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR IDLE MOVE UIDPLUS LITERAL+] ready\r\n' },
      { expect: /^A1 AUTHENTICATE PLAIN AHVzZXIAcGFzcw==$/, reply: 'A1 OK [CAPABILITY IMAP4rev1 IDLE MOVE UIDPLUS SPECIAL-USE LIST-EXTENDED] done\r\n' },
      { expect: 'A2 CAPABILITY', reply: '* CAPABILITY IMAP4rev1 IDLE MOVE UIDPLUS SPECIAL-USE LIST-EXTENDED LITERAL+\r\nA2 OK\r\n' },
      {
        expect: 'A3 LIST "" "*" RETURN (SPECIAL-USE)',
        reply:
          '* LIST (\\HasNoChildren) "/" "INBOX"\r\n' +
          '* LIST (\\HasNoChildren \\Sent) "/" "Sent Items"\r\n' +
          '* LIST (\\HasNoChildren) "/" "Entw&APw-rfe"\r\n' +
          '* LIST (\\Noselect \\HasChildren) "/" "[Gmail]"\r\n' +
          '* LIST (\\HasNoChildren \\Trash) "/" {13}\r\n[Gmail]/Trash\r\n' +
          'A3 OK LIST done\r\n',
      },
      {
        expect: 'A4 SELECT "INBOX"',
        reply:
          '* FLAGS (\\Answered \\Flagged \\Seen)\r\n* 3 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 42] x\r\n* OK [UIDNEXT 100] y\r\n* OK [PERMANENTFLAGS (\\Seen \\*)] z\r\nA4 OK [READ-WRITE] SELECT completed\r\n',
      },
      {
        expect: 'A5 UID FETCH 1:* (UID FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM)])',
        reply:
          `* 1 FETCH (UID 10 FLAGS (\\Seen) RFC822.SIZE 500 BODY[HEADER.FIELDS (SUBJECT FROM)] {${hdr.length}}\r\n${hdr})\r\n` +
          '* 2 FETCH (UID 11 FLAGS () RFC822.SIZE 600 BODY[HEADER.FIELDS (SUBJECT FROM)] "")\r\n' +
          'A5 OK FETCH done\r\n',
      },
      { expect: 'A6 UID SEARCH UNSEEN', reply: '* SEARCH 11 12\r\nA6 OK\r\n' },
      { expect: 'A7 UID STORE 11 +FLAGS.SILENT (\\Seen)', reply: 'A7 OK\r\n' },
      { expect: 'A8 UID MOVE 11 "[Gmail]/Trash"', reply: '* OK [COPYUID 42 11 5]\r\n* 2 EXPUNGE\r\nA8 OK\r\n' },
      { expect: 'A9 LOGOUT', reply: '* BYE\r\nA9 OK\r\n' },
    ])
    const c = await ImapClient.connect({ ...base, socket: sock })
    expect(c.capabilities.has('AUTH=PLAIN')).toBe(true)
    await c.login('user', 'pass')

    const boxes = await c.list()
    expect(boxes.map(b => [b.path, b.role, b.selectable])).toEqual([
      ['INBOX', 'inbox', true],
      ['Sent Items', 'sent', true],
      ['Entwürfe', 'drafts', true],
      ['[Gmail]', null, false],
      ['[Gmail]/Trash', 'trash', true],
    ])
    expect(boxes[4]!.name).toBe('Trash')

    const st = await c.select('INBOX')
    expect(st).toMatchObject({ exists: 3, uidValidity: 42, uidNext: 100, readOnly: false, permanentFlags: ['\\Seen', '\\*'] })

    const items = await c.fetch('1:*', ['UID', 'FLAGS', 'RFC822.SIZE', 'BODY.PEEK[HEADER.FIELDS (SUBJECT FROM)]'])
    expect(items).toHaveLength(2)
    expect(items[0]!.uid).toBe(10)
    expect(tokStr(items[0]!.attrs.get('BODY[HEADER.FIELDS (SUBJECT FROM)]'))).toBe(hdr)
    expect(items[0]!.attrs.get('FLAGS')).toEqual(['\\Seen'])
    expect(items[1]!.attrs.get('RFC822.SIZE')).toBe(600)

    expect(await c.search('UNSEEN')).toEqual([11, 12])
    await c.store('11', ['\\Seen'], 'add')
    await c.move('11', '[Gmail]/Trash')
    expect(c.selected!.exists).toBe(2)
    await c.logout()
    sock.assertDone()
  })

  it('uses LOGIN with a literal password and waits for continuation', async () => {
    const sock = new FakeSocket([
      { reply: '* OK ready\r\n' },
      { expect: 'A1 CAPABILITY', reply: '* CAPABILITY IMAP4rev1\r\nA1 OK\r\n' },
      { expect: 'A2 LOGIN "user" {7}', reply: '+ go\r\n' },
      { expect: 'pässwd', reply: 'A2 OK\r\n' }, // literal bytes then CRLF
      { expect: 'A3 CAPABILITY', reply: '* CAPABILITY IMAP4rev1\r\nA3 OK\r\n' },
    ])
    const c = await ImapClient.connect({ ...base, socket: sock })
    await c.login('user', 'pässwd')
    sock.assertDone()
  })

  it('IDLE delivers unsolicited events and stops before the next command', async () => {
    const sock = new FakeSocket([
      { reply: '* OK [CAPABILITY IMAP4rev1 IDLE] ready\r\n' },
      { expect: 'A1 SELECT "INBOX"', reply: '* 1 EXISTS\r\nA1 OK\r\n' },
      { expect: 'A2 IDLE', reply: '+ idling\r\n* 2 EXISTS\r\n* 2 FETCH (FLAGS (\\Seen))\r\n' },
      { expect: 'DONE', reply: 'A2 OK idle done\r\n' },
      { expect: 'A3 NOOP', reply: 'A3 OK\r\n' },
    ])
    const c = await ImapClient.connect({ ...base, socket: sock })
    const events: string[] = []
    c.onUnsolicited = u => events.push(`${u.num} ${u.type}`)
    await c.select('INBOX')
    await c.startIdle()
    await new Promise(r => setTimeout(r, 10))
    expect(events).toEqual(['2 EXISTS', '2 FETCH'])
    expect(c.selected!.exists).toBe(2)
    await c.noop() // must send DONE first
    expect(sock.sent).toContain('DONE')
    sock.assertDone()
  })

  it('throws ImapError on NO', async () => {
    const sock = new FakeSocket([
      { reply: '* OK ready\r\n' },
      { expect: 'A1 CAPABILITY', reply: '* CAPABILITY IMAP4rev1\r\nA1 OK\r\n' },
      { expect: 'A2 LOGIN "u" "p"', reply: 'A2 NO [AUTHENTICATIONFAILED] Invalid credentials\r\n' },
    ])
    const c = await ImapClient.connect({ ...base, socket: sock })
    await expect(c.login('u', 'p')).rejects.toMatchObject({ name: 'ImapError', status: 'NO', message: 'Invalid credentials' })
  })
})
