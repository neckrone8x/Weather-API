from flask import Flask, jsonify, render_template, request, send_from_directory
import requests
import os
import time
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
    return send_from_directory("static", "manifest.json", mimetype="application/manifest+json")


# =================================
# PWA: SERVICE WORKER
# =================================
@app.route("/service-worker.js")
def service_worker():
    return send_from_directory("static", "service-worker.js", mimetype="application/javascript")

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

    # Nominatim — requires a User-Agent header
    try:
        response = requests.get(
            "https://nominatim.openstreetmap.org/reverse",
            params={
                "lat": lat,
                "lon": lon,
                "format": "json",
                "zoom": 14,          # neighbourhood/village level
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

        # Pick the most precise locality available
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
# START SERVER
# =================================
if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)