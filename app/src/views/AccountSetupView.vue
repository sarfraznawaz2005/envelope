<script setup lang="ts">
import MasterPasswordDialog from '@/components/security/MasterPasswordDialog.vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ACCOUNT_COLORS, emptyAccountInput, type AccountInput, type AccountTestResult, type Security } from '@/shared/accounts'
import { defaultPort, guessSettings } from '@/shared/providers'
import { useAccountsStore } from '@/stores/accounts'
import { useSecurityStore } from '@/stores/security'
import { useSetting } from '@/stores/settings'
import { CheckCircle2, Info, Loader2, Wand2, XCircle } from '@lucide/vue'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'

const route = useRoute()
const router = useRouter()
const accounts = useAccountsStore()
const sec = useSecurityStore()

const editId = computed(() => (route.query.id ? Number(route.query.id) : null))
const form = reactive<AccountInput>(emptyAccountInput())
const step = ref(1)
const guessNote = ref<string | null>(null)
const guessed = ref(false)

onMounted(async () => {
  if (editId.value) {
    if (!accounts.loaded) await accounts.load()
    const a = accounts.byId.get(editId.value)
    if (a) {
      Object.assign(form, a, { inPassword: '', smtpPassword: '' })
      guessed.value = true
    }
  } else {
    form.color = ACCOUNT_COLORS[accounts.list.length % ACCOUNT_COLORS.length]!
  }
})

// guess servers when the email changes (new accounts only)
let lastAutoName = ''
watch(
  () => form.email,
  email => {
    if (editId.value || !email.includes('@')) return
    const g = guessSettings(email, form.kind)
    Object.assign(form, g.patch)
    guessNote.value = g.note ?? null
    guessed.value = true
    // suggest a name from the domain, but never overwrite what the user typed
    if (!form.name || form.name === lastAutoName) {
      lastAutoName = email.split('@')[1]?.split('.')[0]?.replace(/^\w/, c => c.toUpperCase()) ?? ''
      form.name = lastAutoName
    }
  },
)
watch(
  () => form.kind,
  kind => {
    if (editId.value) return
    const g = guessSettings(form.email, kind)
    form.inHost = g.patch.inHost ?? form.inHost
    form.inPort = g.patch.inPort ?? defaultPort(kind, form.inSecurity)
    form.inSecurity = g.patch.inSecurity ?? form.inSecurity
  },
)
watch(() => form.inSecurity, s => (form.inPort = defaultPort(form.kind, s)))
watch(() => form.smtpSecurity, s => (form.smtpPort = defaultPort('smtp', s)))

const secOptions: Array<{ v: Security; l: string }> = [
  { v: 'tls', l: 'SSL/TLS' },
  { v: 'starttls', l: 'STARTTLS' },
  { v: 'none', l: 'None (not safe)' },
]

// ---------- step 4: planned steps shown as placeholders while a test runs ----------
const relayUrl = useSetting('relay.url')
const plannedSteps = computed(() => {
  const steps: Array<{ key: string; label: string; target?: string }> = [{ key: 'relay', label: 'Relay', target: relayUrl.value }]
  if (form.kind === 'imap') {
    steps.push(
      { key: 'in-connect', label: `IMAP connect${form.inSecurity !== 'none' ? ' + TLS' : ''}`, target: `${form.inHost}:${form.inPort}` },
      { key: 'in-login', label: 'IMAP login' },
      { key: 'in-list', label: 'IMAP folders' },
      { key: 'in-idle', label: 'Instant push (IDLE)' },
    )
  } else {
    steps.push(
      { key: 'in-connect', label: `POP3 connect${form.inSecurity !== 'none' ? ' + TLS' : ''}`, target: `${form.inHost}:${form.inPort}` },
      { key: 'in-login', label: 'POP3 login' },
      { key: 'in-stat', label: 'POP3 mailbox' },
    )
  }
  steps.push(
    { key: 'smtp-connect', label: `SMTP connect${form.smtpSecurity === 'starttls' ? ' + STARTTLS' : form.smtpSecurity === 'tls' ? ' + TLS' : ''}`, target: `${form.smtpHost}:${form.smtpPort}` },
    { key: 'smtp-login', label: 'SMTP login' },
  )
  return steps
})

// ---------- master password gate ----------
const mpOpen = ref(false)
function ensureUnlocked(): boolean {
  if (!sec.status.hasPassword) {
    mpOpen.value = true
    return false
  }
  if (!sec.status.unlocked) {
    toast.error('Unlock with your master password first (top of the page).')
    return false
  }
  return true
}

// ---------- test + save ----------
const testing = ref(false)
const result = ref<AccountTestResult | null>(null)
async function runTest() {
  step.value = 4
  testing.value = true
  result.value = null
  try {
    result.value = await accounts.test({ ...form, id: editId.value ?? undefined })
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    testing.value = false
  }
}
const saving = ref(false)
async function finish() {
  if (!ensureUnlocked()) return
  saving.value = true
  try {
    const a = await accounts.save({ ...form, id: editId.value ?? undefined, inPassword: form.inPassword || undefined, smtpPassword: form.smtpPassword || undefined })
    toast.success(`${editId.value ? 'Saved' : 'Added'} ${a.name}`)
    router.push('/settings/accounts')
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    saving.value = false
  }
}
const canNext1 = computed(() => form.email.includes('@') && (editId.value ? true : form.inPassword!.length > 0))
</script>

<template>
  <div class="flex-1 overflow-y-auto p-6">
    <div class="max-w-2xl mx-auto rounded-xl border bg-card shadow-sm">
      <!-- stepper -->
      <div class="flex items-center gap-2 px-6 py-4 border-b text-xs">
        <template v-for="(label, i) in ['Basics', 'Incoming', 'Outgoing', 'Test']" :key="label">
          <div v-if="i" class="flex-1 h-px bg-border" />
          <button class="flex items-center gap-1.5" :class="step === i + 1 ? 'font-medium text-primary' : step > i + 1 ? 'text-emerald-600' : 'text-muted-foreground'" @click="step > i + 1 && (step = i + 1)">
            <span class="size-5 rounded-full flex items-center justify-center" :class="step === i + 1 ? 'bg-primary text-primary-foreground' : step > i + 1 ? 'bg-emerald-600 text-white' : 'bg-muted'">{{ step > i + 1 ? '✓' : i + 1 }}</span>
            {{ label }}
          </button>
        </template>
      </div>

      <div class="p-6 text-sm space-y-4">
        <!-- STEP 1 -->
        <template v-if="step === 1">
          <h1 class="text-xl font-semibold">{{ editId ? 'Edit account' : 'Your account' }}</h1>
          <div class="space-y-1"><Label for="f-email">Email address</Label><Input id="f-email" v-model="form.email" type="email" autocomplete="off" placeholder="you@example.com" /></div>
          <div class="space-y-1">
            <Label for="f-pw">Password</Label>
            <Input id="f-pw" v-model="form.inPassword" type="password" autocomplete="off" :placeholder="editId ? '(unchanged)' : ''" />
            <p class="text-xs text-muted-foreground">Stored encrypted with your master password. For Gmail / Yahoo / iCloud use an <b>app password</b>.</p>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1"><Label for="f-name">Account name (sidebar)</Label><Input id="f-name" v-model="form.name" placeholder="Work" /></div>
            <div class="space-y-1"><Label for="f-disp">Your name (shown to recipients)</Label><Input id="f-disp" v-model="form.displayName" /></div>
          </div>
          <div class="space-y-1">
            <Label>Colour</Label>
            <div class="flex gap-1.5">
              <button v-for="c in ACCOUNT_COLORS" :key="c" type="button" :class="cn('size-6 rounded-full border-2', form.color === c ? 'border-foreground' : 'border-transparent')" :style="{ background: c }" @click="form.color = c" />
            </div>
          </div>
          <div v-if="guessed && !editId" class="rounded-md bg-muted px-3 py-2 text-xs flex items-start gap-2">
            <Wand2 class="size-4 text-primary shrink-0 mt-0.5" />
            <span>Server settings guessed from <b>{{ form.email.split('@')[1] }}</b>. Check them in the next steps.<template v-if="guessNote"> {{ guessNote }}</template></span>
          </div>
          <div class="flex justify-end pt-2"><Button :disabled="!canNext1" @click="step = 2">Next</Button></div>
        </template>

        <!-- STEP 2 -->
        <template v-else-if="step === 2">
          <h1 class="text-xl font-semibold">Incoming mail</h1>
          <div class="grid grid-cols-2 gap-3">
            <label :class="cn('border-2 rounded-lg p-3 cursor-pointer', form.kind === 'imap' ? 'border-primary bg-primary/5' : '')">
              <input v-model="form.kind" type="radio" value="imap" class="mr-1" /> <b>IMAP</b>
              <div class="text-xs text-muted-foreground mt-1">Recommended. Mail stays on the server. Folders sync. Instant push (IDLE).</div>
            </label>
            <label :class="cn('border-2 rounded-lg p-3 cursor-pointer', form.kind === 'pop3' ? 'border-primary bg-primary/5' : '')">
              <input v-model="form.kind" type="radio" value="pop3" class="mr-1" /> <b>POP3</b>
              <div class="text-xs text-muted-foreground mt-1">Downloads mail into this app. No server folders. Checks every few minutes.</div>
            </label>
          </div>
          <div class="grid grid-cols-3 gap-3">
            <div class="space-y-1 col-span-2"><Label for="f-inhost">Server</Label><Input id="f-inhost" v-model="form.inHost" class="font-mono" /></div>
            <div class="space-y-1"><Label for="f-inport">Port</Label><Input id="f-inport" v-model.number="form.inPort" type="number" class="font-mono" /></div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1">
              <Label class="flex items-center gap-1">
                Security
                <Tooltip>
                  <TooltipTrigger as-child><Info class="size-3.5 text-muted-foreground" /></TooltipTrigger>
                  <TooltipContent class="max-w-64">
                    <div class="space-y-1">
                      <div><b>SSL/TLS</b> — encrypted from the first byte. Common ports: 993 (IMAP), 995 (POP3).</div>
                      <div><b>STARTTLS</b> — connects in plain text, then upgrades to TLS. Common port: 143 (IMAP), 110 (POP3).</div>
                      <div><b>None</b> — unencrypted. Only for local/test servers.</div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </Label>
              <Select v-model="form.inSecurity"><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="o in secOptions" :key="o.v" :value="o.v">{{ o.l }}</SelectItem></SelectContent></Select>
            </div>
            <div class="space-y-1"><Label for="f-inuser">Username</Label><Input id="f-inuser" v-model="form.inUser" autocomplete="off" /></div>
          </div>
          <div v-if="form.kind === 'pop3'" class="rounded-lg border p-3 space-y-2 text-xs">
            <div class="font-medium text-sm">POP3 options</div>
            <label class="flex items-center gap-2"><Checkbox v-model="form.popLeaveOnServer" /> Leave a copy of messages on the server</label>
            <label class="flex items-center gap-2 pl-6" :class="!form.popLeaveOnServer && 'opacity-50'">Delete from server after <Input v-model.number="form.popDeleteAfterDays" type="number" class="w-16 h-7" :disabled="!form.popLeaveOnServer" /> days (0 = never)</label>
            <label class="flex items-center gap-2">Check for new mail every
              <Select :model-value="String(form.pollMinutes)" @update:model-value="v => (form.pollMinutes = Number(v))"><SelectTrigger class="h-7 w-24"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="1">1 min</SelectItem><SelectItem value="5">5 min</SelectItem><SelectItem value="15">15 min</SelectItem><SelectItem value="30">30 min</SelectItem></SelectContent></Select>
            </label>
          </div>
          <div class="flex justify-between pt-2"><Button variant="outline" @click="step = 1">Back</Button><Button :disabled="!form.inHost" @click="step = 3">Next</Button></div>
        </template>

        <!-- STEP 3 -->
        <template v-else-if="step === 3">
          <h1 class="text-xl font-semibold">Outgoing mail (SMTP)</h1>
          <div class="grid grid-cols-3 gap-3">
            <div class="space-y-1 col-span-2"><Label for="f-smtphost">Server</Label><Input id="f-smtphost" v-model="form.smtpHost" class="font-mono" /></div>
            <div class="space-y-1"><Label for="f-smtpport">Port</Label><Input id="f-smtpport" v-model.number="form.smtpPort" type="number" class="font-mono" /></div>
          </div>
          <div class="space-y-1">
            <Label class="flex items-center gap-1">
              Security
              <Tooltip>
                <TooltipTrigger as-child><Info class="size-3.5 text-muted-foreground" /></TooltipTrigger>
                <TooltipContent class="max-w-64">
                  <div class="space-y-1">
                    <div><b>STARTTLS</b> — connects in plain text, then upgrades to TLS. Common port: 587.</div>
                    <div><b>SSL/TLS</b> — encrypted from the first byte. Common port: 465.</div>
                    <div><b>None</b> — unencrypted. Only for local/test servers.</div>
                  </div>
                </TooltipContent>
              </Tooltip>
            </Label>
            <Select v-model="form.smtpSecurity"><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="o in secOptions" :key="o.v" :value="o.v">{{ o.l }}</SelectItem></SelectContent></Select>
          </div>
          <label class="flex items-center gap-2 text-xs"><Checkbox v-model="form.smtpSameCreds" /> Same username and password as incoming</label>
          <div v-if="!form.smtpSameCreds" class="grid grid-cols-2 gap-3">
            <div class="space-y-1"><Label for="f-smtpuser">SMTP username</Label><Input id="f-smtpuser" v-model="form.smtpUser" autocomplete="off" /></div>
            <div class="space-y-1"><Label for="f-smtppw">SMTP password</Label><Input id="f-smtppw" v-model="form.smtpPassword" type="password" autocomplete="off" :placeholder="editId ? '(unchanged)' : ''" /></div>
          </div>
          <label class="flex items-center gap-2 text-xs"><Checkbox v-model="form.smtpCopyToSent" /> Save a copy of sent mail to the Sent folder</label>
          <label class="flex items-center gap-2 text-xs"><Checkbox v-model="form.notify" /> Notify me about new mail in this account</label>
          <div class="flex justify-between pt-2"><Button variant="outline" @click="step = 2">Back</Button><Button :disabled="!form.smtpHost" @click="runTest">Test connection</Button></div>
        </template>

        <!-- STEP 4 -->
        <template v-else>
          <h1 class="text-xl font-semibold">{{ testing ? 'Testing connection…' : 'Test result' }}</h1>
          <div class="space-y-2">
            <template v-if="testing">
              <div v-for="p in plannedSteps" :key="p.key" class="flex items-center gap-3 p-3 rounded-md border">
                <Loader2 class="size-5 shrink-0 animate-spin text-muted-foreground" />
                <span>{{ p.label }}</span>
                <span v-if="p.target" class="text-xs text-muted-foreground font-mono">{{ p.target }}</span>
              </div>
            </template>
            <template v-else>
              <div v-for="s in result?.steps ?? []" :key="s.key" class="flex items-center gap-3 p-3 rounded-md border">
                <component :is="s.ok ? CheckCircle2 : XCircle" class="size-5 shrink-0" :class="s.ok ? 'text-emerald-500' : s.key === 'in-idle' ? 'text-amber-500' : 'text-red-500'" />
                <span>{{ s.label }}</span>
                <span class="text-xs text-muted-foreground truncate">{{ s.detail }}</span>
                <span class="ml-auto text-xs text-muted-foreground whitespace-nowrap">{{ s.ms ? s.ms + ' ms' : '' }}</span>
              </div>
            </template>
          </div>
          <div v-if="result && result.ok" class="rounded-md border border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-900 px-3 py-2 text-xs flex items-center gap-2">
            <CheckCircle2 class="size-4" /> All good.<template v-if="result.folders"> {{ result.folders }} folders found.</template><template v-if="result.idle"> Server supports instant push (IDLE).</template>
          </div>
          <div v-else-if="result && !result.ok" class="rounded-md border border-red-300 bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200 dark:border-red-900 px-3 py-2 text-xs">
            Something failed. Fix the settings and test again. You can still save and fix it later.
          </div>
          <div class="flex justify-between pt-2">
            <Button variant="outline" @click="step = 3">Back</Button>
            <div class="flex gap-2">
              <Button variant="outline" :disabled="testing" @click="runTest">Test again</Button>
              <Button :disabled="testing || saving" @click="finish">{{ editId ? 'Save changes' : 'Add account & start sync' }}</Button>
            </div>
          </div>
        </template>
      </div>
    </div>

    <MasterPasswordDialog v-model:open="mpOpen" mode="set" @done="finish" />
  </div>
</template>
