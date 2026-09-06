/**
 * Database schema, as a list of migrations. Each migration runs once, in
 * order, inside a transaction. `PRAGMA user_version` records the last one.
 *
 * Rules:
 *  - Never edit an old migration. Add a new one.
 *  - Keep statements one per array item (the driver runs them one at a time).
 */

export interface Migration {
  version: number
  name: string
  up: string[]
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: [
      // ---- settings: key/value, value is JSON text
      `CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,

      // ---- encrypted secrets (account passwords). AES-GCM with the master key.
      `CREATE TABLE secrets (
        id INTEGER PRIMARY KEY,
        ct BLOB NOT NULL,
        iv BLOB NOT NULL,
        created_at INTEGER NOT NULL
      )`,

      // ---- accounts
      `CREATE TABLE accounts (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT '#2563eb',
        sort_order INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,

        kind TEXT NOT NULL CHECK (kind IN ('imap','pop3')),
        in_host TEXT NOT NULL,
        in_port INTEGER NOT NULL,
        in_security TEXT NOT NULL CHECK (in_security IN ('tls','starttls','none')),
        in_user TEXT NOT NULL,
        in_secret_id INTEGER REFERENCES secrets(id) ON DELETE SET NULL,

        smtp_host TEXT NOT NULL,
        smtp_port INTEGER NOT NULL,
        smtp_security TEXT NOT NULL CHECK (smtp_security IN ('tls','starttls','none')),
        smtp_user TEXT NOT NULL DEFAULT '',
        smtp_secret_id INTEGER REFERENCES secrets(id) ON DELETE SET NULL,
        smtp_same_creds INTEGER NOT NULL DEFAULT 1,
        smtp_copy_to_sent INTEGER NOT NULL DEFAULT 1,

        pop_leave_on_server INTEGER NOT NULL DEFAULT 1,
        pop_delete_after_days INTEGER NOT NULL DEFAULT 30,
        poll_minutes INTEGER NOT NULL DEFAULT 5,
        notify INTEGER NOT NULL DEFAULT 1,

        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,

      // ---- folders
      `CREATE TABLE folders (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        delimiter TEXT,
        role TEXT CHECK (role IN ('inbox','sent','drafts','trash','spam','archive','all')),
        parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
        subscribed INTEGER NOT NULL DEFAULT 1,
        selectable INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        uidvalidity INTEGER,
        uidnext INTEGER,
        highestmodseq INTEGER,
        total INTEGER NOT NULL DEFAULT 0,
        unread INTEGER NOT NULL DEFAULT 0,
        last_sync_at INTEGER,
        UNIQUE (account_id, path)
      )`,

      // ---- threads
      `CREATE TABLE threads (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        subject_norm TEXT NOT NULL DEFAULT '',
        first_date INTEGER,
        last_date INTEGER,
        count INTEGER NOT NULL DEFAULT 0,
        unread INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX idx_threads_account_last ON threads(account_id, last_date DESC)`,

      // ---- messages (headers + flags; body is separate)
      `CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
        uid INTEGER NOT NULL,
        thread_id INTEGER REFERENCES threads(id) ON DELETE SET NULL,
        message_id TEXT,
        in_reply_to TEXT,
        refs TEXT NOT NULL DEFAULT '[]',
        subject TEXT NOT NULL DEFAULT '',
        from_json TEXT NOT NULL DEFAULT '[]',
        to_json TEXT NOT NULL DEFAULT '[]',
        cc_json TEXT NOT NULL DEFAULT '[]',
        bcc_json TEXT NOT NULL DEFAULT '[]',
        reply_to_json TEXT NOT NULL DEFAULT '[]',
        date INTEGER,
        internal_date INTEGER,
        size INTEGER NOT NULL DEFAULT 0,
        flags TEXT NOT NULL DEFAULT '[]',
        seen INTEGER NOT NULL DEFAULT 0,
        flagged INTEGER NOT NULL DEFAULT 0,
        answered INTEGER NOT NULL DEFAULT 0,
        draft INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        has_attachments INTEGER NOT NULL DEFAULT 0,
        snippet TEXT NOT NULL DEFAULT '',
        body_fetched INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE (folder_id, uid)
      )`,
      `CREATE INDEX idx_messages_folder_date ON messages(folder_id, date DESC)`,
      `CREATE INDEX idx_messages_account_date ON messages(account_id, date DESC)`,
      `CREATE INDEX idx_messages_thread ON messages(thread_id)`,
      `CREATE INDEX idx_messages_message_id ON messages(message_id)`,
      `CREATE INDEX idx_messages_unread ON messages(folder_id, seen)`,

      // ---- message bodies
      `CREATE TABLE message_bodies (
        message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        text TEXT,
        html TEXT,
        headers TEXT NOT NULL DEFAULT '{}',
        fetched_at INTEGER NOT NULL
      )`,

      // ---- attachments (data may be NULL until downloaded)
      `CREATE TABLE attachments (
        id INTEGER PRIMARY KEY,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        part_id TEXT NOT NULL,
        filename TEXT NOT NULL DEFAULT '',
        mime TEXT NOT NULL DEFAULT 'application/octet-stream',
        size INTEGER NOT NULL DEFAULT 0,
        content_id TEXT,
        disposition TEXT NOT NULL DEFAULT 'attachment',
        data BLOB
      )`,
      `CREATE INDEX idx_attachments_message ON attachments(message_id)`,

      // ---- full-text search (rowid = messages.id)
      `CREATE VIRTUAL TABLE messages_fts USING fts5(
        subject, from_text, to_text, body,
        tokenize = 'unicode61 remove_diacritics 2'
      )`,

      // ---- contacts
      `CREATE TABLE contacts (
        id INTEGER PRIMARY KEY,
        first_name TEXT NOT NULL DEFAULT '',
        last_name TEXT NOT NULL DEFAULT '',
        display_name TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'saved' CHECK (kind IN ('saved','collected')),
        last_mail_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE contact_emails (
        id INTEGER PRIMARY KEY,
        contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT 'work',
        is_primary INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE UNIQUE INDEX idx_contact_emails_email ON contact_emails(lower(email))`,
      `CREATE INDEX idx_contact_emails_contact ON contact_emails(contact_id)`,
      `CREATE TABLE contact_groups (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      )`,
      `CREATE TABLE contact_group_members (
        contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        group_id INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
        PRIMARY KEY (contact_id, group_id)
      )`,

      // ---- rules
      `CREATE TABLE rules (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        match_mode TEXT NOT NULL DEFAULT 'any' CHECK (match_mode IN ('any','all')),
        account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE rule_conditions (
        id INTEGER PRIMARY KEY,
        rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
        field TEXT NOT NULL,
        op TEXT NOT NULL,
        value TEXT NOT NULL DEFAULT ''
      )`,
      `CREATE TABLE rule_actions (
        id INTEGER PRIMARY KEY,
        rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        arg TEXT NOT NULL DEFAULT ''
      )`,

      // ---- signatures (one per account)
      `CREATE TABLE signatures (
        account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        is_html INTEGER NOT NULL DEFAULT 1,
        content TEXT NOT NULL DEFAULT '',
        position TEXT NOT NULL DEFAULT 'above' CHECK (position IN ('above','below')),
        use_on_reply INTEGER NOT NULL DEFAULT 1
      )`,

      // ---- senders whose remote images always load
      `CREATE TABLE sender_image_allow (
        pattern TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )`,

      // ---- per-account/folder sync bookkeeping
      `CREATE TABLE sync_state (
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (account_id, folder_id, key)
      )`,
    ],
  },
  {
    version: 2,
    name: 'pop3_seen',
    up: [
      // ---- POP3 UIDL bookkeeping (POP3 has no numeric UID; we hash it for messages.uid)
      `CREATE TABLE pop3_seen (
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        uidl TEXT NOT NULL,
        message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        first_seen_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, uidl)
      )`,
    ],
  },
  {
    version: 3,
    name: 'message_raw_source',
    up: [
      // ---- raw RFC822 bytes, kept alongside the parsed text/html for "view source"
      `ALTER TABLE message_bodies ADD COLUMN raw BLOB`,
    ],
  },
  {
    version: 4,
    name: 'drafts',
    up: [
      // ---- compose autosave. id is a client-generated UUID so autosave never needs a round trip first.
      `CREATE TABLE drafts (
        id TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        to_json TEXT NOT NULL DEFAULT '[]',
        cc_json TEXT NOT NULL DEFAULT '[]',
        bcc_json TEXT NOT NULL DEFAULT '[]',
        subject TEXT NOT NULL DEFAULT '',
        is_html INTEGER NOT NULL DEFAULT 1,
        body TEXT NOT NULL DEFAULT '',
        in_reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        reply_mode TEXT,
        updated_at INTEGER NOT NULL
      )`,
    ],
  },
]

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version
