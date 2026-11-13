// Offline cache: network first so updates land, cached copy when offline.
const CACHE = 'cogrush-v1'
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return
  e.respondWith(fetch(e.request).then(res => {
    const copy = res.clone()
    caches.open(CACHE).then(c => c.put(e.request, copy))
    return res
  }).catch(() => caches.match(e.request).then(r => r || caches.match('./'))))
})
