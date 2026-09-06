/** Account shapes shared by UI and engine. */

export type Security = 'tls' | 'starttls' | 'none'
export type AccountKind = 'imap' | 'pop3'

export interface AccountInput {
  id?: number
  name: string
  email: string
  displayName: string
  color: string
  enabled: boolean

  kind: AccountKind
  inHost: string
  inPort: number
  inSecurity: Security
  inUser: string
  /** undefined = keep the stored one */
  inPassword?: string

  smtpHost: string
  smtpPort: number
  smtpSecurity: Security
  smtpUser: string
  smtpPassword?: string
  smtpSameCreds: boolean
  smtpCopyToSent: boolean

  popLeaveOnServer: boolean
  popDeleteAfterDays: number
  pollMinutes: number
  notify: boolean
}

export interface Account extends Omit<AccountInput, 'inPassword' | 'smtpPassword' | 'id'> {
  id: number
  sortOrder: number
  hasInPassword: boolean
  hasSmtpPassword: boolean
  createdAt: number
  updatedAt: number
}

export interface AccountTestStep {
  key: string
  label: string
  ok: boolean
  ms: number
  detail?: string
}

export interface AccountTestResult {
  ok: boolean
  steps: AccountTestStep[]
  folders?: number
  idle?: boolean
  capabilities?: string[]
}

export function emptyAccountInput(): AccountInput {
  return {
    name: '',
    email: '',
    displayName: '',
    color: '#2563eb',
    enabled: true,
    kind: 'imap',
    inHost: '',
    inPort: 993,
    inSecurity: 'tls',
    inUser: '',
    inPassword: '',
    smtpHost: '',
    smtpPort: 587,
    smtpSecurity: 'starttls',
    smtpUser: '',
    smtpPassword: '',
    smtpSameCreds: true,
    smtpCopyToSent: true,
    popLeaveOnServer: true,
    popDeleteAfterDays: 30,
    pollMinutes: 5,
    notify: true,
  }
}

export const ACCOUNT_COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#4f46e5', '#65a30d', '#ea580c']
