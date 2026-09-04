/* CRM V5 — PWA Service Worker
   策略：同源 GET 请求一律 network-first（在线拿最新，离线回退缓存）。
   所有 Google API / OAuth 域名直接放行，绝不缓存。
   更新方式：改代码后把 CACHE 版本号 +1 即可强制刷新缓存。 */
const CACHE = "crm-v5-pwa-v6";
const PRECACHE = [
  "./",
  "./index.html",
  "./app.js",
  "./mobile.js",
  "./styles.css",
  "./mobile.css",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

// 不拦截、不缓存的域名（认证与数据接口必须直连）
const PASS_THROUGH = [
  "accounts.google.com",
  "oauth2.googleapis.com",
  "sheets.googleapis.com",
  "drive.googleapis.com",
  "www.googleapis.com",
  "cdn.sheetjs.com",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (PASS_THROUGH.some((h) => url.hostname === h)) return;
  if (url.origin !== self.location.origin) return;

  // network-first: 优先取最新，失败（含离线）回退缓存
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: req.mode === "navigate" }).then((hit) => {
          if (hit) return hit;
          if (req.mode === "navigate") return caches.match("./index.html");
          return Response.error();
        })
      )
  );
});
