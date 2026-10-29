// Service worker: deja la app disponible offline.
// Subí VERSION en cada despliegue para que los dispositivos tomen los archivos nuevos.
const VERSION = 'gastos-v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.json',
  'guia-atajo.html',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Las llamadas a Apps Script van siempre a la red; la app maneja la cola.
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // Stale-while-revalidate: responde desde caché y actualiza en segundo plano.
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cacheado = await cache.match(e.request, { ignoreSearch: true });
      const red = fetch(e.request)
        .then((r) => { if (r.ok) cache.put(e.request, r.clone()); return r; })
        .catch(() => null);
      if (cacheado) return cacheado;
      const r = await red;
      if (r) return r;
      if (e.request.mode === 'navigate') return cache.match('index.html');
      return Response.error();
    }),
  );
});
