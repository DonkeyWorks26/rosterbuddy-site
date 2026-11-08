const CACHE_NAME = "rosterbuddy-v0-2-18";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  // Every script the page loads, so an offline start runs one consistent version.
  "./supabase-config.local.js",
  "./vendor/supabase.js",
  "./supabase-client.js",
  "./cloud-sync-consent.js",
  "./legacy-magic-link.js",
  "./account-session-view.js",
  "./shared-calendar-model.js",
  "./group-sharing.js",
  "./group-sharing-backend.js",
  "./invite-handoff.js",
  "./group-sharing-ui.js"
];

// All of the app's own code is fetched from the network first (the cache is only the offline fallback). Serving some of
// it cache-first let a new app.js run beside the previous release's sharing scripts until a hard reload.
function isAppShellRequest(request) {
  const url = new URL(request.url);
  return request.mode === "navigate" || /\.(html|js|css|json)$/.test(url.pathname);
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
    // One file that cannot be fetched must not stop the whole update from installing.
    caches.open(CACHE_NAME).then((cache) => Promise.all(APP_SHELL.map((file) => cache.add(file).catch(() => null))))
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
  // Never touch another site's requests (the sign-in and sharing servers): caching one could hand a second
  // person on the same browser the first person's sign-in answer.
  if (self.location && new URL(event.request.url).origin !== self.location.origin) return;
  if (isAppShellRequest(event.request)) {
    event.respondWith(networkFirst(event.request));
    return;
  }
  event.respondWith(cacheFirst(event.request));
});
