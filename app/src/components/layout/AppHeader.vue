<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useEngine } from '@/engine'
import { useInstallPrompt } from '@/lib/install-prompt'
import { useUiStore } from '@/stores/ui'
import { Download, Mail, Moon, Sun, SunMoon, Users, Settings, Wrench } from '@lucide/vue'
import { computed } from 'vue'

const ui = useUiStore()
const engine = useEngine()
const install = useInstallPrompt()

const themeIcon = computed(() => (ui.theme === 'system' ? SunMoon : ui.theme === 'dark' ? Moon : Sun))
const themeLabel = computed(() => ({ system: 'Theme: follow system', light: 'Theme: light', dark: 'Theme: dark' })[ui.theme])
// `import.meta.env.DEV` can't be used directly in a template expression (Vue's template
// compiler parses attribute expressions outside module scope) — read it here instead.
const isDev = import.meta.env.DEV
</script>

<template>
  <header class="h-12 shrink-0 flex items-center gap-3 px-3 border-b bg-background">
    <RouterLink to="/" class="font-bold text-primary flex items-center gap-2">
      <Mail class="size-5" /> Envelope
    </RouterLink>

    <Button as-child size="xs" class="h-7 px-2.5">
      <RouterLink to="/compose">Compose</RouterLink>
    </Button>

    <div class="flex-1" />

    <span class="text-xs font-medium flex items-center gap-1.5 mr-2" :class="engine.ready.value ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'">
      <span class="size-2 rounded-full" :class="engine.ready.value ? 'bg-emerald-500' : 'bg-muted-foreground/50'" />
      {{ engine.isLeader.value ? (engine.ready.value ? 'Engine ready' : 'Starting…') : 'Mirror (another tab is leader)' }}
    </span>

    <Tooltip v-if="install.canInstall.value">
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon" @click="install.promptInstall()">
          <Download class="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Install Envelope as an app</TooltipContent>
    </Tooltip>

    <Tooltip>
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon" @click="ui.cycleTheme()">
          <component :is="themeIcon" class="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <div class="font-medium">{{ themeLabel }}</div>
        <div class="text-xs opacity-80">Click to cycle: system → light → dark</div>
      </TooltipContent>
    </Tooltip>

    <Tooltip>
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon" as-child><RouterLink to="/contacts"><Users class="size-4" /></RouterLink></Button>
      </TooltipTrigger>
      <TooltipContent>Contacts</TooltipContent>
    </Tooltip>

    <Tooltip>
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon" as-child><RouterLink to="/settings"><Settings class="size-4" /></RouterLink></Button>
      </TooltipTrigger>
      <TooltipContent>Settings</TooltipContent>
    </Tooltip>

    <Tooltip v-if="isDev">
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon" as-child><RouterLink to="/dev"><Wrench class="size-4" /></RouterLink></Button>
      </TooltipTrigger>
      <TooltipContent>Developer tools</TooltipContent>
    </Tooltip>
  </header>
</template>
