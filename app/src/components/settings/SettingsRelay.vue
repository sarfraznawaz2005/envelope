<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useEngine } from '@/engine'
import { useSetting } from '@/stores/settings'
import { CheckCircle2, XCircle } from '@lucide/vue'
import { ref } from 'vue'

const url = useSetting('relay.url')
const token = useSetting('relay.token')
const engine = useEngine()

const busy = ref(false)
const result = ref<{ ok: boolean; text: string } | null>(null)

async function test() {
  busy.value = true
  result.value = null
  try {
    const r = await engine.api.testRelay(url.value, token.value || undefined)
    result.value = r.ok ? { ok: true, text: `Connected · relay v${r.version}` } : { ok: false, text: r.error }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-5">
    <div>
      <h1 class="text-2xl font-semibold mb-1">Relay</h1>
      <p class="text-xs text-muted-foreground">Browsers cannot open mail connections directly. A small relay program passes bytes between this app and your mail servers. Run it on this PC, or on a server you trust.</p>
    </div>

    <div class="space-y-1">
      <Label for="relay-url">Relay URL</Label>
      <Input id="relay-url" v-model="url" class="font-mono" placeholder="ws://127.0.0.1:8765" />
    </div>
    <div class="space-y-1">
      <Label for="relay-token">Token (optional)</Label>
      <Input id="relay-token" v-model="token" type="password" autocomplete="off" />
      <p class="text-xs text-muted-foreground">Set the same value with <code>--token</code> when you start the relay.</p>
    </div>

    <div class="flex items-center gap-3">
      <Button :disabled="busy || !engine.ready.value" @click="test">Test relay</Button>
      <span v-if="result" class="text-xs flex items-center gap-1" :class="result.ok ? 'text-emerald-600' : 'text-red-600'">
        <component :is="result.ok ? CheckCircle2 : XCircle" class="size-4" /> {{ result.text }}
      </span>
    </div>

    <div class="rounded-md border p-3 text-xs space-y-2">
      <div class="font-medium">How to run the relay</div>
      <pre class="bg-muted rounded p-2 font-mono">cd relay
npm install
node index.js --verbose</pre>
      <p class="text-muted-foreground">Add <code>--token YOUR_SECRET</code> to require a token. Add <code>--host 0.0.0.0</code> only if you put it behind HTTPS (wss://).</p>
    </div>
  </div>
</template>
