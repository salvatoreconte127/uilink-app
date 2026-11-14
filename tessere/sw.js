/* Service worker di Tessere: l'app funziona anche senza rete (alla cassa il segnale spesso manca). */
const CACHE = "tessere-v3";
const SHELL = ["./", "index.html", "styles.css?v=2", "app.js?v=3", "manifest.webmanifest",
  "vendor/zxing-wasm.js?v=3.1.6", "vendor/zxing_full.wasm?v=3.1.6",
  "icons/apple-touch-icon.png", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("tessere-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // il motore dei codici non cambia: prima la copia salvata
  if (url.pathname.includes("/vendor/")) {
    e.respondWith(caches.match(e.request).then((m) => m || fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    })));
    return;
  }
  // il resto: rete prima, copia salvata se offline
  e.respondWith(
    fetch(e.request, { cache: "no-cache" }).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then((m) => m || caches.match(e.request, { ignoreSearch: true })
      .then((m2) => m2 || (e.request.mode === "navigate" ? caches.match("index.html") : undefined))))
  );
});
