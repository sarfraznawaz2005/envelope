<script setup lang="ts">
/** A draggable divider between two panels. Emits the horizontal distance moved since the
 * last event (not the total), so the parent just adds it to its own persisted width. */
const emit = defineEmits<{ (e: 'resize', deltaX: number): void }>()

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  e.preventDefault()
  // Pointer capture keeps events coming to this element even if the cursor briefly leaves the
  // thin handle during a fast drag — but if it's unavailable for any reason, fall back to
  // tracking on window instead of losing the drag entirely.
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    /* fall back to window-level tracking below */
  }
  let lastX = e.clientX

  function onMove(ev: PointerEvent) {
    emit('resize', ev.clientX - lastX)
    lastX = ev.clientX
  }
  function onUp() {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}
</script>

<template>
  <div class="relative w-1 shrink-0 cursor-col-resize group/handle -mx-0.5 z-10" @pointerdown="onPointerDown">
    <div class="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border group-hover/handle:bg-primary/50 group-hover/handle:w-0.5 transition-colors" />
  </div>
</template>
