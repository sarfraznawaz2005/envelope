import type { ClassValue } from 'clsx'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge Tailwind class lists. Later classes win. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
