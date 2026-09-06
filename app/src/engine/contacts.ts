/**
 * Contacts: minimal autocomplete/collect layer (Phase 7) plus full
 * CRUD, groups, and vCard import/export (Phase 8).
 */
import type { Contact, ContactEmail, ContactGroup, ContactInput, ContactSuggestion, ContactsListFilter } from '@/shared/rpc'
import { getDb, now, type Database, type Param, type Row } from './db'
import { getSetting } from './settings'

export async function contactsAutocomplete(query: string, limit = 8): Promise<ContactSuggestion[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const db = await getDb()
  const useCollected = await getSetting('contacts.useCollectedInAutocomplete')
  const like = `%${q}%`
  const kindFilter = useCollected ? '' : "AND c.kind = 'saved'"
  const rows = await db.all<Row>(
    `SELECT ce.email, c.display_name, c.first_name, c.last_name, c.kind
     FROM contact_emails ce JOIN contacts c ON c.id = ce.contact_id
     WHERE (lower(ce.email) LIKE ? OR lower(c.display_name) LIKE ? OR lower(c.first_name) LIKE ? OR lower(c.last_name) LIKE ?) ${kindFilter}
     ORDER BY (c.kind = 'saved') DESC, c.last_mail_at DESC
     LIMIT ?`,
    [like, like, like, like, limit],
  )
  return rows.map(r => ({
    name: String(r.display_name || `${r.first_name} ${r.last_name}`.trim()),
    address: String(r.email),
  }))
}

/** Adds (or bumps) a "collected" contact — called after a successful send when contacts.autoCollect is on. */
export async function collectContact(address: string, name: string): Promise<void> {
  const addr = address.trim().toLowerCase()
  if (!addr || !addr.includes('@')) return
  if (await getSetting('contacts.skipNoReply')) {
    if (/^(no-?reply|do-?not-?reply)@/i.test(addr)) return
  }
  const db = await getDb()
  const ts = now()
  const existing = await db.get<Row>('SELECT contact_id FROM contact_emails WHERE lower(email) = ?', [addr])
  if (existing) {
    await db.exec('UPDATE contacts SET last_mail_at = ?, updated_at = ? WHERE id = ?', [ts, ts, existing.contact_id])
    return
  }
  await db.tx(async () => {
    const contactId = await db.insert(
      'INSERT INTO contacts (first_name, last_name, display_name, kind, last_mail_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['', '', name || address, 'collected', ts, ts, ts],
    )
    await db.exec('INSERT INTO contact_emails (contact_id, email, label, is_primary) VALUES (?, ?, ?, 1)', [contactId, address, 'work'])
  })
}

// ---------- full CRUD (Phase 8) ----------

async function hydrate(db: Database, c: Row): Promise<Contact> {
  const emails = await db.all<Row>(
    'SELECT email, label, is_primary FROM contact_emails WHERE contact_id = ? ORDER BY is_primary DESC, id',
    [c.id],
  )
  const groups = await db.all<Row>(
    'SELECT g.name FROM contact_group_members m JOIN contact_groups g ON g.id = m.group_id WHERE m.contact_id = ? ORDER BY g.name',
    [c.id],
  )
  return {
    id: Number(c.id),
    firstName: String(c.first_name),
    lastName: String(c.last_name),
    displayName: String(c.display_name),
    phone: String(c.phone),
    notes: String(c.notes),
    kind: c.kind as 'saved' | 'collected',
    lastMailAt: c.last_mail_at != null ? Number(c.last_mail_at) : null,
    emails: emails.map(e => ({ email: String(e.email), label: String(e.label), isPrimary: !!e.is_primary })),
    groups: groups.map(g => String(g.name)),
  }
}

export async function contactsList(filter: ContactsListFilter = {}): Promise<Contact[]> {
  const db = await getDb()
  const clauses: string[] = []
  const params: Param[] = []
  let joinGroup = ''
  if (filter.groupId != null) {
    joinGroup = 'JOIN contact_group_members gm ON gm.contact_id = c.id'
    clauses.push('gm.group_id = ?')
    params.push(filter.groupId)
  }
  if (filter.kind) {
    clauses.push('c.kind = ?')
    params.push(filter.kind)
  }
  if (filter.query?.trim()) {
    const like = `%${filter.query.trim().toLowerCase()}%`
    clauses.push('(lower(c.display_name) LIKE ? OR c.id IN (SELECT contact_id FROM contact_emails WHERE lower(email) LIKE ?))')
    params.push(like, like)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = await db.all<Row>(`SELECT DISTINCT c.* FROM contacts c ${joinGroup} ${where} ORDER BY c.display_name COLLATE NOCASE`, params)
  return Promise.all(rows.map(r => hydrate(db, r)))
}

export async function contactGet(id: number): Promise<Contact | null> {
  const db = await getDb()
  const row = await db.get<Row>('SELECT * FROM contacts WHERE id = ?', [id])
  return row ? hydrate(db, row) : null
}

export async function contactFindByEmail(email: string): Promise<Contact | null> {
  const db = await getDb()
  const addr = email.trim().toLowerCase()
  const row = await db.get<Row>(
    'SELECT c.* FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id WHERE lower(ce.email) = ?',
    [addr],
  )
  return row ? hydrate(db, row) : null
}

export async function contactSave(input: ContactInput): Promise<Contact> {
  const db = await getDb()
  const ts = now()
  const emails = input.emails.filter(e => e.email.trim())
  const displayName = `${input.firstName} ${input.lastName}`.trim() || emails[0]?.email || 'Unnamed'
  let id = input.id ?? null

  await db.tx(async () => {
    if (id != null) {
      await db.exec(
        'UPDATE contacts SET first_name=?, last_name=?, display_name=?, phone=?, notes=?, updated_at=? WHERE id=?',
        [input.firstName, input.lastName, displayName, input.phone, input.notes, ts, id],
      )
    } else {
      id = await db.insert(
        'INSERT INTO contacts (first_name, last_name, display_name, phone, notes, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [input.firstName, input.lastName, displayName, input.phone, input.notes, 'saved', ts, ts],
      )
    }

    const existingEmails = await db.all<Row>('SELECT id, email FROM contact_emails WHERE contact_id = ?', [id])
    const keep = new Set(emails.map(e => e.email.trim().toLowerCase()))
    for (const row of existingEmails) {
      if (!keep.has(String(row.email).toLowerCase())) await db.exec('DELETE FROM contact_emails WHERE id = ?', [row.id])
    }
    for (const e of emails) {
      const addr = e.email.trim()
      await db.exec(
        `INSERT INTO contact_emails (contact_id, email, label, is_primary) VALUES (?, ?, ?, ?)
         ON CONFLICT(lower(email)) DO UPDATE SET contact_id = excluded.contact_id, label = excluded.label, is_primary = excluded.is_primary`,
        [id, addr, e.label || 'work', e.isPrimary ? 1 : 0],
      )
    }

    await db.exec('DELETE FROM contact_group_members WHERE contact_id = ?', [id])
    for (const name of input.groups) {
      const g = name.trim()
      if (!g) continue
      await db.exec('INSERT OR IGNORE INTO contact_groups (name) VALUES (?)', [g])
      const gid = await db.scalar<number>('SELECT id FROM contact_groups WHERE name = ?', [g])
      await db.exec('INSERT OR IGNORE INTO contact_group_members (contact_id, group_id) VALUES (?, ?)', [id, gid])
    }
  })

  const saved = await contactGet(id!)
  if (!saved) throw new Error('Contact save failed')
  return saved
}

export async function contactDelete(id: number): Promise<void> {
  const db = await getDb()
  await db.exec('DELETE FROM contacts WHERE id = ?', [id])
}

export async function contactMoveToSaved(id: number): Promise<void> {
  const db = await getDb()
  await db.exec("UPDATE contacts SET kind = 'saved', updated_at = ? WHERE id = ?", [now(), id])
}

export async function contactGroupsList(): Promise<ContactGroup[]> {
  const db = await getDb()
  const rows = await db.all<Row>(
    `SELECT g.id, g.name, count(m.contact_id) as cnt
     FROM contact_groups g LEFT JOIN contact_group_members m ON m.group_id = g.id
     GROUP BY g.id ORDER BY g.name COLLATE NOCASE`,
  )
  return rows.map(r => ({ id: Number(r.id), name: String(r.name), count: Number(r.cnt) }))
}

export async function contactGroupCreate(name: string): Promise<ContactGroup> {
  const db = await getDb()
  const n = name.trim()
  if (!n) throw new Error('Group name required')
  await db.exec('INSERT OR IGNORE INTO contact_groups (name) VALUES (?)', [n])
  const id = await db.scalar<number>('SELECT id FROM contact_groups WHERE name = ?', [n])
  return { id, name: n, count: 0 }
}

// ---------- vCard import / export ----------

function vcardEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
}

export async function contactsExportVcf(ids?: number[]): Promise<string> {
  const contacts = ids?.length ? await Promise.all(ids.map(contactGet)) : await contactsList()
  const list = contacts.filter((c): c is Contact => !!c)
  return list
    .map(c => {
      const lines = ['BEGIN:VCARD', 'VERSION:3.0']
      lines.push(`N:${vcardEscape(c.lastName)};${vcardEscape(c.firstName)};;;`)
      lines.push(`FN:${vcardEscape(c.displayName)}`)
      for (const e of c.emails) lines.push(`EMAIL;TYPE=${e.label.toUpperCase()}:${e.email}`)
      if (c.phone) lines.push(`TEL:${vcardEscape(c.phone)}`)
      if (c.notes) lines.push(`NOTE:${vcardEscape(c.notes)}`)
      if (c.groups.length) lines.push(`CATEGORIES:${c.groups.map(vcardEscape).join(',')}`)
      lines.push('END:VCARD')
      return lines.join('\r\n')
    })
    .join('\r\n')
}

export async function contactsImportVcf(text: string): Promise<{ imported: number }> {
  const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '')
  const blocks = unfolded.split(/BEGIN:VCARD/i).slice(1)
  let imported = 0

  for (const block of blocks) {
    const body = block.split(/END:VCARD/i)[0]
    const lines = body
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)

    let firstName = ''
    let lastName = ''
    let fn = ''
    let phone = ''
    let notes = ''
    const emails: ContactEmail[] = []
    const groups: string[] = []

    for (const line of lines) {
      const idx = line.indexOf(':')
      if (idx < 0) continue
      const rawKey = line.slice(0, idx)
      const value = line
        .slice(idx + 1)
        .replace(/\\n/gi, '\n')
        .replace(/\\,/g, ',')
        .replace(/\\;/g, ';')
        .replace(/\\\\/g, '\\')
      const key = rawKey.split(';')[0].toUpperCase()

      if (key === 'N') {
        const parts = value.split(';')
        lastName = parts[0] || ''
        firstName = parts[1] || ''
      } else if (key === 'FN') {
        fn = value
      } else if (key === 'EMAIL') {
        const labelMatch = /TYPE=([A-Z]+)/i.exec(rawKey)
        emails.push({ email: value.trim(), label: (labelMatch?.[1] || 'work').toLowerCase(), isPrimary: emails.length === 0 })
      } else if (key === 'TEL') {
        phone = value
      } else if (key === 'NOTE') {
        notes = value
      } else if (key === 'CATEGORIES') {
        groups.push(...value.split(',').map(g => g.trim()).filter(Boolean))
      }
    }

    if (!firstName && !lastName && fn) {
      const parts = fn.split(' ')
      firstName = parts[0] || ''
      lastName = parts.slice(1).join(' ')
    }
    if (!emails.length) continue

    const existing = await contactFindByEmail(emails[0].email)
    await contactSave({ id: existing?.id, firstName, lastName, phone, notes, emails, groups })
    imported++
  }

  return { imported }
}
