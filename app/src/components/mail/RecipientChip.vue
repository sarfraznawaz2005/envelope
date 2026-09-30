<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useEngine } from '@/engine'
import { Copy, UserCheck, UserPlus } from '@lucide/vue'
import { ref } from 'vue'
import { toast } from 'vue-sonner'

const props = defineProps<{ name: string; address: string }>()

const engine = useEngine()
const open = ref(false)
const exists = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

function show() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(async () => {
    open.value = true
    exists.value = !!(await engine.api.contactFindByEmail(props.address).catch(() => null))
  }, 250)
}
function hide() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => (open.value = false), 150)
}

async function add() {
  const name = (props.name || props.address).trim()
  const parts = name.split(/\s+/)
  try {
    await engine.api.contactSave({
      firstName: parts[0] || '',
      lastName: parts.slice(1).join(' '),
      phone: '',
      notes: '',
      emails: [{ email: props.address, label: 'work', isPrimary: true }],
      groups: [],
    })
    exists.value = true
    toast.success('Added to contacts')
  } catch (e) {
    toast.error((e as Error).message)
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(props.address)
    toast.success('Email copied')
  } catch (e) {
    toast.error((e as Error).message)
  }
}
</script>

<template>
  <Popover :open="open">
    <PopoverAnchor as-child>
      <span class="rounded px-0.5 hover:bg-muted cursor-default" @mouseenter="show" @mouseleave="hide">{{ name || address }}</span>
    </PopoverAnchor>
    <PopoverContent class="w-72 p-3" align="start" @open-auto-focus.prevent @mouseenter="show" @mouseleave="hide">
      <div class="text-sm font-semibold truncate">{{ name || address }}</div>
      <div class="text-xs text-muted-foreground break-all">{{ address }}</div>
      <div class="flex gap-2 mt-3">
        <Button size="sm" variant="outline" class="gap-1.5" :disabled="exists" @click="add">
          <component :is="exists ? UserCheck : UserPlus" class="size-3.5" />
          {{ exists ? 'In contacts' : 'Add to contacts' }}
        </Button>
        <Button size="sm" variant="ghost" class="gap-1.5" @click="copy"><Copy class="size-3.5" /> Copy</Button>
      </div>
    </PopoverContent>
  </Popover>
</template>
