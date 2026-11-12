"""
8X Weather (Neckrone8x Weather) — Flask backend.

Upstreams:
  - OpenWeatherMap: current weather, 3-hourly 5-day forecast, geocoding, air pollution
  - Open-Meteo (free, no key): UV index + 16-day daily forecast
  - Nominatim: reverse geocoding        - ipapi.co: IP location
  - GDACS / NWS / USGS: alerts          - SendGrid: feedback email
"""
import copy
import ipaddress
import logging
import os
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, send_from_directory
from requests.adapters import HTTPAdapter
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
USER_AGENT = "Neckrone8xWeather/2.0 (contact@neckrone8x.co.ke)"
DEFAULT_CITY = "Kisumu"

# Cache lifetimes (seconds)
TTL_WEATHER = 600         # current weather + forecast
TTL_OPEN_METEO = 1800     # UV + daily outlook
TTL_GEOCODE = 86400       # city -> coordinates barely ever changes
TTL_REVERSE = 86400
TTL_AIR = 1800
TTL_IP = 21600
TTL_ALERTS = 900


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


cache = TTLCache()


# =================================
# HTTP SESSION (connection pooling + retries on 5xx)
# =================================
def _make_session():
    s = requests.Session()
    retry = Retry(
        total=2,
        backoff_factor=0.4,
        status_forcelist=(500, 502, 503, 504),
        allowed_methods=frozenset(["GET"]),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=20, pool_maxsize=20)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    s.headers.update({"User-Agent": USER_AGENT})
    return s


http = _make_session()
executor = ThreadPoolExecutor(max_workers=8)


# =================================
# ERRORS
# Never put str(exception) in a response: requests' messages include the
# full URL, and the URL contains ?appid=<your API key>.
# =================================
class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


@app.errorhandler(ApiError)
def handle_api_error(err):
    return jsonify({"cod": err.status, "message": err.message}), err.status


def coord_key(lat, lon):
    """~1 km precision, so nearby requests share cache entries."""
    return f"{round(lat, 2):.2f},{round(lon, 2):.2f}"


def owm_get(path, params, cache_key=None, ttl=TTL_WEATHER, units=True):
    if cache_key:
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

    query = dict(params, appid=API_KEY)
    if units:
        query["units"] = "metric"

    try:
        r = http.get(OWM_BASE + path, params=query, timeout=10)
    except requests.exceptions.Timeout:
        log.warning("OWM timeout: %s", path)
        raise ApiError(504, "Weather service timed out")
    except requests.exceptions.RequestException as e:
        log.warning("OWM connection error on %s: %s", path, type(e).__name__)
        raise ApiError(503, "Weather service unavailable")

    if r.status_code == 401:
        log.error("OWM rejected the API key (401) on %s — check OPENWEATHER_API_KEY", path)
        raise ApiError(502, "Weather service configuration error")
    if r.status_code == 404:
        raise ApiError(404, "Location not found")
    if r.status_code == 429:
        log.warning("OWM rate limit hit on %s", path)
        raise ApiError(503, "Weather service is busy, please try again shortly")
    if not r.ok:
        log.warning("OWM %s returned %s", path, r.status_code)
        raise ApiError(502, "Weather service error")

    try:
        data = r.json()
    except ValueError:
        raise ApiError(502, "Weather service returned an invalid response")

    if cache_key:
        cache.set(cache_key, data, ttl)
    return data


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


def get_forecast(lat, lon):
    key = f"fc:{coord_key(lat, lon)}"
    cached = cache.get(key)
    if cached is not None:
        return cached

    data = owm_get("/data/2.5/forecast", {"lat": lat, "lon": lon})
    tz = int(data.get("city", {}).get("timezone", 0) or 0)

    # OWM's dt_txt is UTC. Add a local-time version so the frontend groups
    # days by the location's calendar day, not by UTC midnight.
    for item in data.get("list", []):
        dt = item.get("dt")
        if dt is not None:
            item["dt_txt_local"] = datetime.fromtimestamp(
                int(dt) + tz, tz=timezone.utc
            ).strftime("%Y-%m-%d %H:%M:%S")

    data["timezone"] = tz
    cache.set(key, data, TTL_WEATHER)
    return data


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


def get_open_meteo(lat, lon):
    """UV index (now + today's max) and a 16-day daily outlook. Returns None on failure."""
    key = f"om:{coord_key(lat, lon)}"
    cached = cache.get(key)
    if cached is not None:
        return cached

    try:
        r = http.get(OPEN_METEO_URL, params={
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
        }, timeout=8)
        r.raise_for_status()
        data = r.json()
    except (requests.exceptions.RequestException, ValueError) as e:
        log.warning("Open-Meteo error: %s", type(e).__name__)
        return None

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
    f1 = executor.submit(get_current, lat, lon)
    f2 = executor.submit(get_forecast, lat, lon)
    w, f = attach_location(f1.result(), f2.result(), searched)
    return jsonify(f)


# =================================
# COMBINED WEATHER + FORECAST + DAILY OUTLOOK (one request)
# =================================
@app.route("/weather-full")
def weather_full():
    lat, lon, searched = resolve_location()

    fut_cur = executor.submit(get_current, lat, lon)
    fut_fc = executor.submit(get_forecast, lat, lon)
    fut_om = executor.submit(get_open_meteo, lat, lon)

    current = fut_cur.result()      # ApiError propagates to the handler
    fc = fut_fc.result()
    try:
        om = fut_om.result()
    except Exception:
        om = None

    w, f = attach_location(current, fc, searched)
    if om:
        f["daily"] = om["daily"]
        w["uv"] = {"value": om["uv"], "max_today": om["uv_max_today"]}

    return jsonify({"weather": w, "forecast": f})


# =================================
# UV INDEX
# OWM's 2.5/uvi endpoint is retired and One Call 3.0 needs a separate
# subscription, so Open-Meteo is the primary source now.
# =================================
@app.route("/uv")
def uv_index():
    lat, lon = require_coords()

    om = get_open_meteo(lat, lon)
    if om and om["uv"] is not None:
        return jsonify({"value": om["uv"], "max_today": om["uv_max_today"], "source": "open-meteo"})

    # Fallback: One Call 3.0 (works only if your key has it enabled)
    try:
        data = owm_get("/data/3.0/onecall",
                       {"lat": lat, "lon": lon, "exclude": "minutely,hourly,daily,alerts"},
                       cache_key=f"uv3:{coord_key(lat, lon)}", ttl=TTL_OPEN_METEO)
        uvi = (data.get("current") or {}).get("uvi")
        if uvi is not None:
            return jsonify({"value": uvi, "source": "openweathermap"})
    except ApiError:
        pass

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
        r = http.get("https://nominatim.openstreetmap.org/reverse", params={
            "lat": lat, "lon": lon, "format": "json", "zoom": 14, "addressdetails": 1,
        }, timeout=10)
        r.raise_for_status()
        data = r.json()
    except (requests.exceptions.RequestException, ValueError) as e:
        log.warning("Nominatim error: %s", type(e).__name__)
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
        r = http.get(f"https://ipapi.co/{ip}/json/", timeout=8)
        r.raise_for_status()
        data = r.json()
    except (requests.exceptions.RequestException, ValueError) as e:
        log.warning("IP geolocation error: %s", type(e).__name__)
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
# FEEDBACK -> EMAIL (SendGrid)
# =================================
SENDGRID_API_KEY = os.getenv("SENDGRID_API_KEY")
FEEDBACK_TO_EMAIL = os.getenv("FEEDBACK_TO_EMAIL", "bradleyrex32@gmail.com")
FEEDBACK_LIMIT = 5          # messages per IP...
FEEDBACK_WINDOW = 600       # ...per 10 minutes


@app.route("/feedback", methods=["POST"])
def feedback():
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

    try:
        from sendgrid import SendGridAPIClient
        from sendgrid.helpers.mail import Mail

        mail = Mail(
            from_email=FEEDBACK_TO_EMAIL,
            to_emails=FEEDBACK_TO_EMAIL,
            subject=f"[Neckrone8x Weather] {category.upper()} feedback",
            plain_text_content=body,
        )
        if user_email and "@" in user_email:
            mail.reply_to = user_email

        resp = SendGridAPIClient(SENDGRID_API_KEY).send(mail)
        if resp.status_code in (200, 201, 202):
            return jsonify({"ok": True})
        log.warning("SendGrid returned %s", resp.status_code)
    except Exception as e:
        log.error("Feedback send failed: %s", e)

    return jsonify({"ok": False, "message": "Could not send feedback right now"}), 500


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
        r = http.get("https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH", params={
            "fromdate": (now - timedelta(days=30)).strftime("%Y-%m-%d"),
            "todate": now.strftime("%Y-%m-%d"),
            "alertlevel": "red;orange",
            "pagesize": 20,
        }, timeout=10)
        if r.status_code == 204:          # GDACS sends 204 when nothing matches
            features = []
        else:
            r.raise_for_status()
            features = r.json().get("features", [])
    except (requests.exceptions.RequestException, ValueError) as e:
        log.warning("GDACS error: %s", type(e).__name__)
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
# =================================
def _nws_alerts(lat, lon):
    try:
        r = http.get("https://api.weather.gov/alerts/active",
                     params={"point": f"{lat:.4f},{lon:.4f}"},
                     headers={"Accept": "application/geo+json"}, timeout=8)
        if r.status_code != 200:      # non-US points return 400 — expected
            return []
        out = []
        for feat in r.json().get("features", [])[:5]:
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
    except (requests.exceptions.RequestException, ValueError) as e:
        log.warning("NWS error: %s", type(e).__name__)
        return []


def _usgs_quakes(lat, lon):
    try:
        r = http.get("https://earthquake.usgs.gov/fdsnws/event/1/query", params={
            "format": "geojson",
            "latitude": lat, "longitude": lon,
            "maxradiuskm": 500, "minmagnitude": 4.0,
            "starttime": (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d"),
            "orderby": "time",
        }, timeout=8)
        if r.status_code != 200:
            return []
        out = []
        for feat in r.json().get("features", [])[:3]:
            p = feat.get("properties", {})
            g = (feat.get("geometry") or {}).get("coordinates") or [None, None, None]
            out.append({
                "magnitude": p.get("mag"),
                "place": p.get("place", "Unknown location"),
                "time": p.get("time"),
                "url": p.get("url", ""),
                "lon": g[0], "lat": g[1], "depth": g[2] if len(g) > 2 else None,
            })
        return out
    except (requests.exceptions.RequestException, ValueError) as e:
        log.warning("USGS error: %s", type(e).__name__)
        return []


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

    f_nws = executor.submit(_nws_alerts, lat, lon)
    f_usgs = executor.submit(_usgs_quakes, lat, lon)
    result = {"alerts": f_nws.result(), "quakes": f_usgs.result()}
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
