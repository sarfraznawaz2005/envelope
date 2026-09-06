/**
 * App-shell offline cache. This app renders entirely client-side and keeps
 * all mail in local SQLite (OPFS) — nothing here caches mail data, only the
 * static files (HTML/JS/CSS/icons) needed to open the app without a network
 * connection. Network-first so you always get the newest build when online;
 * falls back to the cache when offline.
 */
const CACHE = 'envelope-shell-v1'

self.addEventListener('install', event => {
  self.skipWaiting()
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/'])))
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  const req = event.request
  if (req.method !== 'GET') return
  if (req.headers.has('range')) return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // never touch relay/mail-server requests

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      try {
        const res = await fetch(req)
        if (res.ok) cache.put(req, res.clone())
        return res
      } catch {
        return (await cache.match(req)) ?? (req.mode === 'navigate' ? await cache.match('/') : Response.error())
      }
    })(),
  )
})
