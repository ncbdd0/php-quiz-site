/* ============================================================
 * sw.js —— PHP 答题站 Service Worker（PWA 离线支持）
 *
 * 策略：
 *   · install  预缓存全部应用壳（含 secure.js 密文，约 0.9MB）
 *   · fetch    导航请求统一回 index.html（支持 ?notes= 离线直达）；
 *              其余同源 GET 走 cache-first，成功响应回填缓存
 *   · activate 清理旧版本缓存
 *
 * 更新数据/代码后：把 SW_VERSION 递增一位即可让所有客户端在
 * 下次联网访问时整体换新（原子替换，不会出现新旧混用）。
 * ============================================================ */
const SW_VERSION = 'phpquiz-v3';
const CACHE_NAME = 'phpquiz-' + SW_VERSION;

/* 预缓存清单（与仓库实际文件一一对应，改动文件名需同步这里） */
const PRECACHE = [
  './',
  'index.html',
  'css/style.css',
  'js/core.js',
  'js/app.js',
  'js/secure.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          if (k !== CACHE_NAME) return caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;   // 只管同源

  /* 页面导航：离线时统一回 index.html（query 参数不影响） */
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(function (resp) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put('index.html', copy); });
          return resp;
        })
        .catch(function () { return caches.match('index.html'); })
    );
    return;
  }

  /* 静态资源：cache-first，后台回填 */
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) {
        fetch(req).then(function (resp) {
          if (resp && resp.status === 200) {
            caches.open(CACHE_NAME).then(function (c) { c.put(req, resp.clone()); });
          }
        }).catch(function () { /* 离线：静默 */ });
        return hit;
      }
      return fetch(req).then(function (resp) {
        if (resp && resp.status === 200) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });
        }
        return resp;
      });
    })
  );
});
