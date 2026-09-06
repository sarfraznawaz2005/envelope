import { useEngine } from '@/engine'
import type { Account, AccountInput, AccountTestResult } from '@/shared/accounts'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export const useAccountsStore = defineStore('accounts', () => {
  const list = ref<Account[]>([])
  const loaded = ref(false)

  const api = () => useEngine().api
  async function load() {
    list.value = await api().accountsList()
    loaded.value = true
  }
  async function save(input: AccountInput): Promise<Account> {
    const a = await api().accountsSave(input)
    await load()
    return a
  }
  async function remove(id: number) {
    await api().accountsDelete(id)
    await load()
  }
  function test(input: AccountInput): Promise<AccountTestResult> {
    return api().accountsTest(input)
  }
  const byId = computed(() => new Map(list.value.map(a => [a.id, a])))

  return { list, loaded, byId, load, save, remove, test }
})
