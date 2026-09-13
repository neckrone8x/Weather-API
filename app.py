from flask import Flask, jsonify, render_template, request, send_from_directory
import requests
import os
import time
from concurrent.futures import ThreadPoolExecutor
from dotenv import load_dotenv

# Load environment variables from .env
load_dotenv()

app = Flask(__name__)

# Read the OpenWeatherMap API key
API_KEY = os.getenv("OPENWEATHER_API_KEY")

# =================================
# CHECK API KEY
# =================================
if not API_KEY:
    raise RuntimeError(
        "OPENWEATHER_API_KEY is not set. Please create a .env file with OPENWEATHER_API_KEY=your_api_key"
    )


# =================================
# SIMPLE IN-MEMORY CACHE
# =================================
cache = {}
CACHE_TTL = 600  # 10 minutes


def get_cache(key):
    """Return cached data if valid, else None."""
    if key in cache:
        entry = cache[key]
        if time.time() - entry["time"] < CACHE_TTL:
            return entry["data"]
        else:
            del cache[key]
    return None


def set_cache(key, data):
    """Store data in cache with current timestamp."""
    cache[key] = {"time": time.time(), "data": data}


# =================================
# HOME PAGE
# =================================
@app.route("/")
def home():
    return render_template("weather.html")


# =================================
# PWA: MANIFEST
# =================================
@app.route("/manifest.json")
def manifest():
    return send_from_directory(
        "static", "manifest.json", mimetype="application/manifest+json"
    )


# =================================
# PWA: SERVICE WORKER
# =================================
@app.route("/service-worker.js")
def service_worker():
    return send_from_directory(
        "static", "service-worker.js", mimetype="application/javascript"
    )


# =================================
# GEOCODING
# =================================
def get_coordinates(city):
    """Convert a city name to coordinates using OpenWeatherMap Geocoding API."""
    url = "https://api.openweathermap.org/geo/1.0/direct"
    city = city.strip()

    country_codes = {
        "kenya": "KE", "angola": "AO", "uganda": "UG",
        "tanzania": "TZ", "rwanda": "RW", "burundi": "BI",
        "ethiopia": "ET", "somalia": "SO", "south africa": "ZA",
        "nigeria": "NG", "ghana": "GH", "united states": "US",
        "usa": "US", "united kingdom": "GB", "uk": "GB",
        "japan": "JP", "china": "CN", "india": "IN",
        "brazil": "BR", "mozambique": "MZ"
    }

    parts = [part.strip() for part in city.split(",")]

    if len(parts) >= 2:
        city_name = parts[0]
        country_input = parts[-1]
        country_code = country_codes.get(country_input.lower(), country_input.upper())
        query = f"{city_name},{country_code}"
    else:
        query = city

    params = {
        "q": query,
        "limit": 5,
        "appid": API_KEY
    }

    try:
        response = requests.get(url, params=params, timeout=10)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.Timeout:
        print(f"Geocoding timeout for: {city}")
        return []
    except requests.exceptions.RequestException as e:
        print(f"Geocoding error for {city}: {e}")
        return []


# =================================
# SEARCH LOCATIONS
# =================================
@app.route("/locations")
def locations():
    city = request.args.get("city")

    if not city:
        return jsonify({
            "cod": 400,
            "message": "Please enter a city"
        }), 400

    results = get_coordinates(city)

    if not results:
        return jsonify({
            "cod": 404,
            "message": "Location not found"
        }), 404

    location_results = []
    for location in results:
        location_results.append({
            "name": location.get("name", ""),
            "country": location.get("country", ""),
            "state": location.get("state", ""),
            "lat": location.get("lat"),
            "lon": location.get("lon")
        })

    return jsonify({
        "cod": 200,
        "locations": location_results
    })


# =================================
# CURRENT WEATHER
# =================================
@app.route("/weather")
def weather():
    city = request.args.get("city")
    latitude = request.args.get("lat")
    longitude = request.args.get("lon")

    url = "https://api.openweathermap.org/data/2.5/weather"

    # Weather using coordinates
    if latitude and longitude:
        try:
            latitude = float(latitude)
            longitude = float(longitude)
        except ValueError:
            return jsonify({
                "cod": 400,
                "message": "Invalid coordinates"
            }), 400

        params = {
            "lat": latitude,
            "lon": longitude,
            "appid": API_KEY,
            "units": "metric"
        }

        try:
            response = requests.get(url, params=params, timeout=10)
            response.raise_for_status()
            weather_data = response.json()
            return jsonify(weather_data)
        except requests.exceptions.Timeout:
            return jsonify({
                "cod": 504,
                "message": "Weather service timed out"
            }), 504
        except requests.exceptions.RequestException as e:
            return jsonify({
                "cod": 503,
                "message": f"Unable to connect to weather service: {str(e)}"
            }), 503

    # Weather using city name
    if not city:
        city = "Kisumu"

    try:
        locations = get_coordinates(city)
    except requests.exceptions.Timeout:
        return jsonify({
            "cod": 504,
            "message": "Location service timed out"
        }), 504
    except requests.exceptions.RequestException as e:
        return jsonify({
            "cod": 503,
            "message": f"Unable to connect to location service: {str(e)}"
        }), 503

    if not locations:
        return jsonify({
            "cod": 404,
            "message": "City not found"
        }), 404

    location = locations[0]
    latitude = location["lat"]
    longitude = location["lon"]

    params = {
        "lat": latitude,
        "lon": longitude,
        "appid": API_KEY,
        "units": "metric"
    }

    try:
        response = requests.get(url, params=params, timeout=10)
        response.raise_for_status()
        weather_data = response.json()

        weather_data["searched_location"] = {
            "name": location.get("name", city),
            "country": location.get("country", ""),
            "state": location.get("state", "")
        }

        return jsonify(weather_data)
    except requests.exceptions.Timeout:
        return jsonify({
            "cod": 504,
            "message": "Weather service timed out"
        }), 504
    except requests.exceptions.RequestException as e:
        return jsonify({
            "cod": 503,
            "message": f"Unable to connect to weather service: {str(e)}"
        }), 503


# =================================
# UV INDEX (with multiple fallbacks)
# =================================
@app.route("/uv")
def uv_index():
    lat = request.args.get("lat")
    lon = request.args.get("lon")
    if not lat or not lon:
        return jsonify({"cod": 400, "value": None, "message": "lat and lon required"}), 400

    cache_key = f"uv:lat{lat},lon{lon}"
    cached = get_cache(cache_key)
    if cached:
        return jsonify(cached)

    # Attempt 1: One Call 3.0
    try:
        response = requests.get(
            "https://api.openweathermap.org/data/3.0/onecall",
            params={
                "lat": lat,
                "lon": lon,
                "appid": API_KEY,
                "units": "metric",
                "exclude": "minutely,hourly,daily,alerts"
            },
            timeout=10
        )
        if response.status_code == 200:
            data = response.json()
            uvi = data.get("current", {}).get("uvi")
            if uvi is not None:
                result = {"value": uvi}
                set_cache(cache_key, result)
                return jsonify(result)
    except requests.exceptions.RequestException as e:
        print(f"One Call UV error: {e}")

    # Attempt 2: Legacy 2.5 endpoint
    try:
        response = requests.get(
            "https://api.openweathermap.org/data/2.5/uvi",
            params={"lat": lat, "lon": lon, "appid": API_KEY},
            timeout=10
        )
        if response.status_code == 200:
            data = response.json()
            if "value" in data:
                set_cache(cache_key, data)
                return jsonify(data)
    except requests.exceptions.RequestException as e:
        print(f"Legacy UV error: {e}")

    return jsonify({"value": None, "message": "UV index unavailable on current plan"}), 200


# =================================
# AIR POLLUTION
# =================================
@app.route("/air")
def air_pollution():
    lat = request.args.get("lat")
    lon = request.args.get("lon")
    if not lat or not lon:
        return jsonify({"cod": 400, "aqi": None, "message": "lat and lon required"}), 400

    cache_key = f"air:lat{lat},lon{lon}"
    cached = get_cache(cache_key)
    if cached:
        return jsonify(cached)

    try:
        response = requests.get(
            "https://api.openweathermap.org/data/2.5/air_pollution",
            params={"lat": lat, "lon": lon, "appid": API_KEY},
            timeout=10
        )
        response.raise_for_status()
        data = response.json()

        if "list" in data and len(data["list"]) > 0:
            aqi = data["list"][0]["main"]["aqi"]
            components = data["list"][0].get("components", {})
            result = {"aqi": aqi, "components": components}
        else:
            result = {"aqi": None}

        set_cache(cache_key, result)
        return jsonify(result)

    except requests.exceptions.RequestException as e:
        print(f"Air pollution error: {e}")
        return jsonify({"aqi": None, "message": str(e)}), 200


# =================================
# 5-DAY FORECAST
# =================================
@app.route("/forecast")
def forecast():
    city = request.args.get("city")
    latitude = request.args.get("lat")
    longitude = request.args.get("lon")

    weather_url = "https://api.openweathermap.org/data/2.5/weather"
    forecast_url = "https://api.openweathermap.org/data/2.5/forecast"

    if latitude and longitude:
        try:
            latitude = float(latitude)
            longitude = float(longitude)
        except ValueError:
            return jsonify({
                "cod": 400,
                "message": "Invalid coordinates"
            }), 400
    else:
        if not city:
            city = "Kisumu"

        locations = get_coordinates(city)
        if not locations:
            return jsonify({
                "cod": 404,
                "message": "City not found"
            }), 404

        location = locations[0]
        latitude = float(location["lat"])
        longitude = float(location["lon"])

    # Current weather (for sunrise/sunset + timezone)
    weather_params = {
        "lat": latitude,
        "lon": longitude,
        "appid": API_KEY,
        "units": "metric"
    }

    try:
        weather_response = requests.get(weather_url, params=weather_params, timeout=10)
        weather_response.raise_for_status()
        weather_data = weather_response.json()
    except requests.exceptions.Timeout:
        return jsonify({
            "cod": 504,
            "message": "Weather service timed out"
        }), 504
    except requests.exceptions.RequestException as e:
        return jsonify({
            "cod": 503,
            "message": f"Unable to connect to weather service: {str(e)}"
        }), 503

    # Forecast
    forecast_params = {
        "lat": latitude,
        "lon": longitude,
        "appid": API_KEY,
        "units": "metric"
    }

    try:
        forecast_response = requests.get(forecast_url, params=forecast_params, timeout=10)
        forecast_response.raise_for_status()
        forecast_data = forecast_response.json()
    except requests.exceptions.Timeout:
        return jsonify({
            "cod": 504,
            "message": "Forecast service timed out"
        }), 504
    except requests.exceptions.RequestException as e:
        return jsonify({
            "cod": 503,
            "message": f"Unable to connect to forecast service: {str(e)}"
        }), 503

    searched_name = weather_data.get("name", city if city else "Your Location")
    searched_country = weather_data.get("sys", {}).get("country", "")

    forecast_data["searched_location"] = {
        "name": searched_name,
        "country": searched_country
    }

    forecast_data["sunrise"] = weather_data.get("sys", {}).get("sunrise", 0)
    forecast_data["sunset"] = weather_data.get("sys", {}).get("sunset", 0)
    forecast_data["timezone"] = forecast_data.get("city", {}).get("timezone", 0)

    return jsonify(forecast_data)

# =================================
# COMBINED WEATHER + FORECAST
# (one request instead of two)
# =================================
@app.route("/weather-full")
def weather_full():
    city = request.args.get("city")
    latitude = request.args.get("lat")
    longitude = request.args.get("lon")

    weather_url = "https://api.openweathermap.org/data/2.5/weather"
    forecast_url = "https://api.openweathermap.org/data/2.5/forecast"

    # ── Resolve coordinates ──
    if latitude and longitude:
        try:
            latitude = float(latitude)
            longitude = float(longitude)
        except ValueError:
            return jsonify({"cod": 400, "message": "Invalid coordinates"}), 400

        searched_name = ""
        searched_state = ""
        searched_country = ""
    else:
        if not city:
            city = "Kisumu"

        locations = get_coordinates(city)
        if not locations:
            return jsonify({"cod": 404, "message": "City not found"}), 404

        location = locations[0]
        latitude = float(location["lat"])
        longitude = float(location["lon"])
        searched_name = location.get("name", city)
        searched_state = location.get("state", "")
        searched_country = location.get("country", "")

    params = {
        "lat": latitude,
        "lon": longitude,
        "appid": API_KEY,
        "units": "metric",
    }

    # ── Fetch both in parallel ──

    def fetch(url):
        try:
            r = requests.get(url, params=params, timeout=10)
            r.raise_for_status()
            return r.json()
        except requests.exceptions.RequestException as e:
            print(f"Fetch error for {url}: {e}")
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        weather_future = pool.submit(fetch, weather_url)
        forecast_future = pool.submit(fetch, forecast_url)
        weather_data = weather_future.result()
        forecast_data = forecast_future.result()

    if not weather_data:
        return jsonify({"cod": 503, "message": "Weather service unavailable"}), 503
    if not forecast_data:
        return jsonify({"cod": 503, "message": "Forecast service unavailable"}), 503

    # ── Attach searched location ──
    if searched_name or searched_country or searched_state:
        weather_data["searched_location"] = {
            "name": searched_name or weather_data.get("name", ""),
            "country": searched_country or weather_data.get("sys", {}).get("country", ""),
            "state": searched_state,
        }
        forecast_data["searched_location"] = {
            "name": searched_name or weather_data.get("name", ""),
            "country": searched_country or weather_data.get("sys", {}).get("country", ""),
        }

    # ── Attach forecast extras needed by the frontend ──
    forecast_data["sunrise"] = weather_data.get("sys", {}).get("sunrise", 0)
    forecast_data["sunset"]  = weather_data.get("sys", {}).get("sunset", 0)
    forecast_data["timezone"] = forecast_data.get("city", {}).get("timezone", 0)

    return jsonify({
        "weather": weather_data,
        "forecast": forecast_data,
    })

# =================================
# REVERSE GEOCODING (Nominatim — most precise)
# =================================
@app.route("/reverse")
def reverse():
    lat = request.args.get("lat")
    lon = request.args.get("lon")
    if not lat or not lon:
        return jsonify({"name": "", "state": "", "country": ""}), 200

    cache_key = f"reverse:lat{lat},lon{lon}"
    cached = get_cache(cache_key)
    if cached:
        return jsonify(cached)

    try:
        response = requests.get(
            "https://nominatim.openstreetmap.org/reverse",
            params={
                "lat": lat,
                "lon": lon,
                "format": "json",
                "zoom": 14,
                "addressdetails": 1
            },
            headers={
                "User-Agent": "Neckrone8xWeather/1.0 (contact@neckrone8x.co.ke)"
            },
            timeout=10
        )
        response.raise_for_status()
        data = response.json()
        addr = data.get("address", {})

        name = (
            addr.get("village") or
            addr.get("hamlet") or
            addr.get("suburb") or
            addr.get("neighbourhood") or
            addr.get("town") or
            addr.get("city") or
            data.get("name") or
            ""
        )

        state = addr.get("state") or addr.get("county") or ""
        country = (addr.get("country_code") or "").upper()

        result = {
            "name": name,
            "state": state,
            "country": country
        }
        set_cache(cache_key, result)
        return jsonify(result)

    except requests.exceptions.RequestException as e:
        print(f"Nominatim error: {e}")
        return jsonify({"name": "", "state": "", "country": ""}), 200

# =================================
# IP-BASED LOCATION (for first-time visitors)
# =================================
@app.route("/my-location")
def my_location():
    # Get client IP — handle proxies like Render, Cloudflare, etc.
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        client_ip = forwarded.split(",")[0].strip()
    else:
        client_ip = request.remote_addr or ""

    # Localhost / private IPs can't be geolocated
    if (
        not client_ip
        or client_ip in ("127.0.0.1", "localhost", "::1")
        or client_ip.startswith("10.")
        or client_ip.startswith("192.168.")
        or client_ip.startswith("172.")
    ):
        return jsonify({
            "name": "", "state": "", "country": "",
            "lat": None, "lon": None
        }), 200

    cache_key = f"iploc:{client_ip}"
    cached = get_cache(cache_key)
    if cached:
        return jsonify(cached)

    try:
        response = requests.get(
            f"https://ipapi.co/{client_ip}/json/",
            headers={"User-Agent": "Neckrone8xWeather/1.0"},
            timeout=8
        )
        response.raise_for_status()
        data = response.json()

        result = {
            "name": data.get("city") or "",
            "state": data.get("region") or "",
            "country": (data.get("country_code") or "").upper(),
            "lat": data.get("latitude"),
            "lon": data.get("longitude")
        }

        if result["name"] and result["lat"] and result["lon"]:
            set_cache(cache_key, result)

        return jsonify(result)

    except requests.exceptions.RequestException as e:
        print(f"IP geolocation error: {e}")
        return jsonify({
            "name": "", "state": "", "country": "",
            "lat": None, "lon": None
        }), 200

# =================================
# FEEDBACK → EMAIL (SendGrid)
# =================================
SENDGRID_API_KEY = os.getenv("SENDGRID_API_KEY")
FEEDBACK_TO_EMAIL = "bradleyrex32@gmail.com"

@app.route("/feedback", methods=["POST"])
def feedback():
    print(f"[feedback] SendGrid key present: {bool(SENDGRID_API_KEY)}")

    if not SENDGRID_API_KEY:
        return jsonify({"ok": False, "message": "Feedback not configured"}), 500

    data = request.get_json(silent=True) or {}
    category = str(data.get("category", "general"))[:20]
    message = str(data.get("message", ""))[:1000]
    user_email = str(data.get("email", "")).strip()[:120]
    city = str(data.get("city", ""))[:120]
    page_url = str(data.get("page_url", ""))[:200]

    if not message.strip():
        return jsonify({"ok": False, "message": "Message required"}), 400

    body = f"""
New feedback from Neckrone8x Weather

Category:    {category}
From city:   {city}
Page URL:    {page_url}
User email:  {user_email or "(not provided)"}

Message:
{message}
    """.strip()

    try:
        from sendgrid import SendGridAPIClient
        from sendgrid.helpers.mail import Mail

        email_message = Mail(
            from_email=FEEDBACK_TO_EMAIL,
            to_emails=FEEDBACK_TO_EMAIL,
            subject=f"[Neckrone8x Weather] {category.upper()} feedback",
            plain_text_content=body
        )

        if user_email and "@" in user_email:
            email_message.reply_to = user_email

        sg = SendGridAPIClient(SENDGRID_API_KEY)
        response = sg.send(email_message)
        print(f"[feedback] SendGrid status: {response.status_code}")

        if response.status_code in (200, 201, 202):
            return jsonify({"ok": True})
        return jsonify({"ok": False, "message": f"SendGrid returned {response.status_code}"}), 500

    except Exception as e:
        print(f"[feedback] error: {e}")
        return jsonify({"ok": False, "message": str(e)}), 500

# =================================
# GLOBAL DISASTER ALERTS (GDACS)
# =================================
@app.route("/global-alerts")
def global_alerts():
    """Fetch recent major disaster events from GDACS."""
    cache_key = "global-alerts"
    cached = get_cache(cache_key)
    if cached:
        return jsonify(cached)

    try:
        # Get events from the last 30 days, red/orange alerts only
        from datetime import datetime, timedelta
        end_date = datetime.now().strftime("%Y-%m-%d")
        start_date = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")

        response = requests.get(
            "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH",
            params={
                "fromdate": start_date,
                "todate": end_date,
                "alertlevel": "red;orange",
                "pagesize": 20
            },
            timeout=10
        )
        response.raise_for_status()
        data = response.json()

        features = data.get("features", [])
        alerts = []
        for f in features:
            props = f.get("properties", {})
            alerts.append({
                "id": props.get("eventid"),
                "type": props.get("eventtype", ""),
                "name": props.get("name", "Unknown event"),
                "alertlevel": props.get("alertlevel", "Green"),
                "country": props.get("country", ""),
                "date": props.get("fromdate", ""),
                "lat": f.get("geometry", {}).get("coordinates", [None, None])[1] if f.get("geometry") else None,
                "lon": f.get("geometry", {}).get("coordinates", [None, None])[0] if f.get("geometry") else None,
                "url": f"https://www.gdacs.org/report.aspx?eventid={props.get('eventid')}&eventtype={props.get('eventtype')}"
            })

        # Sort by alert level (Red first) then date
        order = {"Red": 0, "Orange": 1, "Green": 2}
        alerts.sort(key=lambda a: (order.get(a["alertlevel"], 9), a["date"]))

        result = {"alerts": alerts[:15], "count": len(alerts)}
        set_cache(cache_key, result)
        return jsonify(result)

    except requests.exceptions.RequestException as e:
        print(f"GDACS error: {e}")
        return jsonify({"alerts": [], "error": str(e)}), 200


# =================================
# LOCAL ALERTS (NWS + USGS)
# =================================
@app.route("/local-alerts")
def local_alerts():
    """Fetch active weather alerts (NWS) and recent earthquakes (USGS) near coordinates."""
    lat = request.args.get("lat")
    lon = request.args.get("lon")
    if not lat or not lon:
        return jsonify({"alerts": [], "quakes": []}), 200

    cache_key = f"local-alerts:lat{lat},lon{lon}"
    cached = get_cache(cache_key)
    if cached:
        return jsonify(cached)

    alerts = []
    quakes = []

    # ── NWS active alerts (US only) ──
    try:
        response = requests.get(
            "https://api.weather.gov/alerts/active",
            params={"point": f"{lat},{lon}"},
            headers={"User-Agent": "Neckrone8xWeather/1.0 (contact@neckrone8x.co.ke)"},
            timeout=10
        )
        if response.status_code == 200:
            data = response.json()
            for feat in data.get("features", [])[:5]:
                props = feat.get("properties", {})
                alerts.append({
                    "event": props.get("event", "Weather Alert"),
                    "severity": props.get("severity", "Unknown"),
                    "headline": props.get("headline", ""),
                    "description": (props.get("description") or "")[:300],
                    "onset": props.get("onset", ""),
                    "expires": props.get("expires", "")
                })
    except requests.exceptions.RequestException as e:
        print(f"NWS alert error: {e}")

    # ── USGS recent earthquakes (global) ──
    try:
        # Find earthquakes within ~5 degrees (~500km) in the last 7 days
        response = requests.get(
            "https://earthquake.usgs.gov/fdsnws/event/1/query",
            params={
                "format": "geojson",
                "latitude": lat,
                "longitude": lon,
                "maxradiuskm": 500,
                "minmagnitude": 4.0,
                "starttime": (__import__("datetime").datetime.now() - __import__("datetime").timedelta(days=7)).strftime("%Y-%m-%d")
            },
            timeout=10
        )
        if response.status_code == 200:
            data = response.json()
            for feat in data.get("features", [])[:3]:
                props = feat.get("properties", {})
                geo = feat.get("geometry", {}).get("coordinates", [None, None, None])
                quakes.append({
                    "magnitude": props.get("mag"),
                    "place": props.get("place", "Unknown location"),
                    "time": props.get("time"),
                    "url": props.get("url", ""),
                    "lon": geo[0],
                    "lat": geo[1],
                    "depth": geo[2]
                })
    except requests.exceptions.RequestException as e:
        print(f"USGS error: {e}")

    result = {"alerts": alerts, "quakes": quakes}
    set_cache(cache_key, result)
    return jsonify(result)

# =================================
# START SERVER
# =================================
if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)