"""
8X Weather (Neckrone8x Weather) — Flask backend.

Upstreams:
  - OpenWeatherMap: current weather, 3-hourly 5-day forecast, geocoding, air pollution
  - Open-Meteo (free, no key): UV index + 16-day daily forecast
  - Nominatim: reverse geocoding        - ipapi.co: IP location
  - GDACS / NWS / USGS: alerts          - SendGrid v3 HTTP API: feedback email
                                          (plain HTTPS through upstream(); no SendGrid package)

Every outside call goes through upstream(), which always ends within a hard
deadline (DNS and slow-trickling replies included), so no request can hang.
The API endpoints have generous per-address rate limits (see RATE LIMITS).
"""
import contextvars
import ipaddress
import json
import logging
import math
import os
import re
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

# Lake and farm tips (tips_for). Units are OpenWeatherMap metric: m/s, mm, °C, %.
# No extra calls: everything comes from the weather + forecast we already fetch.
TIPS_MAX = 3                     # tips per place, most important first
TIP_WATER_KM = 15                # lake tips within this distance of the water
TIP_SOON_SLOTS = 2               # forecast slots (3 h each) counted as "soon": 6 h
TIP_DAY_SLOTS = 8                # 24 h
TIP_TWO_DAY_SLOTS = 16           # 48 h
WIND_STRONG_MS = 8.0             # ~29 km/h, Beaufort 5: small boats take care
GUST_STRONG_MS = 11.0            # ~40 km/h
WIND_ROUGH_MS = 11.0             # ~40 km/h, Beaufort 6: rough water, stay ashore
GUST_ROUGH_MS = 15.0             # ~54 km/h
WIND_CALM_MS = 4.0               # ~14 km/h: calm, good fishing weather
GUST_CALM_MS = 6.0
LOW_VISIBILITY_M = 1000          # fog / mist on the water
FOG_IDS = frozenset({701, 741})  # OWM mist, fog
THUNDER_IDS = frozenset(range(200, 233))   # OWM 2xx thunderstorm
HEAVY_RAIN_MM_24H = 20.0         # rain in the next 24 h: delay spraying/harvest
VERY_HEAVY_RAIN_MM_24H = 50.0    # ...and this much is a danger (floods, washed fields)
DRY_RAIN_MM_48H = 1.0            # at most this much rain in 48 h...
DRY_MAX_POP = 0.3                # ...no slot more than 30 % likely to rain...
DRY_MAX_HUMIDITY = 70            # ...and air dry enough to dry crops
HUMID_PCT = 85                   # fungal disease risk (now or the 24 h average)...
HUMID_MIN_TEMP_C = 12            # ...when it is warm enough for fungi to grow
UV_HIGH = 8                      # WHO "very high": cover up in the fields
UV_EXTREME = 11                  # WHO "extreme"
FROST_TEMP_C = 4.0               # air this cold (2 m) can mean ground frost in the highlands
FROST_DANGER_C = 1.0
PLANT_RAIN_TODAY_MM = 10.0       # today's rain that leaves the soil moist enough to plant

# Water for the lake tips: ("name", "area" outline | "line" shore, [(lat, lon), ...]).
# Rough outlines: within TIP_WATER_KM of an edge (or inside) counts as "on the water".
TIP_WATERS = (
    ("Lake Victoria", "area", [
        (-0.10, 34.75), (-0.36, 34.64), (-0.52, 34.45), (-0.43, 34.21), (-0.85, 34.15),
        (-1.01, 34.07), (-1.50, 33.80), (-2.20, 33.70), (-2.52, 32.90), (-2.65, 32.00),
        (-1.85, 31.65), (-1.33, 31.82), (-0.95, 31.75), (-0.31, 32.03), (0.05, 32.46),
        (0.29, 32.65), (0.43, 33.20), (0.24, 33.97), (0.10, 33.97), (-0.07, 34.05),
        (-0.08, 34.45)]),
    ("Lake Turkana", "area", [
        (2.42, 36.58), (2.75, 36.72), (3.20, 36.52), (3.65, 36.33), (3.95, 36.20),
        (4.30, 36.23), (4.60, 36.05), (4.45, 35.95), (4.27, 35.88), (3.55, 35.90),
        (3.25, 35.97), (2.85, 36.15), (2.55, 36.40)]),
    ("Lake Baringo", "area", [
        (0.72, 36.07), (0.66, 36.13), (0.55, 36.10), (0.53, 36.05), (0.60, 36.00), (0.68, 36.02)]),
    ("Lake Naivasha", "area", [
        (-0.70, 36.33), (-0.72, 36.42), (-0.80, 36.42), (-0.85, 36.35), (-0.80, 36.28),
        (-0.73, 36.29)]),
    ("Lake Nakuru", "area", [
        (-0.31, 36.08), (-0.34, 36.12), (-0.40, 36.11), (-0.41, 36.07), (-0.36, 36.05)]),
    ("Lake Elementaita", "area", [
        (-0.42, 36.24), (-0.44, 36.27), (-0.48, 36.26), (-0.47, 36.23)]),
    ("Indian Ocean coast", "line", [
        (-4.68, 39.20), (-4.65, 39.38), (-4.30, 39.59), (-4.05, 39.67), (-3.63, 39.86),
        (-3.35, 40.03), (-3.22, 40.12), (-2.53, 40.53), (-2.27, 40.90), (-1.75, 41.49),
        (-1.66, 41.56)]),
)


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


# =================================
# LANGUAGE — English (default) or Kiswahili, from ?lang=
# The caches above hold the outside services' data as it came (no language
# in it); sentences are put into the visitor's language on the way out, on
# copies, so a cached object is never changed and languages never mix. Every
# reply that carries text in a language is keyed by its URL, which includes
# ?lang= (browser, service worker and any CDN cache).
# =================================
LANGS = ("en", "sw")


def request_lang():
    """'sw' or 'en' (anything else, or no request, means English)."""
    try:
        value = (request.args.get("lang") or "").strip().lower()
    except RuntimeError:          # outside a request
        return "en"
    return value if value in LANGS else "en"


# Every sentence the server writes itself, by its English text.
SW_MESSAGES = {
    "Weather service timed out": "Huduma ya hali ya hewa imechelewa kujibu",
    "Weather service unavailable": "Huduma ya hali ya hewa haipatikani",
    "Location not found": "Mahali hapajapatikana",
    "Weather service is busy, please try again shortly":
        "Huduma ya hali ya hewa ina shughuli nyingi, tafadhali jaribu tena baadaye kidogo",
    "Weather service error": "Hitilafu ya huduma ya hali ya hewa",
    "Weather service returned an invalid response":
        "Huduma ya hali ya hewa imetuma jibu lisilo sahihi",
    "Invalid coordinates": "Viwianishi si sahihi",
    "Coordinates out of range": "Viwianishi viko nje ya kiwango",
    "lat and lon required": "lat na lon zinahitajika",
    "City not found": "Mji haujapatikana",
    "Please enter a city": "Tafadhali andika jina la mji",
    "Weather is temporarily unavailable, please try again later":
        "Hali ya hewa haipatikani kwa muda, tafadhali jaribu tena baadaye",
    "An outside service timed out": "Huduma ya nje imechelewa kujibu",
    "An outside service failed": "Huduma ya nje imeshindwa",
    "Too many requests. Please wait a moment and try again.":
        "Maombi ni mengi mno. Tafadhali subiri kidogo kisha ujaribu tena.",
    "UV index unavailable": "Kiwango cha UV hakipatikani",
    "Sorry, feedback isn't available right now. Please try again later.":
        "Samahani, maoni hayapokelewi kwa sasa. Tafadhali jaribu tena baadaye.",
    "Feedback not configured": "Maoni hayajawekwa tayari",
    "Too many messages, please try again later":
        "Ujumbe ni mwingi mno, tafadhali jaribu tena baadaye",
    "Message required": "Ujumbe unahitajika",
    "Feedback service timed out, please try again":
        "Huduma ya maoni imechelewa kujibu, tafadhali jaribu tena",
    "Could not send feedback right now": "Imeshindikana kutuma maoni kwa sasa",
    "Global alerts unavailable": "Tahadhari za dunia hazipatikani",
    "Unknown location": "Mahali pasipojulikana",
    "Unknown": "Haijulikani",
    # Air quality (AQI_LABELS)
    "Good": "Nzuri", "Fair": "Ya kuridhisha", "Moderate": "Wastani",
    "Poor": "Mbaya", "Very Poor": "Mbaya sana",
}

# Lake and farm tips by id: English text ({...} = numbers filled in).
# The page has the same texts in its I18N table (tip_<id>; a test keeps them equal),
# so a language switch redraws them without asking the server again.
TIP_TEXTS = {
    "lake_thunder": "Thunderstorms likely within 6 hours. Get off the water and away from the shore.",
    "lake_rough": "Rough water: wind up to {kmh} km/h. Do not go out in small boats.",
    "lake_wind": "Strong wind on the water: up to {kmh} km/h. Small boats stay close to shore.",
    "lake_fog": "Fog or mist: low visibility on the water. Go slowly and carry a light and a phone.",
    "lake_calm": "Calm water and light wind: good weather for fishing.",
    "farm_heavy_rain": "Heavy rain coming: about {mm} mm in 24 hours. Delay spraying and harvest, and cover drying crops.",
    "farm_frost": "Frost risk: down to {temp}°C in the next 2 days. Cover seedlings and nurseries.",
    "farm_uv": "Strong sun today (UV {uv}). Field workers: cover up, drink water, rest in the shade at midday.",
    "farm_fungus": "Very humid ({pct}%): high risk of fungal disease such as blight. Check crops and spray if needed.",
    "farm_drying": "Dry days ahead: good for drying maize and coffee.",
    "farm_planting": "The soil is moist after rain: good conditions for planting.",
}
SW_MESSAGES.update({
    TIP_TEXTS["lake_thunder"]: "Radi zinatarajiwa ndani ya saa 6. Toka majini na ukae mbali na ufuo.",
    TIP_TEXTS["lake_rough"]: "Maji yamechafuka: upepo hadi km/h {kmh}. Usiende na mashua ndogo.",
    TIP_TEXTS["lake_wind"]: "Upepo mkali majini: hadi km/h {kmh}. Mashua ndogo zikae karibu na ufuo.",
    TIP_TEXTS["lake_fog"]: "Ukungu: huoni mbali majini. Endesha polepole, beba taa na simu.",
    TIP_TEXTS["lake_calm"]: "Maji yametulia na upepo ni mdogo: hali nzuri ya kuvua samaki.",
    TIP_TEXTS["farm_heavy_rain"]: "Mvua kubwa inakuja: karibu mm {mm} kwa saa 24. Ahirisha dawa na mavuno; funika mazao yanayokaushwa.",
    TIP_TEXTS["farm_frost"]: "Hatari ya baridi kali (barafu): hadi {temp}°C ndani ya siku 2. Funika miche na vitalu.",
    TIP_TEXTS["farm_uv"]: "Jua kali leo (UV {uv}). Wafanyakazi shambani: jifunikeni, kunyweni maji, pumzikeni kivulini mchana.",
    TIP_TEXTS["farm_fungus"]: "Unyevu mwingi ({pct}%): hatari ya magonjwa ya kuvu kama baka. Kagua mazao, nyunyizia dawa ikihitajika.",
    TIP_TEXTS["farm_drying"]: "Siku kavu zinakuja: nzuri kwa kukausha mahindi na kahawa.",
    TIP_TEXTS["farm_planting"]: "Udongo una unyevu baada ya mvua: hali nzuri ya kupanda.",
})


def tr(text, lang=None):
    """`text` in the request's language (English when there is no Kiswahili)."""
    lang = lang or request_lang()
    if lang == "sw":
        return SW_MESSAGES.get(text, text)
    return text


# Weather condition names by OpenWeatherMap condition id (simple Kenyan Kiswahili).
SW_CONDITIONS = {
    200: "radi na mvua nyepesi", 201: "radi na mvua", 202: "radi na mvua kubwa",
    210: "radi nyepesi", 211: "radi na mvua", 212: "radi kali",
    221: "radi za hapa na pale", 230: "radi na manyunyu", 231: "radi na manyunyu",
    232: "radi na manyunyu mengi",
    300: "manyunyu mepesi", 301: "manyunyu", 302: "manyunyu mengi",
    310: "manyunyu na mvua nyepesi", 311: "manyunyu na mvua", 312: "manyunyu na mvua kubwa",
    313: "mvua ya rasharasha na manyunyu", 314: "mvua kubwa ya rasharasha na manyunyu",
    321: "manyunyu ya rasharasha",
    500: "mvua nyepesi", 501: "mvua ya wastani", 502: "mvua kubwa",
    503: "mvua kubwa sana", 504: "mvua kubwa mno", 511: "mvua ya barafu",
    520: "rasharasha nyepesi", 521: "rasharasha", 522: "rasharasha kubwa",
    531: "rasharasha za hapa na pale",
    600: "theluji nyepesi", 601: "theluji", 602: "theluji nyingi",
    611: "theluji na mvua", 612: "theluji na mvua nyepesi", 613: "theluji na mvua",
    615: "mvua nyepesi na theluji", 616: "mvua na theluji",
    620: "theluji nyepesi ya rasharasha", 621: "theluji ya rasharasha",
    622: "theluji nyingi ya rasharasha",
    701: "ukungu mwepesi", 711: "moshi", 721: "ukungu wa vumbi", 731: "vumbi",
    741: "ukungu", 751: "mchanga", 761: "vumbi", 762: "majivu ya volkano",
    771: "upepo mkali", 781: "kimbunga",
    800: "anga safi", 801: "mawingu machache", 802: "mawingu kiasi",
    803: "mawingu mengi", 804: "mawingu mazito",
}


def condition_text(cond_id, description, lang):
    """A condition's description in `lang` (the English one when unknown)."""
    if lang == "sw":
        try:
            return SW_CONDITIONS.get(int(cond_id), description)
        except (TypeError, ValueError):
            return description
    return description


def _localize_conditions(items, lang):
    """Copies of OWM 'weather' entries with the description in `lang`."""
    out = []
    for w in items or []:
        if isinstance(w, dict):
            w = dict(w, description=condition_text(w.get("id"), w.get("description", ""), lang))
        out.append(w)
    return out


def localize_weather(data, lang):
    """A copy of a current-weather reply in `lang` (the same object for English)."""
    if lang == "en" or not isinstance(data, dict):
        return data
    data = dict(data)
    if "weather" in data:
        data["weather"] = _localize_conditions(data.get("weather"), lang)
    return data


def localize_forecast(data, lang):
    """A copy of a forecast reply (3-hour list + daily outlook) in `lang`."""
    if lang == "en" or not isinstance(data, dict):
        return data
    data = dict(data)
    if isinstance(data.get("list"), list):
        data["list"] = [dict(i, weather=_localize_conditions(i.get("weather"), lang))
                        if isinstance(i, dict) else i for i in data["list"]]
    if isinstance(data.get("daily"), list):
        days = []
        for d in data["daily"]:
            if isinstance(d, dict) and isinstance(d.get("weather"), dict):
                w = d["weather"]
                d = dict(d, weather=dict(w, description=condition_text(
                    w.get("id"), w.get("description", ""), lang)))
            days.append(d)
        data["daily"] = days
    return data


# USGS places look like "46 km SE of Ikungi, Tanzania".
_QUAKE_PLACE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*km\s+([NSEW]{1,3})\s+of\s+(.+?)\s*$", re.I)
SW_DIRECTIONS = {
    "N": "kaskazini", "S": "kusini", "E": "mashariki", "W": "magharibi",
    "NE": "kaskazini-mashariki", "NW": "kaskazini-magharibi",
    "SE": "kusini-mashariki", "SW": "kusini-magharibi",
}


def quake_place(place, lang):
    """'46 km SE of Ikungi, Tanzania' -> 'km 46 kusini-mashariki mwa Ikungi, Tanzania'."""
    if lang != "sw":
        return place
    if place == "Unknown location":
        return tr(place, lang)
    m = _QUAKE_PLACE.match(str(place or ""))
    if not m:
        return place          # e.g. "Fiji region": a name, kept as USGS wrote it
    km, direction, where = m.group(1), m.group(2).upper(), m.group(3)
    # Three letters (SSE) -> the nearest two-letter direction (SE).
    if len(direction) == 3:
        direction = direction[1:]
    word = SW_DIRECTIONS.get(direction)
    if not word:
        return place
    return f"km {km} {word} mwa {where}"


@app.errorhandler(ApiError)
def handle_api_error(err):
    if isinstance(err, WeatherUnavailable):
        return jsonify({"error": "weather_unavailable", "cod": 503,
                        "message": tr(err.message)}), 503
    return jsonify({"cod": err.status, "message": tr(err.message)}), err.status


@app.errorhandler(UpstreamError)
def handle_upstream_error(err):
    # Safety net: endpoints normally turn these into their own messages.
    if err.kind == "timeout":
        return jsonify({"cod": 504, "message": tr("An outside service timed out")}), 504
    return jsonify({"cod": 502, "message": tr("An outside service failed")}), 502


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


# Addresses that are never a real visitor: private, carrier-NAT, loopback,
# link-local (and the IPv6 equivalents).
_NON_PUBLIC_NETS = tuple(ipaddress.ip_network(n) for n in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10",
    "127.0.0.0/8", "169.254.0.0/16", "::1/128", "fc00::/7", "fe80::/10"))


def _parse_ip(text):
    """An ip_address from a header value, or None. Accepts '1.2.3.4:5678' and
    '[2001:db8::1]:443' forms too; IPv4-mapped IPv6 becomes plain IPv4."""
    text = (text or "").strip().strip('"')
    if text.startswith("["):
        text = text[1:].split("]", 1)[0]
    elif text.count(":") == 1:             # IPv4 with a port
        text = text.split(":", 1)[0]
    try:
        addr = ipaddress.ip_address(text)
    except ValueError:
        return None
    mapped = getattr(addr, "ipv4_mapped", None)
    return mapped or addr


def _public(addr):
    return bool(addr) and not (
        any(addr in net for net in _NON_PUBLIC_NETS if net.version == addr.version)
        or addr.is_private or addr.is_loopback or addr.is_link_local
        or addr.is_multicast or addr.is_reserved or addr.is_unspecified)


def is_public_ip(ip):
    return _public(_parse_ip(ip))


def client_ip():
    """The visitor's real address, or "unknown".
    1. CF-Connecting-IP, only if it is a public address (set by Cloudflare).
    2. X-Forwarded-For walked from the RIGHT (the hops our host added),
       skipping private / carrier-NAT / loopback / link-local hops. Entries
       further left can be typed by the visitor, so the first public one from
       the right wins.
    3. The connection's own address, if public."""
    cf = _parse_ip(request.headers.get("CF-Connecting-IP"))
    if _public(cf):
        return str(cf)
    for part in reversed(request.headers.get("X-Forwarded-For", "").split(",")):
        addr = _parse_ip(part)
        if _public(addr):
            return str(addr)
    addr = _parse_ip(request.remote_addr)
    return str(addr) if _public(addr) else "unknown"


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


def _local_hhmm(stamp):
    """Open-Meteo local time "2025-11-13T06:32" -> "06:32" (None if not a time)."""
    s = str(stamp or "")
    hhmm = s[11:16]
    if len(s) >= 16 and s[10] == "T" and hhmm[2:3] == ":" and hhmm.replace(":", "").isdigit():
        return hhmm
    return None


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
                "sunrise", "sunset",
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
            # The place's own local clock time (timezone=auto), e.g. "06:32".
            "sunrise": _local_hhmm(_at(d.get("sunrise"), i)),
            "sunset": _local_hhmm(_at(d.get("sunset"), i)),
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
    if request.path in API_PATHS or request.path == "/feedback":
        resp.headers["Content-Language"] = request_lang()
    return resp


API_PATHS = {"/weather", "/weather-full", "/uv", "/air",
             "/locations", "/reverse", "/global-alerts", "/local-alerts"}


# =================================
# RATE LIMITS — per visitor address, in memory
# Generous on purpose: many Kenyan phones share one carrier address, and one
# page load fires several calls at once (/weather-full, /uv, /air,
# /local-alerts, /my-location, /global-alerts, plus /weather for every saved
# city). Each gunicorn worker keeps its own counts.
# =================================
RATE_WINDOW = 60                          # seconds
RATE_LIMIT_ALL = 120                      # requests per address per window, all paths below
RATE_LIMITS = {"/locations": 30}          # extra, tighter limit for these paths
RATE_LIMITED_PATHS = frozenset({
    "/weather-full", "/weather", "/locations", "/uv", "/air",
    "/local-alerts", "/global-alerts", "/my-location"})
RATE_TABLE_MAX = 20000                    # addresses remembered at most


class RateLimiter:
    """Fixed windows: each key gets `limit` hits per `window` seconds.
    Refused hits are not counted, so a client that waits Retry-After gets in."""

    def __init__(self, window=RATE_WINDOW, max_keys=RATE_TABLE_MAX, clock=time.monotonic):
        self.window, self.max_keys, self.clock = window, max_keys, clock
        self._hits = {}                   # key -> (window start, count)
        self._lock = threading.Lock()

    def hit(self, key, limit):
        """Count one request. Returns 0 if allowed, else whole seconds to wait."""
        now = self.clock()
        with self._lock:
            start, count = self._hits.get(key, (now, 0))
            if now - start >= self.window:
                start, count = now, 0
            if count >= limit:
                return max(1, math.ceil(start + self.window - now))
            if key not in self._hits and len(self._hits) >= self.max_keys:
                self._prune(now)
            self._hits[key] = (start, count + 1)
            return 0

    def _prune(self, now):
        for k in [k for k, (s, _) in self._hits.items() if now - s >= self.window]:
            del self._hits[k]
        if len(self._hits) >= self.max_keys:   # a flood of addresses: start over
            self._hits.clear()

    def reset(self):
        with self._lock:
            self._hits.clear()


rate_limiter = RateLimiter()


@app.before_request
def _apply_rate_limits():
    if request.path not in RATE_LIMITED_PATHS:
        return None
    ip = client_ip()
    if ip == "unknown":
        return None
    wait = 0
    if request.path in RATE_LIMITS:
        wait = rate_limiter.hit(f"{request.path}|{ip}", RATE_LIMITS[request.path])
    if not wait:
        wait = rate_limiter.hit(f"all|{ip}", RATE_LIMIT_ALL)
    if not wait:
        return None
    log.warning("Rate limited %s on %s (retry in %ss)", ip, request.path, wait)
    resp = jsonify({"error": "rate_limited",
                    "message": tr("Too many requests. Please wait a moment and try again."),
                    "retry_after": wait})
    resp.status_code = 429
    resp.headers["Retry-After"] = str(wait)
    resp.headers["Cache-Control"] = "no-store"
    return resp


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
    return jsonify(localize_weather(w, request_lang()))


# =================================
# LAKE AND FARM TIPS — simple rules on the weather we already have
# (thresholds and the water list are at the top of the file)
# =================================
TIP_LEVELS = ("danger", "caution", "info")       # most important first
TIP_ORDER = ("lake_thunder", "lake_rough", "farm_heavy_rain", "lake_wind", "lake_fog",
             "farm_frost", "farm_uv", "farm_fungus", "farm_drying", "farm_planting", "lake_calm")


def _num(value, default=None):
    """A finite float, else `default` (missing or bad data never raises)."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def _km_from_edge(lat, lon, a, b):
    """km from (lat, lon) to the segment a-b (flat map; fine at lake size)."""
    k_lat = 110.57
    k_lon = 111.32 * math.cos(math.radians(lat))
    ax, ay = (a[1] - lon) * k_lon, (a[0] - lat) * k_lat
    bx, by = (b[1] - lon) * k_lon, (b[0] - lat) * k_lat
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / length2))
    return math.hypot(ax + t * dx, ay + t * dy)


def _inside(lat, lon, points):
    """Point in polygon (ray casting on lat/lon)."""
    inside = False
    j = len(points) - 1
    for i, (yi, xi) in enumerate(points):
        yj, xj = points[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def water_km(lat, lon):
    """(name, km) of the nearest water in TIP_WATERS (0 inside a lake), or (None, None)."""
    lat, lon = _num(lat), _num(lon)
    if lat is None or lon is None:
        return None, None
    best = (None, None)
    for name, kind, points in TIP_WATERS:
        if kind == "area" and _inside(lat, lon, points):
            return name, 0.0
        edges = list(zip(points, points[1:]))
        if kind == "area":
            edges.append((points[-1], points[0]))
        km = min(_km_from_edge(lat, lon, a, b) for a, b in edges)
        if best[1] is None or km < best[1]:
            best = (name, km)
    return best


def in_kenya(weather):
    """True when the place's country is Kenya (searched place first, then OWM's)."""
    if not isinstance(weather, dict):
        return False
    loc = weather.get("searched_location") or {}
    sys_ = weather.get("sys") or {}
    country = (loc.get("country") if isinstance(loc, dict) else None) or sys_.get("country") or ""
    return str(country).strip().lower() in ("ke", "kenya")


def _condition_id(item):
    w = (item or {}).get("weather") or []
    first = w[0] if isinstance(w, list) and w and isinstance(w[0], dict) else {}
    return int(_num(first.get("id"), 0))


def tip_rules(weather, forecast, lat, lon):
    """The tips that apply, language-free: [{"id", "level", "params"}], at most
    TIPS_MAX, most important first. Pure: same data in, same tips out."""
    weather = weather if isinstance(weather, dict) else {}
    forecast = forecast if isinstance(forecast, dict) else {}
    slots = [i for i in (forecast.get("list") or []) if isinstance(i, dict)]
    daily = [d for d in (forecast.get("daily") or []) if isinstance(d, dict)]
    main = weather.get("main") or {}
    wind = weather.get("wind") or {}

    def slot(i, *path, default=None):
        v = i
        for key in path:
            v = v.get(key) if isinstance(v, dict) else None
        return _num(v, default)

    soon = slots[:TIP_SOON_SLOTS]
    day = slots[:TIP_DAY_SLOTS]
    two_days = slots[:TIP_TWO_DAY_SLOTS]
    found = {}

    # ---- on the water ----
    _, km = water_km(lat, lon)
    if km is not None and km <= TIP_WATER_KM:
        winds = [_num(wind.get("speed"), 0)] + [slot(i, "wind", "speed", default=0) for i in soon]
        gusts = [_num(wind.get("gust"), 0)] + [slot(i, "wind", "gust", default=0) for i in soon]
        top_wind, top_gust = max(winds), max(gusts)
        kmh = round(max(top_wind, top_gust) * 3.6)
        ids_soon = [_condition_id(weather)] + [_condition_id(i) for i in soon]
        if any(c in THUNDER_IDS for c in ids_soon):
            found["lake_thunder"] = ("danger", {})
        if top_wind >= WIND_ROUGH_MS or top_gust >= GUST_ROUGH_MS:
            found["lake_rough"] = ("danger", {"kmh": kmh})
        elif top_wind >= WIND_STRONG_MS or top_gust >= GUST_STRONG_MS:
            found["lake_wind"] = ("caution", {"kmh": kmh})
        visibility = _num(weather.get("visibility"))
        if (visibility is not None and visibility < LOW_VISIBILITY_M) or _condition_id(weather) in FOG_IDS:
            found["lake_fog"] = ("caution", {})
        if (not found and slots and wind.get("speed") is not None
                and top_wind < WIND_CALM_MS and top_gust < GUST_CALM_MS):
            found["lake_calm"] = ("info", {})

    # ---- on the farm (Kenya only) ----
    if in_kenya(weather):
        rain_day = sum(slot(i, "rain", "3h", default=0) for i in day)
        if daily:
            rain_day = max(rain_day, _num(daily[0].get("precipitation"), 0))
        if rain_day >= HEAVY_RAIN_MM_24H:
            level = "danger" if rain_day >= VERY_HEAVY_RAIN_MM_24H else "caution"
            found["farm_heavy_rain"] = (level, {"mm": round(rain_day)})

        lows = [slot(i, "main", "temp_min") for i in two_days] + \
               [_num(d.get("temp_min")) for d in daily[:2]] + [_num(main.get("temp_min"))]
        lows = [v for v in lows if v is not None]
        if lows and min(lows) <= FROST_TEMP_C:
            low = min(lows)
            found["farm_frost"] = ("danger" if low <= FROST_DANGER_C else "caution", {"temp": round(low)})

        uv_info = weather.get("uv") if isinstance(weather.get("uv"), dict) else {}
        uv = _num(uv_info.get("max_today"))
        if uv is None:
            uv = _num(uv_info.get("value"))
        if uv is None and daily:
            uv = _num(daily[0].get("uv_max"))
        if uv is not None and uv >= UV_HIGH:
            found["farm_uv"] = ("danger" if uv >= UV_EXTREME else "caution", {"uv": round(uv)})

        humidity = _num(main.get("humidity"))
        temp = _num(main.get("temp"))
        hums = [v for v in (slot(i, "main", "humidity") for i in day) if v is not None]
        avg_hum = sum(hums) / len(hums) if hums else None
        humid = max(v for v in (humidity, avg_hum, -1) if v is not None)
        warm = [v for v in [temp] + [slot(i, "main", "temp") for i in day] if v is not None]
        if humid >= HUMID_PCT and warm and max(warm) >= HUMID_MIN_TEMP_C:
            found["farm_fungus"] = ("caution", {"pct": round(humid)})

        if len(two_days) >= TIP_DAY_SLOTS:
            rain_two = sum(slot(i, "rain", "3h", default=0) for i in two_days)
            pop_two = max(slot(i, "pop", default=0) for i in two_days)
            if (rain_two <= DRY_RAIN_MM_48H and pop_two <= DRY_MAX_POP
                    and humidity is not None and humidity <= DRY_MAX_HUMIDITY):
                found["farm_drying"] = ("info", {})

        rain_today = _num(daily[0].get("precipitation"), 0) if daily else 0
        if (rain_today >= PLANT_RAIN_TODAY_MM and "farm_heavy_rain" not in found
                and "lake_thunder" not in found and _condition_id(weather) not in THUNDER_IDS):
            found["farm_planting"] = ("info", {})

    order = sorted(found, key=lambda k: (TIP_LEVELS.index(found[k][0]), TIP_ORDER.index(k)))
    return [{"id": k, "level": found[k][0], "params": found[k][1]} for k in order[:TIPS_MAX]]


def tips_for(weather, forecast, lat, lon, lang):
    """Lake and farm tips for a place in `lang`:
    [{"id", "level": info|caution|danger, "text", "params"}], at most TIPS_MAX."""
    return _with_text(tip_rules(weather, forecast, lat, lon), lang)


def _with_text(rules, lang):
    """Copies of the tips with their text in `lang`."""
    return [dict(t, text=tr(TIP_TEXTS[t["id"]], lang).format(**t["params"])) for t in rules]


def cached_tips(weather, forecast, lat, lon, lang):
    """tips_for, with the language-free rules cached along with the weather they
    come from (same place + same readings -> same tips)."""
    stamp = ((weather or {}).get("dt"), ((forecast or {}).get("list") or [{}])[0].get("dt"),
             bool((forecast or {}).get("daily")), in_kenya(weather))
    key = f"tips:{coord_key(lat, lon)}:{stamp}"
    rules = cache.get(key)
    if rules is None:
        rules = tip_rules(weather, forecast, lat, lon)
        cache.set(key, rules, TTL_WEATHER)
    return _with_text(rules, lang)


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

    lang = request_lang()
    try:
        w["tips"] = cached_tips(w, f, lat, lon, lang)   # an extra: never breaks the reply
    except Exception:
        log.exception("tips failed")
        w["tips"] = []
    return jsonify({"weather": localize_weather(w, lang), "forecast": localize_forecast(f, lang)})


# =================================
# UV INDEX — Open-Meteo only.
# (No OpenWeatherMap UV endpoint is used.)
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

    return jsonify({"value": None, "message": tr("UV index unavailable")})


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
        return jsonify({"aqi": None, "message": tr(e.message)})

    items = data.get("list") or []
    if not items:
        return jsonify({"aqi": None})
    aqi = items[0].get("main", {}).get("aqi")
    return jsonify({
        "aqi": aqi,
        "label": tr(AQI_LABELS.get(aqi, "Unknown")),
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
        return jsonify({"ok": False, "message": tr("Sorry, feedback isn't available right now. "
                                                   "Please try again later.")}), 503
    if not SENDGRID_API_KEY:
        return jsonify({"ok": False, "message": tr("Feedback not configured")}), 500

    rl_key = f"fb:{client_ip()}"
    count = cache.get(rl_key) or 0
    if count >= FEEDBACK_LIMIT:
        return jsonify({"ok": False, "message": tr("Too many messages, please try again later")}), 429
    cache.set(rl_key, count + 1, FEEDBACK_WINDOW)

    data = request.get_json(silent=True) or {}
    category = str(data.get("category", "general"))[:20]
    message = str(data.get("message", ""))[:1000]
    user_email = str(data.get("email", "")).strip()[:120]
    city = str(data.get("city", ""))[:120]
    page_url = str(data.get("page_url", ""))[:200]

    if not message.strip():
        return jsonify({"ok": False, "message": tr("Message required")}), 400

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
            return jsonify({"ok": False, "message": tr("Feedback service timed out, please try again")}), 504
        return jsonify({"ok": False, "message": tr("Could not send feedback right now")}), 502

    if r.status in (200, 201, 202):
        return jsonify({"ok": True})
    log.warning("SendGrid returned %s", r.status)
    return jsonify({"ok": False, "message": tr("Could not send feedback right now")}), 502


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
        return jsonify({"alerts": [], "error": tr("Global alerts unavailable")})

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


# Earthquakes: how far away a quake still matters depends on its size.
QUAKE_DAYS = 7
QUAKE_MIN_MAGNITUDE = 4.0
QUAKE_RADIUS_BY_MAGNITUDE = ((6.0, 1500), (5.0, 800), (4.0, 300))   # (from M, km)
QUAKE_SEARCH_RADIUS_KM = max(km for _, km in QUAKE_RADIUS_BY_MAGNITUDE)
QUAKES_RETURNED = 5
EARTH_RADIUS_KM = 6371.0088


def distance_km(lat1, lon1, lat2, lon2):
    """Great-circle (haversine) distance in km."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def quake_radius_km(magnitude):
    """M4–4.9: 300 km, M5–5.9: 800 km, M6+: 1500 km, smaller: 0 (not shown)."""
    for min_mag, km in QUAKE_RADIUS_BY_MAGNITUDE:
        if magnitude >= min_mag:
            return km
    return 0


def quake_score(magnitude, km):
    """Higher = more worth showing: stronger and closer. Shaking falls off
    roughly with 1.5·log10(distance), so e.g. an M4.8 at 120 km (1.68) beats
    an M4.2 at 50 km (1.65) and an M5.5 at 700 km (1.23)."""
    return magnitude - 1.5 * math.log10(max(km, 10.0))


def _usgs_quakes(lat, lon):
    """Quakes of the last 7 days that are close enough for their size, best
    first (see quake_score). Each has its USGS id and distance_km."""
    try:
        r = upstream("usgs", "https://earthquake.usgs.gov/fdsnws/event/1/query", params={
            "format": "geojson",
            "latitude": lat, "longitude": lon,
            "maxradiuskm": QUAKE_SEARCH_RADIUS_KM, "minmagnitude": QUAKE_MIN_MAGNITUDE,
            "starttime": (datetime.now(timezone.utc) - timedelta(days=QUAKE_DAYS))
                         .strftime("%Y-%m-%dT%H:%M:%S"),
            "orderby": "time",
            "limit": 400,
        })
        if r.status != 200:
            return None
        scored = []
        for feat in (r.json() or {}).get("features", []) or []:
            p = feat.get("properties", {}) or {}
            gc = (feat.get("geometry") or {}).get("coordinates") or [None, None, None]
            try:
                mag = float(p.get("mag"))
                q_lon, q_lat = float(gc[0]), float(gc[1])
            except (TypeError, ValueError, IndexError):
                continue
            km = distance_km(lat, lon, q_lat, q_lon)
            if km > quake_radius_km(mag):
                continue
            scored.append((quake_score(mag, km), p.get("time") or 0, {
                "id": feat.get("id") or p.get("code") or "",
                "magnitude": mag,
                "place": p.get("place") or "Unknown location",
                "time": p.get("time"),
                "url": p.get("url", ""),
                "lon": q_lon, "lat": q_lat,
                "depth": gc[2] if len(gc) > 2 else None,
                "distance_km": int(round(km)),
            }))
        scored.sort(key=lambda s: (s[0], s[1]), reverse=True)   # best, then newest
        return [q for _, _, q in scored[:QUAKES_RETURNED]]
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
        return jsonify(localize_local_alerts(cached, request_lang()))

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
    return jsonify(localize_local_alerts(result, request_lang()))


def localize_local_alerts(result, lang):
    """A copy with quake places in `lang`. Free for everyone, in every language.
    (NWS alert texts stay as the US weather service wrote them, in English.)"""
    if lang == "en":
        return result
    return dict(result, quakes=[dict(q, place=quake_place(q.get("place"), lang))
                                for q in result.get("quakes") or []])


# =================================
# START SERVER (local dev only — production runs under gunicorn)
# =================================
if __name__ == "__main__":
    app.run(
        debug=os.getenv("FLASK_DEBUG") == "1",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "5000")),
    )
