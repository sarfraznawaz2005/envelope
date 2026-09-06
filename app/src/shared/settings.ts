/**
 * All app settings that live in the database, with their defaults.
 * UI-only prefs (theme, density) live in localStorage — see stores/ui.ts.
 */

export type ImagePolicy = 'never' | 'ask' | 'always'
export type RememberPolicy = 'never' | '7d' | 'always'

export interface Settings {
  // mail
  'mail.threads': boolean
  'mail.unifiedInbox': boolean
  /** ms before an opened message is marked read; -1 = never (manual) */
  'mail.markReadDelay': number
  /** days of mail to keep offline per folder; 0 = everything */
  'mail.cacheDays': number
  'mail.shortcuts': boolean

  // html + images
  'html.enabled': boolean
  'html.allowStyleTags': boolean
  'html.allowExternalCss': boolean
  'html.warnLinks': boolean
  'images.policy': ImagePolicy

  // notifications
  'notify.desktop': boolean
  'notify.sound': boolean
  'notify.title': boolean
  'notify.toast': boolean
  'notify.inboxOnly': boolean

  // contacts
  'contacts.autoCollect': boolean
  'contacts.collectFromReplies': boolean
  'contacts.useCollectedInAutocomplete': boolean
  'contacts.showAddButton': boolean
  'contacts.skipNoReply': boolean

  // disk backup (File System Access API)
  'backup.disk.enabled': boolean
  'backup.disk.intervalMin': number
  'backup.disk.onClose': boolean
  'backup.disk.lastSavedAt': number | null
  'backup.disk.folderName': string | null

  // security
  'security.remember': RememberPolicy
  /** minutes of idle before auto-lock; 0 = never */
  'security.idleLockMin': number

  // relay
  'relay.url': string
  'relay.token': string
}

export const SETTINGS_DEFAULTS: Settings = {
  'mail.threads': true,
  'mail.unifiedInbox': true,
  'mail.markReadDelay': 0,
  'mail.cacheDays': 90,
  'mail.shortcuts': true,

  'html.enabled': true,
  'html.allowStyleTags': true,
  'html.allowExternalCss': false,
  'html.warnLinks': true,
  'images.policy': 'ask',

  'notify.desktop': true,
  'notify.sound': true,
  'notify.title': true,
  'notify.toast': true,
  'notify.inboxOnly': true,

  'contacts.autoCollect': true,
  'contacts.collectFromReplies': false,
  'contacts.useCollectedInAutocomplete': true,
  'contacts.showAddButton': true,
  'contacts.skipNoReply': true,

  'backup.disk.enabled': false,
  'backup.disk.intervalMin': 15,
  'backup.disk.onClose': true,
  'backup.disk.lastSavedAt': null,
  'backup.disk.folderName': null,

  'security.remember': '7d',
  'security.idleLockMin': 60,

  'relay.url': 'ws://127.0.0.1:8765',
  'relay.token': '',
}

export type SettingKey = keyof Settings
export const SETTING_KEYS = Object.keys(SETTINGS_DEFAULTS) as SettingKey[]
