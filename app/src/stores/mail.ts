/**
 * Central mail state: which folder is selected, its message list, and the
 * open message's detail. Components read from here instead of each calling
 * the engine directly, so they all see the same list after an action.
 */
import { useEngine } from '@/engine'
import type { FolderSummary, MessageDetail, MessageFlagName, MessageSummary, SyncStatusEntry } from '@/shared/rpc'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { useAccountsStore } from './accounts'

export type FolderSelection = { kind: 'unified' } | { kind: 'folder'; accountId: number; folderId: number }

const PAGE_SIZE = 50

export const useMailStore = defineStore('mail', () => {
  const accounts = useAccountsStore()
  const foldersByAccount = ref<Record<number, FolderSummary[]>>({})
  const selection = ref<FolderSelection>({ kind: 'unified' })
  const messages = ref<MessageSummary[]>([])
  const totalCount = ref(0)
  const loadingList = ref(false)
  const selectedMessageId = ref<number | null>(null)
  const detail = ref<MessageDetail | null>(null)
  const loadingDetail = ref(false)
  const searchQuery = ref('')
  const thread = ref<MessageSummary[]>([])
  const syncStatuses = ref<Record<number, SyncStatusEntry>>({})
  let wired = false

  const engine = () => useEngine()

  function findFolder(accountId: number, folderId: number): FolderSummary | null {
    return foldersByAccount.value[accountId]?.find(f => f.id === folderId) ?? null
  }
  const selectedFolder = computed<FolderSummary | null>(() => {
    if (selection.value.kind !== 'folder') return null
    return findFolder(selection.value.accountId, selection.value.folderId)
  })

  const unreadTotal = computed(() => {
    let n = 0
    for (const list of Object.values(foldersByAccount.value)) {
      const inbox = list.find(f => f.role === 'inbox')
      if (inbox) n += inbox.unread
    }
    return n
  })

  /** True while a real server sync is in flight for the account(s) currently in view — drives the refresh spinner. */
  const isSyncingCurrent = computed(() => {
    const active = (s: SyncStatusEntry | undefined) => s?.state === 'syncing' || s?.state === 'connecting'
    const sel = selection.value
    if (sel.kind === 'unified') return Object.values(syncStatuses.value).some(active)
    return active(syncStatuses.value[sel.accountId])
  })

  async function loadFolders(accountId: number) {
    try {
      foldersByAccount.value = { ...foldersByAccount.value, [accountId]: await engine().api.foldersList(accountId) }
    } catch (e) {
      // Called both from the initial boot (already inside its own try/catch) and from
      // fire-and-forget event handlers in wireEvents() below — those need their own handling
      // so a failure doesn't become an unhandled rejection with the sidebar just stuck stale.
      toast.error(`Could not load folders: ${(e as Error).message}`)
    }
  }

  async function loadAllFolders() {
    try {
      if (!accounts.loaded) await accounts.load()
    } catch (e) {
      toast.error(`Could not load accounts: ${(e as Error).message}`)
      return
    }
    await Promise.all(accounts.list.map(a => loadFolders(a.id)))
  }

  function currentFolderIds(): number[] {
    if (selection.value.kind === 'folder') return [selection.value.folderId]
    const ids: number[] = []
    for (const list of Object.values(foldersByAccount.value)) {
      const inbox = list.find(f => f.role === 'inbox')
      if (inbox) ids.push(inbox.id)
    }
    return ids
  }

  async function loadMessages() {
    const ids = currentFolderIds()
    if (!ids.length) {
      messages.value = []
      totalCount.value = 0
      return
    }
    loadingList.value = true
    try {
      if (searchQuery.value.trim()) {
        messages.value = await engine().api.searchMessages(searchQuery.value.trim(), { folderIds: ids, limit: PAGE_SIZE })
        totalCount.value = messages.value.length
      } else {
        const [rows, count] = await Promise.all([engine().api.messagesList(ids, PAGE_SIZE, 0), engine().api.messagesCount(ids)])
        messages.value = rows
        totalCount.value = count
      }
    } catch (e) {
      toast.error(`Could not load messages: ${(e as Error).message}`)
    } finally {
      loadingList.value = false
    }
  }

  /** Appends the next page. No-op while searching (search already returns its own capped set). */
  async function loadMore() {
    if (searchQuery.value.trim() || loadingList.value || messages.value.length >= totalCount.value) return
    const ids = currentFolderIds()
    if (!ids.length) return
    loadingList.value = true
    try {
      const rows = await engine().api.messagesList(ids, PAGE_SIZE, messages.value.length)
      const seen = new Set(messages.value.map(m => m.id))
      messages.value = [...messages.value, ...rows.filter(r => !seen.has(r.id))]
    } catch (e) {
      toast.error(`Could not load more messages: ${(e as Error).message}`)
    } finally {
      loadingList.value = false
    }
  }

  function selectFolder(sel: FolderSelection) {
    selection.value = sel
    selectedMessageId.value = null
    detail.value = null
    void loadMessages()
  }

  function setSearch(q: string) {
    searchQuery.value = q
    void loadMessages()
  }

  async function openMessage(id: number) {
    selectedMessageId.value = id
    loadingDetail.value = true
    detail.value = null
    thread.value = []
    try {
      const [d, t] = await Promise.all([engine().api.messageGet(id), engine().api.threadMessages(id)])
      if (selectedMessageId.value !== id) return // a newer open() won
      detail.value = d
      thread.value = t
    } catch (e) {
      if (selectedMessageId.value === id) toast.error(`Could not open message: ${(e as Error).message}`)
    } finally {
      if (selectedMessageId.value === id) loadingDetail.value = false
    }
  }

  function openAdjacent(delta: number) {
    const ids = messages.value.map(m => m.id)
    const i = ids.indexOf(selectedMessageId.value ?? -1)
    if (i < 0) return
    const j = i + delta
    if (j < 0 || j >= ids.length) return
    void openMessage(ids[j]!)
  }

  function closeMessage() {
    selectedMessageId.value = null
    detail.value = null
    thread.value = []
  }

  function patchLocal(id: number, patch: Partial<MessageSummary>) {
    const m = messages.value.find(x => x.id === id)
    if (m) Object.assign(m, patch)
    if (detail.value?.id === id) Object.assign(detail.value, patch)
  }

  async function setFlag(id: number, flag: MessageFlagName, value: boolean) {
    patchLocal(id, { [flag]: value } as Partial<MessageSummary>)
    try {
      await engine().api.messageSetFlag(id, flag, value)
    } catch (e) {
      // Undo the optimistic update — otherwise a failed save left the UI showing a flag
      // state (starred/read) that was never actually persisted, with no way to tell.
      patchLocal(id, { [flag]: !value } as Partial<MessageSummary>)
      throw e
    }
  }

  function removeFromList(id: number) {
    messages.value = messages.value.filter(m => m.id !== id)
    totalCount.value = Math.max(0, totalCount.value - 1)
    if (selectedMessageId.value === id) closeMessage()
  }

  async function archive(id: number) {
    await engine().api.messageArchive(id)
    removeFromList(id)
  }
  async function spam(id: number) {
    await engine().api.messageSpam(id)
    removeFromList(id)
  }
  async function remove(id: number) {
    await engine().api.messageDelete(id)
    removeFromList(id)
  }
  async function moveTo(id: number, destFolderId: number) {
    await engine().api.messageMoveToFolder(id, destFolderId)
    removeFromList(id)
  }

  function wireEvents() {
    if (wired) return
    wired = true
    engine().on('folders:changed', e => {
      void loadFolders((e as { accountId: number }).accountId)
      void loadMessages()
    })
    engine().on('mail:new', () => void loadMessages())
    engine().on('accounts:changed', () => void loadAllFolders())
    engine().on('settings:changed', e => {
      if ((e as { key: string }).key === 'mail.threads') void loadMessages()
    })
    engine().on('sync:status', e => {
      const s = e as SyncStatusEntry
      syncStatuses.value = { ...syncStatuses.value, [s.accountId]: s }
    })
    void engine()
      .api.syncStatus()
      .then(list => {
        syncStatuses.value = Object.fromEntries(list.map(s => [s.accountId, s]))
      })
  }

  return {
    foldersByAccount,
    selection,
    selectedFolder,
    unreadTotal,
    isSyncingCurrent,
    messages,
    totalCount,
    pageSize: PAGE_SIZE,
    loadingList,
    selectedMessageId,
    detail,
    loadingDetail,
    searchQuery,
    thread,
    loadAllFolders,
    loadFolders,
    selectFolder,
    setSearch,
    loadMessages,
    loadMore,
    openMessage,
    openAdjacent,
    closeMessage,
    setFlag,
    archive,
    spam,
    remove,
    moveTo,
    wireEvents,
  }
})
