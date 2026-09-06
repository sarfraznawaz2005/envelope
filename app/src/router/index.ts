import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

// The dev tools page can send real mail from a real account and probe arbitrary hosts through
// the relay — useful while building the app, not something a production build should expose
// to whoever clicks the wrench icon. import.meta.env.DEV is replaced at build time, so a
// production bundle never even ships this route or the DevView.vue chunk.
const devRoutes: RouteRecordRaw[] = import.meta.env.DEV ? [{ path: '/dev', name: 'dev', component: () => import('@/views/DevView.vue') }] : []

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'mail', component: () => import('@/views/MailView.vue') },
    { path: '/compose', name: 'compose', component: () => import('@/views/ComposeView.vue') },
    { path: '/contacts', name: 'contacts', component: () => import('@/views/ContactsView.vue') },
    { path: '/settings/:tab?', name: 'settings', component: () => import('@/views/SettingsView.vue') },
    { path: '/setup', name: 'setup', component: () => import('@/views/AccountSetupView.vue') },
    ...devRoutes,
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
