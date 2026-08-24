/*
 * オフライン動作(REQ-13)のための最小の Service Worker。
 *
 * ビルドでファイル名にハッシュが付くため、固定リストの precache は使わず、
 * 一度取得した同一オリジンの GET をキャッシュしていく方式にしている。
 * 初回はオンラインが要るが、その後は機内モードでも起動する。
 */
const CACHE = "pwa-doc-scan-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(["./", "./index.html", "./manifest.webmanifest", "./icon.svg"]))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const fromNetwork = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      // キャッシュがあれば即返し、裏で更新する
      return cached || fromNetwork;
    }),
  );
});
