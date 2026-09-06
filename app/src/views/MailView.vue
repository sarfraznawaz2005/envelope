<script setup lang="ts">
import FolderTree from '@/components/mail/FolderTree.vue'
import MessageList from '@/components/mail/MessageList.vue'
import MessageView from '@/components/mail/MessageView.vue'
import ResizeHandle from '@/components/layout/ResizeHandle.vue'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMailStore } from '@/stores/mail'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { ChevronLeft, ChevronRight } from '@lucide/vue'
import { onMounted, onUnmounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { useRouter } from 'vue-router'

const mail = useMailStore()
const settings = useSettingsStore()
const ui = useUiStore()
const router = useRouter()

const SIDEBAR_MIN = 160
const SIDEBAR_MAX = 420
const LIST_MIN = 280
const LIST_MAX = 640
const sidebarWrap = ref<HTMLElement | null>(null)
function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}
function resizeSidebar(dx: number) {
  // Before the first manual resize, width is content-fit (no explicit pixel value yet) — start
  // the drag from whatever that computed to, not from an arbitrary default.
  const base = ui.sidebarWidth ?? sidebarWrap.value?.getBoundingClientRect().width ?? SIDEBAR_MIN
  ui.sidebarWidth = clamp(base + dx, SIDEBAR_MIN, SIDEBAR_MAX)
}
function resizeList(dx: number) {
  ui.listWidth = clamp(ui.listWidth + dx, LIST_MIN, LIST_MAX)
}

// Keyboard shortcuts fire-and-forget the underlying store calls; without this they were
// unhandled promise rejections with nothing shown to the user on failure (e.g. archive a
// message right as the connection drops).
function guarded(p: Promise<unknown>) {
  p.catch(e => toast.error((e as Error).message))
}

function isTyping(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null
  if (!e) return false
  return e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.isContentEditable
}

function onKeydown(e: KeyboardEvent) {
  if (!settings.values['mail.shortcuts']) return
  if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
  const id = mail.selectedMessageId
  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      mail.openAdjacent(1)
      break
    case 'k':
    case 'ArrowUp':
      mail.openAdjacent(-1)
      break
    case 'e':
      if (id != null) guarded(mail.archive(id))
      break
    case '#':
      if (id != null) guarded(mail.remove(id))
      break
    case 'u':
      if (id != null) guarded(mail.setFlag(id, 'seen', false))
      break
    case 'r':
      if (id != null) void router.push(`/compose?reply=${id}`)
      break
    case 'a':
      if (id != null) void router.push(`/compose?replyAll=${id}`)
      break
    case 'f':
      if (id != null) void router.push(`/compose?forward=${id}`)
      break
    case 'c':
      void router.push('/compose')
      break
    case '/':
      document.getElementById('mail-search')?.focus()
      break
    default:
      return
  }
  e.preventDefault()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="flex-1 flex min-h-0 relative">
    <div ref="sidebarWrap" class="flex shrink-0">
      <FolderTree
        :style="!ui.sidebarCollapsed && ui.sidebarWidth ? { width: ui.sidebarWidth + 'px' } : {}"
        class="shrink-0 border-r"
        :class="!ui.sidebarCollapsed && !ui.sidebarWidth ? 'w-max min-w-24 max-w-[420px]' : ''"
      />
      <ResizeHandle v-if="!ui.sidebarCollapsed" @resize="resizeSidebar" />
    </div>

    <Tooltip>
      <TooltipTrigger as-child>
        <Button
          variant="outline"
          size="icon"
          class="absolute bottom-2 left-2 size-6 rounded-full shadow-sm bg-background z-10"
          @click="ui.sidebarCollapsed = !ui.sidebarCollapsed"
        >
          <component :is="ui.sidebarCollapsed ? ChevronRight : ChevronLeft" class="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{{ ui.sidebarCollapsed ? 'Show folders' : 'Hide folders' }}</TooltipContent>
    </Tooltip>

    <div class="relative flex shrink-0">
      <MessageList :style="{ width: ui.listWidth + 'px' }" class="shrink-0 border-r" />
      <ResizeHandle @resize="resizeList" />
    </div>

    <MessageView class="flex-1 min-w-0" />
  </div>
</template>
