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
# WEATHER API
# =================================

@app.route("/weather")
def weather():

    # Get city from URL
    city = request.args.get("city")


    # Get GPS coordinates from URL
    latitude = request.args.get("lat")
    longitude = request.args.get("lon")


    # OpenWeather URL
    url = "https://api.openweathermap.org/data/2.5/weather"


    # =================================
    # WEATHER BY GPS LOCATION
    # =================================

    if latitude and longitude:

        params = {
            "lat": latitude,
            "lon": longitude,
            "appid": API_KEY,
            "units": "metric"
        }


    # =================================
    # WEATHER BY CITY
    # =================================

    else:

        if not city:
            city = "Kisumu"


        params = {
            "q": city,
            "appid": API_KEY,
            "units": "metric"
        }


    # =================================
    # REQUEST OPENWEATHER
    # =================================

    response = requests.get(
        url,
        params=params
    )


    return jsonify(
        response.json()
    )


# =================================
# START SERVER
# =================================

if __name__ == "__main__":

    app.run(
        debug=True
    )

    # =================================
# 5-DAY FORECAST
# =================================

@app.route("/forecast")
def forecast():

    city = request.args.get("city", "Kisumu")

    url = "https://api.openweathermap.org/data/2.5/forecast"

    params = {
        "q": city,
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