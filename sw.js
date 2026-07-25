const CACHE_NAME = 'quran-app-v9';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=4',
  './app.js?v=8',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // App shell: cache-first so the app opens instantly and works offline.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
    return;
  }

  // External APIs (Quran text, prayer times, YouTube): always go to network.
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
