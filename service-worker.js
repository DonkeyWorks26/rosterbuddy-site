const CACHE_NAME = "rosterbuddy-v0-2-1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

function isAppShellRequest(request) {
  const url = new URL(request.url);
  return request.mode === "navigate" || /\/(index\.html|app\.js|styles\.css|manifest\.json|service-worker\.js)$/.test(url.pathname);
}

function networkFirst(request) {
  return fetch(request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
    return response;
  }).catch(() => caches.match(request).then((cached) => cached || caches.match("./index.html")));
}

function cacheFirst(request) {
  return caches.match(request).then((cached) => {
    if (cached !== undefined) return cached;
    return fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      return response;
    }).catch(() => caches.match("./index.html"));
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => (key.startsWith("shiftmate-") || key.startsWith("rosterbuddy-")) && key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (isAppShellRequest(event.request)) {
    event.respondWith(networkFirst(event.request));
    return;
  }
  event.respondWith(cacheFirst(event.request));
});
