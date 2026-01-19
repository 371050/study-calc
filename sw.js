
const CACHE = 'study-tracker-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png'
  // 512 アイコンを追加したら './icon-512.png'
];

self.addEventListener('install', (e)=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', (e)=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))))
  self.clients.claim();
});
self.addEventListener('fetch', (e)=>{
  const url = new URL(e.request.url);
  // same-origin のみ
  if(url.origin !== location.origin) return;
  // HTML はネット優先
  if(e.request.mode === 'navigate'){
    e.respondWith(
      fetch(e.request).then(r=>{
        const copy = r.clone();
        caches.open(CACHE).then(c=>c.put(e.request, copy));
        return r;
      }).catch(()=>caches.match(e.request).then(r=>r || caches.match('./index.html')))
    );
    return;
  }
  // それ以外はキャッシュ優先→ネット
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res=>{
      const copy = res.clone();
      caches.open(CACHE).then(c=>c.put(e.request, copy));
      return res;
    }))
  );
});
