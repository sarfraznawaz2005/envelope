<script setup lang="ts">
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { FolderSummary } from '@/shared/rpc'
import { useAccountsStore } from '@/stores/accounts'
import { useMailStore } from '@/stores/mail'
import { useUiStore } from '@/stores/ui'
import { Archive, File, Folder, Inbox, Mail, Send, ShieldAlert, Trash2 } from '@lucide/vue'
import { computed, type Component } from 'vue'

const accounts = useAccountsStore()
const mail = useMailStore()
const ui = useUiStore()

const ROLE_ICON: Record<string, Component> = {
  inbox: Inbox,
  sent: Send,
  drafts: File,
  trash: Trash2,
  spam: ShieldAlert,
  archive: Archive,
  all: Mail,
}
function iconFor(f: FolderSummary): Component {
  return ROLE_ICON[f.role ?? ''] ?? Folder
}

// server order is already role-ish; put the common ones first, custom folders after
const ROLE_ORDER = ['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash']
function sortedFolders(list: FolderSummary[]): FolderSummary[] {
  return [...list].sort((a, b) => {
    const ai = a.role ? ROLE_ORDER.indexOf(a.role) : -1
    const bi = b.role ? ROLE_ORDER.indexOf(b.role) : -1
    if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
    return a.name.localeCompare(b.name)
  })
}

const sections = computed(() => accounts.list.map(a => ({ account: a, folders: sortedFolders(mail.foldersByAccount[a.id] ?? []) })))

function selectUnified() {
  mail.selectFolder({ kind: 'unified' })
}
function selectFolder(accountId: number, folderId: number) {
  mail.selectFolder({ kind: 'folder', accountId, folderId })
}
function isSelected(accountId: number, folderId: number) {
  return mail.selection.kind === 'folder' && mail.selection.accountId === accountId && mail.selection.folderId === folderId
}
</script>

<template>
  <aside v-if="!ui.sidebarCollapsed" class="flex flex-col bg-muted/60">
    <nav class="flex-1 overflow-y-auto text-sm px-2 space-y-4 pb-4 pt-3">
      <div v-if="accounts.list.length > 1">
        <div class="px-2 text-[11px] uppercase tracking-wide text-muted-foreground mb-1">All accounts</div>
        <button
          class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left"
          :class="mail.selection.kind === 'unified' ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted'"
          @click="selectUnified"
        >
          <Inbox class="size-4" /> Unified Inbox
          <span v-if="mail.unreadTotal" class="ml-auto text-xs bg-primary text-primary-foreground rounded-full px-1.5">{{ mail.unreadTotal }}</span>
        </button>
      </div>

      <div v-for="s in sections" :key="s.account.id">
        <div class="px-2 flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
          <span class="size-2 rounded-full shrink-0" :style="{ background: s.account.color }" />
          {{ s.account.name }}
        </div>
        <button
          v-for="f in s.folders"
          :key="f.id"
          class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left"
          :class="isSelected(s.account.id, f.id) ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted'"
          @click="selectFolder(s.account.id, f.id)"
        >
          <component :is="iconFor(f)" class="size-4 shrink-0" />
          <span class="truncate">{{ f.name }}</span>
          <span v-if="f.unread" class="ml-auto text-xs font-semibold">{{ f.unread }}</span>
        </button>
      </div>
    </nav>
  </aside>

  <!-- Collapsed: an icon-only rail instead of hiding folders entirely — each icon keeps a rich
       tooltip (account, folder, unread count) since the text label is gone. -->
  <aside v-else class="flex flex-col items-center bg-muted/60 w-12 shrink-0">
    <nav class="flex-1 overflow-y-auto flex flex-col items-center gap-1 pb-4 pt-3">
      <Tooltip v-if="accounts.list.length > 1">
        <TooltipTrigger as-child>
          <button
            class="size-9 rounded flex items-center justify-center relative"
            :class="mail.selection.kind === 'unified' ? 'bg-primary/10 text-primary' : 'hover:bg-muted text-muted-foreground'"
            @click="selectUnified"
          >
            <Inbox class="size-4" />
            <span v-if="mail.unreadTotal" class="absolute -top-1 -right-1 text-[10px] leading-none bg-primary text-primary-foreground rounded-full px-1 py-0.5">{{ mail.unreadTotal }}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <div class="font-medium">Unified Inbox</div>
          <div v-if="mail.unreadTotal" class="text-xs opacity-80">{{ mail.unreadTotal }} unread</div>
        </TooltipContent>
      </Tooltip>

      <template v-for="s in sections" :key="s.account.id">
        <div class="w-6 border-t my-1" :title="s.account.name" />
        <Tooltip v-for="f in s.folders" :key="f.id">
          <TooltipTrigger as-child>
            <button
              class="size-9 rounded flex items-center justify-center relative"
              :class="isSelected(s.account.id, f.id) ? 'bg-primary/10 text-primary' : 'hover:bg-muted text-muted-foreground'"
              @click="selectFolder(s.account.id, f.id)"
            >
              <component :is="iconFor(f)" class="size-4" />
              <span v-if="f.unread" class="absolute -top-1 -right-1 text-[10px] leading-none bg-primary text-primary-foreground rounded-full px-1 py-0.5">{{ f.unread }}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            <div class="font-medium">{{ f.name }}</div>
            <div class="text-xs opacity-80">{{ s.account.name }}<span v-if="f.unread"> · {{ f.unread }} unread</span></div>
          </TooltipContent>
        </Tooltip>
      </template>
    </nav>
  </aside>
</template>
