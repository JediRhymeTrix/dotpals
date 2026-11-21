// dotpals remote client: service worker. Two jobs, both small.
//  1. The app shell works offline-ish: its own files (scripts, styles, icons) are cached, so the app
//     opens instantly and, with no connection, still shows the last thing it knew (the page keeps a
//     copy of the data). Data is never cached here: /events and /api always go to the network.
//  2. Web Push: show the notification the bridge sent (already summarised and redacted on the
//     computer), and open the app when it's tapped.
const VERSION = '__VERSION__';
const SHELL = `dotpals-shell-${VERSION}`;
const SHELL_FILES = [
  '/', '/manifest.webmanifest', '/bridge/remote/remote.css', '/bridge/remote/boot.js', '/bridge/remote/stream.js', '/bridge/remote/client.js',
  '/bridge/remote/settings.js', '/bridge/remote/icons/icon-192.png', '/desktop/icon.png',
];

self.addEventListener('install', (event) => {
  // Cache what we can; a failed file (not signed in yet) must not stop the worker installing.
  event.waitUntil(caches.open(SHELL).then((cache) => Promise.allSettled(SHELL_FILES.map((f) => cache.add(f)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('dotpals-shell-') && key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

const isShell = (url) => url.origin === self.location.origin && (url.pathname === '/' || /^\/(?:src|bridge|desktop)\//.test(url.pathname) || url.pathname === '/manifest.webmanifest');

// Stale-while-revalidate for the app's own files: instant from the cache, refreshed in the background.
// Everything else (data, the live stream, sign-in) goes straight to the network.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!isShell(url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req, { ignoreSearch: url.pathname === '/' });
    const fresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; });
    if (hit) { fresh.catch(() => {}); return hit; }
    try { return await fresh; } catch { return (await cache.match('/')) ?? new Response('Offline', { status: 503 }); }
  })());
});

// -- push ---------------------------------------------------------------------------------------
self.addEventListener('push', (event) => {
  let note = { title: 'dotpals', body: '', tag: 'dotpals', url: '/' };
  try { note = { ...note, ...event.data.json() }; } catch { try { note.body = event.data.text(); } catch {} }
  event.waitUntil((async () => {
    // If the app is open and visible, it already shows this live: don't buzz as well.
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (open.some((c) => c.visibilityState === 'visible') && note.kind !== 'approval') return;
    await self.registration.showNotification(String(note.title).slice(0, 80), {
      body: String(note.body ?? '').slice(0, 200), tag: String(note.tag ?? 'dotpals'), renotify: note.kind === 'approval',
      icon: '/bridge/remote/icons/icon-192.png', badge: '/bridge/remote/icons/icon-96.png', timestamp: Number(note.at) || Date.now(),
      requireInteraction: note.kind === 'approval' || note.kind === 'waiting', data: { url: typeof note.url === 'string' && note.url.startsWith('/') ? note.url : '/' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mine = open.find((c) => new URL(c.url).origin === self.location.origin);
    if (mine) { await mine.focus(); if ('navigate' in mine && target !== mine.url) mine.navigate(target).catch(() => {}); return; }
    await self.clients.openWindow(target);
  })());
});

// The push service rotated our subscription: tell the page (when it next opens) to register again.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(self.clients.matchAll({ includeUncontrolled: true }).then((all) => all.forEach((c) => c.postMessage({ type: 'resubscribe' }))));
});
