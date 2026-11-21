/* =========================================================
   NECKRONE8X WEATHER — SERVICE WORKER
   Strategy:
     - HTML / CSS / JS  → network-first (always get fresh code)
     - API calls        → network-first, last good copy as offline fallback
     - Images / icons   → cache-first (they rarely change)
   Rules that keep it from ever breaking a request:
     - every path ends in a real Response (never "nothing")
     - only good (200 OK) replies are saved, never errors
     - /health always goes straight to the server
     - the network gets a time limit: if it hangs, the saved copy is
       served (marked X-SW-Fallback: 1 so the page can say so)
========================================================= */
const CACHE_NAME = "neckrone8x-weather-v31";

// How long to wait for the network before serving the saved copy.
// Kept under the page's own 20 s fetch timeout.
const API_WAIT_MS = 12000;
const PAGE_WAIT_MS = 8000;
// With nothing saved, keep waiting up to this long, then give up.
const HARD_LIMIT_MS = 25000;

const APP_SHELL = [
    "/",
    "/static/icon-192.png",
    "/static/icon-512.png"
];

const API_PREFIXES = [
    "/weather", "/forecast", "/locations", "/uv", "/air",
    "/reverse", "/my-location", "/local-alerts", "/global-alerts"
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

function offlineJson() {
    return new Response(
        JSON.stringify({ cod: 503, message: "The weather service is waking up. Please try again in a moment." }),
        { status: 503, headers: { "Content-Type": "application/json" } }
    );
}

function offlineHtml() {
    return new Response(OFFLINE_PAGE, {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" }
    });
}

/* Save a copy, but only of a good reply, and never let saving break anything. */
function remember(request, response) {
    if (!response || !response.ok || response.type === "opaque") return;
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

/* ---------- Install ---------- */
self.addEventListener("install", (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_SHELL))
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
    if (url.origin !== self.location.origin) return;

    // Health checks must always reach the real server.
    if (url.pathname === "/health") return;

    // 1) API calls
    if (API_PREFIXES.some(p => url.pathname.startsWith(p))) {
        event.respondWith(networkFirst(request, offlineJson, API_WAIT_MS));
        return;
    }

    // 2) Code and pages (HTML / CSS / JS): network-first so updates show up
    const isPage = request.mode === "navigate" ||
        (request.headers.get("accept") || "").includes("text/html");
    const isCode = /\.(css|js)$/i.test(url.pathname) || url.pathname === "/" || isPage;
    if (isCode) {
        event.respondWith(networkFirst(request, async () => {
            if (isPage) {
                const shell = await fromCache("/");
                return shell || offlineHtml();
            }
            return new Response("", { status: 503 });
        }, PAGE_WAIT_MS));
        return;
    }

    // 3) Static assets (images, icons, fonts): cache-first
    event.respondWith((async () => {
        const cached = await fromCache(request);
        if (cached) return cached;
        try {
            const response = await fetch(request);
            remember(request, response);
            return response;
        } catch (e) {
            return new Response("", { status: 503 });
        }
    })());
});
