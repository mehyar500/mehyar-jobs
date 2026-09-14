// mehyar.jobs service worker — app-shell caching for installability + resilience.
//
// Strategy:
//   - Navigations (HTML): network-first, fall back to cache, then offline page.
//   - Static assets (JS/CSS/images/fonts under /assets/ or with hash): cache-first.
//   - API calls (/api/*): network-only, never cached.
// Version the cache name to invalidate on deploy.

const CACHE = "mehyar-jobs-v1";
// Fall back to the cached app shell ("/" always 200s; /offline.html gets
// a Pages 308, so it can't be a reliable cache key).
const OFFLINE_URL = "/";

const PRECACHE = [
  "/",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/favicon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/assets/") ||
    /\.(js|css|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf)$/i.test(url.pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API: never cache.
  if (url.pathname.startsWith("/api/")) return;

  // Static assets: cache-first.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((hit) => {
        if (hit) return hit;
        return fetch(request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return res;
        });
      })
    );
    return;
  }

  // Navigations + everything else: network-first, cache fallback, offline page.
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return res;
      })
      .catch(() =>
        caches.match(request).then((hit) => hit || caches.match(OFFLINE_URL))
      )
  );
});
