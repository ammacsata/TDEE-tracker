const BASE = '/nutritracker/';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.hostname.includes('supabase.co') || url.hostname.includes('anthropic.com') || url.hostname.includes('googleapis.com')) {
    return;
  }
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request, {cache: 'no-cache'}).catch(() => caches.match(BASE + 'index.html'))
    );
    return;
  }
  // Force revalidation with server to avoid stale HTTP cache
  event.respondWith(
    fetch(event.request, {cache: 'no-cache'}).then(response => {
      if (response.ok) {
        const clone = response.clone();
        caches.open('nutritracker').then(cache => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});
