const CACHE_NAME = 'puyo-tsukai-v8';

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Share Target の POST リクエストを処理
    if (event.request.method === 'POST' && (url.pathname.endsWith('/index.html') || url.pathname === '/' || url.pathname.endsWith('/index'))) {
        event.respondWith(
            (async () => {
                const formData = await event.request.formData();
                const image = formData.get('shared_image');
                if (image) {
                    const cache = await caches.open('puyo-share');
                    await cache.put('shared-image', new Response(image));
                    return Response.redirect('./?shared=1', 303);
                }
                return fetch(event.request);
            })()
        );
        return;
    }

    // 静的ファイルのキャッシュとフォールバック
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll([
                './',
                './index.html',
                './css/style.css',
                './js/script.js',
                './js/opencv.js',
                './assets/menu_template.png',
                './assets/next_template.png',
                './assets/pwa-icon.png',
                './manifest.json?v=2'
            ]);
        })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            caches.keys().then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cacheName) => {
                        if (cacheName !== CACHE_NAME && cacheName !== 'puyo-share') {
                            return caches.delete(cacheName);
                        }
                    })
                );
            })
        ])
    );
});
