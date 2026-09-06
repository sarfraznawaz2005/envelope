<script setup lang="ts">
import { useEngine } from '@/engine'
import type { ContactSuggestion, MessageAddress } from '@/shared/rpc'
import { X } from '@lucide/vue'
import { ref } from 'vue'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const props = defineProps<{ modelValue: MessageAddress[]; label: string }>()
const emit = defineEmits<{ 'update:modelValue': [MessageAddress[]] }>()
const engine = useEngine()

const text = ref('')
const suggestions = ref<ContactSuggestion[]>([])
const showSuggest = ref(false)

function parseOne(raw: string): MessageAddress | null {
  const s = raw.trim()
  if (!s) return null
  const m = /^(.*)<([^>]+)>$/.exec(s)
  if (m) return { name: m[1]!.trim().replace(/^"|"$/g, ''), address: m[2]!.trim() }
  if (s.includes('@')) return { name: '', address: s }
  return null
}

/** Append addresses, dropping any that already exist in the field (case-insensitive on the address). */
function addAddresses(additions: MessageAddress[]) {
  if (!additions.length) return
  const seen = new Set(props.modelValue.map(a => a.address.toLowerCase()))
  const unique: MessageAddress[] = []
  for (const a of additions) {
    const key = a.address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(a)
  }
  if (unique.length) emit('update:modelValue', [...props.modelValue, ...unique])
}

/** While typing: commit only the finished (comma-terminated) tokens, leave the rest being typed. */
function commitTyped() {
  const parts = text.value.split(',')
  const complete = parts.slice(0, -1)
  const rest = parts[parts.length - 1] ?? ''
  const parsed = complete.map(parseOne).filter((x): x is MessageAddress => !!x)
  addAddresses(parsed)
  text.value = rest.trimStart()
}

/** On blur / Enter / Tab / submit: commit everything, including a trailing address with no comma after it. */
function commitAll() {
  const parts = text.value
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
  const parsed = parts.map(parseOne).filter((x): x is MessageAddress => !!x)
  addAddresses(parsed)
  text.value = ''
}
defineExpose({ commitAll })

async function search() {
  const q = text.value.trim()
  if (!q) {
    suggestions.value = []
    showSuggest.value = false
    return
  }
  try {
    suggestions.value = await engine.api.contactsAutocomplete(q)
    showSuggest.value = suggestions.value.length > 0
  } catch (e) {
    // A toast per keystroke would be worse than just having no suggestions this time.
    console.warn('[contacts autocomplete]', (e as Error).message)
    suggestions.value = []
    showSuggest.value = false
  }
}
function onInput() {
  if (text.value.includes(',')) commitTyped()
  void search()
}
function pick(s: ContactSuggestion) {
  addAddresses([{ name: s.name, address: s.address }])
  text.value = ''
  suggestions.value = []
  showSuggest.value = false
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === 'Tab') {
    if (text.value.trim()) {
      e.preventDefault()
      commitAll()
      showSuggest.value = false
    }
  } else if (e.key === 'Backspace' && !text.value && props.modelValue.length) {
    emit('update:modelValue', props.modelValue.slice(0, -1))
  }
}
function remove(i: number) {
  emit(
    'update:modelValue',
    props.modelValue.filter((_, idx) => idx !== i),
  )
}
function onBlur() {
  commitAll()
  setTimeout(() => {
    showSuggest.value = false
  }, 150)
}
</script>

<template>
  <div class="flex items-start gap-2 border-b py-1.5 relative">
    <span class="text-xs text-muted-foreground w-10 pt-1.5 shrink-0">{{ label }}</span>
    <div class="flex-1 flex flex-wrap gap-1 items-center">
      <span v-for="(r, i) in modelValue" :key="i" class="inline-flex items-center gap-1 bg-muted rounded-full px-2 py-0.5 text-xs">
        {{ r.name || r.address }}
        <Tooltip>
          <TooltipTrigger as-child>
            <button type="button" class="text-muted-foreground hover:text-foreground" @click="remove(i)">
              <X class="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Remove {{ r.name || r.address }}</TooltipContent>
        </Tooltip>
      </span>
      <input
        v-model="text"
        class="flex-1 min-w-[120px] outline-none bg-transparent text-sm py-1"
        @input="onInput"
        @keydown="onKeydown"
        @blur="onBlur"
        @focus="search"
      >
    </div>
    <div v-if="showSuggest" class="absolute left-10 top-full z-10 mt-1 w-72 rounded-md border bg-popover shadow-md text-sm py-1 max-h-56 overflow-y-auto">
      <button v-for="s in suggestions" :key="s.address" type="button" class="w-full text-left px-3 py-1.5 hover:bg-muted" @mousedown.prevent="pick(s)">
        <div class="font-medium">{{ s.name || s.address }}</div>
        <div v-if="s.name" class="text-xs text-muted-foreground">{{ s.address }}</div>
      </button>
    </div>
  </div>
</template>
