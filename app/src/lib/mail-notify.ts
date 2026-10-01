/**
 * Turns "new mail" events from the engine into a desktop notification, a
 * short chime, and an unread count in the tab title. Runs in the UI thread —
 * Notification and document.title only work here, not in the worker.
 */
import NewMailToast from '@/components/mail/NewMailToast.vue'
import { useEngine } from '@/engine'
import type { FolderSummary, NewMailEvent } from '@/shared/rpc'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { ref } from 'vue'
import { toast } from 'vue-sonner'

let started = false
export const recentMail = ref<NewMailEvent[]>([])
export const unreadTotal = ref(0)

function playChime() {
  try {
    const Ctx = window.AudioContext
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.15, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.3)
    osc.onended = () => void ctx.close()
  } catch {
    /* audio not available (no user gesture yet, or unsupported) */
  }
}

async function refreshUnreadTitle() {
  const engine = useEngine()
  const accounts = useAccountsStore()
  if (!accounts.loaded) await accounts.load()
  let total = 0
  for (const a of accounts.list) {
    try {
      const folders: FolderSummary[] = await engine.api.foldersList(a.id)
      const inbox = folders.find(f => f.role === 'inbox')
      if (inbox) total += inbox.unread
    } catch {
      /* account not synced yet */
    }
  }
  unreadTotal.value = total
  document.title = total > 0 ? `(${total}) Envelope` : 'Envelope'
}

/** More than this many due notifications collapse into one summary. */
const MAX_INDIVIDUAL = 3
/** New mail arriving within this window is grouped together. */
const BATCH_WINDOW_MS = 1500

let pending: { ev: NewMailEvent; accountName: string }[] = []
let flushTimer: ReturnType<typeof setTimeout> | undefined

async function desktopNotify(title: string, body: string, tag: string) {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'default') await Notification.requestPermission().catch(() => {})
  if (Notification.permission !== 'granted') return
  const n = new Notification(title, { body, tag })
  n.onclick = () => window.focus()
  if (useSettingsStore().values['notify.sound']) playChime()
}

async function flushPending() {
  flushTimer = undefined
  const batch = pending
  pending = []
  if (!batch.length) return
  const settings = useSettingsStore()

  if (batch.length > MAX_INDIVIDUAL) {
    const text = `You have ${batch.length} new unread messages`
    if (settings.values['notify.toast']) toast(text, { duration: 6000 })
    if (settings.values['notify.desktop']) await desktopNotify('New mail', text, 'mail-summary')
    return
  }

  for (const { ev, accountName } of batch) {
    if (settings.values['notify.toast']) {
      toast.custom(NewMailToast, { componentProps: { event: ev, accountName }, duration: 6000 })
    }
    if (settings.values['notify.desktop']) {
      await desktopNotify(ev.subject || '(no subject)', `${ev.from}\n${ev.snippet}`, `mail-${ev.id}`)
    }
  }
}

export function useMailNotify() {
  if (started) return
  started = true
  const engine = useEngine()
  const settings = useSettingsStore()
  const accounts = useAccountsStore()

  engine.on('mail:new', async data => {
    const ev = data as NewMailEvent
    recentMail.value.unshift(ev)
    if (recentMail.value.length > 50) recentMail.value.length = 50
    void refreshUnreadTitle()

    if (settings.values['notify.inboxOnly'] && ev.folderPath.toUpperCase() !== 'INBOX') return
    const account = accounts.byId.get(ev.accountId)
    if (account && !account.notify) return

    pending.push({ ev, accountName: account?.name ?? '' })
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => void flushPending(), BATCH_WINDOW_MS)
  })

  engine.on('folders:changed', () => void refreshUnreadTitle())
  void refreshUnreadTitle()
}
