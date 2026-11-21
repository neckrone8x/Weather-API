/* =========================================================
   NECKRONE8X WEATHER — SERVICE WORKER
   Strategy:
     - the page (HTML)       → network-first, the saved page shell offline
     - scripts, styles,
       icons, libraries      → cache-first, refreshed in the background, so
                               the app opens with no network at all
     - API calls             → not touched: they go straight to the network.
                               The page keeps its own saved forecasts (per
                               place, in localStorage) and shows them offline.
   Rules that keep it from ever breaking a request:
     - every path ends in a real Response (never "nothing")
     - only good (200 OK) replies are saved, never errors
     - /health always goes straight to the server
   Bump CACHE_NAME with every release that changes a file below, so phones
   fetch the new files at once (the old cache is deleted on activate).
========================================================= */
const CACHE_NAME = "neckrone8x-weather-v34";

// How long to wait for the network before serving the saved page.
const PAGE_WAIT_MS = 8000;
// With nothing saved, keep waiting up to this long, then give up.
const HARD_LIMIT_MS = 25000;

// Saved at install: everything the page needs to open offline. The URLs must
// match the template exactly (including ?v=), so a test checks them.
const APP_SHELL = [
    "/",
    "/manifest.json",
    "/static/style.css?v=2",
    "/static/app.js",
    "/static/earth.js",
    "/static/mkuu-helper.css?v=2",
    "/static/mkuu-weather-context.js?v=2",
    "/static/mkuu-helper.js?v=4",
    "/static/icon-192.png",
    "/static/icon-512.png"
];

// Pinned (versioned, never-changing) libraries from CDNs, cache-first too.
// Analytics and map tiles are left alone.
const LIBRARIES = [
    "https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js",
    "https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
];

// The app's own data: never cached here.
const API_PREFIXES = [
    "/weather", "/weather-full", "/locations", "/uv", "/air", "/reverse", "/my-location",
    "/local-alerts", "/global-alerts", "/feedback", "/health"
];

const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>8X Weather</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;text-align:center;padding:24px}
  button{margin-top:18px;padding:12px 22px;border:0;border-radius:999px;background:#38bdf8;
         color:#06202e;font-weight:700;font-size:15px;cursor:pointer}
  p{color:#94a3b8;max-width:340px;margin:8px auto 0;line-height:1.5}
</style></head><body><div>
<h1 style="margin:0;font-size:22px">8X Weather is waking up</h1>
<p>The weather service is starting or your connection dropped. This usually takes under a minute.</p>
<button onclick="location.reload()">Try again</button>
</div></body></html>`;

function offlineHtml() {
    return new Response(OFFLINE_PAGE, {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" }
    });
}

/* Save a copy, but only of a good reply, and never let saving break anything.
   (An opaque reply is a library loaded without CORS: it can't be checked, so
   only the pinned LIBRARIES may be saved that way.) */
function remember(request, response) {
    if (!response) return;
    const lib = LIBRARIES.includes(request.url || request);
    if (response.type === "opaque" ? !lib : !response.ok) return;
    const copy = response.clone();
    caches.open(CACHE_NAME)
        .then(cache => cache.put(request, copy))
        .catch(() => { /* storage full or blocked: just skip */ });
}

async function fromCache(request) {
    try {
        return await caches.match(request);
    } catch (e) {
        return undefined;
    }
}

/* A saved copy, labelled so the page knows it isn't fresh. */
function markSaved(cached) {
    try {
        const headers = new Headers(cached.headers);
        headers.set("X-SW-Fallback", "1");
        headers.set("X-SW-Saved-At", cached.headers.get("Date") || "");
        return new Response(cached.body, {
            status: cached.status,
            statusText: cached.statusText,
            headers
        });
    } catch (e) {
        return cached;
    }
}

const TIMED_OUT = Symbol("timed out");

function wait(ms) {
    return new Promise(resolve => setTimeout(() => resolve(TIMED_OUT), ms));
}

/* Network first, but never forever:
     - network answers in time        -> that answer (good ones are saved)
     - network fails                  -> the saved copy, else fallback()
     - network hangs past `waitMs`    -> the saved copy if there is one;
       with nothing saved, keep waiting until HARD_LIMIT_MS, then fallback(). */
async function networkFirst(request, fallback, waitMs) {
    const controller = new AbortController();
    // A navigation can't be re-created with options (it would change its
    // mode), so pages are fetched as-is and simply not aborted.
    const network = (request.mode === "navigate"
            ? fetch(request)
            : fetch(request, { signal: controller.signal }))
        .then(response => {
            remember(request, response);
            return response;
        });
    network.catch(() => { /* handled below */ });

    try {
        const first = await Promise.race([network, wait(waitMs)]);
        if (first !== TIMED_OUT) return first;
    } catch (e) {
        const cached = await fromCache(request);
        return cached ? markSaved(cached) : fallback();
    }

    // The network is hanging.
    const cached = await fromCache(request);
    if (cached) {
        controller.abort();
        return markSaved(cached);
    }
    try {
        const late = await Promise.race([network, wait(HARD_LIMIT_MS - waitMs)]);
        if (late !== TIMED_OUT) return late;
    } catch (e) { /* fall through */ }
    controller.abort();
    return fallback();
}

/* ---------- Allow the page to trigger immediate activation ---------- */
self.addEventListener("message", (event) => {
    if (event.data === "SKIP_WAITING") {
        self.skipWaiting();
    }
});

/* Cache-first: the saved copy at once (refreshed in the background for next
   time), else the network (and save it), else an empty 503. */
async function cacheFirst(request, event) {
    const cached = await fromCache(request);
    const network = fetch(request).then(response => {
        remember(request, response);
        return response;
    });
    if (cached) {
        network.catch(() => { /* offline: the saved copy is enough */ });
        if (event && typeof event.waitUntil === "function") {
            event.waitUntil(network.then(() => {}, () => {}));
        }
        return cached;
    }
    try {
        return await network;
    } catch (e) {
        return new Response("", { status: 503 });
    }
}

/* ---------- Install ---------- */
self.addEventListener("install", (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => Promise.all([
                // One by one: a single missing file must not stop the others.
                ...APP_SHELL.map(url => cache.add(url).catch(() => {})),
                ...LIBRARIES.map(url => cache.add(new Request(url, { mode: "cors" })).catch(() => {}))
            ]))
            .catch(err => console.warn("SW install: app shell not cached yet:", err))
    );
});

/* ---------- Activate — drop old caches (including saved error replies) ---------- */
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            ))
            .catch(() => {})
            .then(() => self.clients.claim())
    );
});

/* ---------- Fetch ---------- */
self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;

    let url;
    try { url = new URL(request.url); } catch (e) { return; }

    // Pinned libraries from CDNs: cache-first. Anything else from another
    // site (analytics, map tiles, Mkuu) is left to the browser.
    if (url.origin !== self.location.origin) {
        if (LIBRARIES.includes(url.href)) event.respondWith(cacheFirst(request, event));
        return;
    }

    // 1) API calls and health checks: straight to the network, never saved.
    if (API_PREFIXES.some(p => url.pathname === p || url.pathname.startsWith(p + "/"))) {
        return;
    }

    // 2) The page: network-first so updates show up; the saved shell offline.
    const isPage = request.mode === "navigate" ||
        (request.headers.get("accept") || "").includes("text/html");
    if (isPage || url.pathname === "/") {
        event.respondWith(networkFirst(request, async () => {
            const shell = await fromCache("/");
            return shell || offlineHtml();
        }, PAGE_WAIT_MS));
        return;
    }

    // 3) Scripts, styles, icons, manifest: cache-first.
    event.respondWith(cacheFirst(request, event));
});
