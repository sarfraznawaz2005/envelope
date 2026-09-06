/**
 * Master password state, mirrored from the engine.
 */
import { useEngine } from '@/engine'
import type { SecurityStatus } from '@/shared/rpc'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export const useSecurityStore = defineStore('security', () => {
  const status = ref<SecurityStatus>({ hasPassword: false, unlocked: false, remembered: false, rememberExpiresAt: null })
  const loaded = ref(false)

  const needsUnlock = computed(() => status.value.hasPassword && !status.value.unlocked)

  async function refresh() {
    status.value = await useEngine().api.securityStatus()
    loaded.value = true
  }
  function apply(s: SecurityStatus) {
    status.value = s
    loaded.value = true
  }

  const api = () => useEngine().api
  const setup = async (pw: string, remember: boolean) => apply(await api().securitySetup(pw, remember))
  const unlock = async (pw: string, remember: boolean) => apply(await api().securityUnlock(pw, remember))
  const lock = async () => apply(await api().securityLock())
  const change = async (oldPw: string, newPw: string) => apply(await api().securityChange(oldPw, newPw))
  const forgetDevice = async () => apply(await api().securityForgetDevice())

  return { status, loaded, needsUnlock, refresh, apply, setup, unlock, lock, change, forgetDevice }
})
