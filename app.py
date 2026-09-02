from flask import Flask, jsonify, render_template, request
import requests
import os
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

API_KEY = os.getenv("OPENWEATHER_API_KEY")


# =================================
# HOME PAGE
# =================================

@app.route("/")
def home():

    return render_template("weather.html")


# =================================
# GEOCODING
# =================================

def get_coordinates(city):

    url = (
        "https://api.openweathermap.org/"
        "geo/1.0/direct"
    )

    city = city.strip()

    # =================================
    # COUNTRY NAME → COUNTRY CODE
    # =================================

    parts = [
        part.strip()
        for part in city.split(",")
    ]

    country_codes = {

        "kenya": "KE",
        "angola": "AO",
        "uganda": "UG",
        "tanzania": "TZ",
        "rwanda": "RW",
        "burundi": "BI",
        "ethiopia": "ET",
        "somalia": "SO",
        "south africa": "ZA",
        "nigeria": "NG",
        "ghana": "GH",
        "united states": "US",
        "usa": "US",
        "united kingdom": "GB",
        "uk": "GB",
        "japan": "JP",
        "china": "CN",
        "india": "IN",
        "brazil": "BR",
        "mozambique": "MZ"

    }


    # =================================
    # CITY + COUNTRY
    # =================================

    if len(parts) >= 2:

        city_name = parts[0]

        country_input = parts[-1]

        country_code = country_codes.get(
            country_input.lower(),
            country_input.upper()
        )

        query = (
            f"{city_name},{country_code}"
        )

    else:

        query = city


    # =================================
    # REQUEST GEOCODING
    # =================================

    params = {

        "q": query,

        "limit": 5,

        "appid": API_KEY

    }


    response = requests.get(
        url,
        params=params
    )

    return response.json()

# =================================
# SEARCH LOCATIONS
# =================================

@app.route("/locations")
def locations():

    city = request.args.get("city")


    if not city:

        return jsonify({

            "cod": 400,

            "message":
                "Please enter a city"

        })


    # =================================
    # GET LOCATIONS
    # =================================

    results = get_coordinates(city)


    if not results:

        return jsonify({

            "cod": 404,

            "message":
                "Location not found"

        })


    # =================================
    # PREPARE RESULTS
    # =================================

    location_results = []


    for location in results:

        location_results.append({

            "name":
                location.get(
                    "name",
                    ""
                ),

            "country":
                location.get(
                    "country",
                    ""
                ),

            "state":
                location.get(
                    "state",
                    ""
                ),

            "lat":
                location.get(
                    "lat"
                ),

            "lon":
                location.get(
                    "lon"
                )

        })


    return jsonify({

        "cod": 200,

        "locations":
            location_results

    })


# =================================
# CURRENT WEATHER
# =================================

@app.route("/weather")
def weather():

    city = request.args.get("city")

    latitude = request.args.get("lat")

    longitude = request.args.get("lon")


    # =================================
    # WEATHER USING COORDINATES
    # =================================

    if latitude and longitude:

        url = (
            "https://api.openweathermap.org/"
            "data/2.5/weather"
        )

        params = {

            "lat": latitude,

            "lon": longitude,

            "appid": API_KEY,

            "units": "metric"

        }


        response = requests.get(
            url,
            params=params
        )


        return jsonify(
            response.json()
        )


    # =================================
    # DEFAULT CITY
    # =================================

    if not city:

        city = "Kisumu"


    # =================================
    # FIND CITY
    # =================================

    locations = get_coordinates(city)


    if not locations:

        return jsonify({

            "cod": 404,

            "message":
                "City not found"

        })


    # =================================
    # FIRST LOCATION
    # =================================

    location = locations[0]


    latitude = location["lat"]

    longitude =location["lon"]


    # =================================
    # CURRENT WEATHER
    # =================================

    url = (
        "https://api.openweathermap.org/"
        "data/2.5/weather"
    )

    params = {

        "lat": latitude,

        "lon": longitude,

        "appid": API_KEY,

        "units": "metric"

    }


    response = requests.get(
        url,
        params=params
    )


    weather_data = response.json()


    # =================================
    # PRESERVE SEARCHED LOCATION
    # =================================

    weather_data[
        "searched_location"
    ] = {

        "name":
            location.get(
                "name",
                city
            ),

        "country":
            location.get(
                "country",
                ""
            )

    }


    return jsonify(
        weather_data
    )


# =================================
# 5-DAY FORECAST
# =================================

@app.route("/forecast")
def forecast():

    city = request.args.get(
        "city"
    )

    latitude = request.args.get("lat")

    longitude = request.args.get("lon")


    # =================================
    # FORECAST USING COORDINATES
    # =================================

    if latitude and longitude:

        url = (
            "https://api.openweathermap.org/"
            "data/2.5/forecast"
        )

        params = {

            "lat": latitude,

            "lon": longitude,

            "appid": API_KEY,

            "units": "metric"

        }


        response = requests.get(
            url,
            params=params
        )


        return jsonify(
            response.json()
        )


    # =================================
    # DEFAULT CITY
    # =================================

    if not city:

        city = "Kisumu"


    # =================================
    # FIND CITY
    # =================================

    locations = get_coordinates(city)


    if not locations:

        return jsonify({

            "cod": 404,

            "message":
                "City not found"

        })


    # =================================
    # FIRST LOCATION
    # =================================

    location = locations[0]


    latitude = location["lat"]

    longitude = location["lon"]


    # =================================
    # FORECAST API
    # =================================

    url = (
        "https://api.openweathermap.org/"
        "data/2.5/forecast"
    )


    params = {

        "lat": latitude,

        "lon": longitude,

        "appid": API_KEY,

        "units": "metric"

    }


    response = requests.get(
        url,
        params=params
    )


    forecast_data = response.json()


    # =================================
    # PRESERVE LOCATION
    # =================================

    forecast_data[
        "searched_location"
    ] = {

        "name":
            location.get(
                "name",
                city
            ),

        "country":
            location.get(
                "country",
                ""
            )

    }


    return jsonify(
        forecast_data
    )


# =================================
# START SERVER
# =================================

if __name__ == "__main__":

    app.run(
        debug=True
    )