"""
8X Weather (Neckrone8x Weather) — Flask backend.

Upstreams:
  - OpenWeatherMap: current weather, 3-hourly 5-day forecast, geocoding, air pollution
  - Open-Meteo (free, no key): UV index + 16-day daily forecast
  - Nominatim: reverse geocoding        - ipapi.co: IP location
  - GDACS / NWS / USGS: alerts          - SendGrid: feedback email

Every outside call goes through upstream(), which always ends within a hard
deadline (DNS and slow-trickling replies included), so no request can hang.
"""
import contextvars
import ipaddress
import json
import logging
import os
import signal
import sys
import threading
import time
import traceback
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from datetime import datetime, timedelta, timezone

import requests
from dotenv import load_dotenv
from flask import Flask, g, jsonify, render_template, request, send_from_directory
from requests.adapters import HTTPAdapter
from urllib3.exceptions import HTTPError as Urllib3Error, TimeoutError as Urllib3Timeout
from urllib3.util.retry import Retry

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("weather")

app = Flask(__name__)

API_KEY = os.getenv("OPENWEATHER_API_KEY")
if not API_KEY:
    raise RuntimeError(
        "OPENWEATHER_API_KEY is not set. Create a .env file with OPENWEATHER_API_KEY=your_api_key"
    )

OWM_BASE = "https://api.openweathermap.org"
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
SENDGRID_URL = "https://api.sendgrid.com/v3/mail/send"
USER_AGENT = "Neckrone8xWeather/2.0 (contact@neckrone8x.co.ke)"
DEFAULT_CITY = "Kisumu"

# Time limits (seconds).
CONNECT_TIMEOUT = 3
READ_TIMEOUT = 6
UPSTREAM_TIMEOUT = (CONNECT_TIMEOUT, READ_TIMEOUT)
UPSTREAM_TOTAL = 10         # hard cap for one outside call: DNS, connect, slow replies, retry
REQUEST_BUDGET = 15         # the most one of our endpoints may spend on outside calls
OPEN_METEO_WAIT = 6         # UV + 16-day outlook are extras: never wait long
OPEN_METEO_COOLDOWN = 60    # after a 429 or failure, skip Open-Meteo for 60 s
KEY_LOG_INTERVAL = 60       # log "OWM rejected the API key" at most once per minute
RETRY_PAUSE = 0.3
RETRY_MIN_LEFT = 2          # only retry if at least this much time is left
MAX_UPSTREAM_BODY = 5 * 1024 * 1024
SLOW_REQUEST_LOG = 3        # log any request slower than this
STUCK_REQUEST_LIMIT = 40    # watchdog: a request this old means a stuck thread
WATCHDOG_INTERVAL = 5

# Cache lifetimes (seconds)
TTL_WEATHER = 600         # current weather + forecast
TTL_OPEN_METEO = 1800     # UV + daily outlook
TTL_GEOCODE = 86400       # city -> coordinates barely ever changes
TTL_REVERSE = 86400
TTL_AIR = 1800
TTL_IP = 21600
TTL_ALERTS = 900
TTL_STALE = 7 * 86400     # last good copy, served only when the live call can't be made


# =================================
# THREAD-SAFE TTL + LRU CACHE
# (bounded, so memory can't grow forever on a long-running server)
# =================================
class TTLCache:
    def __init__(self, max_items=2000):
        self._data = OrderedDict()
        self._lock = threading.Lock()
        self._max = max_items

    def get(self, key):
        with self._lock:
            entry = self._data.get(key)
            if entry is None:
                return None
            expires, value = entry
            if time.time() > expires:
                del self._data[key]
                return None
            self._data.move_to_end(key)
            return value

    def set(self, key, value, ttl):
        with self._lock:
            self._data[key] = (time.time() + ttl, value)
            self._data.move_to_end(key)
            while len(self._data) > self._max:
                self._data.popitem(last=False)

    def clear(self):
        with self._lock:
            self._data.clear()


cache = TTLCache(max_items=4000)   # room for fresh entries + their "stale:" copies


# =================================
# HTTP SESSION (connection pooling; retries are done by upstream())
# =================================
def _make_session():
    s = requests.Session()
    # No retries at this level: upstream() retries once itself, and only
    # while the deadline allows it. A slow READ is never retried.
    retry = Retry(total=0, connect=0, read=0, status=0, raise_on_status=False)
    adapter = HTTPAdapter(max_retries=retry, pool_connections=20, pool_maxsize=40)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    s.headers.update({"User-Agent": USER_AGENT})
    return s


http = _make_session()

# Two pools so they can never wait on each other:
#   task_pool     runs an endpoint's parallel jobs (current + forecast + extras)
#   upstream_pool runs the actual network calls, so the caller can stop
#                 waiting at the deadline even if DNS or a socket is stuck.
task_pool = ThreadPoolExecutor(max_workers=24, thread_name_prefix="task")
upstream_pool = ThreadPoolExecutor(max_workers=48, thread_name_prefix="upstream")

# Per-request state that follows the work into the pools.
_deadline_var = contextvars.ContextVar("request_deadline", default=None)
_trace_var = contextvars.ContextVar("upstream_trace", default=None)
_stale_var = contextvars.ContextVar("stale_saved_at", default=None)


def _mark_stale(saved_at):
    """This request is answering with a saved copy fetched at `saved_at`."""
    marks = _stale_var.get()
    if marks is not None:
        marks.append(saved_at)


def submit(fn, *args):
    """task_pool.submit, carrying this request's deadline and trace along."""
    ctx = contextvars.copy_context()
    return task_pool.submit(ctx.run, fn, *args)


def time_left(grace=0.5):
    """Seconds left in this request's budget (plus a little grace)."""
    deadline = _deadline_var.get()
    if deadline is None:
        return REQUEST_BUDGET
    return max(0.1, deadline - time.monotonic() + grace)


# =================================
# ERRORS
# Never put str(exception) or a URL in a response or a log line: the URL
# contains ?appid=<your API key>.
# =================================
class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class UpstreamError(Exception):
    """An outside call that failed or ran out of time.
    kind: "timeout", "connection", "invalid" or "too_large"."""

    def __init__(self, provider, kind):
        super().__init__(f"{provider}: {kind}")
        self.provider = provider
        self.kind = kind


class WeatherUnavailable(ApiError):
    """OpenWeatherMap refused our key (401/403) and nothing is saved."""

    def __init__(self):
        super().__init__(503, "Weather is temporarily unavailable, please try again later")


@app.errorhandler(ApiError)
def handle_api_error(err):
    if isinstance(err, WeatherUnavailable):
        return jsonify({"error": "weather_unavailable", "cod": 503,
                        "message": err.message}), 503
    return jsonify({"cod": err.status, "message": err.message}), err.status


@app.errorhandler(UpstreamError)
def handle_upstream_error(err):
    # Safety net: endpoints normally turn these into their own messages.
    if err.kind == "timeout":
        return jsonify({"cod": 504, "message": "An outside service timed out"}), 504
    return jsonify({"cod": 502, "message": "An outside service failed"}), 502


def wait_for(future, timeout, message="Weather service timed out"):
    """A future's result, but never after `timeout` seconds."""
    try:
        return future.result(timeout=max(0.1, timeout))
    except FutureTimeout:
        future.cancel()
        raise ApiError(504, message)


# =================================
# THE ONE WAY TO CALL AN OUTSIDE SERVICE
# =================================
class Reply:
    """A finished upstream reply: status code + the whole body."""
    __slots__ = ("provider", "status", "body")

    def __init__(self, provider, status, body):
        self.provider = provider
        self.status = status
        self.body = body

    @property
    def ok(self):
        return 200 <= self.status < 300

    def json(self):
        try:
            return json.loads(self.body) if self.body else None
        except ValueError:
            raise UpstreamError(self.provider, "invalid") from None


def _read_body(provider, resp, deadline):
    """Read the body piece by piece, giving up at the deadline. A server that
    sends one byte every few seconds can't hold us past it."""
    raw = getattr(resp, "raw", None)
    read1 = getattr(raw, "read1", None)
    if callable(read1):
        pieces = iter(lambda: read1(65536, decode_content=True), b"")
    else:
        pieces = resp.iter_content(65536)

    parts, size = [], 0
    for piece in pieces:
        if not piece:
            continue
        size += len(piece)
        if size > MAX_UPSTREAM_BODY:
            raise UpstreamError(provider, "too_large")
        parts.append(piece)
        if time.monotonic() > deadline:
            raise UpstreamError(provider, "timeout")
    return b"".join(parts)


def _attempt(provider, method, url, params, headers, json_body, deadline):
    """One network attempt. Runs in upstream_pool."""
    left = deadline - time.monotonic()
    if left <= 0:
        raise UpstreamError(provider, "timeout")
    kwargs = {
        "params": params,
        "headers": headers,
        "timeout": (min(CONNECT_TIMEOUT, left), min(READ_TIMEOUT, left)),
        "stream": True,
    }
    if json_body is not None:
        kwargs["json"] = json_body
    send = http.get if method == "GET" else http.post

    try:
        resp = send(url, **kwargs)
    except requests.exceptions.Timeout:
        raise UpstreamError(provider, "timeout") from None
    except requests.exceptions.RequestException:
        raise UpstreamError(provider, "connection") from None

    finished = False
    try:
        body = _read_body(provider, resp, deadline)
        finished = True
        return Reply(provider, resp.status_code, body)
    except (requests.exceptions.Timeout, Urllib3Timeout, TimeoutError):
        raise UpstreamError(provider, "timeout") from None
    except (requests.exceptions.RequestException, Urllib3Error, OSError):
        raise UpstreamError(provider, "connection") from None
    finally:
        raw = getattr(resp, "raw", None)
        if finished and hasattr(raw, "release_conn"):
            raw.release_conn()          # fully read: keep the connection for reuse
        elif hasattr(resp, "close"):
            resp.close()                # cut off: drop the connection


def _attempt_with_deadline(provider, method, url, params, headers, json_body, deadline):
    future = upstream_pool.submit(_attempt, provider, method, url, params, headers,
                                  json_body, deadline)
    try:
        return future.result(timeout=max(0.05, deadline - time.monotonic()))
    except FutureTimeout:
        # Covers what socket timeouts can't: DNS lookups, a full pool, etc.
        # The worker thread finishes by itself shortly after (read timeout).
        future.cancel()
        raise UpstreamError(provider, "timeout") from None


def _record(provider, seconds, outcome):
    trace = _trace_var.get()
    if trace is not None:
        trace.append((provider, round(seconds, 1), outcome))


def upstream(provider, url, *, method="GET", params=None, headers=None, json_body=None,
             total=None, retry=None):
    """Call an outside service. Always returns a Reply or raises UpstreamError
    within `total` seconds (default UPSTREAM_TOTAL), and never after the
    current request's budget runs out.

    Retries once, only for GET, only on a refused/reset connection or a
    502/503/504 reply, and only if enough time is left. Never retries a timeout.
    """
    start = time.monotonic()
    deadline = start + (UPSTREAM_TOTAL if total is None else total)
    request_deadline = _deadline_var.get()
    if request_deadline is not None:
        deadline = min(deadline, request_deadline)
    if retry is None:
        retry = method == "GET"
    attempts = 2 if retry else 1

    outcome = "error"
    try:
        for attempt in range(attempts):
            can_retry = attempt + 1 < attempts and deadline - time.monotonic() >= RETRY_MIN_LEFT
            try:
                reply = _attempt_with_deadline(provider, method, url, params, headers,
                                               json_body, deadline)
            except UpstreamError as e:
                outcome = e.kind
                if e.kind == "connection" and can_retry:
                    time.sleep(RETRY_PAUSE)
                    continue
                raise
            outcome = str(reply.status)
            if reply.status in (502, 503, 504) and can_retry:
                time.sleep(RETRY_PAUSE)
                continue
            return reply
    finally:
        _record(provider, time.monotonic() - start, outcome)


_key_log_lock = threading.Lock()
_key_log_last = None


def _log_key_rejected(status, path):
    """One error line per minute, not one per request, while the key is bad."""
    global _key_log_last
    now = time.monotonic()
    with _key_log_lock:
        if _key_log_last is not None and now - _key_log_last < KEY_LOG_INTERVAL:
            return
        _key_log_last = now
    log.error("OWM rejected the API key (%s) on %s — check OPENWEATHER_API_KEY", status, path)


def owm_get(path, params, cache_key=None, ttl=TTL_WEATHER, units=True, transform=None):
    """GET from OpenWeatherMap, cached under `cache_key`. `transform(data)`
    runs once on fresh data before it is cached. Every good reply is also kept
    as "stale:<key>", which is served if OWM later rejects our key."""
    if cache_key:
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

    query = dict(params, appid=API_KEY)
    if units:
        query["units"] = "metric"

    try:
        r = upstream("openweathermap", OWM_BASE + path, params=query)
    except UpstreamError as e:
        log.warning("OWM %s on %s", e.kind, path)
        if e.kind == "timeout":
            raise ApiError(504, "Weather service timed out")
        raise ApiError(503, "Weather service unavailable")

    if r.status in (401, 403):
        _log_key_rejected(r.status, path)
        saved = cache.get(f"stale:{cache_key}") if cache_key else None
        if saved is not None:
            saved_at, data = saved
            _mark_stale(saved_at)
            return data
        raise WeatherUnavailable()
    if r.status == 404:
        raise ApiError(404, "Location not found")
    if r.status == 429:
        log.warning("OWM rate limit hit on %s", path)
        raise ApiError(503, "Weather service is busy, please try again shortly")
    if not r.ok:
        log.warning("OWM %s returned %s", path, r.status)
        raise ApiError(502, "Weather service error")

    try:
        data = r.json()
    except UpstreamError:
        raise ApiError(502, "Weather service returned an invalid response")

    if transform is not None:
        data = transform(data)
    if cache_key:
        cache.set(cache_key, data, ttl)
        cache.set(f"stale:{cache_key}", (time.time(), data), TTL_STALE)
    return data


# =================================
# REQUEST CLOCK: budget, slow-request log, stuck-request watchdog
# =================================
_inflight = {}                  # thread id -> (start time, path)
_inflight_lock = threading.Lock()
_watchdog_started = False
_watchdog_fired = False


@app.before_request
def _start_request_clock():
    now = time.monotonic()
    g._t0 = now
    g._ctx_tokens = (_deadline_var.set(now + REQUEST_BUDGET), _trace_var.set([]),
                     _stale_var.set([]))
    with _inflight_lock:
        _inflight[threading.get_ident()] = (now, request.path)
    _ensure_watchdog()


@app.teardown_request
def _finish_request(exc):
    with _inflight_lock:
        _inflight.pop(threading.get_ident(), None)
    t0 = g.pop("_t0", None)
    trace = _trace_var.get() or []
    if t0 is not None:
        seconds = time.monotonic() - t0
        if seconds >= SLOW_REQUEST_LOG:
            calls = ", ".join(f"{p} {s}s {o}" for p, s, o in trace) or "none"
            log.warning("SLOW request %s took %.1fs (upstream: %s)", request.path, seconds, calls)
    tokens = g.pop("_ctx_tokens", None)
    if tokens:
        for var, token in zip((_deadline_var, _trace_var, _stale_var), tokens):
            try:
                var.reset(token)
            except (ValueError, RuntimeError):
                pass


def _ensure_watchdog():
    """Start the watchdog once per gunicorn worker (after the fork)."""
    global _watchdog_started
    if _watchdog_started or "gunicorn" not in sys.modules:
        return
    with _inflight_lock:
        if _watchdog_started:
            return
        _watchdog_started = True
    threading.Thread(target=_watchdog_loop, name="watchdog", daemon=True).start()


def _watchdog_tick(now=None):
    """If any request has run longer than STUCK_REQUEST_LIMIT, log where it is
    stuck and ask gunicorn to replace this worker. Returns True if it fired.

    gthread's --timeout only checks the worker's main loop, never a request
    thread, so without this a stuck thread would hold its slot forever.
    SIGTERM = graceful restart: other requests get graceful_timeout to finish,
    and gunicorn's arbiter kills the worker outright if it still won't exit."""
    global _watchdog_fired
    if _watchdog_fired:
        return False
    now = time.monotonic() if now is None else now
    with _inflight_lock:
        stuck = [(ident, t0, path) for ident, (t0, path) in _inflight.items()
                 if now - t0 > STUCK_REQUEST_LIMIT]
    if not stuck:
        return False
    frames = sys._current_frames()
    for ident, t0, path in stuck:
        frame = frames.get(ident)
        stack = "".join(traceback.format_stack(frame)) if frame else "(no stack)\n"
        log.error("STUCK request %s running %.0fs — restarting this worker. Stack:\n%s",
                  path, now - t0, stack)
    _watchdog_fired = True
    os.kill(os.getpid(), signal.SIGTERM)
    return True


def _watchdog_loop():
    while not _watchdog_fired:
        time.sleep(WATCHDOG_INTERVAL)
        try:
            _watchdog_tick()
        except Exception:
            log.exception("watchdog error")


# =================================
# INPUT HELPERS
# =================================
def parse_coords(lat, lon):
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        raise ApiError(400, "Invalid coordinates")
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ApiError(400, "Coordinates out of range")
    return lat, lon


def require_coords():
    lat, lon = request.args.get("lat"), request.args.get("lon")
    if not lat or not lon:
        raise ApiError(400, "lat and lon required")
    return parse_coords(lat, lon)


def coord_key(lat, lon):
    """~1 km precision, so nearby requests share cache entries."""
    return f"{round(lat, 2):.2f},{round(lon, 2):.2f}"


def client_ip():
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or ""


def is_public_ip(ip):
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (addr.is_private or addr.is_loopback or addr.is_reserved
                or addr.is_link_local or addr.is_multicast)


# =================================
# GEOCODING
# =================================
COUNTRY_CODES = {
    "kenya": "KE", "angola": "AO", "uganda": "UG", "tanzania": "TZ", "rwanda": "RW",
    "burundi": "BI", "ethiopia": "ET", "somalia": "SO", "south africa": "ZA",
    "nigeria": "NG", "ghana": "GH", "united states": "US", "usa": "US",
    "united kingdom": "GB", "uk": "GB", "japan": "JP", "china": "CN", "india": "IN",
    "brazil": "BR", "mozambique": "MZ", "south sudan": "SS", "sudan": "SD",
    "egypt": "EG", "morocco": "MA", "zambia": "ZM", "zimbabwe": "ZW",
    "malawi": "MW", "drc": "CD", "congo": "CG", "germany": "DE", "france": "FR",
    "canada": "CA", "australia": "AU", "uae": "AE",
}


def geocode(city):
    city = (city or "").strip()[:100]
    if not city:
        return []

    parts = [p.strip() for p in city.split(",") if p.strip()]
    if len(parts) >= 2:
        country = COUNTRY_CODES.get(parts[-1].lower(), parts[-1].upper())
        query = f"{parts[0]},{country}"
    else:
        query = city

    return owm_get(
        "/geo/1.0/direct",
        {"q": query, "limit": 5},
        cache_key=f"geo:{query.lower()}",
        ttl=TTL_GEOCODE,
        units=False,
    ) or []


def resolve_location():
    """Return (lat, lon, searched_location dict or None) from ?lat&lon or ?city."""
    lat, lon = request.args.get("lat"), request.args.get("lon")
    if lat and lon:
        lat, lon = parse_coords(lat, lon)
        return lat, lon, None

    city = request.args.get("city") or DEFAULT_CITY
    results = geocode(city)
    if not results:
        raise ApiError(404, "City not found")
    loc = results[0]
    searched = {
        "name": loc.get("name", city),
        "state": loc.get("state", ""),
        "country": loc.get("country", ""),
    }
    return float(loc["lat"]), float(loc["lon"]), searched


# =================================
# WEATHER DATA FETCHERS
# =================================
def get_current(lat, lon):
    return owm_get("/data/2.5/weather", {"lat": lat, "lon": lon},
                   cache_key=f"cur:{coord_key(lat, lon)}")


def _add_local_times(data):
    """OWM's dt_txt is UTC. Add a local-time version so the frontend groups
    days by the location's calendar day, not by UTC midnight."""
    tz = int(data.get("city", {}).get("timezone", 0) or 0)
    for item in data.get("list", []):
        dt = item.get("dt")
        if dt is not None:
            item["dt_txt_local"] = datetime.fromtimestamp(
                int(dt) + tz, tz=timezone.utc
            ).strftime("%Y-%m-%d %H:%M:%S")
    data["timezone"] = tz
    return data


def get_forecast(lat, lon):
    return owm_get("/data/2.5/forecast", {"lat": lat, "lon": lon},
                   cache_key=f"fc:{coord_key(lat, lon)}", transform=_add_local_times)


# WMO weather code (Open-Meteo) -> (OWM condition id, OWM icon, description)
# so the existing frontend icon/condition helpers work unchanged.
WMO_TO_OWM = {
    0: (800, "01d", "clear sky"),
    1: (801, "02d", "mainly clear"),
    2: (802, "03d", "partly cloudy"),
    3: (804, "04d", "overcast"),
    45: (741, "50d", "fog"), 48: (741, "50d", "depositing rime fog"),
    51: (300, "09d", "light drizzle"), 53: (301, "09d", "drizzle"),
    55: (302, "09d", "dense drizzle"),
    56: (511, "13d", "freezing drizzle"), 57: (511, "13d", "freezing drizzle"),
    61: (500, "10d", "light rain"), 63: (501, "10d", "moderate rain"),
    65: (502, "10d", "heavy rain"),
    66: (511, "13d", "freezing rain"), 67: (511, "13d", "freezing rain"),
    71: (600, "13d", "light snow"), 73: (601, "13d", "snow"),
    75: (602, "13d", "heavy snow"), 77: (600, "13d", "snow grains"),
    80: (520, "09d", "light showers"), 81: (521, "09d", "showers"),
    82: (522, "09d", "violent showers"),
    85: (620, "13d", "snow showers"), 86: (622, "13d", "heavy snow showers"),
    95: (211, "11d", "thunderstorm"),
    96: (201, "11d", "thunderstorm with hail"),
    99: (202, "11d", "thunderstorm with heavy hail"),
}


def _at(arr, i):
    return arr[i] if arr and i < len(arr) else None


def _last_open_meteo(key):
    """The last good Open-Meteo result for this place, however old, or None."""
    saved = cache.get(f"stale:{key}")
    if saved is None:
        return None
    saved_at, result = saved
    return dict(result, stale=True, saved_at=int(saved_at))


def get_open_meteo(lat, lon):
    """UV index (now + today's max) and a 16-day daily outlook, cached 30 min
    per ~1 km cell. After a 429 or failure Open-Meteo is left alone for 60 s;
    meanwhile the last good result is served (marked stale), else None."""
    key = f"om:{coord_key(lat, lon)}"
    cached = cache.get(key)
    if cached is not None:
        return cached
    if cache.get("om:down"):   # it failed a moment ago: don't call it again yet
        return _last_open_meteo(key)

    try:
        r = upstream("open-meteo", OPEN_METEO_URL, params={
            "latitude": round(lat, 4),
            "longitude": round(lon, 4),
            "current": "uv_index",
            "hourly": "uv_index",
            "daily": ",".join([
                "weather_code", "temperature_2m_max", "temperature_2m_min",
                "precipitation_probability_max", "precipitation_sum", "uv_index_max",
            ]),
            "timezone": "auto",
            "forecast_days": 16,
        }, total=OPEN_METEO_WAIT, retry=False)   # an extra: one quick try only
        if not r.ok:
            raise UpstreamError("open-meteo", f"http {r.status}")
        data = r.json() or {}
    except UpstreamError as e:
        log.warning("Open-Meteo error: %s", e.kind)
        cache.set("om:down", True, OPEN_METEO_COOLDOWN)
        return _last_open_meteo(key)

    d = data.get("daily", {}) or {}
    days = []
    for i, date in enumerate(d.get("time", []) or []):
        code = _at(d.get("weather_code"), i)
        owm_id, icon, desc = WMO_TO_OWM.get(code, (803, "03d", "cloudy"))
        pop = _at(d.get("precipitation_probability_max"), i)
        days.append({
            "date": date,
            "temp_max": _at(d.get("temperature_2m_max"), i),
            "temp_min": _at(d.get("temperature_2m_min"), i),
            "pop": (pop / 100.0) if pop is not None else None,
            "precipitation": _at(d.get("precipitation_sum"), i),
            "uv_max": _at(d.get("uv_index_max"), i),
            "weather": {"id": owm_id, "icon": icon, "description": desc},
        })

    uv_now = (data.get("current") or {}).get("uv_index")
    if uv_now is None:
        # Fallback: pick the current local hour from the hourly series.
        offset = int(data.get("utc_offset_seconds", 0) or 0)
        hour = (datetime.now(timezone.utc) + timedelta(seconds=offset)).strftime("%Y-%m-%dT%H:00")
        h = data.get("hourly", {}) or {}
        times = h.get("time", []) or []
        if hour in times:
            uv_now = _at(h.get("uv_index"), times.index(hour))

    result = {
        "uv": uv_now,
        "uv_max_today": days[0]["uv_max"] if days else None,
        "daily": days,
    }
    cache.set(key, result, TTL_OPEN_METEO)
    cache.set(f"stale:{key}", (time.time(), result), TTL_STALE)
    return result


def attach_location(weather, forecast, searched):
    """Return shallow copies (never mutate cached objects) with location info."""
    weather = dict(weather) if weather is not None else None
    forecast = dict(forecast) if forecast is not None else None
    if searched:
        if weather is not None:
            weather["searched_location"] = {
                "name": searched["name"] or weather.get("name", ""),
                "state": searched.get("state", ""),
                "country": searched["country"] or weather.get("sys", {}).get("country", ""),
            }
        if forecast is not None:
            forecast["searched_location"] = dict(
                weather["searched_location"] if weather else searched
            )
    elif forecast is not None and weather is not None:
        forecast["searched_location"] = {
            "name": weather.get("name", "Your Location"),
            "country": weather.get("sys", {}).get("country", ""),
        }
    if forecast is not None and weather is not None:
        forecast["sunrise"] = weather.get("sys", {}).get("sunrise", 0)
        forecast["sunset"] = weather.get("sys", {}).get("sunset", 0)
    return weather, forecast


@app.after_request
def add_cache_headers(resp):
    # A reply built from saved copies says so (unix time of the oldest one),
    # so the page can show "Showing saved data from <time>". Never cache it.
    marks = _stale_var.get()
    if marks:
        resp.headers["X-Stale-Saved-At"] = str(int(min(marks)))
        resp.headers["Cache-Control"] = "no-store"
    # Let browsers/SW reuse API responses briefly; never cache errors.
    if request.path in API_PATHS and resp.status_code == 200 and "Cache-Control" not in resp.headers:
        resp.headers["Cache-Control"] = "public, max-age=120"
    return resp


API_PATHS = {"/weather", "/forecast", "/weather-full", "/uv", "/air",
             "/locations", "/reverse", "/global-alerts", "/local-alerts"}


# =================================
# PAGES / PWA
# =================================
@app.route("/")
def home():
    return render_template("weather.html")


@app.route("/manifest.json")
def manifest():
    return send_from_directory("static", "manifest.json", mimetype="application/manifest+json")


@app.route("/service-worker.js")
def service_worker():
    resp = send_from_directory("static", "service-worker.js", mimetype="application/javascript")
    resp.headers["Cache-Control"] = "no-cache"   # so SW updates reach phones promptly
    resp.headers["Service-Worker-Allowed"] = "/"
    return resp


@app.route("/health")
def health():
    return jsonify({"ok": True, "time": int(time.time())})


# =================================
# SEARCH LOCATIONS
# =================================
@app.route("/locations")
def locations():
    city = (request.args.get("city") or "").strip()
    if not city:
        raise ApiError(400, "Please enter a city")

    results = geocode(city)
    if not results:
        raise ApiError(404, "Location not found")

    seen, out = set(), []
    for loc in results:
        key = (loc.get("name"), loc.get("state"), loc.get("country"))
        if key in seen:           # OWM often returns duplicates
            continue
        seen.add(key)
        out.append({
            "name": loc.get("name", ""),
            "country": loc.get("country", ""),
            "state": loc.get("state", ""),
            "lat": loc.get("lat"),
            "lon": loc.get("lon"),
        })
    return jsonify({"cod": 200, "locations": out})


# =================================
# CURRENT WEATHER
# =================================
@app.route("/weather")
def weather():
    lat, lon, searched = resolve_location()
    w, _ = attach_location(get_current(lat, lon), None, searched)
    return jsonify(w)


# =================================
# 5-DAY FORECAST (kept for compatibility)
# =================================
@app.route("/forecast")
def forecast():
    lat, lon, searched = resolve_location()
    f1 = submit(get_current, lat, lon)
    f2 = submit(get_forecast, lat, lon)
    current = wait_for(f1, time_left())
    fc = wait_for(f2, time_left())
    w, f = attach_location(current, fc, searched)
    return jsonify(f)


# =================================
# COMBINED WEATHER + FORECAST + DAILY OUTLOOK (one request)
# =================================
@app.route("/weather-full")
def weather_full():
    lat, lon, searched = resolve_location()

    fut_cur = submit(get_current, lat, lon)
    fut_fc = submit(get_forecast, lat, lon)
    fut_om = submit(get_open_meteo, lat, lon)

    current = wait_for(fut_cur, time_left())   # ApiError goes to the handler
    fc = wait_for(fut_fc, time_left())
    try:
        # The extras (UV, 16-day outlook) get a short wait; without them the
        # page still works, it just skips those parts this time.
        om = fut_om.result(timeout=max(0.1, min(OPEN_METEO_WAIT, time_left(0))))
    except Exception:
        om = None

    w, f = attach_location(current, fc, searched)
    if om:
        f["daily"] = om["daily"]
        w["uv"] = {"value": om["uv"], "max_today": om["uv_max_today"]}

    return jsonify({"weather": w, "forecast": f})


# =================================
# UV INDEX — Open-Meteo only.
# (OWM's 2.5/uvi is retired and our key has no One Call 3.0 subscription.)
# value is null when there is no UV at all: the page then hides the UV tile.
# =================================
@app.route("/uv")
def uv_index():
    lat, lon = require_coords()

    om = get_open_meteo(lat, lon)
    if om and om["uv"] is not None:
        out = {"value": om["uv"], "max_today": om["uv_max_today"], "source": "open-meteo"}
        if om.get("stale"):
            out["stale"] = True
            out["saved_at"] = om["saved_at"]
        return jsonify(out)

    return jsonify({"value": None, "message": "UV index unavailable"})


# =================================
# AIR POLLUTION
# =================================
AQI_LABELS = {1: "Good", 2: "Fair", 3: "Moderate", 4: "Poor", 5: "Very Poor"}


@app.route("/air")
def air_pollution():
    lat, lon = require_coords()
    try:
        data = owm_get("/data/2.5/air_pollution", {"lat": lat, "lon": lon},
                       cache_key=f"air:{coord_key(lat, lon)}", ttl=TTL_AIR, units=False)
    except ApiError as e:
        return jsonify({"aqi": None, "message": e.message})

    items = data.get("list") or []
    if not items:
        return jsonify({"aqi": None})
    aqi = items[0].get("main", {}).get("aqi")
    return jsonify({
        "aqi": aqi,
        "label": AQI_LABELS.get(aqi, "Unknown"),
        "components": items[0].get("components", {}),
    })


# =================================
# REVERSE GEOCODING (Nominatim)
# =================================
EMPTY_PLACE = {"name": "", "state": "", "country": ""}


@app.route("/reverse")
def reverse():
    lat, lon = request.args.get("lat"), request.args.get("lon")
    if not lat or not lon:
        return jsonify(EMPTY_PLACE)
    try:
        lat, lon = parse_coords(lat, lon)
    except ApiError:
        return jsonify(EMPTY_PLACE)

    key = f"rev:{coord_key(lat, lon)}"
    cached = cache.get(key)
    if cached:
        return jsonify(cached)

    try:
        r = upstream("nominatim", "https://nominatim.openstreetmap.org/reverse", params={
            "lat": lat, "lon": lon, "format": "json", "zoom": 14, "addressdetails": 1,
        })
        if not r.ok:
            raise UpstreamError("nominatim", f"http {r.status}")
        data = r.json() or {}
    except UpstreamError as e:
        log.warning("Nominatim error: %s", e.kind)
        return jsonify(EMPTY_PLACE)

    addr = data.get("address", {})
    result = {
        "name": (addr.get("village") or addr.get("hamlet") or addr.get("suburb")
                 or addr.get("neighbourhood") or addr.get("town") or addr.get("city")
                 or data.get("name") or ""),
        "state": addr.get("state") or addr.get("county") or "",
        "country": (addr.get("country_code") or "").upper(),
    }
    cache.set(key, result, TTL_REVERSE)
    return jsonify(result)


# =================================
# IP-BASED LOCATION (first-time visitors)
# =================================
EMPTY_IPLOC = {"name": "", "state": "", "country": "", "lat": None, "lon": None}


@app.route("/my-location")
def my_location():
    ip = client_ip()
    if not is_public_ip(ip):
        return jsonify(EMPTY_IPLOC)

    key = f"ip:{ip}"
    cached = cache.get(key)
    if cached:
        return jsonify(cached)

    try:
        r = upstream("ipapi", f"https://ipapi.co/{ip}/json/")
        if not r.ok:
            raise UpstreamError("ipapi", f"http {r.status}")
        data = r.json() or {}
    except UpstreamError as e:
        log.warning("IP geolocation error: %s", e.kind)
        return jsonify(EMPTY_IPLOC)

    result = {
        "name": data.get("city") or "",
        "state": data.get("region") or "",
        "country": (data.get("country_code") or "").upper(),
        "lat": data.get("latitude"),
        "lon": data.get("longitude"),
    }
    if result["name"] and result["lat"] is not None and result["lon"] is not None:
        cache.set(key, result, TTL_IP)
    return jsonify(result)


# =================================
# FEEDBACK -> EMAIL (SendGrid v3 API, called through upstream())
# =================================
SENDGRID_API_KEY = os.getenv("SENDGRID_API_KEY")
# Both addresses come only from the environment (the From address must be a
# sender verified in SendGrid). No address is kept in the code.
FEEDBACK_TO_EMAIL = (os.getenv("FEEDBACK_TO_EMAIL") or "").strip()
FEEDBACK_FROM_EMAIL = (os.getenv("FEEDBACK_FROM_EMAIL") or "").strip()
FEEDBACK_LIMIT = 5          # messages per IP...
FEEDBACK_WINDOW = 600       # ...per 10 minutes


def _check_feedback_config():
    """Warn (once, at startup) if the feedback addresses are missing."""
    missing = [name for name, value in (("FEEDBACK_TO_EMAIL", FEEDBACK_TO_EMAIL),
                                        ("FEEDBACK_FROM_EMAIL", FEEDBACK_FROM_EMAIL))
               if not value]
    if missing:
        log.warning("Feedback email is off: %s not set", " and ".join(missing))
    return missing


_check_feedback_config()


@app.route("/feedback", methods=["POST"])
def feedback():
    if not (FEEDBACK_TO_EMAIL and FEEDBACK_FROM_EMAIL):
        return jsonify({"ok": False, "message": "Sorry, feedback isn't available right now. "
                                                "Please try again later."}), 503
    if not SENDGRID_API_KEY:
        return jsonify({"ok": False, "message": "Feedback not configured"}), 500

    rl_key = f"fb:{client_ip()}"
    count = cache.get(rl_key) or 0
    if count >= FEEDBACK_LIMIT:
        return jsonify({"ok": False, "message": "Too many messages, please try again later"}), 429
    cache.set(rl_key, count + 1, FEEDBACK_WINDOW)

    data = request.get_json(silent=True) or {}
    category = str(data.get("category", "general"))[:20]
    message = str(data.get("message", ""))[:1000]
    user_email = str(data.get("email", "")).strip()[:120]
    city = str(data.get("city", ""))[:120]
    page_url = str(data.get("page_url", ""))[:200]

    if not message.strip():
        return jsonify({"ok": False, "message": "Message required"}), 400

    body = (
        "New feedback from Neckrone8x Weather\n\n"
        f"Category:    {category}\n"
        f"From city:   {city}\n"
        f"Page URL:    {page_url}\n"
        f"User email:  {user_email or '(not provided)'}\n\n"
        f"Message:\n{message}"
    )
    mail = {
        "personalizations": [{"to": [{"email": FEEDBACK_TO_EMAIL}]}],
        "from": {"email": FEEDBACK_FROM_EMAIL},
        "subject": f"[Neckrone8x Weather] {category.upper()} feedback",
        "content": [{"type": "text/plain", "value": body}],
    }
    if user_email and "@" in user_email:
        mail["reply_to"] = {"email": user_email}

    try:
        # POST: never retried, so a slow reply can't send the email twice.
        r = upstream("sendgrid", SENDGRID_URL, method="POST", json_body=mail,
                     headers={"Authorization": f"Bearer {SENDGRID_API_KEY}"}, retry=False)
    except UpstreamError as e:
        log.warning("Feedback send failed: %s", e.kind)
        if e.kind == "timeout":
            return jsonify({"ok": False, "message": "Feedback service timed out, please try again"}), 504
        return jsonify({"ok": False, "message": "Could not send feedback right now"}), 502

    if r.status in (200, 201, 202):
        return jsonify({"ok": True})
    log.warning("SendGrid returned %s", r.status)
    return jsonify({"ok": False, "message": "Could not send feedback right now"}), 502


# =================================
# GLOBAL DISASTER ALERTS (GDACS)
# =================================
@app.route("/global-alerts")
def global_alerts():
    cached = cache.get("global-alerts")
    if cached:
        return jsonify(cached)

    now = datetime.now(timezone.utc)
    try:
        r = upstream("gdacs", "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH", params={
            "fromdate": (now - timedelta(days=30)).strftime("%Y-%m-%d"),
            "todate": now.strftime("%Y-%m-%d"),
            "alertlevel": "red;orange",
            "pagesize": 20,
        })
        if r.status == 204:          # GDACS sends 204 when nothing matches
            features = []
        elif not r.ok:
            raise UpstreamError("gdacs", f"http {r.status}")
        else:
            features = (r.json() or {}).get("features", [])
    except UpstreamError as e:
        log.warning("GDACS error: %s", e.kind)
        return jsonify({"alerts": [], "error": "Global alerts unavailable"})

    alerts = []
    for f in features:
        props = f.get("properties", {})
        coords = (f.get("geometry") or {}).get("coordinates") or [None, None]
        alerts.append({
            "id": props.get("eventid"),
            "type": props.get("eventtype", ""),
            "name": props.get("name", "Unknown event"),
            "alertlevel": props.get("alertlevel", "Green"),
            "country": props.get("country", ""),
            "date": props.get("fromdate", ""),
            "lat": coords[1] if len(coords) > 1 else None,
            "lon": coords[0] if coords else None,
            "url": (f"https://www.gdacs.org/report.aspx?eventid={props.get('eventid')}"
                    f"&eventtype={props.get('eventtype')}"),
        })

    # Red before Orange; newest first within each level.
    order = {"Red": 0, "Orange": 1, "Green": 2}
    alerts.sort(key=lambda a: a["date"] or "", reverse=True)
    alerts.sort(key=lambda a: order.get(a["alertlevel"], 9))

    result = {"alerts": alerts[:15], "count": len(alerts)}
    cache.set("global-alerts", result, TTL_ALERTS)
    return jsonify(result)


# =================================
# LOCAL ALERTS (NWS for the US + USGS earthquakes worldwide)
# Each returns a list, or None if the service failed (so it isn't cached).
# =================================
def _nws_alerts(lat, lon):
    try:
        r = upstream("nws", "https://api.weather.gov/alerts/active",
                     params={"point": f"{lat:.4f},{lon:.4f}"},
                     headers={"Accept": "application/geo+json"})
        if r.status != 200:      # non-US points return 400 — expected
            return []
        out = []
        for feat in (r.json() or {}).get("features", [])[:5]:
            p = feat.get("properties", {})
            out.append({
                "event": p.get("event", "Weather Alert"),
                "severity": p.get("severity", "Unknown"),
                "headline": p.get("headline", ""),
                "description": (p.get("description") or "")[:300],
                "onset": p.get("onset", ""),
                "expires": p.get("expires", ""),
            })
        return out
    except UpstreamError as e:
        log.warning("NWS error: %s", e.kind)
        return None


def _usgs_quakes(lat, lon):
    try:
        r = upstream("usgs", "https://earthquake.usgs.gov/fdsnws/event/1/query", params={
            "format": "geojson",
            "latitude": lat, "longitude": lon,
            "maxradiuskm": 500, "minmagnitude": 4.0,
            "starttime": (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d"),
            "orderby": "time",
        })
        if r.status != 200:
            return None
        out = []
        for feat in (r.json() or {}).get("features", [])[:3]:
            p = feat.get("properties", {})
            gc = (feat.get("geometry") or {}).get("coordinates") or [None, None, None]
            out.append({
                "magnitude": p.get("mag"),
                "place": p.get("place", "Unknown location"),
                "time": p.get("time"),
                "url": p.get("url", ""),
                "lon": gc[0], "lat": gc[1], "depth": gc[2] if len(gc) > 2 else None,
            })
        return out
    except UpstreamError as e:
        log.warning("USGS error: %s", e.kind)
        return None


@app.route("/local-alerts")
def local_alerts():
    lat, lon = request.args.get("lat"), request.args.get("lon")
    if not lat or not lon:
        return jsonify({"alerts": [], "quakes": []})
    try:
        lat, lon = parse_coords(lat, lon)
    except ApiError:
        return jsonify({"alerts": [], "quakes": []})

    key = f"local:{coord_key(lat, lon)}"
    cached = cache.get(key)
    if cached:
        return jsonify(cached)

    f_nws = submit(_nws_alerts, lat, lon)
    f_usgs = submit(_usgs_quakes, lat, lon)
    try:
        alerts = f_nws.result(timeout=time_left())
    except FutureTimeout:
        alerts = None
    try:
        quakes = f_usgs.result(timeout=time_left())
    except FutureTimeout:
        quakes = None
    result = {"alerts": alerts or [], "quakes": quakes or []}
    if alerts is not None and quakes is not None:   # don't keep a failure for 15 min
        cache.set(key, result, TTL_ALERTS)
    return jsonify(result)


# =================================
# START SERVER (local dev only — production runs under gunicorn)
# =================================
if __name__ == "__main__":
    app.run(
        debug=os.getenv("FLASK_DEBUG") == "1",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "5000")),
    )
