/**
 * Reply/forward text: subject prefixing and quoted-body building, for both
 * the rich (HTML) and plain-text composer.
 */
import type { MessageDetail } from '@/shared/rpc'

export function withPrefix(subject: string, prefix: 'Re' | 'Fwd'): string {
  const re = new RegExp(`^${prefix}\\s*:`, 'i')
  const s = subject.trim()
  return re.test(s) ? s : `${prefix}: ${s}`
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function textToHtml(text: string): string {
  return `<p>${escapeHtml(text).replace(/\r?\n/g, '<br>')}</p>`
}

function who(addr: { name: string; address: string } | undefined): string {
  if (!addr) return 'someone'
  return addr.name ? `${addr.name} <${addr.address}>` : addr.address
}

export function buildReplyQuoteHtml(original: MessageDetail): string {
  const when = original.date ? new Date(original.date).toLocaleString() : ''
  const header = `<p>On ${escapeHtml(when)}, ${escapeHtml(who(original.from[0]))} wrote:</p>`
  const content = original.html ?? (original.text ? textToHtml(original.text) : '')
  return `${header}<blockquote style="border-left:2px solid #ccc;margin:0 0 0 8px;padding-left:12px;color:#666">${content}</blockquote>`
}

export function buildReplyQuoteText(original: MessageDetail): string {
  const when = original.date ? new Date(original.date).toLocaleString() : ''
  const header = `On ${when}, ${who(original.from[0])} wrote:`
  const body = original.text ?? (original.html ? original.html.replace(/<[^>]+>/g, ' ') : '')
  const quoted = body
    .split(/\r?\n/)
    .map(l => `> ${l}`)
    .join('\n')
  return `${header}\n${quoted}`
}

export function buildForwardHeaderHtml(original: MessageDetail): string {
  const from = original.from[0]
  const when = original.date ? new Date(original.date).toLocaleString() : ''
  return (
    `<p>---------- Forwarded message ----------<br>` +
    `From: ${escapeHtml(from ? from.name || from.address : '')}${from ? ` &lt;${escapeHtml(from.address)}&gt;` : ''}<br>` +
    `Date: ${escapeHtml(when)}<br>` +
    `Subject: ${escapeHtml(original.subject)}<br>` +
    `To: ${escapeHtml(original.to.map(a => a.name || a.address).join(', '))}</p>`
  )
}

export function buildForwardHtml(original: MessageDetail): string {
  const content = original.html ?? (original.text ? textToHtml(original.text) : '')
  return `${buildForwardHeaderHtml(original)}${content}`
}

export function buildForwardText(original: MessageDetail): string {
  const from = original.from[0]
  const when = original.date ? new Date(original.date).toLocaleString() : ''
  const header =
    `---------- Forwarded message ----------\n` +
    `From: ${from ? who(from) : ''}\n` +
    `Date: ${when}\n` +
    `Subject: ${original.subject}\n` +
    `To: ${original.to.map(a => a.name || a.address).join(', ')}\n\n`
  const body = original.text ?? (original.html ? original.html.replace(/<[^>]+>/g, ' ') : '')
  return header + body
}
