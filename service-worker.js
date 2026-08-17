const CACHE_NAME = 'minhas-financas-auto';
const CACHE_PREFIX = 'minhas-financas-';

const OFFLINE_FILES = [
  './index.html',
  './manifest.json',
  './icone.png',
  './auth-guard-v3.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const arquivo of OFFLINE_FILES) {
      try {
        const resposta = await fetch(new Request(arquivo, { cache: 'reload' }));
        if (resposta.ok) await cache.put(arquivo, resposta);
      } catch (e) {}
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(
      nomes
        .filter(nome => nome.startsWith(CACHE_PREFIX) && nome !== CACHE_NAME)
        .map(nome => caches.delete(nome))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const resposta = await fetch(request, { cache: 'no-store' });
        if (resposta && resposta.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put('./index.html', resposta.clone());
        }
        return resposta;
      } catch (e) {
        const salvo = await caches.match('./index.html');
        return salvo || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const resposta = await fetch(request, { cache: 'no-cache' });
      if (resposta && resposta.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, resposta.clone());
      }
      return resposta;
    } catch (e) {
      const salvo = await caches.match(request);
      return salvo || Response.error();
    }
  })());
});
