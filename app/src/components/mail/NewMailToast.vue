<script setup lang="ts">
/**
 * In-app "new mail" toast content, rendered via vue-sonner's toast.custom()
 * from lib/mail-notify.ts. Clicking the card opens the message; the X only
 * dismisses. Mirrors mockups/01-mail.html's bottom-right toast.
 */
import { avatarColor, avatarInitials } from '@/lib/avatar'
import type { NewMailEvent } from '@/shared/rpc'
import { useMailStore } from '@/stores/mail'
import { Bell, X } from '@lucide/vue'
import { useRouter } from 'vue-router'

const props = defineProps<{
  event: NewMailEvent
  accountName: string
}>()
const emit = defineEmits<{ (e: 'close-toast'): void }>()

const mail = useMailStore()
const router = useRouter()

async function open() {
  emit('close-toast')
  mail.selectFolder({ kind: 'folder', accountId: props.event.accountId, folderId: props.event.folderId })
  if (router.currentRoute.value.name !== 'mail') await router.push('/')
  await mail.openMessage(props.event.id)
}
function dismiss() {
  emit('close-toast')
}
</script>

<template>
  <div
    class="w-80 bg-popover text-popover-foreground border shadow-xl rounded-lg p-3 flex gap-3 cursor-pointer"
    role="button"
    @click="open"
  >
    <div class="size-9 rounded-full text-white flex items-center justify-center text-xs font-bold shrink-0" :class="avatarColor(event.from)">
      {{ avatarInitials(event.from) }}
    </div>
    <div class="min-w-0">
      <div class="text-xs text-muted-foreground flex items-center gap-1"><Bell class="size-3" /> New mail · {{ accountName }}</div>
      <div class="text-sm font-semibold truncate">{{ event.from }}</div>
      <div class="text-sm truncate">{{ event.subject || '(no subject)' }}</div>
    </div>
    <button class="ml-auto text-muted-foreground hover:text-foreground shrink-0" @click.stop="dismiss">
      <X class="size-4" />
    </button>
  </div>
</template>
