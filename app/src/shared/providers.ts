/**
 * Guess server settings from an email domain. Known providers first, then
 * the common imap./smtp./pop. pattern.
 */
import type { AccountInput, Security } from './accounts'

interface Preset {
  imap: [string, number, Security]
  pop3?: [string, number, Security]
  smtp: [string, number, Security]
  note?: string
}

const PRESETS: Record<string, Preset> = {
  'gmail.com': { imap: ['imap.gmail.com', 993, 'tls'], pop3: ['pop.gmail.com', 995, 'tls'], smtp: ['smtp.gmail.com', 587, 'starttls'], note: 'Gmail needs an App Password (Google Account → Security → 2-Step Verification → App passwords).' },
  'googlemail.com': { imap: ['imap.gmail.com', 993, 'tls'], pop3: ['pop.gmail.com', 995, 'tls'], smtp: ['smtp.gmail.com', 587, 'starttls'], note: 'Gmail needs an App Password.' },
  'outlook.com': { imap: ['outlook.office365.com', 993, 'tls'], pop3: ['outlook.office365.com', 995, 'tls'], smtp: ['smtp-mail.outlook.com', 587, 'starttls'], note: 'Outlook.com may require OAuth; basic auth is being phased out.' },
  'hotmail.com': { imap: ['outlook.office365.com', 993, 'tls'], pop3: ['outlook.office365.com', 995, 'tls'], smtp: ['smtp-mail.outlook.com', 587, 'starttls'] },
  'live.com': { imap: ['outlook.office365.com', 993, 'tls'], pop3: ['outlook.office365.com', 995, 'tls'], smtp: ['smtp-mail.outlook.com', 587, 'starttls'] },
  'yahoo.com': { imap: ['imap.mail.yahoo.com', 993, 'tls'], pop3: ['pop.mail.yahoo.com', 995, 'tls'], smtp: ['smtp.mail.yahoo.com', 465, 'tls'], note: 'Yahoo needs an App Password.' },
  'icloud.com': { imap: ['imap.mail.me.com', 993, 'tls'], smtp: ['smtp.mail.me.com', 587, 'starttls'], note: 'iCloud needs an app-specific password.' },
  'me.com': { imap: ['imap.mail.me.com', 993, 'tls'], smtp: ['smtp.mail.me.com', 587, 'starttls'] },
  'mac.com': { imap: ['imap.mail.me.com', 993, 'tls'], smtp: ['smtp.mail.me.com', 587, 'starttls'] },
  'fastmail.com': { imap: ['imap.fastmail.com', 993, 'tls'], pop3: ['pop.fastmail.com', 995, 'tls'], smtp: ['smtp.fastmail.com', 465, 'tls'], note: 'Fastmail needs an app password.' },
  'fastmail.fm': { imap: ['imap.fastmail.com', 993, 'tls'], smtp: ['smtp.fastmail.com', 465, 'tls'] },
  'zoho.com': { imap: ['imap.zoho.com', 993, 'tls'], pop3: ['pop.zoho.com', 995, 'tls'], smtp: ['smtp.zoho.com', 465, 'tls'] },
  'gmx.com': { imap: ['imap.gmx.com', 993, 'tls'], pop3: ['pop.gmx.com', 995, 'tls'], smtp: ['mail.gmx.com', 587, 'starttls'] },
  'gmx.de': { imap: ['imap.gmx.net', 993, 'tls'], pop3: ['pop.gmx.net', 995, 'tls'], smtp: ['mail.gmx.net', 587, 'starttls'] },
  'gmx.net': { imap: ['imap.gmx.net', 993, 'tls'], pop3: ['pop.gmx.net', 995, 'tls'], smtp: ['mail.gmx.net', 587, 'starttls'] },
  'web.de': { imap: ['imap.web.de', 993, 'tls'], pop3: ['pop3.web.de', 995, 'tls'], smtp: ['smtp.web.de', 587, 'starttls'] },
  'yandex.com': { imap: ['imap.yandex.com', 993, 'tls'], pop3: ['pop.yandex.com', 995, 'tls'], smtp: ['smtp.yandex.com', 465, 'tls'] },
  'yandex.ru': { imap: ['imap.yandex.ru', 993, 'tls'], pop3: ['pop.yandex.ru', 995, 'tls'], smtp: ['smtp.yandex.ru', 465, 'tls'] },
  'aol.com': { imap: ['imap.aol.com', 993, 'tls'], pop3: ['pop.aol.com', 995, 'tls'], smtp: ['smtp.aol.com', 465, 'tls'] },
  'mail.com': { imap: ['imap.mail.com', 993, 'tls'], pop3: ['pop.mail.com', 995, 'tls'], smtp: ['smtp.mail.com', 587, 'starttls'] },
  'proton.me': { imap: ['127.0.0.1', 1143, 'starttls'], smtp: ['127.0.0.1', 1025, 'starttls'], note: 'Proton needs Proton Mail Bridge running on this PC.' },
  'protonmail.com': { imap: ['127.0.0.1', 1143, 'starttls'], smtp: ['127.0.0.1', 1025, 'starttls'], note: 'Proton needs Proton Mail Bridge running on this PC.' },
}

export interface Guess {
  patch: Partial<AccountInput>
  known: boolean
  note?: string
}

export function guessSettings(email: string, kind: 'imap' | 'pop3' = 'imap'): Guess {
  const domain = email.split('@')[1]?.toLowerCase().trim() ?? ''
  if (!domain) return { patch: {}, known: false }
  const p = PRESETS[domain]
  if (p) {
    const inn = kind === 'pop3' && p.pop3 ? p.pop3 : p.imap
    return {
      known: true,
      note: p.note,
      patch: {
        kind: kind === 'pop3' && p.pop3 ? 'pop3' : 'imap',
        inHost: inn[0],
        inPort: inn[1],
        inSecurity: inn[2],
        inUser: email,
        smtpHost: p.smtp[0],
        smtpPort: p.smtp[1],
        smtpSecurity: p.smtp[2],
        smtpUser: email,
      },
    }
  }
  return {
    known: false,
    patch: {
      inHost: `${kind === 'pop3' ? 'pop' : 'imap'}.${domain}`,
      inPort: kind === 'pop3' ? 995 : 993,
      inSecurity: 'tls',
      inUser: email,
      smtpHost: `smtp.${domain}`,
      smtpPort: 587,
      smtpSecurity: 'starttls',
      smtpUser: email,
    },
  }
}

/** Default port for a protocol + security combo. */
export function defaultPort(kind: 'imap' | 'pop3' | 'smtp', security: Security): number {
  if (kind === 'imap') return security === 'tls' ? 993 : 143
  if (kind === 'pop3') return security === 'tls' ? 995 : 110
  return security === 'tls' ? 465 : security === 'starttls' ? 587 : 25
}
