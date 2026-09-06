import { describe, expect, it } from 'vitest'
import { SmtpClient } from '@/engine/smtp/client'
import { Pop3Client } from '@/engine/pop3/client'
import { buildMessage, quotedPrintable, encodeHeaderText, foldHeader } from '@/engine/mime/build'
import { parseMessage, makeSnippet } from '@/engine/mime/parse'
import { FakeSocket } from './fake-socket'

const td = new TextDecoder()

describe('SmtpClient', () => {
  it('EHLO, STARTTLS, AUTH PLAIN, send with dot-stuffing', async () => {
    const sock = new FakeSocket([
      { reply: '220 mail.example.com ESMTP\r\n' },
      { expect: 'EHLO localhost', reply: '250-mail.example.com\r\n250-STARTTLS\r\n250 SIZE 1000000\r\n' },
      { expect: 'STARTTLS', reply: '220 go ahead\r\n', tls: true },
      { expect: 'EHLO localhost', reply: '250-mail.example.com\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SIZE 1000000\r\n' },
      { expect: 'AUTH PLAIN AHUAcA==', reply: '235 ok\r\n' },
      { expect: /^MAIL FROM:<a@example.com> BODY=8BITMIME SIZE=\d+$/, reply: '250 ok\r\n' },
      { expect: 'RCPT TO:<b@example.com>', reply: '250 ok\r\n' },
      { expect: 'DATA', reply: '354 go\r\n' },
      { expect: 'Subject: x' },
      { expect: '' },
      { expect: '..leading dot' }, // stuffed
      { expect: 'end' },
      { expect: '.', reply: '250 queued as 123\r\n' },
      { expect: 'QUIT', reply: '221 bye\r\n' },
    ])
    const c = await SmtpClient.connect({ relayUrl: 'ws://x', host: 'h', port: 587, security: 'starttls', socket: sock })
    expect(sock.secure).toBe(true)
    await c.auth('u', 'p')
    const r = await c.send({ from: 'a@example.com', to: ['b@example.com'], data: new TextEncoder().encode('Subject: x\r\n\r\n.leading dot\r\nend') })
    expect(r).toContain('queued')
    await c.quit()
    sock.assertDone()
  })

  it('AUTH LOGIN fallback', async () => {
    const sock = new FakeSocket([
      { reply: '220 x\r\n' },
      { expect: 'EHLO localhost', reply: '250-x\r\n250 AUTH LOGIN\r\n' },
      { expect: 'AUTH LOGIN', reply: '334 VXNlcm5hbWU6\r\n' },
      { expect: 'dQ==', reply: '334 UGFzc3dvcmQ6\r\n' },
      { expect: 'cA==', reply: '235 ok\r\n' },
    ])
    const c = await SmtpClient.connect({ relayUrl: 'ws://x', host: 'h', port: 465, security: 'tls', socket: sock })
    await c.auth('u', 'p')
    sock.assertDone()
  })

  it('reports SMTP errors with code', async () => {
    const sock = new FakeSocket([
      { reply: '220 x\r\n' },
      { expect: 'EHLO localhost', reply: '250-x\r\n250 AUTH PLAIN\r\n' },
      { expect: /^AUTH PLAIN/, reply: '535 5.7.8 Authentication failed\r\n' },
    ])
    const c = await SmtpClient.connect({ relayUrl: 'ws://x', host: 'h', port: 465, security: 'tls', socket: sock })
    await expect(c.auth('u', 'p')).rejects.toMatchObject({ name: 'SmtpError', code: 535 })
  })
})

describe('Pop3Client', () => {
  it('login, stat, uidl, retr with dot-unstuffing, dele, quit', async () => {
    const sock = new FakeSocket([
      { reply: '+OK POP3 ready\r\n' },
      { expect: 'CAPA', reply: '+OK\r\nUIDL\r\nTOP\r\n.\r\n' },
      { expect: 'USER u', reply: '+OK\r\n' },
      { expect: 'PASS p', reply: '+OK logged in\r\n' },
      { expect: 'STAT', reply: '+OK 2 320\r\n' },
      { expect: 'UIDL', reply: '+OK\r\n1 whqtswO00WBw418f9t5JxYwZ\r\n2 QhdPYR:00WBw1Ph7x7\r\n.\r\n' },
      { expect: 'RETR 1', reply: '+OK 120 octets\r\nSubject: hi\r\n\r\n..dot line\r\nbody\r\n.\r\n' },
      { expect: 'DELE 1', reply: '+OK deleted\r\n' },
      { expect: 'QUIT', reply: '+OK bye\r\n' },
    ])
    const c = await Pop3Client.connect({ relayUrl: 'ws://x', host: 'h', port: 995, security: 'tls', socket: sock })
    expect(c.capabilities.has('UIDL')).toBe(true)
    await c.login('u', 'p')
    expect(await c.stat()).toEqual({ count: 2, size: 320 })
    expect(await c.uidl()).toEqual([
      { num: 1, uid: 'whqtswO00WBw418f9t5JxYwZ' },
      { num: 2, uid: 'QhdPYR:00WBw1Ph7x7' },
    ])
    expect(td.decode(await c.retr(1))).toBe('Subject: hi\r\n\r\n.dot line\r\nbody')
    await c.dele(1)
    await c.quit()
    sock.assertDone()
  })
})

describe('MIME build + parse', () => {
  it('quoted-printable', () => {
    expect(quotedPrintable('héllo = world')).toBe('h=C3=A9llo =3D world')
    expect(quotedPrintable('trailing \r\nx')).toBe('trailing=20\r\nx')
  })
  it('encoded words + folding', () => {
    expect(encodeHeaderText('plain')).toBe('plain')
    expect(encodeHeaderText('Grüße')).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
    const folded = foldHeader('To', Array.from({ length: 10 }, (_, i) => `person${i}@example.com,`).join(' '))
    for (const l of folded.split('\r\n')) expect(l.length).toBeLessThanOrEqual(78)
  })

  it('builds a message postal-mime can parse back', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3])
    const { bytes, messageId, recipients } = buildMessage({
      from: { name: 'Zoë Ä', address: 'zoe@example.com' },
      to: [{ name: 'Bob', address: 'bob@example.com' }],
      cc: [{ address: 'cc@example.com' }],
      bcc: [{ address: 'hidden@example.com' }],
      subject: 'Grüße from MailClient',
      text: 'Hello Bob,\nline two with = sign\n',
      html: '<p>Hello <b>Bob</b> <img src="cid:img1"></p>',
      attachments: [
        { filename: 'pic.png', mime: 'image/png', data: png, cid: 'img1' },
        { filename: 'Réport.pdf', mime: 'application/pdf', data: new Uint8Array([1, 2, 3]) },
      ],
      inReplyTo: '<abc@example.com>',
      references: ['<abc@example.com>'],
    })
    expect(recipients).toEqual(['bob@example.com', 'cc@example.com', 'hidden@example.com'])
    const raw = td.decode(bytes)
    expect(raw).not.toContain('hidden@example.com') // bcc never in headers
    expect(raw).toContain('Content-Type: multipart/mixed')
    expect(raw).toContain('multipart/alternative')
    expect(raw).toContain('multipart/related')

    const p = await parseMessage(bytes)
    expect(p.messageId).toBe(messageId)
    expect(p.subject).toBe('Grüße from MailClient')
    expect(p.from[0]).toEqual({ name: 'Zoë Ä', address: 'zoe@example.com' })
    expect(p.to[0]!.address).toBe('bob@example.com')
    expect(p.text).toContain('line two with = sign')
    expect(p.html).toContain('<b>Bob</b>')
    expect(p.inReplyTo).toBe('<abc@example.com>')
    expect(p.attachments.map(a => [a.filename, a.mime, a.size])).toEqual([
      ['pic.png', 'image/png', png.length],
      ['Réport.pdf', 'application/pdf', 3],
    ])
    expect(p.attachments[0]!.contentId).toBe('img1')
  })

  it('snippet strips quotes and html', () => {
    expect(makeSnippet('Hi\n> quoted\nthere', null)).toBe('Hi there')
    expect(makeSnippet(null, '<style>x{}</style><p>Hello&nbsp;<b>you</b></p>')).toBe('Hello you')
  })
})
