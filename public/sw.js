// Minimal service worker: network-first for navigations, with a cached
// app-shell fallback for offline use. Deliberately does NOT intercept
// /api/*, ComfyUI proxy calls, or WebSocket upgrades — generation traffic
// must always hit the network live.
const CACHE_NAME = "cj-shell-v1";
const SHELL_URL = "/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.add(SHELL_URL))
      .catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle top-level page navigations. Everything else (API routes,
  // ComfyUI proxy/websocket traffic, images, static assets) passes through
  // to the network untouched.
  if (request.method !== "GET" || request.mode !== "navigate") {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches
          .open(CACHE_NAME)
          .then((cache) => cache.put(SHELL_URL, copy))
          .catch(() => {});
        return response;
      })
      .catch(() =>
        caches.match(SHELL_URL).then((cached) => cached || Response.error()),
      ),
  );
});
