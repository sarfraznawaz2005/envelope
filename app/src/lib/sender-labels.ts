/** UI-side cache of sender labels, shared by the message list and the message view. */
import { useEngine } from '@/engine'
import type { SenderLabel } from '@/shared/rpc'
import { reactive } from 'vue'

/** Full class strings, so Tailwind can see them. */
export const LABEL_COLORS: Record<string, string> = {
  blue: 'bg-blue-600 text-white',
  red: 'bg-red-600 text-white',
  orange: 'bg-orange-500 text-white',
  amber: 'bg-amber-500 text-black',
  green: 'bg-green-600 text-white',
  teal: 'bg-teal-600 text-white',
  purple: 'bg-purple-600 text-white',
  pink: 'bg-pink-600 text-white',
  gray: 'bg-gray-500 text-white',
}

const labels = reactive(new Map<string, SenderLabel>())
let loaded = false

export async function loadSenderLabels() {
  if (loaded) return
  loaded = true
  try {
    const list = await useEngine().api.senderLabelsList()
    labels.clear()
    for (const l of list) labels.set(l.email, l)
  } catch {
    loaded = false
  }
}

export function senderLabelFor(address: string | undefined): SenderLabel | undefined {
  return address ? labels.get(address.toLowerCase()) : undefined
}

/** Pass null to remove the label. */
export async function setSenderLabel(address: string, label: { name: string; color: string } | null) {
  const key = address.toLowerCase()
  await useEngine().api.senderLabelSet(key, label)
  if (label?.name.trim()) labels.set(key, { email: key, name: label.name.trim(), color: label.color })
  else labels.delete(key)
}
