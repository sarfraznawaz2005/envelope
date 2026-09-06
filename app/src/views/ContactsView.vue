<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useEngine } from '@/engine'
import type { Contact, ContactGroup, ContactInput } from '@/shared/rpc'
import { useMailStore } from '@/stores/mail'
import { BookUser, Download, Mail, Mails, Plus, Search, Sparkles, Tag, Trash2, Upload, UserPlus, Users, X } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'

const engine = useEngine()
const router = useRouter()
const mail = useMailStore()

type GroupFilter = 'all' | 'saved' | 'collected' | number

const contacts = ref<Contact[]>([])
const groups = ref<ContactGroup[]>([])
const groupFilter = ref<GroupFilter>('all')
const query = ref('')
const selectedId = ref<number | null>(null)
const editing = ref<ContactInput | null>(null)
const newGroupName = ref('')
const addingGroup = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const deleteTarget = ref<Contact | null>(null)
const loaded = ref(false)
const counts = ref({ all: 0, saved: 0, collected: 0 })

const selected = computed(() => contacts.value.find(c => c.id === selectedId.value) ?? null)
const dirty = computed(() => !!editing.value)

type ListEntry = { type: 'header'; letter: string } | { type: 'contact'; contact: Contact }
const groupedList = computed<ListEntry[]>(() => {
  const out: ListEntry[] = []
  let letter = ''
  for (const c of contacts.value) {
    const l = (c.displayName || c.emails[0]?.email || '?')[0]?.toUpperCase() ?? '?'
    if (l !== letter) {
      out.push({ type: 'header', letter: l })
      letter = l
    }
    out.push({ type: 'contact', contact: c })
  }
  return out
})

async function loadGroups() {
  groups.value = await engine.api.contactGroupsList()
}
async function load() {
  const base =
    groupFilter.value === 'all' ? {} : groupFilter.value === 'saved' ? { kind: 'saved' as const } : groupFilter.value === 'collected' ? { kind: 'collected' as const } : { groupId: groupFilter.value }
  contacts.value = await engine.api.contactsList({ ...base, query: query.value.trim() || undefined })
}
async function loadCounts() {
  const [all, saved, collected] = await Promise.all([
    engine.api.contactsList({}),
    engine.api.contactsList({ kind: 'saved' }),
    engine.api.contactsList({ kind: 'collected' }),
  ])
  counts.value = { all: all.length, saved: saved.length, collected: collected.length }
}
onMounted(async () => {
  await Promise.all([load(), loadGroups(), loadCounts()])
  loaded.value = true
})

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(query, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(load, 200)
})
watch(groupFilter, load)

function blankForm(): ContactInput {
  const presetGroup = typeof groupFilter.value === 'number' ? groups.value.find(g => g.id === groupFilter.value)?.name : undefined
  return { firstName: '', lastName: '', phone: '', notes: '', emails: [{ email: '', label: 'work', isPrimary: true }], groups: presetGroup ? [presetGroup] : [] }
}
function selectContact(id: number) {
  selectedId.value = id
  const c = contacts.value.find(x => x.id === id)
  if (!c) return
  editing.value = {
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    phone: c.phone,
    notes: c.notes,
    emails: c.emails.map(e => ({ ...e })),
    groups: [...c.groups],
  }
}
function newContact() {
  selectedId.value = null
  editing.value = blankForm()
}
function cancelEdit() {
  if (selected.value) selectContact(selected.value.id)
  else editing.value = null
}

function addEmailField() {
  editing.value?.emails.push({ email: '', label: 'work', isPrimary: false })
}
function removeEmailField(i: number) {
  editing.value?.emails.splice(i, 1)
}

const groupsText = computed({
  get: () => editing.value?.groups.join(', ') ?? '',
  set: (v: string) => {
    if (!editing.value) return
    editing.value.groups = v
      .split(',')
      .map(g => g.trim())
      .filter(Boolean)
  },
})

async function save() {
  if (!editing.value) return
  const emails = editing.value.emails.filter(e => e.email.trim())
  if (!emails.length) {
    toast.error('Add at least one email address.')
    return
  }
  const saved = await engine.api.contactSave({ ...editing.value, emails })
  toast.success('Saved')
  await Promise.all([load(), loadGroups(), loadCounts()])
  selectContact(saved.id)
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  await engine.api.contactDelete(deleteTarget.value.id)
  if (selectedId.value === deleteTarget.value.id) {
    selectedId.value = null
    editing.value = null
  }
  const name = deleteTarget.value.displayName
  deleteTarget.value = null
  toast.success(`Deleted ${name}`)
  await Promise.all([load(), loadGroups(), loadCounts()])
}

async function moveToSaved(c: Contact) {
  await engine.api.contactMoveToSaved(c.id)
  await Promise.all([load(), loadCounts()])
  selectContact(c.id)
}

function sendMail(address: string) {
  void router.push(`/compose?to=${encodeURIComponent(address)}`)
}
function showMails(address: string) {
  mail.setSearch(address)
  void router.push('/')
}

async function createGroup() {
  const name = newGroupName.value.trim()
  if (!name) return
  await engine.api.contactGroupCreate(name)
  newGroupName.value = ''
  addingGroup.value = false
  await loadGroups()
}

function downloadVcf(text: string, filename: string) {
  const blob = new Blob([text], { type: 'text/vcard' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
async function exportOne(c: Contact) {
  const vcf = await engine.api.contactsExportVcf([c.id])
  downloadVcf(vcf, `${c.displayName || 'contact'}.vcf`)
}
async function exportAll() {
  const vcf = await engine.api.contactsExportVcf()
  downloadVcf(vcf, 'contacts.vcf')
}
function pickImportFile() {
  fileInput.value?.click()
}
async function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const { imported } = await engine.api.contactsImportVcf(text)
    toast.success(`Imported ${imported} contact${imported === 1 ? '' : 's'}`)
    await Promise.all([load(), loadGroups(), loadCounts()])
  } catch (err) {
    toast.error((err as Error).message)
  } finally {
    input.value = ''
  }
}

function initials(c: Contact): string {
  const name = c.displayName || c.emails[0]?.email || '?'
  const cleaned = name.replace(/[()]/g, '')
  const parts = cleaned.split(/[\s@.]/).filter(Boolean).slice(0, 2)
  return (parts.map(w => w[0]).join('') || '?').toUpperCase()
}
const COLORS = ['bg-violet-500', 'bg-emerald-500', 'bg-rose-500', 'bg-sky-500', 'bg-amber-500', 'bg-indigo-500', 'bg-fuchsia-500', 'bg-teal-500']
function colorFor(c: Contact): string {
  let h = 0
  for (const ch of c.displayName || c.emails[0]?.email || '?') h = (h * 31 + ch.charCodeAt(0)) % COLORS.length
  return COLORS[h]
}
function fmtLast(ts: number | null): string {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="flex-1 flex min-h-0">
    <aside class="w-56 shrink-0 border-r bg-muted/60 flex flex-col">
      <div class="p-3">
        <Button class="w-full rounded-full gap-2" @click="newContact"><UserPlus class="size-4" /> New contact</Button>
      </div>
      <nav class="text-sm px-2 space-y-0.5">
        <button
          class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left"
          :class="groupFilter === 'all' ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted'"
          @click="groupFilter = 'all'"
        >
          <Users class="size-4" /> All <span class="ml-auto text-xs text-muted-foreground">{{ counts.all }}</span>
        </button>
        <button
          class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left"
          :class="groupFilter === 'saved' ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted'"
          @click="groupFilter = 'saved'"
        >
          <BookUser class="size-4" /> Saved <span class="ml-auto text-xs text-muted-foreground">{{ counts.saved }}</span>
        </button>
        <button
          class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left"
          :class="groupFilter === 'collected' ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted'"
          @click="groupFilter = 'collected'"
        >
          <Sparkles class="size-4" /> Collected <span class="ml-auto text-xs text-muted-foreground">{{ counts.collected }}</span>
        </button>

        <div class="px-2 pt-4 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Groups</div>
        <button
          v-for="g in groups"
          :key="g.id"
          class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left"
          :class="groupFilter === g.id ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted'"
          @click="groupFilter = g.id"
        >
          <span class="truncate">{{ g.name }}</span> <span class="ml-auto text-xs text-muted-foreground">{{ g.count }}</span>
        </button>
        <div v-if="addingGroup" class="flex items-center gap-1 px-2 py-1">
          <Input v-model="newGroupName" placeholder="Group name" class="h-7 text-xs" @keydown.enter="createGroup" @keydown.esc="addingGroup = false" />
          <Tooltip>
            <TooltipTrigger as-child>
              <Button size="icon" variant="ghost" class="size-7 shrink-0" @click="createGroup"><Plus class="size-3.5" /></Button>
            </TooltipTrigger>
            <TooltipContent>Add group</TooltipContent>
          </Tooltip>
        </div>
        <button v-else class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-muted-foreground hover:bg-muted" @click="addingGroup = true">
          <Plus class="size-4" /> New group
        </button>
      </nav>
      <div class="mt-auto p-2 border-t space-y-1 text-xs">
        <input ref="fileInput" type="file" accept=".vcf,text/vcard" class="hidden" @change="onImportFile">
        <button class="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted" @click="pickImportFile"><Upload class="size-3.5" /> Import vCard (.vcf)</button>
        <button class="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted" @click="exportAll"><Download class="size-3.5" /> Export all (.vcf)</button>
      </div>
    </aside>

    <section class="w-[340px] shrink-0 border-r flex flex-col min-h-0">
      <div class="h-12 shrink-0 flex items-center px-3 border-b relative">
        <Search class="absolute left-6 size-4 text-muted-foreground" />
        <Input v-model="query" placeholder="Search contacts" class="pl-9 h-9" />
      </div>
      <div v-if="loaded" class="h-7 shrink-0 flex items-center px-3 text-xs text-muted-foreground border-b">
        {{ contacts.length }} contact{{ contacts.length === 1 ? '' : 's' }}
      </div>
      <div class="flex-1 overflow-y-auto text-sm">
        <div v-if="!loaded" class="text-center text-muted-foreground text-sm mt-10">Loading…</div>
        <div v-else-if="!contacts.length" class="text-center text-muted-foreground text-sm mt-10">No contacts.</div>
        <template v-for="(entry, idx) in groupedList" :key="idx">
          <div v-if="entry.type === 'header'" class="px-3 pt-3 pb-1 text-[11px] font-semibold text-muted-foreground">{{ entry.letter }}</div>
          <button
            v-else
            class="w-full flex items-center gap-3 px-3 py-2 text-left"
            :class="entry.contact.id === selectedId ? 'bg-primary/10' : 'hover:bg-muted'"
            @click="selectContact(entry.contact.id)"
          >
            <div class="size-9 rounded-full text-white flex items-center justify-center text-xs font-bold shrink-0" :class="colorFor(entry.contact)">{{ initials(entry.contact) }}</div>
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium">{{ entry.contact.displayName }}</div>
              <div class="truncate text-xs text-muted-foreground">{{ entry.contact.emails[0]?.email }}</div>
            </div>
            <span v-if="entry.contact.kind === 'collected'" class="text-[10px] px-1.5 rounded bg-muted text-muted-foreground shrink-0">Collected</span>
          </button>
        </template>
      </div>
    </section>

    <main class="flex-1 min-w-0 overflow-y-auto">
      <div v-if="!dirty" class="text-muted-foreground text-center mt-20 text-sm">Select a contact, or create a new one.</div>
      <form v-else class="max-w-2xl mx-auto px-8 py-8" @submit.prevent="save">
        <div class="flex items-start gap-5 mb-8">
          <div v-if="selected" class="size-20 rounded-full text-white flex items-center justify-center text-2xl font-bold shrink-0" :class="colorFor(selected)">{{ initials(selected) }}</div>
          <div v-else class="size-20 rounded-full bg-muted flex items-center justify-center text-2xl font-bold text-muted-foreground shrink-0"><UserPlus class="size-8" /></div>
          <div class="flex-1 min-w-0">
            <h1 class="text-2xl font-semibold truncate">{{ selected ? selected.displayName : 'New contact' }}</h1>
            <div v-if="selected" class="text-sm text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
              <span class="px-2 py-0.5 rounded-full text-xs" :class="selected.kind === 'saved' ? 'bg-primary/10 text-primary' : 'bg-muted'">{{ selected.kind === 'saved' ? 'Saved' : 'Collected' }}</span>
              <span v-for="g in selected.groups" :key="g" class="px-2 py-0.5 rounded-full text-xs bg-muted flex items-center gap-1"><Tag class="size-3" />{{ g }}</span>
              <span v-if="selected.lastMailAt">· Last mail {{ fmtLast(selected.lastMailAt) }}</span>
            </div>
            <div v-if="selected" class="flex gap-2 mt-4 flex-wrap">
              <Button type="button" size="sm" class="rounded-full gap-2" @click="sendMail(selected.emails[0]?.email)"><Mail class="size-3.5" /> Send mail</Button>
              <Button type="button" size="sm" variant="outline" class="rounded-full gap-2" @click="showMails(selected.emails[0]?.email)"><Mails class="size-3.5" /> Show mails</Button>
              <Button v-if="selected.kind === 'collected'" type="button" size="sm" variant="outline" class="rounded-full gap-2" @click="moveToSaved(selected)"><BookUser class="size-3.5" /> Move to Saved</Button>
              <Tooltip>
                <TooltipTrigger as-child>
                  <Button type="button" size="icon" variant="ghost" class="ml-auto text-destructive hover:text-destructive" @click="deleteTarget = selected"><Trash2 class="size-4" /></Button>
                </TooltipTrigger>
                <TooltipContent>Delete</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>

        <div class="space-y-4 text-sm">
          <div class="grid grid-cols-2 gap-4">
            <label class="block"><span class="text-xs text-muted-foreground">First name</span><Input v-model="editing!.firstName" class="mt-1" /></label>
            <label class="block"><span class="text-xs text-muted-foreground">Last name</span><Input v-model="editing!.lastName" class="mt-1" /></label>
          </div>
          <div>
            <span class="text-xs text-muted-foreground">Email addresses</span>
            <div v-for="(e, i) in editing!.emails" :key="i" class="mt-1 flex gap-2">
              <Input v-model="e.email" type="email" placeholder="name@example.com" class="flex-1" />
              <select v-model="e.label" class="h-9 px-2 rounded-md border bg-background text-xs">
                <option value="work">Work</option>
                <option value="home">Home</option>
                <option value="other">Other</option>
              </select>
              <Tooltip>
                <TooltipTrigger as-child>
                  <Button type="button" variant="ghost" size="icon" class="text-muted-foreground shrink-0" @click="removeEmailField(i)"><X class="size-4" /></Button>
                </TooltipTrigger>
                <TooltipContent>Remove email</TooltipContent>
              </Tooltip>
            </div>
            <button type="button" class="mt-1 text-xs text-primary flex items-center gap-1" @click="addEmailField"><Plus class="size-3.5" /> Add email</button>
          </div>
          <label class="block"><span class="text-xs text-muted-foreground">Phone</span><Input v-model="editing!.phone" class="mt-1" /></label>
          <label class="block"><span class="text-xs text-muted-foreground">Groups</span><Input v-model="groupsText" placeholder="Clients, Family…" class="mt-1" /></label>
          <label class="block"><span class="text-xs text-muted-foreground">Notes</span><Textarea v-model="editing!.notes" rows="3" class="mt-1" /></label>

          <div class="flex gap-2 pt-2">
            <Button type="submit">Save</Button>
            <Button type="button" variant="outline" @click="cancelEdit">Cancel</Button>
            <Button v-if="selected" type="button" variant="outline" size="sm" class="ml-auto gap-1 text-xs" @click="exportOne(selected)"><Download class="size-3.5" /> Export .vcf</Button>
          </div>
        </div>
      </form>
    </main>

    <Dialog :open="!!deleteTarget" @update:open="v => !v && (deleteTarget = null)">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {{ deleteTarget?.displayName }}?</DialogTitle>
          <DialogDescription>This removes the contact and its saved email addresses. This can't be undone.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="deleteTarget = null">Cancel</Button>
          <Button variant="destructive" @click="confirmDelete">Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
