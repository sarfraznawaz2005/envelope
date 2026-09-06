/**
 * Leader election with the Web Locks API.
 *
 * Only one tab may own the database and the mail connections. That tab is the
 * "leader". Other tabs are mirrors. When the leader tab closes, the browser
 * releases the lock and the next waiting tab becomes leader.
 */

const LOCK_NAME = 'envelope-engine-leader'

export interface Leadership {
  /** true if this tab is the leader right now */
  isLeader: boolean
  /** resolves when this tab becomes leader (immediately if already) */
  whenLeader: Promise<void>
}

export function requestLeadership(onBecomeLeader: () => void): Leadership {
  const state: Leadership = { isLeader: false, whenLeader: Promise.resolve() }

  if (!('locks' in navigator)) {
    // Very old browser. Assume single tab.
    state.isLeader = true
    onBecomeLeader()
    return state
  }

  state.whenLeader = new Promise<void>(resolve => {
    // This request waits in the queue until the lock is free. The callback
    // runs when we get it, and the lock is held as long as the returned
    // promise is pending — i.e. for the life of this tab.
    navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, () => {
      state.isLeader = true
      resolve()
      onBecomeLeader()
      return new Promise<void>(() => {
        /* hold forever; released when the tab closes */
      })
    })
  })

  return state
}

/** Peek: is some tab already leader? (does not take the lock) */
export async function hasLeader(): Promise<boolean> {
  if (!('locks' in navigator)) return false
  const q = await navigator.locks.query()
  return (q.held ?? []).some(l => l.name === LOCK_NAME)
}
