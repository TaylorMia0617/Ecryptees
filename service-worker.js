'use strict';

const CACHE_NAME = 'ecryptees-app-v5';
const APP_SHELL = [
    './',
    './index.html',
    './manifest.webmanifest',
    './css/styles.css',
    './assets/background.jpg',
    './assets/icon-192.png',
    './assets/icon-512.png',
    './js/core.js',
    './js/comic-core.js',
    './js/history-core.js',
    './js/app.js',
    './js/comic-worker.js',
    './js/comic-app.js',
    './js/pwa.js',
    './js/android-bridge.js'
];

const APP_URLS = new Set(APP_SHELL.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(names => Promise.all(
                names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    const indexUrl = new URL('./index.html', self.registration.scope).href;
    const isNavigation = request.mode === 'navigate' && url.origin === self.location.origin;
    if (!isNavigation && !APP_URLS.has(url.href)) return;

    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
            const response = await fetch(request);
            if (response.ok) await cache.put(isNavigation ? indexUrl : request, response.clone());
            return response;
        } catch (error) {
            const cached = await cache.match(isNavigation ? indexUrl : request, { ignoreSearch: true });
            if (cached) return cached;
            throw error;
        }
    })());
});
