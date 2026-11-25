const CACHE_VERSION = 'v2'
const SHELL_CACHE = `tavernchat-shell-${CACHE_VERSION}`
const STATIC_CACHE = `tavernchat-static-${CACHE_VERSION}`
const KEEP_CACHES = new Set([SHELL_CACHE, STATIC_CACHE])
const STATIC_CACHE_LIMIT = 120

const APP_SHELL_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './app-icon.svg',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
]

const trimCache = async (cache) => {
  const keys = await cache.keys()
  if (keys.length <= STATIC_CACHE_LIMIT) return
  await Promise.all(
    keys.slice(0, keys.length - STATIC_CACHE_LIMIT).map((key) => cache.delete(key))
  )
}

const cachePut = (cacheName, request, response) => {
  void caches
    .open(cacheName)
    .then(async (cache) => {
      await cache.put(request, response)
      if (cacheName === STATIC_CACHE) await trimCache(cache)
    })
    .catch(() => undefined)
}

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL_URLS))
      .catch(() => undefined)
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => !KEEP_CACHES.has(key)).map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // 只缓存同源静态应用壳与资源；绝不拦截 /api 或外部大模型 SSE 接口
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            cachePut(SHELL_CACHE, './index.html', response.clone())
          }
          return response
        })
        .catch(() => caches.match('./index.html').then((cached) => cached ?? Response.error()))
    )
    return
  }

  if (url.pathname.includes('/static/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              cachePut(STATIC_CACHE, request, response.clone())
            }
            return response
          })
      )
    )
    return
  }

  event.respondWith(
    fetch(request).catch(() => caches.match(request).then((cached) => cached ?? Response.error()))
  )
})
