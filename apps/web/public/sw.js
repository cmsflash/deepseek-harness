// Offline application shell: same-origin GETs go to the network first and fall
// back to the last successful copy, so the page boots while the Host is
// unreachable. Host data is replayed by the client (api-gateway offline replay),
// not here; /api requests other than file reads, and event streams, pass through
// untouched.
const CACHE = 'dsh-shell-v1'
const NETWORK_TIMEOUT_MS = 4000

self.addEventListener('install', () => { self.skipWaiting() })
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()) })

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  // An event stream never ends, so copying it would hold its HTTP connection for
  // the worker's lifetime; six held connections stall every request to the Host.
  if (request.headers.get('accept')?.includes('text/event-stream')) return
  const url = new URL(request.url)
  const scope = new URL(self.registration.scope)
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return
  const path = url.pathname.slice(scope.pathname.length)
  if (path.startsWith('api/') && path !== 'api/file') return
  if (request.mode === 'navigate') {
    // The index is the only page; its query (a sign-in token) never selects content.
    if (path !== '' && path !== 'index.html') return
    event.respondWith(respond(event, request, scope.href))
    return
  }
  event.respondWith(respond(event, request, request.url))
})

async function respond(event, request, key) {
  const cache = await caches.open(CACHE)
  const network = fetch(request)
  // The page reads the response while the copy is written, not after.
  event.waitUntil(network.then(async (response) => {
    if (response.ok && response.type === 'basic') await cache.put(key, response.clone())
  }).catch(() => {}))
  const cached = await cache.match(key)
  if (cached === undefined) return network
  // An unreachable Host over a VPN can hang instead of failing, so a cached copy
  // wins after a bounded wait.
  const timeout = new Promise((resolve) => { setTimeout(() => { resolve(cached) }, NETWORK_TIMEOUT_MS) })
  return Promise.race([network.catch(() => cached), timeout])
}
