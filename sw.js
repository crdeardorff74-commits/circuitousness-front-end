// Circuitousness Service Worker
// APP_VERSION must match PAGE_VERSION in index.html — mismatch causes a refresh loop.
// Bump both together on each deploy via /release or /rel.

// Pull PROJECT_SLUG (and the rest of config.js) into the worker scope.
// Per universal rule 1, config.js is the single source of truth for the slug.
// Do NOT add DOM/window references to config.js — it must stay worker-safe.
importScripts('/config.js');

const APP_VERSION = '1.39';
const CACHE_NAME = `${PROJECT_SLUG}-v${APP_VERSION}`;

const CORE_ASSETS = [
    '/',
    '/index.html',
    '/styles.css',
    '/platform-redirect.js',
    '/config.js',
    '/i18n.js',
    '/controls-config.js',
    '/gamepad.js',
    '/touch-controls.js',
    '/maze.js',
    '/maze-worker.js',
    '/render.js',
    '/game.js',
    '/intro.js',
    '/tooltip.js',
    '/tutorial.js',
    '/warnings.txt',
    '/manifest.json',
    '/favicon.svg'
];

// Cross-origin assets to precache at SW install. Currently empty: the 54
// background images are too heavy to precache up-front (multi-MB at SW
// install would block the new worker), and the runtime fetch path + the
// browser's own HTTP cache handle repeats fine. Anything that's small,
// always-needed, and cross-origin should be added here as a string URL —
// they're fetched with `mode: 'no-cors'` (opaque response) and stored
// via cache.put().
const EXTERNAL_ASSETS = [];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        console.log('PWA: Caching core assets for v' + APP_VERSION);
        // Per-asset add so ONE missing file (404, removed asset, etc) doesn't
        // reject the whole precache batch the way cache.addAll() does — that
        // was leaving the entire cache empty when /favicon.ico was missing,
        // breaking offline play for the rest of the assets too.
        await Promise.all(CORE_ASSETS.map(async (url) => {
            try { await cache.add(url); }
            catch (err) { console.log('PWA: Failed to precache core asset', url, err); }
        }));
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

    // Dev bypass: skip the SW cache entirely when running on localhost
    // (any port). The dev server already sends Cache-Control: no-cache
    // headers, so the browser will hit disk on each request and pick up
    // the latest bytes. Without this bypass, iterative edits on localhost
    // require manually clearing the SW + Cache Storage every time —
    // because stale-while-revalidate returns the cached old code FIRST
    // and only updates the cache for the NEXT load, which costs an extra
    // round-trip the dev didn't expect. Production (real domain) still
    // gets the full cache-first behavior below.
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return;

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
