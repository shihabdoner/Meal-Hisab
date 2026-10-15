const V = "khaddo-v14";   // v2 release. Rename (khaddo-v7, v8 …) to force everyone onto fresh files
const SHELL = ["./", "index.html", "style.css", "app.js", "firebase-config.js", "manifest.json"];

self.addEventListener("install", e => {
  // add files one by one so a single missing file cannot break the whole install
  e.waitUntil(caches.open(V).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;   // sheet calls, Firebase, fonts pass through
  e.respondWith(caches.open(V).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;                                                       // show cached copy now, refresh in background
  }));
});
