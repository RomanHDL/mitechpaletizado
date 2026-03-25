// Service Worker — NO CACHE
// Solo existe para que la PWA sea instalable.
// Siempre va a la red, nunca sirve cache viejo.
// Esto evita problemas de version congelada en escaneres.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Limpiar cualquier cache viejo
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Siempre red, nunca cache
  event.respondWith(fetch(event.request));
});
