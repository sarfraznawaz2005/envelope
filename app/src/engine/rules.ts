/**
 * Rule management: CRUD, reordering, and "run now on folder" for the UI
 * (Settings > Rules). The matching/apply engine used by the live sync
 * pipeline lives in `./sync/rules.ts` — this module builds on top of it.
 */
import type { RuleActionInput, RuleField, RuleInput, RuleOp, RuleRecord } from '@/shared/rpc'
import { getDb, json, now, type Row } from './db'
import { messageDelete, messageMoveToFolder, messageSetFlag, messageSpam } from './mail-actions'
import { loadRules, matchesRule, type RuleMatchable } from './sync/rules'

function hydrateRule(r: Row, conditions: Row[], actions: Row[]): RuleRecord {
  return {
    id: Number(r.id),
    name: String(r.name),
    enabled: !!r.enabled,
    matchMode: r.match_mode === 'all' ? 'all' : 'any',
    accountId: r.account_id != null ? Number(r.account_id) : null,
    sortOrder: Number(r.sort_order),
    conditions: conditions.map(c => ({ field: c.field as RuleField, op: c.op as RuleOp, value: String(c.value) })),
    actions: actions.map(a => ({ kind: a.kind as RuleActionInput['kind'], arg: String(a.arg) })),
  }
}

export async function rulesList(): Promise<RuleRecord[]> {
  const db = await getDb()
  const rows = await db.all<Row>('SELECT * FROM rules ORDER BY sort_order, id')
  const out: RuleRecord[] = []
  for (const r of rows) {
    const conditions = await db.all<Row>('SELECT * FROM rule_conditions WHERE rule_id = ? ORDER BY id', [r.id])
    const actions = await db.all<Row>('SELECT * FROM rule_actions WHERE rule_id = ? ORDER BY id', [r.id])
    out.push(hydrateRule(r, conditions, actions))
  }
  return out
}

export async function ruleSave(input: RuleInput): Promise<RuleRecord> {
  const db = await getDb()
  let id = input.id ?? null

  await db.tx(async () => {
    if (id != null) {
      await db.exec('UPDATE rules SET name=?, enabled=?, match_mode=?, account_id=? WHERE id=?', [
        input.name,
        input.enabled ? 1 : 0,
        input.matchMode,
        input.accountId,
        id,
      ])
      await db.exec('DELETE FROM rule_conditions WHERE rule_id = ?', [id])
      await db.exec('DELETE FROM rule_actions WHERE rule_id = ?', [id])
    } else {
      const maxOrder = await db.scalar<number>('SELECT COALESCE(MAX(sort_order), -1) FROM rules')
      id = await db.insert('INSERT INTO rules (name, enabled, match_mode, account_id, sort_order, created_at) VALUES (?,?,?,?,?,?)', [
        input.name,
        input.enabled ? 1 : 0,
        input.matchMode,
        input.accountId,
        maxOrder + 1,
        now(),
      ])
    }
    for (const c of input.conditions) {
      if (c.field !== 'hasAttachment' && !c.value.trim()) continue
      await db.exec('INSERT INTO rule_conditions (rule_id, field, op, value) VALUES (?,?,?,?)', [id, c.field, c.op, c.value])
    }
    for (const a of input.actions) {
      await db.exec('INSERT INTO rule_actions (rule_id, kind, arg) VALUES (?,?,?)', [id, a.kind, a.arg])
    }
  })

  const r = await db.get<Row>('SELECT * FROM rules WHERE id = ?', [id])
  if (!r) throw new Error('Rule save failed')
  const conditions = await db.all<Row>('SELECT * FROM rule_conditions WHERE rule_id = ?', [id])
  const actions = await db.all<Row>('SELECT * FROM rule_actions WHERE rule_id = ?', [id])
  return hydrateRule(r, conditions, actions)
}

export async function ruleDelete(id: number): Promise<void> {
  const db = await getDb()
  await db.exec('DELETE FROM rules WHERE id = ?', [id])
}

export async function rulesReorder(orderedIds: number[]): Promise<void> {
  const db = await getDb()
  await db.tx(async () => {
    for (let i = 0; i < orderedIds.length; i++) {
      await db.exec('UPDATE rules SET sort_order = ? WHERE id = ?', [i, orderedIds[i]])
    }
  })
}

interface AddrJson {
  name: string
  address: string
}

export async function rulesRunNow(folderId: number): Promise<{ scanned: number; matched: number }> {
  const db = await getDb()
  const folder = await db.get<Row>('SELECT * FROM folders WHERE id = ?', [folderId])
  if (!folder) throw new Error('Folder not found')
  const accountId = Number(folder.account_id)

  const rules = await loadRules(db, accountId)
  const rows = await db.all<Row>('SELECT id, subject, from_json, to_json, has_attachments FROM messages WHERE folder_id = ?', [folderId])
  if (!rules.length) return { scanned: rows.length, matched: 0 }

  let matched = 0
  for (const row of rows) {
    const from = json<AddrJson[]>(row.from_json, [])
    const to = json<AddrJson[]>(row.to_json, [])
    const matchable: RuleMatchable = {
      subject: String(row.subject ?? ''),
      from: from.map(a => `${a.name} ${a.address}`).join(' '),
      to: to.map(a => `${a.name} ${a.address}`).join(' '),
      fromAddresses: from.map(a => a.address),
      toAddresses: to.map(a => a.address),
      hasAttachments: !!row.has_attachments,
    }
    const hits = rules.filter(r => matchesRule(matchable, r))
    if (!hits.length) continue
    matched++
    const id = Number(row.id)

    outer: for (const rule of hits) {
      for (const action of rule.actions) {
        if (action.kind === 'markRead') await messageSetFlag(id, 'seen', true)
        else if (action.kind === 'flag') await messageSetFlag(id, 'flagged', true)
        else if (action.kind === 'delete') {
          await messageDelete(id)
          break outer
        } else if (action.kind === 'move' && action.arg) {
          const dest = await db.get<Row>('SELECT id FROM folders WHERE account_id = ? AND path = ?', [accountId, action.arg])
          if (dest) {
            await messageMoveToFolder(id, Number(dest.id))
            break outer
          }
        } else if (action.kind === 'spam') {
          await messageSpam(id)
          break outer
        }
      }
      if (rule.actions.some(a => a.kind === 'stop')) break
    }
  }
  return { scanned: rows.length, matched }
}
