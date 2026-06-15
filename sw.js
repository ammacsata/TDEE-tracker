const CACHE_NAME = 'nutritracker-v1.20';
const BASE = '/nutritracker/';
const ASSETS = [
  BASE + 'index.html',
  BASE + 'style.css',
  BASE + 'app.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Don't cache API calls or fonts
  if (url.hostname.includes('supabase.co') || url.hostname.includes('anthropic.com') || url.hostname.includes('googleapis.com')) {
    return;
  }
  // For navigation requests (opening the app), serve index.html
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(BASE + 'index.html'))
    );
    return;
  }
  // For other requests, try network first, fall back to cache
  event.respondWith(
    fetch(event.request).then(response => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});
