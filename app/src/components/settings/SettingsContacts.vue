<script setup lang="ts">
import SettingRow from './SettingRow.vue'
import { Switch } from '@/components/ui/switch'
import { useSetting } from '@/stores/settings'

const autoCollect = useSetting('contacts.autoCollect')
const fromReplies = useSetting('contacts.collectFromReplies')
const useCollected = useSetting('contacts.useCollectedInAutocomplete')
const showAdd = useSetting('contacts.showAddButton')
const skipNoReply = useSetting('contacts.skipNoReply')
</script>

<template>
  <div>
    <h1 class="text-2xl font-semibold mb-4">Contacts</h1>

    <SettingRow label="Collect contacts automatically" description='When you send mail, add each recipient to the "Collected" group.'>
      <Switch v-model="autoCollect" />
    </SettingRow>
    <SettingRow label="Also collect from replies I receive"><Switch v-model="fromReplies" /></SettingRow>
    <SettingRow label="Use Collected contacts in autocomplete"><Switch v-model="useCollected" /></SettingRow>
    <SettingRow label='Show "Add to contacts" button on messages'><Switch v-model="showAdd" /></SettingRow>
    <SettingRow label="Skip no-reply addresses" description="noreply@, no-reply@, donotreply@ and similar."><Switch v-model="skipNoReply" /></SettingRow>

    <p class="text-xs text-muted-foreground mt-4">Import / export vCard and the Collected group live on the Contacts page.</p>
  </div>
</template>
