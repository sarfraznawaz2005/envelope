/** Consistent per-sender avatar color + initials, shared by the message list and message view
 * so the same person always shows the same color instead of it changing per message/row. */
const COLORS = ['bg-violet-500', 'bg-emerald-500', 'bg-rose-500', 'bg-sky-500', 'bg-amber-500', 'bg-indigo-500']

function stripAddress(name: string): string {
  return name.replace(/<[^>]*>/g, '').trim() || name
}

export function avatarInitials(name: string): string {
  const parts = stripAddress(name).split(/\s+/).filter(Boolean).slice(0, 2)
  return (parts.map(w => w[0]).join('') || '?').toUpperCase()
}

export function avatarColor(name: string): string {
  const key = stripAddress(name).toLowerCase()
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return COLORS[h % COLORS.length]!
}
