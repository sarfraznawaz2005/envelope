<script setup lang="ts">
defineProps<{
  label: string
  description?: string
  /** stack control under the label (for wide controls) */
  stacked?: boolean
}>()
</script>

<template>
  <div class="py-3 border-b last:border-b-0" :class="stacked ? 'space-y-2' : 'flex items-center justify-between gap-6'">
    <div class="min-w-0">
      <div class="font-medium text-sm">{{ label }}</div>
      <div v-if="description || $slots.description" class="text-xs text-muted-foreground mt-0.5">
        <slot name="description">{{ description }}</slot>
      </div>
    </div>
    <div class="shrink-0" :class="stacked ? '' : 'flex items-center'">
      <slot />
    </div>
  </div>
</template>
