const CACHE_NAME = 'quran-app-v17';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=8',
  './app.js?v=15',
  './data/surah-info.json?v=2',
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
      // Only remove old copies of the app itself, never the saved surahs and audio.
      Promise.all(keys.filter((k) => k.startsWith('quran-app-v') && k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Let the phone handle audio and partial (Range) requests itself. Going through
  // the service worker can break playback in Safari.
  if (event.request.destination === 'audio' || event.request.destination === 'video' || event.request.headers.has('range')) return;

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
