<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useEngine } from '@/engine'
import type { FolderSummary, RuleActionInput, RuleConditionInput, RuleField, RuleInput, RuleOp, RuleRecord } from '@/shared/rpc'
import { useAccountsStore } from '@/stores/accounts'
import { GripVertical, Pencil, Play, Plus, Trash2, X } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'

const engine = useEngine()
const accounts = useAccountsStore()

const rules = ref<RuleRecord[]>([])
const editingId = ref<number | 'new' | null>(null)
const form = ref<RuleInput | null>(null)
const editorFolders = ref<FolderSummary[]>([])
const dragIndex = ref<number | null>(null)

const runAccountId = ref<number | null>(null)
const runFolderId = ref<number | null>(null)
const runFolders = ref<FolderSummary[]>([])
const running = ref(false)
const loaded = ref(false)

async function load() {
  rules.value = await engine.api.rulesList()
}
onMounted(async () => {
  if (!accounts.loaded) await accounts.load()
  await load()
  runAccountId.value = accounts.list[0]?.id ?? null
  loaded.value = true
})

watch(runAccountId, async id => {
  runFolders.value = id != null ? await engine.api.foldersList(id) : []
  runFolderId.value = runFolders.value.find(f => f.role === 'inbox')?.id ?? runFolders.value[0]?.id ?? null
})
watch(
  () => form.value?.accountId,
  async id => {
    editorFolders.value = id != null ? await engine.api.foldersList(id) : []
  },
)

const FIELD_LABEL: Record<RuleField, string> = { subject: 'subject', from: 'from', to: 'to', hasAttachment: 'has attachment' }
const OP_LABEL: Record<RuleOp, string> = { contains: 'contains', notContains: 'does not contain', equals: 'is', startsWith: 'starts with', endsWith: 'ends with', regex: 'matches regex' }
function actionLabel(a: RuleActionInput): string {
  switch (a.kind) {
    case 'markRead':
      return 'Mark read'
    case 'flag':
      return 'Flag'
    case 'spam':
      return 'Mark as spam'
    case 'delete':
      return 'Delete'
    case 'stop':
      return 'Stop processing'
    case 'move':
      return `Move to ${a.arg || '…'}`
  }
}
function accountName(id: number | null): string {
  if (id == null) return 'All accounts'
  return accounts.byId.get(id)?.name ?? 'Unknown account'
}
function summarize(rule: RuleRecord): string {
  const condText = rule.conditions.length
    ? rule.conditions.map(c => (c.field === 'hasAttachment' ? `has attachment: ${c.value === 'true' ? 'yes' : 'no'}` : `${FIELD_LABEL[c.field]} ${OP_LABEL[c.op]} "${c.value}"`)).join(' · ')
    : 'always'
  const actionText = rule.actions.map(actionLabel).join(', ') || 'no actions'
  return `${accountName(rule.accountId)} · If ${rule.matchMode}: ${condText} → ${actionText}`
}

function newRule() {
  editingId.value = 'new'
  form.value = {
    name: '',
    enabled: true,
    matchMode: 'any',
    accountId: accounts.list[0]?.id ?? null,
    conditions: [{ field: 'subject', op: 'contains', value: '' }],
    actions: [{ kind: 'markRead', arg: '' }],
  }
}
function editRule(r: RuleRecord) {
  editingId.value = r.id
  form.value = {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    matchMode: r.matchMode,
    accountId: r.accountId,
    conditions: r.conditions.map(c => ({ ...c })),
    actions: r.actions.map(a => ({ ...a })),
  }
}
function cancelEdit() {
  editingId.value = null
  form.value = null
}

function addCondition() {
  form.value?.conditions.push({ field: 'subject', op: 'contains', value: '' })
}
function removeCondition(i: number) {
  form.value?.conditions.splice(i, 1)
}
function onFieldChange(c: RuleConditionInput) {
  if (c.field === 'hasAttachment') {
    c.op = 'equals'
    if (c.value !== 'true' && c.value !== 'false') c.value = 'true'
  }
}
function addAction() {
  form.value?.actions.push({ kind: 'markRead', arg: '' })
}
function removeAction(i: number) {
  form.value?.actions.splice(i, 1)
}

async function saveRule() {
  if (!form.value) return
  if (!form.value.name.trim()) {
    toast.error('Name the rule.')
    return
  }
  const conditions = form.value.conditions.filter(c => c.field === 'hasAttachment' || c.value.trim())
  if (!conditions.length) {
    toast.error('Add at least one condition.')
    return
  }
  if (!form.value.actions.length) {
    toast.error('Add at least one action.')
    return
  }
  await engine.api.ruleSave({ ...form.value, conditions })
  toast.success('Rule saved')
  await load()
  cancelEdit()
}
async function removeRule(id: number) {
  await engine.api.ruleDelete(id)
  if (editingId.value === id) cancelEdit()
  toast.success('Rule deleted')
  await load()
}
async function toggleEnabled(r: RuleRecord) {
  await engine.api.ruleSave({ id: r.id, name: r.name, enabled: !r.enabled, matchMode: r.matchMode, accountId: r.accountId, conditions: r.conditions, actions: r.actions })
  await load()
}

function onDragStart(i: number) {
  dragIndex.value = i
}
function onDrop(i: number) {
  if (dragIndex.value === null || dragIndex.value === i) return
  const list = [...rules.value]
  const [moved] = list.splice(dragIndex.value, 1)
  list.splice(i, 0, moved!)
  rules.value = list
  dragIndex.value = null
  void engine.api.rulesReorder(list.map(r => r.id))
}

async function runNow() {
  if (!runFolderId.value) return
  running.value = true
  try {
    const { scanned, matched } = await engine.api.rulesRunNow(runFolderId.value)
    toast.success(`Scanned ${scanned} message${scanned === 1 ? '' : 's'}, ${matched} matched a rule.`)
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    running.value = false
  }
}

const editorTitle = computed(() => (editingId.value === 'new' ? 'New rule' : `Edit rule: ${rules.value.find(r => r.id === editingId.value)?.name ?? ''}`))
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center">
      <h1 class="text-2xl font-semibold">Rules</h1>
      <Button size="sm" class="ml-auto gap-2" @click="newRule"><Plus class="size-4" /> New rule</Button>
    </div>
    <p class="text-muted-foreground text-xs">Rules run automatically on new mail, top to bottom. Drag the handle to reorder.</p>

    <div v-if="!loaded" class="text-muted-foreground text-sm">Loading…</div>
    <div v-else-if="!rules.length" class="text-muted-foreground text-sm">No rules yet.</div>
    <div class="space-y-2">
      <div
        v-for="(r, i) in rules"
        :key="r.id"
        class="border rounded-lg p-3 flex items-center gap-3"
        :class="{ 'opacity-50': !r.enabled }"
        draggable="true"
        @dragstart="onDragStart(i)"
        @dragover.prevent
        @drop="onDrop(i)"
      >
        <GripVertical class="size-4 text-muted-foreground cursor-grab shrink-0" />
        <Switch :model-value="r.enabled" @update:model-value="toggleEnabled(r)" />
        <div class="flex-1 min-w-0">
          <div class="font-medium truncate">{{ r.name }}</div>
          <div class="text-xs text-muted-foreground truncate">{{ summarize(r) }}</div>
        </div>
        <Button size="sm" variant="outline" class="gap-1" @click="editRule(r)"><Pencil class="size-3.5" /> Edit</Button>
        <Button size="sm" variant="outline" class="gap-1 text-destructive hover:text-destructive" @click="removeRule(r.id)"><Trash2 class="size-3.5" /></Button>
      </div>
    </div>

    <div class="border rounded-lg p-3 flex items-center gap-2 flex-wrap">
      <Play class="size-4 text-muted-foreground shrink-0" />
      <span class="text-sm">Run all enabled rules now, on</span>
      <select v-model="runAccountId" class="h-8 px-2 rounded-md border bg-background text-sm">
        <option v-for="a in accounts.list" :key="a.id" :value="a.id">{{ a.name }}</option>
      </select>
      <select v-model="runFolderId" class="h-8 px-2 rounded-md border bg-background text-sm">
        <option v-for="f in runFolders" :key="f.id" :value="f.id">{{ f.name }}</option>
      </select>
      <Button size="sm" :disabled="running || !runFolderId" @click="runNow">Run now</Button>
      <span class="text-xs text-muted-foreground">Applies to mail already synced into that folder — it doesn't fetch new mail.</span>
    </div>

    <div v-if="form" class="border-2 border-primary/30 rounded-lg p-4 space-y-4">
      <div class="font-medium">{{ editorTitle }}</div>

      <label class="block"><span class="text-xs text-muted-foreground">Name</span><Input v-model="form.name" class="mt-1" placeholder="Invoices to folder" /></label>

      <div class="flex items-center gap-2 text-sm">
        <Switch v-model="form.enabled" /> Enabled
        <span class="ml-4 text-xs text-muted-foreground">Applies to</span>
        <select v-model="form.accountId" class="h-8 px-2 rounded-md border bg-background text-sm">
          <option :value="null">All accounts</option>
          <option v-for="a in accounts.list" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
      </div>

      <div>
        <div class="text-xs text-muted-foreground mb-1 flex items-center gap-1">
          If
          <select v-model="form.matchMode" class="h-7 px-1 rounded-md border bg-background text-xs">
            <option value="any">any</option>
            <option value="all">all</option>
          </select>
          of these match:
        </div>
        <div class="space-y-2">
          <div v-for="(c, i) in form.conditions" :key="i" class="flex gap-2">
            <select v-model="c.field" class="h-9 px-2 rounded-md border bg-background text-sm" @change="onFieldChange(c)">
              <option value="subject">Subject</option>
              <option value="from">From</option>
              <option value="to">To</option>
              <option value="hasAttachment">Has attachment</option>
            </select>
            <template v-if="c.field === 'hasAttachment'">
              <select v-model="c.value" class="flex-1 h-9 px-2 rounded-md border bg-background text-sm">
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </template>
            <template v-else>
              <select v-model="c.op" class="h-9 px-2 rounded-md border bg-background text-sm">
                <option value="contains">contains</option>
                <option value="notContains">does not contain</option>
                <option value="equals">is</option>
                <option value="startsWith">starts with</option>
                <option value="endsWith">ends with</option>
                <option value="regex">matches regex</option>
              </select>
              <Input v-model="c.value" class="flex-1" placeholder="value" />
            </template>
            <Button variant="ghost" size="icon" class="text-muted-foreground shrink-0" @click="removeCondition(i)"><X class="size-4" /></Button>
          </div>
        </div>
        <button type="button" class="mt-2 text-xs text-primary flex items-center gap-1" @click="addCondition"><Plus class="size-3.5" /> Add condition</button>
      </div>

      <div>
        <div class="text-xs text-muted-foreground mb-1">Then:</div>
        <div class="space-y-2">
          <div v-for="(a, i) in form.actions" :key="i" class="flex gap-2">
            <select v-model="a.kind" class="h-9 px-2 rounded-md border bg-background text-sm">
              <option value="move">Move to folder</option>
              <option value="markRead">Mark as read</option>
              <option value="flag">Flag</option>
              <option value="spam">Mark as spam</option>
              <option value="delete">Delete</option>
              <option value="stop">Stop processing more rules</option>
            </select>
            <template v-if="a.kind === 'move'">
              <select v-if="form.accountId != null" v-model="a.arg" class="flex-1 h-9 px-2 rounded-md border bg-background text-sm">
                <option value="" disabled>Choose a folder…</option>
                <option v-for="f in editorFolders" :key="f.id" :value="f.path">{{ f.name }}</option>
              </select>
              <Input v-else v-model="a.arg" class="flex-1" placeholder="Folder path, e.g. Work/Invoices" />
            </template>
            <Button variant="ghost" size="icon" class="text-muted-foreground shrink-0" @click="removeAction(i)"><X class="size-4" /></Button>
          </div>
        </div>
        <button type="button" class="mt-2 text-xs text-primary flex items-center gap-1" @click="addAction"><Plus class="size-3.5" /> Add action</button>
      </div>

      <div class="flex gap-2 pt-2">
        <Button @click="saveRule">Save rule</Button>
        <Button variant="outline" @click="cancelEdit">Cancel</Button>
        <Button v-if="typeof editingId === 'number'" variant="outline" class="ml-auto text-destructive hover:text-destructive" @click="removeRule(editingId)">Delete rule</Button>
      </div>
    </div>
  </div>
</template>
