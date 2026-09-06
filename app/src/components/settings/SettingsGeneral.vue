<script setup lang="ts">
import SettingRow from './SettingRow.vue'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useSetting } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { computed } from 'vue'

const ui = useUiStore()
const threads = useSetting('mail.threads')
const unified = useSetting('mail.unifiedInbox')
const shortcuts = useSetting('mail.shortcuts')
const markRead = useSetting('mail.markReadDelay')
const cacheDays = useSetting('mail.cacheDays')

// selects want strings
const markReadStr = computed({ get: () => String(markRead.value), set: v => (markRead.value = Number(v)) })
const cacheDaysStr = computed({ get: () => String(cacheDays.value), set: v => (cacheDays.value = Number(v)) })
</script>

<template>
  <div>
    <h1 class="text-2xl font-semibold mb-4">General</h1>

    <SettingRow label="Theme" description="Follow the system, or pick one.">
      <Select v-model="ui.theme">
        <SelectTrigger class="w-40"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="system">System</SelectItem>
          <SelectItem value="light">Light</SelectItem>
          <SelectItem value="dark">Dark</SelectItem>
        </SelectContent>
      </Select>
    </SettingRow>

    <SettingRow label="Message list density">
      <Select v-model="ui.density">
        <SelectTrigger class="w-40"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="comfortable">Comfortable</SelectItem>
          <SelectItem value="compact">Compact</SelectItem>
        </SelectContent>
      </Select>
    </SettingRow>

    <SettingRow label="Show Unified Inbox" description="One inbox for all accounts.">
      <Switch v-model="unified" />
    </SettingRow>

    <SettingRow label="Group messages into threads">
      <Switch v-model="threads" />
    </SettingRow>

    <SettingRow label="Mark as read when opened">
      <Select v-model="markReadStr">
        <SelectTrigger class="w-40"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="0">Immediately</SelectItem>
          <SelectItem value="2000">After 2 seconds</SelectItem>
          <SelectItem value="-1">Never (manual)</SelectItem>
        </SelectContent>
      </Select>
    </SettingRow>

    <SettingRow label="Keyboard shortcuts" description="Gmail-style: j/k next/prev, r reply, a reply all, f forward, e archive, # delete, / search, c compose.">
      <Switch v-model="shortcuts" />
    </SettingRow>

    <SettingRow label="Offline cache per folder" description="Older mail is fetched from the server when you open it.">
      <Select v-model="cacheDaysStr">
        <SelectTrigger class="w-40"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="30">Last 30 days</SelectItem>
          <SelectItem value="90">Last 90 days</SelectItem>
          <SelectItem value="365">Last year</SelectItem>
          <SelectItem value="0">Everything</SelectItem>
        </SelectContent>
      </Select>
    </SettingRow>
  </div>
</template>
