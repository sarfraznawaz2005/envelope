/**
 * Rules engine: loads enabled rules for an account and applies them to a
 * newly-synced message. The rule editor UI lands in Phase 9 — this module
 * just needs to work correctly once rules exist in the database.
 */
import type { ImapClient } from '../imap/client'
import type { Database, Row } from '../db'

// Not the engine's rpc/server `log()` — that module touches worker-only globals at import
// time, which breaks this file's plain unit tests (matchesRule/normalizeSubject). Rule
// failures are a background/best-effort concern, so a console line is enough here.
function warn(msg: string) {
  console.warn(`[rules] ${msg}`)
}

export interface RuleCondition {
  field: string
  op: string
  value: string
}

export interface RuleAction {
  kind: string
  arg: string
}

export interface Rule {
  id: number
  name: string
  matchMode: 'any' | 'all'
  conditions: RuleCondition[]
  actions: RuleAction[]
}

export interface RuleMatchable {
  subject: string
  from: string
  to: string
  fromAddresses: string[]
  toAddresses: string[]
  hasAttachments: boolean
}

export interface RuleApplyResult {
  deleteRequested: boolean
  movedAway: boolean
}

function fieldValue(m: RuleMatchable, field: string): string {
  switch (field) {
    case 'subject':
      return m.subject
    case 'from':
      return m.from
    case 'to':
      return m.to
    default:
      return ''
  }
}

function testCondition(m: RuleMatchable, c: RuleCondition): boolean {
  if (c.field === 'hasAttachment') return m.hasAttachments === (c.value.toLowerCase() === 'true')
  const raw = fieldValue(m, c.field)
  if (c.op === 'regex') {
    try {
      return new RegExp(c.value, 'i').test(raw)
    } catch {
      return false // invalid pattern never matches, rather than throwing during sync
    }
  }
  const hay = raw.toLowerCase()
  const needle = c.value.toLowerCase()
  switch (c.op) {
    case 'contains':
      return hay.includes(needle)
    case 'notContains':
      return !hay.includes(needle)
    case 'equals':
      return hay === needle
    case 'startsWith':
      return hay.startsWith(needle)
    case 'endsWith':
      return hay.endsWith(needle)
    default:
      return false
  }
}

export function matchesRule(m: RuleMatchable, rule: Rule): boolean {
  if (!rule.conditions.length) return true
  return rule.matchMode === 'all' ? rule.conditions.every(c => testCondition(m, c)) : rule.conditions.some(c => testCondition(m, c))
}

export async function loadRules(db: Database, accountId: number): Promise<Rule[]> {
  const rows = await db.all<Row>('SELECT * FROM rules WHERE enabled = 1 AND (account_id IS NULL OR account_id = ?) ORDER BY sort_order, id', [accountId])
  const rules: Rule[] = []
  for (const r of rows) {
    const conditions = (await db.all<Row>('SELECT field, op, value FROM rule_conditions WHERE rule_id = ?', [r.id])).map(c => ({
      field: String(c.field),
      op: String(c.op),
      value: String(c.value),
    }))
    const actions = (await db.all<Row>('SELECT kind, arg FROM rule_actions WHERE rule_id = ?', [r.id])).map(a => ({
      kind: String(a.kind),
      arg: String(a.arg),
    }))
    rules.push({ id: Number(r.id), name: String(r.name), matchMode: r.match_mode === 'all' ? 'all' : 'any', conditions, actions })
  }
  return rules
}

/** IMAP: markRead/flag write through to the server; move/delete change the mailbox. */
export async function applyRulesImap(
  ctx: { db: Database; client: ImapClient; folderPath: string; messageDbId: number; uid: number; accountId: number },
  m: RuleMatchable,
  rules: Rule[],
): Promise<RuleApplyResult> {
  let deleteRequested = false
  let movedAway = false
  // The local row must only be removed once the server actually confirms the move/delete —
  // swallowing a network failure here used to delete the message locally while it stayed on
  // the server in its original folder, making it permanently invisible to this client (the
  // next sync advances past its UID and never looks at it again).
  async function moveTo(path: string) {
    if (!path || path === ctx.folderPath) return
    try {
      await ctx.client.move(String(ctx.uid), path)
    } catch (e) {
      warn(`move to "${path}" failed, leaving message in place: ${(e as Error).message}`)
      return
    }
    await ctx.db.exec('DELETE FROM messages WHERE id = ?', [ctx.messageDbId])
    await ctx.db.exec('DELETE FROM messages_fts WHERE rowid = ?', [ctx.messageDbId])
    movedAway = true
  }
  outer: for (const rule of rules) {
    if (!matchesRule(m, rule)) continue
    for (const action of rule.actions) {
      switch (action.kind) {
        case 'markRead':
          await ctx.db.exec('UPDATE messages SET seen = 1 WHERE id = ?', [ctx.messageDbId])
          await ctx.client.store(String(ctx.uid), ['\\Seen'], 'add').catch(e => warn(`markRead store failed: ${(e as Error).message}`))
          break
        case 'flag':
          await ctx.db.exec('UPDATE messages SET flagged = 1 WHERE id = ?', [ctx.messageDbId])
          await ctx.client.store(String(ctx.uid), ['\\Flagged'], 'add').catch(e => warn(`flag store failed: ${(e as Error).message}`))
          break
        case 'delete':
          try {
            await ctx.client.deleteMessages(String(ctx.uid))
          } catch (e) {
            warn(`delete failed, leaving message in place: ${(e as Error).message}`)
            break
          }
          await ctx.db.exec('DELETE FROM messages WHERE id = ?', [ctx.messageDbId])
          await ctx.db.exec('DELETE FROM messages_fts WHERE rowid = ?', [ctx.messageDbId])
          deleteRequested = true
          movedAway = true
          break
        case 'move':
          if (action.arg) await moveTo(action.arg)
          break
        case 'spam': {
          const spamFolder = await ctx.db.get<Row>('SELECT path FROM folders WHERE account_id = ? AND role = ?', [ctx.accountId, 'spam'])
          if (spamFolder) await moveTo(String(spamFolder.path))
          break
        }
      }
      if (movedAway) break outer
    }
    if (rule.actions.some(a => a.kind === 'stop')) break
  }
  return { deleteRequested, movedAway }
}

/** POP3: no server-side move. markRead/flag are local; delete is reported to the caller, who sends DELE. */
export async function applyRulesLocal(db: Database, messageDbId: number, m: RuleMatchable, rules: Rule[]): Promise<RuleApplyResult> {
  let deleteRequested = false
  outer: for (const rule of rules) {
    if (!matchesRule(m, rule)) continue
    for (const action of rule.actions) {
      if (action.kind === 'markRead') await db.exec('UPDATE messages SET seen = 1 WHERE id = ?', [messageDbId])
      else if (action.kind === 'flag') await db.exec('UPDATE messages SET flagged = 1 WHERE id = ?', [messageDbId])
      else if (action.kind === 'delete') {
        deleteRequested = true
        break outer
      }
    }
    if (rule.actions.some(a => a.kind === 'stop')) break
  }
  if (deleteRequested) {
    await db.exec('DELETE FROM messages WHERE id = ?', [messageDbId])
    await db.exec('DELETE FROM messages_fts WHERE rowid = ?', [messageDbId])
  }
  return { deleteRequested, movedAway: deleteRequested }
}
