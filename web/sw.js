/**
 * sh-agent service worker
 *
 * Exists for one reason: Chrome will only offer "install as app" on a page
 * that has one. It is not a caching layer for freshness — app.js/styles.css
 * already carry a commit-hash query from the deploy workflow, which is what
 * actually keeps a phone from running stale code after a push.
 *
 * Strategy is network-first, same-origin only: try the network, cache what
 * comes back, and fall back to that cache only when the network fails
 * outright (offline, PC asleep). It can never make staleness worse than not
 * having a service worker at all, and it never touches the tunnel — those
 * requests are cross-origin and skipped before any caching logic runs, so a
 * chat message is never served from a stale cache and never accidentally
 * cached.
 */

const CACHE = 'sh-agent-shell-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return; // never touch the relay/tunnel

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
