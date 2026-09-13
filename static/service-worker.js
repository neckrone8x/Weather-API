/* =========================================================
   NECKRONE8X WEATHER — SERVICE WORKER
========================================================= */
const CACHE_NAME = "neckrone8x-weather-v11";

const APP_SHELL = [
    "/",
    "/static/icon-192.png",
    "/static/icon-512.png"
];

/* Allow the page to trigger an immediate activation */
self.addEventListener("message", (event) => {
    if (event.data === "SKIP_WAITING") {
        self.skipWaiting();
    }
});

/* ---------- Install ---------- */
self.addEventListener("install", (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_SHELL))
            .catch(err => console.warn("SW install failed:", err))
    );
});

/* ---------- Activate ---------- */
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME)
                    .map(k => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

/* ---------- Fetch ---------- */
self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    if (event.request.method !== "GET") return;
    if (url.origin !== self.location.origin) return;

    // API calls: network-first, then cache, then safe fallback
    if (
        url.pathname.startsWith("/weather") ||
        url.pathname.startsWith("/forecast") ||
        url.pathname.startsWith("/locations") ||
        url.pathname.startsWith("/uv") ||
        url.pathname.startsWith("/air") ||
        url.pathname.startsWith("/reverse") ||
        url.pathname.startsWith("/my-location")
    ) {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
                    return response;
                })
                .catch(() =>
                    caches.match(event.request).then(cached => {
                        if (cached) return cached;
                        return new Response(
                            JSON.stringify({ cod: 503, message: "Offline" }),
                            {
                                status: 503,
                                headers: { "Content-Type": "application/json" }
                            }
                        );
                    })
                )
        );
        return;
    }

    // Shell / static files: cache-first, fall back to network, then app shell
    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;
            return fetch(event.request)
                .then(response => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
                    return response;
                })
                .catch(() =>
                    caches.match("/").then(fallback =>
                        fallback || new Response("", { status: 503 })
                    )
                );
        })
    );
});