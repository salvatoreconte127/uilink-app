/* Service worker: dati e grafica sempre aggiornati quando c'è rete, app disponibile anche offline. */
const CACHE = "uilink-v5";
const SHELL = ["./", "index.html", "styles.css?v=5", "app.js?v=5", "manifest.webmanifest",
  "icons/logo-round.png", "icons/apple-touch-icon.png", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // rete prima, senza usare la memoria HTTP del telefono; la copia salvata serve solo offline
  const key = url.pathname.includes("/data/") ? new Request(url.pathname) : e.request;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" }).then((r) => {
      if (r.ok) {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(key, copy));
      }
      return r;
    }).catch(() => caches.match(key).then((m) => m || caches.match(e.request, { ignoreSearch: true })))
  );
});
