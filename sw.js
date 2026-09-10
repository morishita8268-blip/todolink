/* ToDoリンク — 自己解除用のサービスワーカー
 *
 * 以前はここでオフライン用のキャッシュを持っていたが、
 * 古い app.js を返し続けてアプリが起動できなくなる事故を起こしたため廃止した。
 * すでにこのワーカーが入っている端末から確実に外れるよう、
 * 何も横取りせず、自分自身を登録解除するだけの中身にしてある。
 */

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.registration.unregister(); })
      .then(function () { return self.clients.matchAll({ type: 'window' }); })
      .then(function (cs) { cs.forEach(function (c) { c.navigate(c.url); }); })
      .catch(function () {})
  );
});

/* fetch は一切横取りしない（ここが事故の元だった） */
