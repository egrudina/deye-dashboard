// Service worker: network-first for static files with a cache fallback, and Web Push.
// Navigations and /api are not intercepted, so Cloudflare Access login redirects keep working.
const CACHE = "deye-v5";
const ASSETS = [
  "/style.css", "/js/main.js", "/js/api.js", "/js/fmt.js", "/js/dom.js", "/js/svg.js", "/js/graphics.js",
  "/js/push.js", "/js/tabs/now.js", "/js/tabs/plan.js", "/js/tabs/history.js", "/js/tabs/system.js",
  "/icon.svg", "/icon-192.png", "/manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (e.request.mode === "navigate" || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && !res.redirected) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r ?? Response.error())),
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Інвертор", {
    body: d.body || "",
    tag: d.tag,
    renotify: !!d.tag,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: d.url || "/#now" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        if ("navigate" in c) c.navigate(target).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
