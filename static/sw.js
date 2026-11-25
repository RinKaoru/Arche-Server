// Service worker : app installable (PWA), coquille hors-ligne, notifications push.
const CACHE = "nas-shell-v12";
const SHELL = ["/", "/static/css/app.css?v=12", "/static/js/app.js?v=12", "/static/vendor/lucide.min.js", "/static/icons/icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/") || u.pathname.startsWith("/s/")) return;
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match("/")));
    return;
  }
  if (u.pathname.startsWith("/static/")) {
    // toujours revalider auprès du serveur (304 si inchangé) : jamais un ancien module resté dans le cache du navigateur
    e.respondWith(fetch(e.request, { cache: "no-cache" }).then((r) => { const c = r.clone(); caches.open(CACHE).then((ca) => ca.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
  }
});
self.addEventListener("push", (e) => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: "NAS", body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "NAS", { body: d.body || "", icon: "/static/icons/icon-192.png", badge: "/static/icons/badge.png", data: { link: d.link || "/" } }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const link = e.notification.data?.link || "/";
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((cs) => {
    for (const c of cs) { if ("focus" in c) { c.navigate(link); return c.focus(); } }
    return self.clients.openWindow(link);
  }));
});
