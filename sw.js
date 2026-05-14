// Circuitousness Service Worker
// APP_VERSION must match PAGE_VERSION in index.html — mismatch causes a refresh loop.
// Bump both together on each deploy via /release or /rel.

// Pull PROJECT_SLUG (and the rest of config.js) into the worker scope.
// Per universal rule 1, config.js is the single source of truth for the slug.
// Do NOT add DOM/window references to config.js — it must stay worker-safe.
importScripts('/config.js');

const APP_VERSION = '0.19';
const CACHE_NAME = `${PROJECT_SLUG}-v${APP_VERSION}`;

const CORE_ASSETS = [
    '/',
    '/index.html',
    '/styles.css',
    '/config.js',
    '/i18n.js',
    '/controls-config.js',
    '/gamepad.js',
    '/touch-controls.js',
    '/maze.js',
    '/maze-worker.js',
    '/render.js',
    '/game.js',
    '/manifest.json',
    '/favicon.ico'
];

// Cross-origin assets (e.g. images hosted on GitHub Releases). Fetched with
// mode: 'no-cors' so the browser allows the cross-origin response, which
// arrives "opaque" — opaque responses fail cache.addAll's response.ok check,
// so we cache.put() them individually instead.
const EXTERNAL_ASSETS = [BACKGROUND_IMAGE_URL];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        console.log('PWA: Caching core assets for v' + APP_VERSION);
        await cache.addAll(CORE_ASSETS);
        await Promise.all(EXTERNAL_ASSETS.map(async (url) => {
            try {
                const response = await fetch(url, { mode: 'no-cors' });
                await cache.put(url, response);
                console.log('PWA: Precached external asset', url);
            } catch (err) {
                console.log('PWA: Failed to precache external asset', url, err);
            }
        }));
    })());
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((names) =>
            Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => {
                console.log('PWA: Removing old cache:', n);
                return caches.delete(n);
            }))
        ).then(() => self.clients.claim())
         .then(() => self.clients.matchAll({ type: 'window' }).then((clients) => {
            clients.forEach((c) => c.postMessage({ type: 'SW_UPDATED', version: APP_VERSION }));
            console.log('PWA: Notified ' + clients.length + ' client(s) of v' + APP_VERSION);
        }))
    );
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'GET_VERSION') {
        event.source.postMessage({ type: 'SW_VERSION', version: APP_VERSION });
    }
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    if (event.request.method !== 'GET') return;
    if (!url.protocol.startsWith('http')) return;

    // API calls: network only, never cached
    if (url.hostname.includes('onrender.com') || url.pathname.startsWith('/api/')) return;

    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) {
                fetch(event.request).then((response) => {
                    if (response.ok) {
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response));
                    }
                }).catch(() => {});
                return cached;
            }
            return fetch(event.request).then((response) => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            });
        })
    );
});
