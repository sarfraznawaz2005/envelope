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

    if (settings.values['notify.toast']) {
      toast.custom(NewMailToast, {
        componentProps: { event: ev, accountName: account?.name ?? '' },
        duration: 6000,
      })
    }

    if (settings.values['notify.desktop'] && typeof Notification !== 'undefined') {
      if (Notification.permission === 'default') await Notification.requestPermission().catch(() => {})
      if (Notification.permission === 'granted') {
        const n = new Notification(ev.subject || '(no subject)', { body: `${ev.from}\n${ev.snippet}`, tag: `mail-${ev.id}` })
        n.onclick = () => window.focus()
        if (settings.values['notify.sound']) playChime()
      }
    }
  })

  engine.on('folders:changed', () => void refreshUnreadTitle())
  void refreshUnreadTitle()
}
