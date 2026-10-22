// Makes the app open and work with no internet.
// - The app itself is saved when it is first opened (REQUIRED / OPTIONAL below).
// - Quran words, notes and questions live in /data/ and are saved on the phone too.
// - Saved audio is kept in its own storage by the app and is never deleted here.
const CACHE_NAME = 'quran-app-v20';
const DATA_CACHE = 'quran-data';

// If any of these cannot be saved, the install stops and is tried again later,
// so the app is never saved half-way.
const REQUIRED = [
  './',
  './index.html',
  './styles.css?v=11',
  './app.js?v=18',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
  './icons/icon-32.png'
];
const OPTIONAL = [
  './data/surahs.json?v=1',
  './data/surah-info.json?v=2',
  './data/study-order.json?v=1',
  './data/meanings-index.json?v=1'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(REQUIRED);
    await Promise.all(OPTIONAL.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Remove old copies of the app itself, never the saved Quran words or audio.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('quran-app-v') && k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // Audio and partial (Range) requests are left to the phone. Going through the
  // service worker can break playback in Safari.
  if (req.destination === 'audio' || req.destination === 'video' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // other websites are left alone

  if (req.mode === 'navigate') {
    event.respondWith(openApp(req));
  } else {
    event.respondWith(getFile(req, url));
  }
});

// Opening the app (also from the home-screen icon, even with ?something after the address).
async function openApp(req) {
  const saved = (await caches.match(req, { ignoreSearch: true }))
    || (await caches.match('./index.html'))
    || (await caches.match('./'));
  if (saved) return saved;
  try {
    return await fetch(req);
  } catch (e) {
    return new Response(
      '<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:24px;background:#0f1720;color:#eaf1f7">' +
      '<h2>No internet</h2><p>Open LP Quran once with internet. After that it works anywhere.</p></body>',
      { status: 503, headers: { 'Content-Type': 'text/html' } }
    );
  }
}

// Any other file: use the saved copy, or get it and save it for next time.
async function getFile(req, url) {
  const saved = await caches.match(req);
  if (saved) return saved;
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      const name = url.pathname.includes('/data/') ? DATA_CACHE : CACHE_NAME;
      caches.open(name).then((c) => c.put(req, copy));
    }
    return res;
  } catch (e) {
    const near = await caches.match(req, { ignoreSearch: true });
    return near || Response.error();
  }
}
