/* Minhas Finanças — Service Worker
   Atualização automática: não é necessário trocar v1/v2 ao alterar o index.html. */

const CACHE_NAME = 'minhas-financas-cache';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icone.jpg'
];

self.addEventListener('install', event => {
  self.skipWaiting();

  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Um arquivo ausente (ex.: ícone ainda não enviado) não impede
    // a instalação do Service Worker.
    await Promise.allSettled(
      APP_SHELL.map(url =>
        fetch(url, { cache: 'reload' })
          .then(response => {
            if (response && response.ok) return cache.put(url, response.clone());
          })
      )
    );
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(key => key !== CACHE_NAME && key.startsWith('minhas-financas'))
        .map(key => caches.delete(key))
    );

    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Não interfere nas APIs externas usadas pelo app.
  if (url.origin !== self.location.origin) return;

  // Páginas/HTML: internet primeiro. Se estiver offline, usa a última
  // versão salva. Assim alterações no index.html aparecem automaticamente.
  if (request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request, { cache: 'no-store' });
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put('./index.html', fresh.clone());
          await cache.put('./', fresh.clone());
        }
        return fresh;
      } catch (error) {
        const cache = await caches.open(CACHE_NAME);
        return (
          await cache.match(request) ||
          await cache.match('./index.html') ||
          await cache.match('./') ||
          Response.error()
        );
      }
    })());
    return;
  }

  // Manifesto e ícone: usa o cache imediatamente e atualiza em segundo plano.
  const isShellAsset = APP_SHELL.some(item => {
    const absolute = new URL(item, self.location.href);
    return absolute.href === url.href;
  });

  if (isShellAsset) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);

      const update = fetch(request, { cache: 'no-store' })
        .then(response => {
          if (response && response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);

      return cached || (await update) || Response.error();
    })());
  }
});
