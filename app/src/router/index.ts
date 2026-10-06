import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import AccountSetupView from '@/views/AccountSetupView.vue'
import ComposeView from '@/views/ComposeView.vue'
import ContactsView from '@/views/ContactsView.vue'
import MailView from '@/views/MailView.vue'
import SettingsView from '@/views/SettingsView.vue'

// These pages are bundled with the app (not lazy-loaded). When they were separate chunks, a
// chunk request that failed or hung (stale files, service worker, a host app that blocks or
// delays requests) left the page blank under a working header. A local app gains nothing from
// lazy pages, so there is no chunk to fail.

// The dev tools page can send real mail from a real account and probe arbitrary hosts through
// the relay — useful while building the app, not something a production build should expose
// to whoever clicks the wrench icon. import.meta.env.DEV is replaced at build time, so a
// production bundle never even ships this route or the DevView.vue chunk.
const devRoutes: RouteRecordRaw[] = import.meta.env.DEV ? [{ path: '/dev', name: 'dev', component: () => import('@/views/DevView.vue') }] : []

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'mail', component: MailView },
    { path: '/compose', name: 'compose', component: ComposeView },
    { path: '/contacts', name: 'contacts', component: ContactsView },
    { path: '/settings/:tab?', name: 'settings', component: SettingsView },
    { path: '/setup', name: 'setup', component: AccountSetupView },
    ...devRoutes,
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

// Safety net for any page still loaded as a separate chunk (the dev page). If the app has been open a while
// and the files changed or the server hiccuped, that load fails and vue-router drops the click
// silently — the button "does nothing". On such a failure, do a full page load of the target
// (which fetches fresh files). The sessionStorage flag stops an endless reload loop.
router.onError((err, to) => {
  const msg = String((err as Error)?.message ?? err)
  const isChunkError = /dynamically imported module|Importing a module script failed|Loading chunk|Failed to fetch/i.test(msg)
  if (!isChunkError) {
    console.error('[router]', err)
    return
  }
  const key = `chunk-reload:${to.fullPath}`
  if (sessionStorage.getItem(key)) {
    sessionStorage.removeItem(key)
    console.error('[router] page failed to load again after reload', err)
    return
  }
  sessionStorage.setItem(key, '1')
  window.location.assign(to.fullPath)
})

router.afterEach(to => sessionStorage.removeItem(`chunk-reload:${to.fullPath}`))
