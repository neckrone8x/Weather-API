/* =========================================================
   GLOBAL STATE
========================================================= */
let currentLocation = null;
let selectedTimezoneOffset = 0;

let themeMode = localStorage.getItem("weatherTheme") || "auto";

let currentSunrise = null;
let currentSunset = null;
let currentTimezone = null;

window._currentWeatherData = null;
window._lastForecastData = null;

let autoRefreshTimer = null;
const AUTO_REFRESH_MS = 5 * 60 * 1000;   // 5 minutes
window._loadedLocation = null;
let savedLocations = JSON.parse(localStorage.getItem("weatherSavedLocations") || "[]");

let unitMode = localStorage.getItem("weatherUnit") || "metric";


/* =========================================================
   ELEMENT HELPER
========================================================= */
function getElement(id) {
    return document.getElementById(id);
}


/* =========================================================
   LOCAL CACHE — instant load on next visit
========================================================= */
const WEATHER_CACHE_KEY = "neckrone8x_weather_cache";
const FORECAST_CACHE_KEY = "neckrone8x_forecast_cache";
const CACHE_MAX_AGE = 60 * 60 * 1000;   // 1 hour

function saveWeatherToCache(weatherData, forecastData) {
    try {
        if (weatherData) {
            localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({
                data: weatherData,
                time: Date.now()
            }));
        }
        if (forecastData) {
            localStorage.setItem(FORECAST_CACHE_KEY, JSON.stringify({
                data: forecastData,
                time: Date.now()
            }));
        }
    } catch (e) {
        console.warn("Cache save failed:", e);
    }
}

function loadWeatherFromCache() {
    try {
        const raw = localStorage.getItem(WEATHER_CACHE_KEY);
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (!entry || !entry.data) return null;
        if (Date.now() - entry.time > CACHE_MAX_AGE) return null;
        return entry.data;
    } catch { return null; }
}

function loadForecastFromCache() {
    try {
        const raw = localStorage.getItem(FORECAST_CACHE_KEY);
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (!entry || !entry.data) return null;
        if (Date.now() - entry.time > CACHE_MAX_AGE) return null;
        return entry.data;
    } catch { return null; }
}

function setControlsVisibility(visible) {
    const controlsBar = document.querySelector(".controls-bar");
    const savedEl = getElement("saved-locations");
    const display = visible ? "" : "none";
    if (controlsBar) controlsBar.style.display = display;
    if (savedEl) savedEl.style.display = display;
}


/* =========================================================
   COUNTRY NAME
========================================================= */
function getCountryName(countryCode) {
    if (!countryCode) return "";
    try {
        return new Intl.DisplayNames(["en"], { type: "region" }).of(countryCode);
    } catch {
        return countryCode;
    }
}


/* =========================================================
   WEATHER ICON
========================================================= */
function getWeatherIcon(weatherId, iconCode = "") {
    const isNight = String(iconCode).endsWith("n");

    if (weatherId >= 200 && weatherId <= 232) return "⛈️";
    if (weatherId >= 300 && weatherId <= 321) return "🌦️";
    if (weatherId >= 500 && weatherId <= 531) return "🌧️";
    if (weatherId >= 600 && weatherId <= 622) return "❄️";
    if (weatherId >= 701 && weatherId <= 781) return "🌫️";
    if (weatherId === 800) return isNight ? "🌙" : "☀️";
    if (weatherId === 801) return isNight ? "🌙☁️" : "🌤️";
    if (weatherId === 802) return isNight ? "🌙☁️" : "⛅";
    if (weatherId === 803) return isNight ? "🌙☁️" : "🌥️";
    if (weatherId === 804) return "☁️";
    return "🌤️";
}


/* =========================================================
   CONDITION TEXT
========================================================= */
function getConditionText(weatherId, description = "") {
    if (weatherId === 800) return "Sunny";
    if (weatherId === 801) return "Partly cloudy";
    if (weatherId === 802) return "Scattered clouds";
    if (weatherId === 803) return "Broken clouds";
    if (weatherId === 804) return "Overcast";
    if (weatherId >= 200 && weatherId <= 232) return "Thunderstorm";
    if (weatherId >= 300 && weatherId <= 321) return "Drizzle";
    if (weatherId >= 500 && weatherId <= 531) return "Rain";
    if (weatherId >= 600 && weatherId <= 622) return "Snow";
    if (weatherId >= 701 && weatherId <= 781) return "Foggy";
    return description || "Unknown";
}


/* =========================================================
   WIND DIRECTION TO COMPASS
========================================================= */
function degreesToCompass(deg) {
    if (!Number.isFinite(deg)) return "";
    const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return dirs[Math.round(deg / 22.5) % 16];
}


/* =========================================================
   FORMAT LOCATION
========================================================= */
function formatLocation(name, state, country) {
    let result = name || "Unknown location";

    // Skip state if it's redundant (e.g., "Mombasa" + "Mombasa County")
    if (state) {
        const cityLower = String(name).toLowerCase().replace(/\s+county$/i, "").trim();
        const stateLower = String(state).toLowerCase().replace(/\s+county$/i, "").trim();
        const isRedundant = cityLower === stateLower ||
                           stateLower.includes(cityLower) ||
                           cityLower.includes(stateLower);
        if (!isRedundant) {
            result += `, ${state}`;
        }
    }

    if (country) result += `, ${getCountryName(country)}`;
    return result;
}


/* =========================================================
   UNIT CONVERSION HELPERS
========================================================= */
function convertTemp(celsius) {
    const c = Number(celsius);
    if (!Number.isFinite(c)) return null;
    return unitMode === "imperial" ? (c * 9/5) + 32 : c;
}

function tempUnit() {
    return unitMode === "imperial" ? "°F" : "°C";
}

function speedUnit() {
    return unitMode === "imperial" ? "mph" : "m/s";
}

function convertSpeed(mps) {
    const s = Number(mps);
    if (!Number.isFinite(s)) return null;
    return unitMode === "imperial" ? s * 2.23694 : s;
}

function formatTemp(celsius, decimals = 1) {
    const t = convertTemp(celsius);
    return t === null ? "--" : t.toFixed(decimals);
}

function formatSpeed(mps, decimals = 1) {
    const s = convertSpeed(mps);
    return s === null ? "--" : s.toFixed(decimals);
}


/* =========================================================
   APPLY THEME
========================================================= */
function applyTheme() {
    let isDay;

    if (themeMode === "light") {
        isDay = true;
    } else if (themeMode === "dark") {
        isDay = false;
    } else {
        if (currentSunrise && currentSunset && currentTimezone !== null) {
            const now = Math.floor(Date.now() / 1000);
            const localNow = now + Number(currentTimezone);
            const localSunrise = Number(currentSunrise) + Number(currentTimezone);
            const localSunset = Number(currentSunset) + Number(currentTimezone);
            isDay = localNow >= localSunrise && localNow < localSunset;
        } else {
            isDay = true;
        }
    }

    document.body.classList.toggle("day-theme", isDay);
    document.body.classList.toggle("night-theme", !isDay);

    const card = document.querySelector(".weather-card");
    if (card) {
        card.classList.toggle("day-theme", isDay);
        card.classList.toggle("night-theme", !isDay);
    }

    const btn = getElement("theme-toggle");
    if (btn) {
        if (themeMode === "auto") {
            btn.textContent = "🌗";
            btn.title = "Theme: Auto (follows sun) — click for Light";
        } else if (themeMode === "light") {
            btn.textContent = "☀️";
            btn.title = "Theme: Light — click for Dark";
        } else {
            btn.textContent = "🌙";
            btn.title = "Theme: Dark — click for Auto";
        }
    }
}

function updateTheme(sunrise, sunset, timezone) {
    currentSunrise = sunrise;
    currentSunset = sunset;
    currentTimezone = timezone;
    applyTheme();
}

function cycleTheme() {
    if (themeMode === "auto") themeMode = "light";
    else if (themeMode === "light") themeMode = "dark";
    else themeMode = "auto";

    localStorage.setItem("weatherTheme", themeMode);
    applyTheme();
}


/* =========================================================
   CYCLE UNIT (°C ↔ °F)
========================================================= */
function updateUnitButton() {
    const btn = getElement("unit-toggle");
    if (btn) btn.textContent = unitMode === "imperial" ? "°F" : "°C";
}

function cycleUnit() {
    unitMode = unitMode === "metric" ? "imperial" : "metric";
    localStorage.setItem("weatherUnit", unitMode);
    updateUnitButton();

    if (window._currentWeatherData) {
        displayWeather(window._currentWeatherData);
    }
    if (window._lastForecastData) {
        renderHourlyForecast(window._lastForecastData);
        renderForecast(window._lastForecastData);
    }

    if (typeof mpTrack === "function") {
        mpTrack("unit_toggled", { new_mode: unitMode });
    }

    if (window._currentWeatherData) {
        renderEarthPanel(window._currentWeatherData);
    }

    clearCityCardCache();
    renderCitiesGlance();
}

function setupUnitButton() {
    const btn = getElement("unit-toggle");
    if (!btn) return;
    updateUnitButton();
    btn.addEventListener("click", cycleUnit);
}


/* =========================================================
   MANUAL REFRESH
========================================================= */
function setupRefreshButton() {
    const btn = getElement("refresh-btn");
    if (!btn) return;

    btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.classList.add("spinning");

        const loc = window._loadedLocation;
        const input = getElement("city-input");

        try {
            if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
                await refreshByCoordinates(loc.lat, loc.lon, loc.name, loc.country, loc.state);
            } else if (input && input.value.trim()) {
                await refreshByCity(input.value.trim());
            } else {
                await refreshByCity("Kisumu");
            }

            clearCityCardCache();
            renderCitiesGlance();

            showToast("✅ Weather updated");
        } catch (err) {
            console.error("Refresh failed:", err);
            showToast("❌ Refresh failed");
        } finally {
            btn.classList.remove("spinning");
            btn.disabled = false;
        }
    });
}

function refreshByCoordinates(lat, lon, name = "", country = "", state = "") {
    return new Promise((resolve) => {
        getWeatherByCoordinates(lat, lon, name, country, state);
        setTimeout(resolve, 800);
    });
}

function refreshByCity(city) {
    return new Promise((resolve) => {
        getWeather(city);
        setTimeout(resolve, 800);
    });
}


/* =========================================================
   FORMAT UNIX TIME
========================================================= */
function formatTimeFromUnix(timestamp, timezone = 0) {
    if (!timestamp) return "--:--";
    const date = new Date((Number(timestamp) + Number(timezone || 0)) * 1000);
    return date.toISOString().substring(11, 16);
}


/* =========================================================
   UPDATE DATE / TIME
========================================================= */
function updateDateTime() {
    const now = new Date();
    const dateElement = getElement("date");
    const timeElement = getElement("time");

    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    const locationTime = new Date(utcTime + (selectedTimezoneOffset * 1000));

    if (dateElement) {
        dateElement.textContent = locationTime.toLocaleDateString("en-KE", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric"
        });
    }
    if (timeElement) {
        timeElement.textContent = locationTime.toLocaleTimeString("en-KE", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
        });
    }

    const eiTime = getElement("ei-time");
    if (eiTime) {
        eiTime.textContent = locationTime.toLocaleTimeString("en-KE", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
        });
    }
}


/* =========================================================
   DISPLAY SUN TIMES
========================================================= */
function displaySunTimes(sunrise, sunset, timezone) {
    const sunriseElement = getElement("sunrise");
    const sunsetElement = getElement("sunset");
    if (sunriseElement) sunriseElement.textContent = formatTimeFromUnix(sunrise, timezone);
    if (sunsetElement) sunsetElement.textContent = formatTimeFromUnix(sunset, timezone);
}


/* =========================================================
   WHAT TO WEAR — condition first, temperature second
========================================================= */
function getWhatToWear(data) {
    const main = data.main || {};
    const weather = data.weather?.[0] || {};

    // Use feels-like when available — more accurate for clothing advice
    const temp = Number.isFinite(Number(main.feels_like))
        ? Number(main.feels_like)
        : Number(main.temp);
    const weatherId = Number(weather.id);

    if (!Number.isFinite(temp)) {
        return { icon: "👕", text: "No advice available" };
    }

    // Check rain in next 6 hours
    let rainSoon = false;
    const fd = window._lastForecastData;
    if (fd && Array.isArray(fd.list)) {
        const now = Math.floor(Date.now() / 1000);
        const next6h = fd.list.filter(item => {
            const dt = Number(item.dt);
            return dt >= now && dt <= now + 6 * 3600;
        });
        rainSoon = next6h.some(item => (Number(item.pop) || 0) >= 0.5);
    }

    const isHeavyRain = weatherId >= 502 && weatherId <= 504;
    const isLightRain = (weatherId >= 300 && weatherId <= 321) ||
                        (weatherId >= 500 && weatherId <= 501);
    const isAnyRain = weatherId >= 200 && weatherId <= 531;
    const isThunder = weatherId >= 200 && weatherId <= 232;
    const isSnowing = weatherId >= 600 && weatherId <= 622;

    // PRIORITY 1: Thunderstorm
    if (isThunder) {
        return {
            icon: "⛈️",
            text: "Stay indoors if possible — thunderstorms nearby"
        };
    }

    // PRIORITY 2: Snow
    if (isSnowing) {
        return {
            icon: "🧥",
            text: "Heavy winter coat, gloves, and waterproof boots"
        };
    }

    // PRIORITY 3: Rain (heavy or current)
    if (isHeavyRain || (isAnyRain && !isLightRain)) {
        if (temp >= 25) {
            return {
                icon: "☔",
                text: "Rainy — light waterproof clothes and an umbrella"
            };
        } else if (temp >= 18) {
            return {
                icon: "🧥",
                text: "Rainy — waterproof jacket and umbrella"
            };
        } else {
            return {
                icon: "🧥",
                text: "Cold and rainy — raincoat and boots"
            };
        }
    }

    // PRIORITY 4: Light rain / drizzle
    if (isLightRain) {
        if (temp >= 25) {
            return {
                icon: "☔",
                text: "Light rain — t-shirt with an umbrella"
            };
        } else if (temp >= 15) {
            return {
                icon: "☔",
                text: "Light rain — jacket and umbrella"
            };
        } else {
            return {
                icon: "🧥",
                text: "Cold and damp — warm coat with umbrella"
            };
        }
    }

    // PRIORITY 5: Rain coming soon
    if (rainSoon) {
        if (temp >= 25) {
            return {
                icon: "☔",
                text: "Light clothes + bring an umbrella — rain coming soon"
            };
        } else if (temp >= 15) {
            return {
                icon: "☔",
                text: "Light jacket + umbrella — rain in the next few hours"
            };
        } else {
            return {
                icon: "🧥",
                text: "Warm coat + umbrella — cold rain on the way"
            };
        }
    }

    // PRIORITY 6: Dry — temperature based
    if (temp >= 30) {
        return {
            icon: "🩳",
            text: "Shorts, t-shirt, and sun protection — very hot day"
        };
    }
    if (temp >= 25) {
        return {
            icon: "👕",
            text: "Light t-shirt and shorts or jeans — warm day"
        };
    }
    if (temp >= 20) {
        return {
            icon: "👕",
            text: "T-shirt and jeans — comfortable day"
        };
    }
    if (temp >= 15) {
        return {
            icon: "🧥",
            text: "Light jacket or long sleeves recommended"
        };
    }
    if (temp >= 10) {
        return {
            icon: "🧥",
            text: "Sweater or hoodie recommended"
        };
    }
    if (temp >= 5) {
        return {
            icon: "🧥",
            text: "Warm coat and long pants"
        };
    }
    return {
        icon: "🧣",
        text: "Heavy coat, scarf, and warm layers"
    };
}

function renderWhatToWear(data) {
    const card = getElement("what-to-wear");
    const iconEl = getElement("wtw-icon");
    const textEl = getElement("wtw-text");
    if (!card || !iconEl || !textEl) return;

    const advice = getWhatToWear(data);
    iconEl.textContent = advice.icon;
    textEl.textContent = advice.text;
}


/* =========================================================
   GENERATE NATURAL LANGUAGE WEATHER REPORT
========================================================= */
function generateWeatherReport(data) {
    const weather = data.weather?.[0] || {};
    const main = data.main || {};
    const wind = data.wind || {};
    const clouds = Number(data.clouds?.all || 0);
    const visibility = Number(data.visibility);

    const temp = Number(main.temp);
    const feelsLike = Number(main.feels_like);
    const humidity = Number(main.humidity);
    const windSpeed = Number(wind.speed);
    const windDeg = Number(wind.deg);
    const weatherId = Number(weather.id);
    const condition = getConditionText(weatherId, weather.description);

    let report = `Currently ${formatTemp(temp)}${tempUnit()} with ${condition.toLowerCase()}.`;

    if (Number.isFinite(feelsLike)) {
        const diff = feelsLike - temp;
        if (diff > 2) {
            report += ` It feels warmer at ${formatTemp(feelsLike)}${tempUnit()}.`;
        } else if (diff < -2) {
            report += ` It feels cooler at ${formatTemp(feelsLike)}${tempUnit()}.`;
        }
    }

    report += ` Humidity is at ${humidity}%`;

    if (Number.isFinite(windSpeed)) {
        report += ` and wind is blowing at ${formatSpeed(windSpeed)} ${speedUnit()}`;
        if (Number.isFinite(windDeg)) {
            report += ` from the ${degreesToCompass(windDeg)} (${windDeg}°)`;
        }
        report += ".";
    } else {
        report += ".";
    }

    if (clouds > 0) {
        report += ` Cloud cover is around ${clouds}%.`;
    } else {
        report += ` Skies are clear.`;
    }

    if (Number.isFinite(visibility)) {
        const km = visibility / 1000;
        if (km < 5) {
            report += ` Visibility is reduced to ${km.toFixed(1)} km.`;
        } else if (km > 15) {
            report += ` Visibility is excellent at ${km.toFixed(0)} km.`;
        }
    }

    return report;
}


/* =========================================================
   LOCATION SAFETY ALERTS
========================================================= */
async function checkLocationAlerts(lat, lon) {
    const banner = getElement("safety-alert");
    const titleEl = getElement("safety-alert-title");
    const textEl = getElement("safety-alert-text");
    const iconEl = getElement("safety-alert-icon");
    const closeBtn = getElement("safety-alert-close");

    if (!banner || !titleEl || !textEl) return;

    banner.style.display = "none";
    banner.className = "safety-alert";

    try {
        const res = await fetch(`/local-alerts?lat=${lat}&lon=${lon}`);
        if (!res.ok) return;
        const data = await res.json();

        const alerts = data.alerts || [];
        const quakes = data.quakes || [];

        if (alerts.length > 0) {
            const top = alerts[0];
            const sev = (top.severity || "").toLowerCase();

            iconEl.textContent = "⚠️";
            titleEl.textContent = top.event || "Weather Alert";
            textEl.textContent = top.headline || top.description || "";

            if (sev === "extreme" || sev === "severe") {
                banner.classList.add("severity-moderate");
            } else {
                banner.classList.add("severity-minor");
            }

            banner.style.display = "flex";

            if (typeof mpTrack === "function") {
                mpTrack("safety_alert_shown", {
                    event: top.event,
                    severity: top.severity
                });
            }

        } else if (quakes.length > 0) {
            const q = quakes[0];
            iconEl.textContent = "🌋";
            titleEl.textContent = `M${q.magnitude} Earthquake Nearby`;
            textEl.textContent = `${q.place} — ${Math.round(q.depth)}km deep`;

            banner.classList.add("severity-moderate");
            banner.style.display = "flex";

            if (typeof mpTrack === "function") {
                mpTrack("earthquake_alert_shown", {
                    magnitude: q.magnitude,
                    place: q.place
                });
            }
        }

    } catch (err) {
        console.warn("Alert check failed:", err);
    }

    if (closeBtn) {
        closeBtn.onclick = () => {
            banner.style.display = "none";
        };
    }
}


/* =========================================================
   ANIMATED WEATHER CANVAS (real rain / snow particles)
========================================================= */
let weatherCanvas = null;
let weatherCtx = null;
let weatherParticles = [];
let weatherAnimFrame = null;
let weatherParticleType = null;

function stopWeatherCanvas() {
    if (weatherAnimFrame) {
        cancelAnimationFrame(weatherAnimFrame);
        weatherAnimFrame = null;
    }
    if (weatherCtx && weatherCanvas) {
        weatherCtx.clearRect(0, 0, weatherCanvas.width, weatherCanvas.height);
    }
    weatherParticles = [];
    weatherParticleType = null;
}

function startWeatherCanvas(type) {
    weatherCanvas = document.getElementById("weather-canvas");
    if (!weatherCanvas) return;

    const parent = weatherCanvas.parentElement;
    const rect = parent.getBoundingClientRect();

    weatherCanvas.width = rect.width;
    weatherCanvas.height = rect.height;

    weatherCtx = weatherCanvas.getContext("2d");
    weatherParticleType = type;

    weatherParticles = [];
    const isRain = type === "rain" || type === "rain-heavy";
    const count = type === "rain-heavy" ? 160 :
                  type === "rain"       ? 70  :
                                          45;
    for (let i = 0; i < count; i++) {
        weatherParticles.push({
            x: Math.random() * weatherCanvas.width,
            y: Math.random() * weatherCanvas.height,
            length: isRain
                ? (type === "rain-heavy"
                    ? 12 + Math.random() * 14
                    : 8 + Math.random() * 10)
                : 0,
            speedY: isRain
                ? (type === "rain-heavy"
                    ? 6 + Math.random() * 5
                    : 4 + Math.random() * 4)
                : 0.5 + Math.random() * 1.2,
            speedX: isRain
                ? 0.5 + Math.random() * 1
                : -0.5 + Math.random() * 1,
            radius: isRain ? 0 : 1.5 + Math.random() * 2,
            opacity: isRain
                ? 0.35 + Math.random() * 0.4
                : 0.5 + Math.random() * 0.4,
            wobble: isRain ? 0 : Math.random() * Math.PI * 2,
            wobbleSpeed: 0.02 + Math.random() * 0.03
        });
    }

    function draw() {
        if (!weatherCtx || !weatherCanvas) return;

        weatherCtx.clearRect(0, 0, weatherCanvas.width, weatherCanvas.height);

        weatherParticles.forEach(p => {
            if (weatherParticleType === "rain" ||
                weatherParticleType === "rain-heavy") {
                weatherCtx.strokeStyle = `rgba(186, 230, 253, ${p.opacity})`;
                weatherCtx.lineWidth = 1.4;
                weatherCtx.lineCap = "round";
                weatherCtx.beginPath();
                weatherCtx.moveTo(p.x, p.y);
                weatherCtx.lineTo(p.x + p.speedX * 2, p.y + p.length);
                weatherCtx.stroke();
            } else {
                weatherCtx.fillStyle = `rgba(255, 255, 255, ${p.opacity})`;
                weatherCtx.beginPath();
                weatherCtx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
                weatherCtx.fill();
            }

            p.y += p.speedY;
            p.x += p.speedX;

            if (weatherParticleType === "snow") {
                p.wobble += p.wobbleSpeed;
                p.x += Math.sin(p.wobble) * 0.4;
            }

            if (p.y > weatherCanvas.height + 10) {
                p.y = -10;
                p.x = Math.random() * weatherCanvas.width;
            }

            if (p.x < -10) p.x = weatherCanvas.width + 10;
            if (p.x > weatherCanvas.width + 10) p.x = -10;
        });

        weatherAnimFrame = requestAnimationFrame(draw);
    }

    draw();
}

window.addEventListener("resize", () => {
    if (!weatherCanvas || !weatherParticleType) return;
    const parent = weatherCanvas.parentElement;
    const rect = parent.getBoundingClientRect();
    weatherCanvas.width = rect.width;
    weatherCanvas.height = rect.height;
});


/* =========================================================
   WEATHER BACKGROUND FOR HERO CARD
========================================================= */
function applyWeatherBackground(weatherId, iconCode) {
    const hero = document.querySelector(".cw-hero");
    if (!hero) return;

    stopWeatherCanvas();

    hero.classList.remove(
        "weather-sunny",
        "weather-cloudy",
        "weather-rain",
        "weather-thunder",
        "weather-snow",
        "weather-fog"
    );

    let cls = "weather-cloudy";
    let canvasType = null;

    if (weatherId >= 200 && weatherId <= 232) {
        cls = "weather-thunder";
        canvasType = "rain-heavy";
    } else if (weatherId >= 502 && weatherId <= 531) {
        cls = "weather-rain";
        canvasType = "rain-heavy";
    } else if (weatherId >= 300 && weatherId <= 501) {
        cls = "weather-rain";
        canvasType = "rain";
    } else if (weatherId >= 600 && weatherId <= 622) {
        cls = "weather-snow";
        canvasType = "snow";
    } else if (weatherId >= 701 && weatherId <= 781) {
        cls = "weather-fog";
    } else if (weatherId === 800) {
        cls = "weather-sunny";
    } else if (weatherId >= 801 && weatherId <= 804) {
        cls = "weather-cloudy";
    }

    hero.classList.add(cls);

    if (canvasType) {
        setTimeout(() => startWeatherCanvas(canvasType), 50);
    }
}


/* =========================================================
   DISPLAY CURRENT WEATHER
========================================================= */
function displayWeather(data) {
    if (!data || (data.cod !== 200 && data.cod !== "200")) {
        const errorMessage = getElement("error-message");
        if (errorMessage) errorMessage.textContent = "City not found. Please try again.";
        return;
    }

    const weather = data.weather?.[0] || {};
    const main = data.main || {};
    const wind = data.wind || {};
    const sys = data.sys || {};

    const temperature = Number(main.temp);
    const feelsLike = Number(main.feels_like);
    const humidity = Number(main.humidity);
    const pressure = Number(main.pressure);
    const windSpeed = Number(wind.speed);
    const clouds = Number(data.clouds?.all || 0);
    const visibility = Number(data.visibility);
    const windDirection = Number(wind.deg);
    const windGust = Number(wind.gust);
    const weatherId = Number(weather.id);
    const description = weather.description || "";
    const iconCode = weather.icon || "";

    const searchedLocation = data.searched_location || {};
    const cityName = searchedLocation.name || data.name || "Unknown location";
    const stateName = searchedLocation.state || "";
    const countryCode = searchedLocation.country || sys.country || "";
    const locationText = formatLocation(cityName, stateName, countryCode);

    const timezone = Number(data.timezone || 0);
    selectedTimezoneOffset = timezone;
    updateTheme(sys.sunrise, sys.sunset, timezone);
    updateDateTime();

    applyWeatherBackground(weatherId, iconCode);

    const cityElement = getElement("city");
    if (cityElement) cityElement.textContent = locationText;

    // Remember the last viewed location (name + coords) for next visit
    try {
        localStorage.setItem("weatherLastCity", locationText);
        if (data.coord && Number.isFinite(data.coord.lat) && Number.isFinite(data.coord.lon)) {
            localStorage.setItem("weatherLastCoords", JSON.stringify({
                lat: data.coord.lat,
                lon: data.coord.lon,
                name: cityName,
                state: stateName,
                country: countryCode
            }));
        }
    } catch (e) { /* storage might be full/blocked */ }

    const temperatureElement = getElement("temperature");
    if (temperatureElement && Number.isFinite(temperature)) {
        temperatureElement.textContent = `${formatTemp(temperature)}${tempUnit()}`;
    }

    const feelsLikeElement = getElement("feels-like");
    if (feelsLikeElement && Number.isFinite(feelsLike)) {
        feelsLikeElement.textContent = `${formatTemp(feelsLike)}${tempUnit()}`;
    }

    const humidityElement = getElement("humidity");
    if (humidityElement) humidityElement.textContent = `${humidity}%`;

    const windElement = getElement("wind");
    if (windElement && Number.isFinite(windSpeed)) {
        windElement.textContent = `${formatSpeed(windSpeed)} ${speedUnit()}`;
    }

    const cloudsElement = getElement("clouds");
    if (cloudsElement) {
        let cloudsLabel = `${clouds}%`;
        const isCurrentlyRaining = weatherId >= 200 && weatherId <= 531;
        if (isCurrentlyRaining && clouds < 40) {
            cloudsLabel = `${clouds}% (shower)`;
        }
        cloudsElement.textContent = cloudsLabel;
        cloudsElement.title = "Total sky area covered by clouds";
    }

    const conditionElement = getElement("condition");
    if (conditionElement) conditionElement.textContent = getConditionText(weatherId, description);

    const iconElement = getElement("weather-icon");
    if (iconElement) iconElement.textContent = getWeatherIcon(weatherId, iconCode);

    const reportElement = getElement("weather-report");
    if (reportElement) reportElement.textContent = generateWeatherReport(data);

    const pressureElement = getElement("pressure");
    if (pressureElement && Number.isFinite(pressure)) pressureElement.textContent = `${pressure} hPa`;

    const visibilityElement = getElement("visibility");
    if (visibilityElement && Number.isFinite(visibility)) {
        visibilityElement.textContent = `${(visibility / 1000).toFixed(1)} km`;
    }

    const windDirectionElement = getElement("wind-direction");
    if (windDirectionElement && Number.isFinite(windDirection)) {
        windDirectionElement.textContent = `${windDirection}° ${degreesToCompass(windDirection)}`;
    }

    const windGustElement = getElement("wind-gust");
    if (windGustElement) {
        windGustElement.textContent = Number.isFinite(windGust)
            ? `${formatSpeed(windGust)} ${speedUnit()}`
            : `-- ${speedUnit()}`;
    }

    displaySunTimes(sys.sunrise, sys.sunset, timezone);

    if (data.coord && Number.isFinite(data.coord.lat) && Number.isFinite(data.coord.lon)) {
        fetchExtraData(data.coord.lat, data.coord.lon);
    }

    if (data.coord && Number.isFinite(data.coord.lat) && Number.isFinite(data.coord.lon)) {
        checkLocationAlerts(data.coord.lat, data.coord.lon);
    }

    renderMoonCard();
    updateSunCountdown();
    renderWhatToWear(data);

    const errorMessage = getElement("error-message");
    if (errorMessage) errorMessage.textContent = "";

    window._currentWeatherData = data;

    if (data.coord && Number.isFinite(data.coord.lat) && Number.isFinite(data.coord.lon)) {
        window._loadedLocation = {
            name: cityName,
            state: stateName,
            country: countryCode,
            lat: data.coord.lat,
            lon: data.coord.lon
        };
        updateSaveButtonState();
    }

    if (window._lastForecastData) {
        renderHourlyForecast(window._lastForecastData);
    }

    if (data.coord && Number.isFinite(data.coord.lat) && Number.isFinite(data.coord.lon)) {
        updateCurrentMarker(data.coord.lat, data.coord.lon);
        rotateGlobeTo(data.coord.lat, data.coord.lon);
    }

    if (typeof mpTrack === "function") {
        mpTrack("weather_loaded", {
            city: locationText,
            country: countryCode,
            lat: data.coord?.lat,
            lon: data.coord?.lon,
            temp_c: temperature,
            condition: getConditionText(weatherId, description),
            source: data.searched_location?.name ? "search" : "coordinates"
        });
    }

    renderEarthPanel(data);
    saveWeatherToCache(data, window._lastForecastData || null);
}


/* =========================================================
   MOON PHASE
========================================================= */
function getMoonPhase(date = new Date()) {
    const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14, 0);
    const synodicMonth = 29.530588853 * 86400000;

    const daysSince = (date.getTime() - knownNewMoon) / 86400000;
    let phase = (daysSince % 29.530588853) / 29.530588853;
    if (phase < 0) phase += 1;

    const illumination = (1 - Math.cos(phase * 2 * Math.PI)) / 2;

    let name, emoji;
    if (phase < 0.0625)      { name = "New Moon";        emoji = "🌑"; }
    else if (phase < 0.1875) { name = "Waxing Crescent"; emoji = "🌒"; }
    else if (phase < 0.3125) { name = "First Quarter";   emoji = "🌓"; }
    else if (phase < 0.4375) { name = "Waxing Gibbous";  emoji = "🌔"; }
    else if (phase < 0.5625) { name = "Full Moon";       emoji = "🌕"; }
    else if (phase < 0.6875) { name = "Waning Gibbous";  emoji = "🌖"; }
    else if (phase < 0.8125) { name = "Last Quarter";    emoji = "🌗"; }
    else if (phase < 0.9375) { name = "Waning Crescent"; emoji = "🌘"; }
    else                     { name = "New Moon";        emoji = "🌑"; }

    return { phase, illumination, name, emoji };
}

function renderMoonCard() {
    const el = getElement("moon-phase");
    if (!el) return;

    const moon = getMoonPhase();
    const pct = Math.round(moon.illumination * 100);
    el.textContent = `${moon.emoji} ${pct}%`;
    el.title = `${moon.name} — ${pct}% illuminated`;
}


/* =========================================================
   SUNRISE / SUNSET COUNTDOWN
========================================================= */
function formatCountdown(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "--";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function updateSunCountdown() {
    const valueEl = getElement("sun-countdown");
    const labelEl = getElement("sun-countdown-label");
    if (!valueEl) return;

    const data = window._currentWeatherData;
    if (!data || !data.sys || !data.sys.sunrise || !data.sys.sunset) {
        valueEl.textContent = "--";
        return;
    }

    const sunrise = Number(data.sys.sunrise);
    const sunset  = Number(data.sys.sunset);
    const now = Math.floor(Date.now() / 1000);

    if (now < sunrise) {
        const secs = sunrise - now;
        valueEl.textContent = formatCountdown(secs);
        valueEl.title = "Until sunrise";
        if (labelEl) labelEl.textContent = "🌅 SUNRISE IN";
    } else if (now < sunset) {
        const secs = sunset - now;
        valueEl.textContent = formatCountdown(secs);
        valueEl.title = "Until sunset";
        if (labelEl) labelEl.textContent = "🌇 SUNSET IN";
    } else {
        const tomorrowSunrise = sunrise + 86400;
        const secs = tomorrowSunrise - now;
        valueEl.textContent = formatCountdown(secs);
        valueEl.title = "Until tomorrow's sunrise";
        if (labelEl) labelEl.textContent = "🌅 SUNRISE IN";
    }
}


/* =========================================================
   FETCH EXTRA DATA (UV + AQI)
========================================================= */
function fetchExtraData(lat, lon) {
    fetch(`/uv?lat=${lat}&lon=${lon}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            const el = getElement("uv-index");
            if (!el) return;
            if (data && data.value !== undefined && data.value !== null) {
                const val = Math.round(data.value);
                let label = "";
                if (val <= 2) label = "Low";
                else if (val <= 5) label = "Moderate";
                else if (val <= 7) label = "High";
                else if (val <= 10) label = "Very High";
                else label = "Extreme";
                el.textContent = `${val} (${label})`;
            } else {
                el.textContent = "--";
            }
        })
        .catch(() => {
            const el = getElement("uv-index");
            if (el) el.textContent = "--";
        });

    fetch(`/air?lat=${lat}&lon=${lon}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            const el = getElement("air-quality");
            if (!el) return;
            if (data && data.aqi) {
                const labels = ["Good", "Fair", "Moderate", "Poor", "Very Poor"];
                el.textContent = `${data.aqi} (${labels[data.aqi - 1] || "Unknown"})`;
            } else {
                el.textContent = "--";
            }
        })
        .catch(() => {
            const el = getElement("air-quality");
            if (el) el.textContent = "--";
        });
}


/* =========================================================
   DISPLAY FORECAST LOCATION
========================================================= */
function displayForecastLocation(data) {
    const locationElement = getElement("forecast-location");
    if (!locationElement) return;

    const location = data.searched_location || {};
    const city = data.city || {};
    const name = location.name || city.name || "";
    const state = location.state || "";
    const country = location.country || city.country || "";
    locationElement.textContent = formatLocation(name, state, country);
}


/* =========================================================
   RENDER HOURLY FORECAST
========================================================= */
function renderHourlyForecast(data) {
    const container = getElement("hourly-forecast");
    if (!container) return;

    if (!data || !Array.isArray(data.list) || data.list.length === 0) {
        container.innerHTML = "Hourly forecast unavailable.";
        return;
    }

    window._lastForecastData = data;

    container.innerHTML = "";
    const timezone = Number(data.timezone || 0);
    const now = Math.floor(Date.now() / 1000);

    const cw = window._currentWeatherData;
    if (cw && cw.weather && cw.main) {
        const w = cw.weather[0] || {};
        const wId = Number(w.id);
        const icon = getWeatherIcon(wId, w.icon);
        const temp = Number(cw.main.temp);
        const condition = getConditionText(wId, w.description);

        const nowCard = document.createElement("div");
        nowCard.className = "hourly-card now-card";
        nowCard.innerHTML = `
            <div class="hourly-time">Now</div>
            <div class="hourly-icon">${icon}</div>
            <div class="hourly-temperature">${formatTemp(temp, 0)}${tempUnit()}</div>
            <div class="hourly-rain">💧 --</div>
            <div class="hourly-condition">${condition}</div>
        `;
        container.appendChild(nowCard);
    }

    let startIndex = data.list.findIndex(item => Number(item.dt) >= now);
    if (startIndex < 0) startIndex = 0;

    const hourlyData = data.list.slice(startIndex, startIndex + 7);

    hourlyData.forEach((item, index) => {
        const weather = item.weather?.[0] || {};
        const weatherId = Number(weather.id);
        const icon = getWeatherIcon(weatherId, weather.icon);
        const temperature = Number(item.main?.temp);
        const rainChance = Math.round((Number(item.pop) || 0) * 100);
        const localTime = new Date((Number(item.dt) + timezone) * 1000);
        const time = localTime.toLocaleTimeString("en-KE", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            timeZone: "UTC"
        });
        const condition = getConditionText(weatherId, weather.description);

        const card = document.createElement("div");
        card.className = "hourly-card";
        card.style.animationDelay = `${index * 50}ms`;
        card.innerHTML = `
            <div class="hourly-time">${time}</div>
            <div class="hourly-icon">${icon}</div>
            <div class="hourly-temperature">${formatTemp(temperature, 0)}${tempUnit()}</div>
            <div class="hourly-rain">💧 ${rainChance}%</div>
            <div class="hourly-condition">${condition}</div>
        `;
        container.appendChild(card);
    });
}


/* =========================================================
   RENDER 5-DAY FORECAST
========================================================= */
function renderForecast(data) {
    const container = getElement("forecast");
    if (!container) return;

    if (!data || (data.cod !== 200 && data.cod !== "200") || !Array.isArray(data.list) || data.list.length === 0) {
        container.innerHTML = "Forecast unavailable.";
        return;
    }

    displayForecastLocation(data);
    renderCalendar(data);

    const days = {};
    data.list.forEach(item => {
        if (!item.dt_txt) return;
        const dateString = item.dt_txt.split(" ")[0];
        if (!days[dateString]) days[dateString] = [];
        days[dateString].push(item);
    });

    const timezone = Number(data.timezone || 0);
    const now = Math.floor(Date.now() / 1000);
    const localNow = new Date((now + timezone) * 1000);
    const today = localNow.toISOString().substring(0, 10);

    const forecastDates = Object.keys(days)
        .filter(date => date !== today)
        .slice(0, 5);

    container.innerHTML = "";

    forecastDates.forEach((dateString, index) => {
        const entries = days[dateString];
        if (!entries || entries.length === 0) return;

        const temperatures = entries
            .map(item => Number(item.main?.temp))
            .filter(value => Number.isFinite(value));
        if (temperatures.length === 0) return;

        const high = Math.max(...temperatures);
        const low = Math.min(...temperatures);

        const rainChance = Math.round(
            Math.max(...entries.map(item => (Number(item.pop) || 0) * 100))
        );

        const daytimeEntries = entries.filter(item =>
            String(item.weather?.[0]?.icon || "").endsWith("d")
        );
        const candidates = daytimeEntries.length > 0 ? daytimeEntries : entries;

        let representative = candidates[0];
        const priority = weather => {
            const id = Number(weather?.id);
            if (id >= 200 && id <= 232) return 6;
            if (id >= 500 && id <= 531) return 5;
            if (id >= 300 && id <= 321) return 4;
            if (id >= 600 && id <= 622) return 4;
            if (id >= 701 && id <= 781) return 3;
            if (id === 804) return 2;
            if (id >= 801 && id <= 803) return 1;
            return 0;
        };
        candidates.forEach(item => {
            if (priority(item.weather?.[0]) > priority(representative.weather?.[0])) {
                representative = item;
            }
        });

        const weather = representative.weather?.[0] || {};
        const weatherId = Number(weather.id);
        const icon = getWeatherIcon(weatherId, weather.icon);
        const condition = getConditionText(weatherId, weather.description);

        const date = new Date(`${dateString}T12:00:00`);
        const day = date.toLocaleDateString("en-KE", { weekday: "short" });
        const forecastDate = date.toLocaleDateString("en-KE", { day: "numeric", month: "short" });

        const card = document.createElement("div");
        card.className = "forecast-day";
        card.style.animationDelay = `${index * 70}ms`;
        card.innerHTML = `
            <div class="forecast-day-name">${day}</div>
            <div class="forecast-date">${forecastDate}</div>
            <div class="forecast-icon">${icon}</div>
            <div class="forecast-high">${formatTemp(high, 0)}${tempUnit()}</div>
            <div class="forecast-low">${formatTemp(low, 0)}${tempUnit()}</div>
            <div class="forecast-rain">💧 ${rainChance}%</div>
            <div class="forecast-condition">${condition}</div>
        `;
        container.appendChild(card);
    });

    if (container.children.length === 0) {
        container.innerHTML = "Forecast unavailable.";
    }

    if (window._currentWeatherData) {
        saveWeatherToCache(window._currentWeatherData, data);
    }

    if (window._currentWeatherData) {
        renderWhatToWear(window._currentWeatherData);
    }
}


/* =========================================================
   RENDER MONTHLY CALENDAR
========================================================= */
        /* =========================================================
           RENDER MONTHLY CALENDAR (with month navigation)
        ========================================================= */
        let _calViewYear = null;
        let _calViewMonth = null;      // 0-11
        let _calWeatherMap = {};
        let _calTodayKey = "";         // "YYYY-MM-DD"

        function renderCalendar(data) {
            const grid = getElement("calendar-grid");
            const label = getElement("cal-month-label");
            if (!grid || !label) return;

            if (!data || !Array.isArray(data.list) || data.list.length === 0) {
                grid.innerHTML = "";
                label.textContent = "—";
                return;
            }

            const timezone = Number(data.timezone || 0);

            const locationEl = getElement("calendar-location");
            if (locationEl) {
                const loc = data.searched_location || {};
                const city = data.city || {};
                const name = loc.name || city.name || "";
                const state = loc.state || "";
                const country = loc.country || city.country || "";
                locationEl.textContent = formatLocation(name, state, country);
            }

            // Build weather map (date → icon)
            const weatherMap = {};
            const dateGroups = {};
            data.list.forEach(item => {
                if (!item.dt_txt) return;
                const dateString = item.dt_txt.split(" ")[0];
                if (!dateGroups[dateString]) dateGroups[dateString] = [];
                dateGroups[dateString].push(item);
            });

            Object.keys(dateGroups).forEach(dateString => {
                const entries = dateGroups[dateString];
                const daytimeEntries = entries.filter(item =>
                    String(item.weather?.[0]?.icon || "").endsWith("d")
                );
                const candidates = daytimeEntries.length > 0 ? daytimeEntries : entries;
                let rep = candidates[0];
                const priority = weather => {
                    const id = Number(weather?.id);
                    if (id >= 200 && id <= 232) return 6;
                    if (id >= 500 && id <= 531) return 5;
                    if (id >= 300 && id <= 321) return 4;
                    if (id >= 600 && id <= 622) return 4;
                    if (id >= 701 && id <= 781) return 3;
                    if (id === 804) return 2;
                    if (id >= 801 && id <= 803) return 1;
                    return 0;
                };
                candidates.forEach(item => {
                    if (priority(item.weather?.[0]) > priority(rep.weather?.[0])) rep = item;
                });
                const w = rep.weather?.[0] || {};
                weatherMap[dateString] = getWeatherIcon(Number(w.id), w.icon);
            });

            // Compute today in the location's timezone
            const now = Math.floor(Date.now() / 1000);
            const localNow = new Date((now + timezone) * 1000);
            const todayYear = localNow.getUTCFullYear();
            const todayMonth = localNow.getUTCMonth();
            const todayDate = localNow.getUTCDate();

            _calWeatherMap = weatherMap;
            _calTodayKey = `${todayYear}-${String(todayMonth + 1).padStart(2, "0")}-${String(todayDate).padStart(2, "0")}`;

            // Reset view to current month each time new forecast arrives
            _calViewYear = todayYear;
            _calViewMonth = todayMonth;

            paintCalendar();
        }

        function paintCalendar() {
            const grid = getElement("calendar-grid");
            const label = getElement("cal-month-label");
            if (!grid || !label) return;
            if (_calViewYear === null || _calViewMonth === null) return;

            const year = _calViewYear;
            const month = _calViewMonth;

            const monthNames = [
                "January","February","March","April","May","June",
                "July","August","September","October","November","December"
            ];
            label.textContent = `${monthNames[month]} ${year}`;

            const firstDay = new Date(Date.UTC(year, month, 1));
            const startWeekday = firstDay.getUTCDay();
            const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

            grid.innerHTML = "";

            for (let i = 0; i < startWeekday; i++) {
                const cell = document.createElement("div");
                cell.className = "cal-day empty";
                grid.appendChild(cell);
            }

            for (let day = 1; day <= daysInMonth; day++) {
                const cell = document.createElement("div");
                cell.className = "cal-day";

                const dateStr =
                    `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

                if (dateStr === _calTodayKey) cell.classList.add("today");

                const dateEl = document.createElement("div");
                dateEl.className = "cal-date";
                dateEl.textContent = day;
                cell.appendChild(dateEl);

                const icon = _calWeatherMap[dateStr];
                if (icon) {
                    const iconEl = document.createElement("div");
                    iconEl.className = "cal-icon";
                    iconEl.textContent = icon;
                    cell.appendChild(iconEl);
                }

                grid.appendChild(cell);
            }
        }

        function changeCalendarMonth(delta) {
            if (_calViewYear === null || _calViewMonth === null) return;

            let m = _calViewMonth + delta;
            let y = _calViewYear;

            while (m < 0) { m += 12; y -= 1; }
            while (m > 11) { m -= 12; y += 1; }

            _calViewMonth = m;
            _calViewYear = y;

            paintCalendar();

            if (typeof mpTrack === "function") {
                mpTrack("calendar_month_changed", {
                    direction: delta > 0 ? "next" : "prev"
                });
            }
        }

        function setupCalendarNav() {
            const prevBtn = getElement("cal-prev");
            const nextBtn = getElement("cal-next");
            if (prevBtn) prevBtn.addEventListener("click", () => changeCalendarMonth(-1));
            if (nextBtn) nextBtn.addEventListener("click", () => changeCalendarMonth(1));
        }


/* =========================================================
   EARTH SPHERE (Three.js)
========================================================= */
let earthInitialized = false;
let earthRenderer = null;
let earthScene = null;
let earthCamera = null;
let earthMesh = null;
let earthMaterial = null;
let earthSunDirection = new THREE.Vector3(1, 0, 0);
let currentLocationMarker = null;
let savedLocationMarkers = [];

let earthClouds = null;
let cloudsVisible = true;
let clockTimer = null;

let earthStars = null;
let starsVisible = true;
let globeLockedOnCity = false;

let camRadius = 3;
let camPhi = Math.PI / 2;
let camTheta = 0;
let camTargetPhi = camPhi;
let camTargetTheta = camTheta;
let camAnimating = false;
let autoRotatePausedUntil = 0;
let globeInView = true;
const AUTO_ROTATE_SPEED = 0.0025;
const AUTO_ROTATE_PAUSE_MS = 15000;

/* Convert latitude/longitude to a 3D position on a sphere */
function latLonToVector3(lat, lon, radius = 1) {
    const phi = (90 - lat) * Math.PI / 180;
    const theta = (lon + 180) * Math.PI / 180;
    const x = -radius * Math.sin(phi) * Math.cos(theta);
    const y =  radius * Math.cos(phi);
    const z =  radius * Math.sin(phi) * Math.sin(theta);
    return new THREE.Vector3(x, y, z);
}

/* Inverse: 3D point on sphere → lat/lon */
function vector3ToLatLon(v) {
    const r = v.length();
    const lat = 90 - Math.acos(v.y / r) * 180 / Math.PI;
    let lon = (Math.atan2(v.z, -v.x) * 180 / Math.PI) - 180;
    lon = ((lon + 540) % 360) - 180;
    return { lat, lon };
}

/* Compute the direction from earth's center to the sun */
function getSunDirection() {
    const now = new Date();
    const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    const subsolarLon = -15 * (utcHours - 12);

    const start = new Date(now.getUTCFullYear(), 0, 1);
    const dayOfYear = Math.floor((now - start) / 86400000) + 1;
    const decl = 23.44 * Math.sin(2 * Math.PI * (dayOfYear - 81) / 365);

    return latLonToVector3(decl, subsolarLon, 1).normalize();
}

/* Remove a marker from the scene */
function removeMarker(marker) {
    if (!marker || !earthScene) return;
    earthScene.remove(marker);
    if (marker.geometry) marker.geometry.dispose();
    if (marker.material) marker.material.dispose();
}

/* Create a floating text label sprite for the globe */
function makeLabelSprite(text) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = 256;
    canvas.height = 64;

    ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
    const r = 12;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(canvas.width - r, 0);
    ctx.quadraticCurveTo(canvas.width, 0, canvas.width, r);
    ctx.lineTo(canvas.width, canvas.height - r);
    ctx.quadraticCurveTo(canvas.width, canvas.height, canvas.width - r, canvas.height);
    ctx.lineTo(r, canvas.height);
    ctx.quadraticCurveTo(0, canvas.height, 0, canvas.height - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "rgba(56, 189, 248, 0.8)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = "bold 28px Arial, sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const maxWidth = canvas.width - 20;
    let displayText = text;
    if (ctx.measureText(displayText).width > maxWidth) {
        while (displayText.length > 3 &&
               ctx.measureText(displayText + "…").width > maxWidth) {
            displayText = displayText.slice(0, -1);
        }
        displayText += "…";
    }
    ctx.fillText(displayText, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: true,
        depthWrite: false
    });

    const sprite = new THREE.Sprite(material);
    sprite.scale.set(0.28, 0.07, 1);
    return sprite;
}

/* Add a marker dot at a location */
function addMarker(lat, lon, color, size = 0.025, radius = 1.015) {
    const pos = latLonToVector3(lat, lon, radius);
    const geo = new THREE.SphereGeometry(size, 12, 12);
    const mat = new THREE.MeshBasicMaterial({ color });
    const dot = new THREE.Mesh(geo, mat);
    dot.position.copy(pos);
    return dot;
}

/* Update the current-location marker */
function updateCurrentMarker(lat, lon) {
    if (!earthScene) return;
    if (currentLocationMarker) {
        removeMarker(currentLocationMarker);
        currentLocationMarker = null;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const group = new THREE.Group();
    group.add(addMarker(lat, lon, 0xffffff, 0.03, 1.02));
    group.add(addMarker(lat, lon, 0xff3b3b, 0.02, 1.025));

    for (let i = 0; i < 2; i++) {
        const ringGeo = new THREE.RingGeometry(0.04, 0.05, 32);
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0xff5c5c,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.75 - i * 0.3
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.copy(latLonToVector3(lat, lon, 1.03 + i * 0.005));
        ring.lookAt(0, 0, 0);
        ring.userData.pulseOffset = i * 0.5;
        group.add(ring);
    }

    earthScene.add(group);
    currentLocationMarker = group;
}

/* Rebuild all saved-location markers (with name labels) */
function updateSavedMarkers() {
    if (!earthScene) return;
    savedLocationMarkers.forEach(m => removeMarker(m));
    savedLocationMarkers = [];

    savedLocations.forEach(loc => {
        if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return;

        const marker = addMarker(loc.lat, loc.lon, 0x38bdf8, 0.018, 1.015);
        earthScene.add(marker);
        savedLocationMarkers.push(marker);

        const labelText = loc.name || "Unknown";
        const label = makeLabelSprite(labelText);
        const pos = latLonToVector3(loc.lat, loc.lon, 1.08);
        label.position.copy(pos);
        earthScene.add(label);
        savedLocationMarkers.push(label);
    });
}

/* Rotate the camera to face a specific location */
function rotateGlobeTo(lat, lon) {
    if (!earthInitialized) return;
    camTargetPhi = (90 - lat) * Math.PI / 180;
    camTargetTheta = (lon + 180) * Math.PI / 180;

    let dTheta = camTargetTheta - camTheta;
    while (dTheta > Math.PI) { camTargetTheta -= 2 * Math.PI; dTheta = camTargetTheta - camTheta; }
    while (dTheta < -Math.PI) { camTargetTheta += 2 * Math.PI; dTheta = camTargetTheta - camTheta; }

    camAnimating = true;

    if (globeLockedOnCity) {
        autoRotatePausedUntil = Infinity;
    } else {
        autoRotatePausedUntil = Date.now() + AUTO_ROTATE_PAUSE_MS;
    }
}

/* Click handler — convert clicked point to lat/lon and load weather */
function onGlobeClick(event) {
    if (!earthRenderer || !earthMesh || !earthCamera) return;

    const rect = earthRenderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, earthCamera);

    const intersects = raycaster.intersectObject(earthMesh);
    if (!intersects.length) return;

    const point = intersects[0].point;
    const { lat, lon } = vector3ToLatLon(point);

    const roundedLat = Math.round(lat * 100) / 100;
    const roundedLon = Math.round(lon * 100) / 100;

    showToast(`📍 Loading weather at ${roundedLat}°, ${roundedLon}°`);

    getWeatherByLocation(roundedLat, roundedLon, `Point (${roundedLat}, ${roundedLon})`);
}

/* =========================================================
   EARTH CLOCK (UTC time + instructions)
========================================================= */
function startEarthClock() {
    if (clockTimer) return;

    function tick() {
        const el = getElement("earth-clock");
        if (!el) return;

        const now = new Date();
        const utcHours = String(now.getUTCHours()).padStart(2, "0");
        const utcMins  = String(now.getUTCMinutes()).padStart(2, "0");
        const utcSecs  = String(now.getUTCSeconds()).padStart(2, "0");

        el.textContent =
            `🕒 UTC ${utcHours}:${utcMins}:${utcSecs}  •  ` +
            `Drag to rotate · Scroll/pinch to zoom · Click to load weather`;
    }

    tick();
    clockTimer = setInterval(tick, 1000);
}


/* =========================================================
   EARTH INFO PANEL
========================================================= */
function formatTimezoneLabel(offsetSeconds) {
    const totalMin = Math.round(Number(offsetSeconds) / 60);
    const sign = totalMin >= 0 ? "+" : "-";
    const abs = Math.abs(totalMin);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return `UTC${sign}${h}${m > 0 ? ":" + String(m).padStart(2, "0") : ""}`;
}

function renderEarthPanel(data) {
    if (!data) return;

    const nameEl = getElement("ei-name");
    const coordsEl = getElement("ei-coords");
    const tzEl = getElement("ei-tz");
    const tempEl = getElement("ei-temp");
    const condEl = getElement("ei-condition");
    const sunriseEl = getElement("ei-sunrise");
    const sunsetEl = getElement("ei-sunset");

    const loc = data.searched_location || {};
    const cityName = loc.name || data.name || "Unknown";
    const state = loc.state || "";
    const country = loc.country || data.sys?.country || "";
    if (nameEl) nameEl.textContent = formatLocation(cityName, state, country);

    if (coordsEl) {
        const lat = data.coord?.lat;
        const lon = data.coord?.lon;
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
            const latDir = lat >= 0 ? "N" : "S";
            const lonDir = lon >= 0 ? "E" : "W";
            coordsEl.textContent =
                `${Math.abs(lat).toFixed(2)}°${latDir}, ${Math.abs(lon).toFixed(2)}°${lonDir}`;
        } else {
            coordsEl.textContent = "--";
        }
    }

    if (tzEl) tzEl.textContent = formatTimezoneLabel(data.timezone || 0);

    const temp = Number(data.main?.temp);
    if (tempEl) tempEl.textContent = `${formatTemp(temp)}${tempUnit()}`;

    const w = data.weather?.[0] || {};
    if (condEl) condEl.textContent = getConditionText(Number(w.id), w.description);

    const tz = Number(data.timezone || 0);
    if (sunriseEl) sunriseEl.textContent = formatTimeFromUnix(data.sys?.sunrise, tz);
    if (sunsetEl) sunsetEl.textContent = formatTimeFromUnix(data.sys?.sunset, tz);

    const btn = getElement("earth-save-btn");
    if (btn) {
        btn.onclick = () => {
            const saveBtn = getElement("save-location-btn");
            if (saveBtn) saveBtn.click();
            updateEarthSaveButton();
        };
        updateEarthSaveButton();
    }

    const shareBtn = getElement("earth-share-btn");
    if (shareBtn) {
        shareBtn.onclick = () => {
            if (typeof shareCurrentWeather === "function") {
                shareCurrentWeather();
            }
        };
    }
}

function updateEarthSaveButton() {
    const btn = getElement("earth-save-btn");
    if (!btn) return;

    const loc = window._loadedLocation;
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) {
        btn.textContent = "♡ Save this place";
        btn.classList.remove("saved");
        return;
    }

    if (isLocationSaved(loc.lat, loc.lon)) {
        btn.textContent = "♥ Saved";
        btn.classList.add("saved");
    } else {
        btn.textContent = "♡ Save this place";
        btn.classList.remove("saved");
    }
}

/* Initialize the whole scene */
function initEarth() {
    if (earthInitialized) return;

    const container = getElement("earth-container");
    if (!container) return;
    if (typeof THREE === "undefined") {
        console.warn("Three.js not loaded — Earth skipped");
        return;
    }

    const size = container.clientWidth || 320;

    earthScene = new THREE.Scene();

    earthCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    earthCamera.position.set(camRadius, 0, 0);
    earthCamera.lookAt(0, 0, 0);

    earthRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    earthRenderer.setSize(size, size);
    earthRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const canvas = earthRenderer.domElement;
    canvas.style.touchAction = "none";
    canvas.style.userSelect = "none";
    canvas.style.cursor = "grab";
    container.appendChild(canvas);

    const geometry = new THREE.SphereGeometry(1, 64, 64);

    const textureLoader = new THREE.TextureLoader();
    const earthTexture = textureLoader.load(
        "https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg",
        () => {
            const loader = getElement("earth-loader");
            if (loader) {
                loader.classList.add("hidden");
                setTimeout(() => loader.remove(), 600);
            }
        }
    );

    earthMaterial = new THREE.ShaderMaterial({
        uniforms: {
            earthMap: { value: earthTexture },
            sunDirection: { value: earthSunDirection }
        },
        vertexShader: `
            varying vec2 vUv;
            varying vec3 vWorldNormal;
            void main() {
                vUv = uv;
                vWorldNormal = normalize(mat3(modelMatrix) * normal);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform sampler2D earthMap;
            uniform vec3 sunDirection;
            varying vec2 vUv;
            varying vec3 vWorldNormal;
            void main() {
                vec3 dayColor = texture2D(earthMap, vUv).rgb;
                vec3 nightColor = dayColor * 0.12 + vec3(0.02, 0.05, 0.14);
                float d = dot(normalize(vWorldNormal), normalize(sunDirection));
                float mixAmount = smoothstep(-0.15, 0.15, d);
                vec3 finalColor = mix(nightColor, dayColor, mixAmount);
                gl_FragColor = vec4(finalColor, 1.0);
            }
        `
    });

    earthMesh = new THREE.Mesh(geometry, earthMaterial);
    earthScene.add(earthMesh);

    earthScene.add(new THREE.AmbientLight(0xffffff, 0.15));
    const sunLight = new THREE.DirectionalLight(0xffffff, 0.9);
    sunLight.position.set(5, 3, 5);
    earthScene.add(sunLight);

    const cloudTexture = textureLoader.load(
        "https://threejs.org/examples/textures/planets/earth_clouds_1024.png"
    );
    const cloudGeometry = new THREE.SphereGeometry(1.012, 64, 64);
    const cloudMaterial = new THREE.MeshLambertMaterial({
        map: cloudTexture,
        transparent: true,
        opacity: 0.55,
        depthWrite: false
    });
    earthClouds = new THREE.Mesh(cloudGeometry, cloudMaterial);
    earthClouds.visible = cloudsVisible;
    earthScene.add(earthClouds);

    const starGeo = new THREE.BufferGeometry();
    const starCount = 1500;
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
        const r = 30 + Math.random() * 20;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        starPositions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
        starPositions[i * 3 + 1] = r * Math.cos(phi);
        starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));

    const starMat = new THREE.PointsMaterial({
        color: 0xffffff,
        size: 0.35,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.9
    });
    earthStars = new THREE.Points(starGeo, starMat);
    earthStars.visible = starsVisible;
    earthScene.add(earthStars);

    /* Interaction state */
    const DRAG_SENSITIVITY = 0.006;
    const MIN_ZOOM = 1.5;
    const MAX_ZOOM = 5.0;

    let activePointers = new Map();
    let dragPointerId = null;
    let isDragging = false;
    let wasDragged = false;
    let lastX = 0, lastY = 0;
    let dragStartTime = 0;
    let pinchStartDist = 0;
    let pinchStartRadius = camRadius;

    function pauseAutoRotate(ms) {
        autoRotatePausedUntil = Date.now() + ms;
    }

    canvas.addEventListener("pointerdown", (e) => {
        canvas.setPointerCapture(e.pointerId);
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (activePointers.size === 1) {
            isDragging = true;
            wasDragged = false;
            dragStartTime = Date.now();
            lastX = e.clientX;
            lastY = e.clientY;
            dragPointerId = e.pointerId;
            canvas.style.cursor = "grabbing";
            pauseAutoRotate(60000);
        } else if (activePointers.size === 2) {
            isDragging = false;
            const [p1, p2] = Array.from(activePointers.values());
            pinchStartDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
            pinchStartRadius = camRadius;
        }
    });

    canvas.addEventListener("pointermove", (e) => {
        if (!activePointers.has(e.pointerId)) return;
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (activePointers.size === 2) {
            const [p1, p2] = Array.from(activePointers.values());
            const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
            if (pinchStartDist > 0) {
                const scale = pinchStartDist / dist;
                camRadius = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchStartRadius * scale));
            }
            return;
        }

        if (isDragging && e.pointerId === dragPointerId) {
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            if (Math.abs(dx) + Math.abs(dy) > 3) wasDragged = true;
            lastX = e.clientX;
            lastY = e.clientY;

            camTheta += dx * DRAG_SENSITIVITY;
            camPhi   -= dy * DRAG_SENSITIVITY;
            camPhi = Math.max(0.15, Math.min(Math.PI - 0.15, camPhi));

            camAnimating = false;
            camTargetPhi = camPhi;
            camTargetTheta = camTheta;
        }
    });

    function endPointer(e) {
        activePointers.delete(e.pointerId);

        if (e.pointerId === dragPointerId) {
            const quickTap = !wasDragged && (Date.now() - dragStartTime < 400);
            isDragging = false;
            dragPointerId = null;
            canvas.style.cursor = "grab";

            if (quickTap) {
                onGlobeClick(e);
            }
        }
    }
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);

    canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        camRadius += e.deltaY * 0.003;
        camRadius = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camRadius));
        pauseAutoRotate(10000);
    }, { passive: false });

    canvas.addEventListener("dblclick", () => {
        autoRotatePausedUntil = 0;
        camAnimating = false;
    });

    /* Animation loop */
    let lastSunUpdate = 0;

    function animate() {
        requestAnimationFrame(animate);

        if (!globeInView) return;

        const now = Date.now();

        if (now - lastSunUpdate > 30000) {
            earthSunDirection.copy(getSunDirection());
            lastSunUpdate = now;
        }

        if (now > autoRotatePausedUntil && !camAnimating && activePointers.size === 0) {
            camTheta += AUTO_ROTATE_SPEED;
        }

        if (camAnimating) {
            camPhi   += (camTargetPhi   - camPhi)   * 0.08;
            camTheta += (camTargetTheta - camTheta) * 0.08;
            if (Math.abs(camTargetPhi - camPhi) < 0.005 &&
                Math.abs(camTargetTheta - camTheta) < 0.005) {
                camPhi = camTargetPhi;
                camTheta = camTargetTheta;
                camAnimating = false;
            }
        }

        earthCamera.position.x = camRadius * Math.sin(camPhi) * Math.cos(camTheta);
        earthCamera.position.y = camRadius * Math.cos(camPhi);
        earthCamera.position.z = camRadius * Math.sin(camPhi) * Math.sin(camTheta);
        earthCamera.lookAt(0, 0, 0);

        if (earthClouds && earthClouds.visible) {
            earthClouds.rotation.y += 0.00035;
        }

        if (currentLocationMarker) {
            const t = performance.now() * 0.001;
            currentLocationMarker.children.forEach(child => {
                if (child.userData && child.userData.pulseOffset !== undefined) {
                    const phase = (t + child.userData.pulseOffset) % 2;
                    const scale = 1 + phase * 0.7;
                    child.scale.set(scale, scale, scale);
                    if (child.material) {
                        child.material.opacity = Math.max(0, 0.75 - phase * 0.5);
                    }
                }
            });
        }

        earthRenderer.render(earthScene, earthCamera);
    }
    animate();

    window.addEventListener("resize", () => {
        if (!earthRenderer || !earthCamera) return;
        const newSize = container.clientWidth || 320;
        earthRenderer.setSize(newSize, newSize);
        earthCamera.aspect = 1;
        earthCamera.updateProjectionMatrix();
    });

    const toggleBtn = getElement("toggle-clouds");
    if (toggleBtn) {
        toggleBtn.addEventListener("click", () => {
            cloudsVisible = !cloudsVisible;
            if (earthClouds) earthClouds.visible = cloudsVisible;
            toggleBtn.classList.toggle("off", !cloudsVisible);
            toggleBtn.textContent = cloudsVisible ? "☁️ Clouds" : "☁️ Clouds Off";
        });
    }

    const starBtn = getElement("toggle-stars");
    if (starBtn) {
        starBtn.addEventListener("click", () => {
            starsVisible = !starsVisible;
            if (earthStars) earthStars.visible = starsVisible;
            starBtn.classList.toggle("stars-off", !starsVisible);
        });
    }

    const lockBtn = getElement("toggle-lock");
    if (lockBtn) {
        lockBtn.textContent = globeLockedOnCity ? "🔒 Locked on city" : "🔓 Auto-rotate";
        lockBtn.addEventListener("click", () => {
            globeLockedOnCity = !globeLockedOnCity;
            lockBtn.textContent = globeLockedOnCity ? "🔒 Locked on city" : "🔓 Auto-rotate";
            if (globeLockedOnCity) {
                autoRotatePausedUntil = Infinity;
            } else {
                autoRotatePausedUntil = 0;
            }
        });
    }

    if ("IntersectionObserver" in window) {
        const io = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                globeInView = entry.isIntersecting;
            });
        }, { threshold: 0.05 });
        io.observe(container);
    }

    startEarthClock();

    earthInitialized = true;
    updateSavedMarkers();
}


/* =========================================================
   RESET LOADING STATES
========================================================= */
function setLoadingState() {
    const hourlyContainer = getElement("hourly-forecast");
    const forecastContainer = getElement("forecast");
    if (hourlyContainer) {
        hourlyContainer.innerHTML = '<div class="loading-container"><div class="spinner"></div></div>';
    }
    if (forecastContainer) {
        forecastContainer.innerHTML = '<div class="loading-container"><div class="spinner"></div></div>';
    }

    const uvEl = getElement("uv-index");
    const aqEl = getElement("air-quality");
    if (uvEl) uvEl.textContent = "--";
    if (aqEl) aqEl.textContent = "--";

    const reportEl = getElement("weather-report");
    if (reportEl) reportEl.textContent = "";
}


/* =========================================================
   LOAD WEATHER BY CITY
========================================================= */
function getWeather(city) {
    city = String(city || "").trim();
    if (!city) return;

    const errorMessage = getElement("error-message");
    const cityElement = getElement("city");
    const conditionElement = getElement("condition");
    const temperatureElement = getElement("temperature");

    if (errorMessage) errorMessage.textContent = "";
    if (cityElement) cityElement.textContent = "Loading...";
    if (conditionElement) conditionElement.textContent = "Loading weather...";
    if (temperatureElement) temperatureElement.textContent = `--${tempUnit()}`;
    setLoadingState();

    window._currentWeatherData = null;

    fetch(`/weather-full?city=${encodeURIComponent(city)}`)
        .then(response => {
            if (!response.ok) throw new Error(`Weather request failed: ${response.status}`);
            return response.json();
        })
        .then(payload => {
            if (!payload || !payload.weather || !payload.forecast) {
                throw new Error("Invalid combined response");
            }
            displayWeather(payload.weather);
            renderHourlyForecast(payload.forecast);
            renderForecast(payload.forecast);
        })
        .catch(error => {
            console.error("Weather error:", error);
            if (conditionElement) conditionElement.textContent = "Unable to load weather.";
            if (errorMessage) errorMessage.textContent = "Unable to load weather.";
        });
}


/* =========================================================
   SELECT SEARCH LOCATION
========================================================= */
function selectLocation(location) {
    if (!location) return;
    currentLocation = location;

    const resultsContainer = getElement("location-results");
    const errorMessage = getElement("error-message");
    const searchInput = getElement("city-input");
    const searchHint = getElement("search-hint");

    if (resultsContainer) {
        resultsContainer.innerHTML = "";
        resultsContainer.style.display = "none";
    }
    setControlsVisibility(true);
    if (errorMessage) errorMessage.textContent = "";
    if (searchHint) searchHint.style.display = "none";

    const name = location.name || "";
    const state = location.state || "";
    const country = location.country || "";
    const displayName = formatLocation(name, state, country);
    if (searchInput) searchInput.value = displayName;

    const latitude = Number(location.lat);
    const longitude = Number(location.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        if (errorMessage) errorMessage.textContent = "Invalid location coordinates.";
        return;
    }

    getWeatherByCoordinates(latitude, longitude, name, country, state);
}


/* =========================================================
   WEATHER BY COORDINATES
========================================================= */
function getWeatherByCoordinates(latitude, longitude, searchedName = "", searchedCountry = "", searchedState = "") {
    const errorMessage = getElement("error-message");
    const cityElement = getElement("city");
    const conditionElement = getElement("condition");
    const temperatureElement = getElement("temperature");
    const forecastLocation = getElement("forecast-location");

    if (errorMessage) errorMessage.textContent = "";
    if (cityElement) cityElement.textContent = "Loading...";
    if (conditionElement) conditionElement.textContent = "Loading weather...";
    if (temperatureElement) temperatureElement.textContent = `--${tempUnit()}`;
    if (forecastLocation) forecastLocation.textContent = "Loading...";
    setLoadingState();

    window._currentWeatherData = null;

    fetch(`/weather-full?lat=${latitude}&lon=${longitude}`)
        .then(response => {
            if (!response.ok) throw new Error(`Weather request failed: ${response.status}`);
            return response.json();
        })
        .then(payload => {
            if (!payload || !payload.weather || !payload.forecast) {
                throw new Error("Invalid combined response");
            }

            const w = payload.weather;
            const f = payload.forecast;

            w.searched_location = {
                name: searchedName || w.name,
                country: searchedCountry || w.sys?.country || "",
                state: searchedState || ""
            };
            f.searched_location = {
                name: searchedName || w.name,
                country: searchedCountry || w.sys?.country || "",
                state: searchedState || ""
            };

            displayWeather(w);
            renderHourlyForecast(f);
            renderForecast(f);
        })
        .catch(error => {
            console.error("Coordinate weather error:", error);
            if (conditionElement) conditionElement.textContent = "Unable to load weather.";
            if (errorMessage) errorMessage.textContent = "Unable to load weather.";
        });
}


/* =========================================================
   SEARCH LOCATIONS
========================================================= */
function searchLocations(city) {
    city = String(city || "").trim();
    if (!city) return;

    const resultsContainer = getElement("location-results");
    const errorMessage = getElement("error-message");
    const searchHint = getElement("search-hint");

    if (!resultsContainer) return;
    if (typeof mpTrack === "function") {
        mpTrack("search_city", { query: city });
    }
    if (errorMessage) errorMessage.textContent = "";
    resultsContainer.innerHTML = '<div class="loading-container"><div class="spinner"></div></div>';
    resultsContainer.style.display = "block";
    setControlsVisibility(false);

    fetch(`/locations?city=${encodeURIComponent(city)}`)
        .then(response => response.json().then(data => ({ status: response.status, data })))
        .then(({ status, data }) => {
            resultsContainer.innerHTML = "";

            if (status === 404 || data.cod === 404 || data.cod === "404") {
                if (errorMessage) errorMessage.textContent = "City not found. Please try again.";
                resultsContainer.style.display = "none";
                if (searchHint) searchHint.style.display = "none";
                setControlsVisibility(true);
                return;
            }
            if (status !== 200 && data.cod !== 200 && data.cod !== "200") {
                if (errorMessage) errorMessage.textContent = "Unable to search locations.";
                resultsContainer.style.display = "none";
                if (searchHint) searchHint.style.display = "none";
                setControlsVisibility(true);
                return;
            }
            if (!Array.isArray(data.locations) || data.locations.length === 0) {
                if (errorMessage) errorMessage.textContent = "City not found. Please try again.";
                resultsContainer.style.display = "none";
                if (searchHint) searchHint.style.display = "none";
                setControlsVisibility(true);
                return;
            }

            if (data.locations.length === 1) {
                selectLocation(data.locations[0]);
                return;
            }

            const heading = document.createElement("div");
            heading.className = "location-heading";
            heading.innerHTML = `
                📍 Choose your location
                <small class="location-instruction">Select a location below to view its weather.</small>
            `;
            resultsContainer.appendChild(heading);

            data.locations.forEach(location => {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "location-item";
                const countryName = getCountryName(location.country);
                button.innerHTML = `
                    <strong>📍 ${location.name || "Unknown location"}</strong>
                    ${location.state ? `<small>📌 ${location.state}</small>` : ""}
                    <small>🌍 ${countryName}</small>
                `;
                button.addEventListener("click", () => selectLocation(location));
                resultsContainer.appendChild(button);
            });
        })
        .catch(error => {
            console.error("Location search error:", error);
            resultsContainer.innerHTML = "";
            resultsContainer.style.display = "none";
            if (errorMessage) errorMessage.textContent = "Unable to search locations.";
            setControlsVisibility(true);
        });
}


/* =========================================================
   USE MY LOCATION
========================================================= */
function useMyLocation() {
    const errorMessage = getElement("error-message");
    const searchInput = getElement("city-input");
    const searchHint = getElement("search-hint");
    const resultsContainer = getElement("location-results");
    const locationBtn = getElement("location-button");

    if (!navigator.geolocation) {
        if (errorMessage) errorMessage.textContent = "Geolocation is not supported by this browser.";
        return;
    }

    if (errorMessage) errorMessage.textContent = "📍 Getting your precise location...";
    if (locationBtn) {
        locationBtn.disabled = true;
        locationBtn.textContent = "📍 Locating...";
    }

    if (searchInput) searchInput.value = "";
    if (searchHint) searchHint.style.display = "none";
    if (resultsContainer) {
        resultsContainer.innerHTML = "";
        resultsContainer.style.display = "none";
    }
    setControlsVisibility(true);

    window._currentWeatherData = null;

    if (typeof mpTrack === "function") {
        mpTrack("use_my_location");
    }

    navigator.geolocation.getCurrentPosition(
        position => {
            const latitude = position.coords.latitude;
            const longitude = position.coords.longitude;
            const accuracy = position.coords.accuracy;

            if (locationBtn) {
                locationBtn.disabled = false;
                locationBtn.textContent = "📍 Use My Location";
            }

            if (errorMessage) {
                errorMessage.textContent =
                    `📍 Located within ~${Math.round(accuracy)}m accuracy. Loading weather...`;
            }

            getWeatherByLocation(latitude, longitude, `Your Location (±${Math.round(accuracy)}m)`);
        },
        error => {
            console.error("Geolocation error:", error);
            if (locationBtn) {
                locationBtn.disabled = false;
                locationBtn.textContent = "📍 Use My Location";
            }
            if (errorMessage) {
                if (error.code === error.PERMISSION_DENIED) {
                    errorMessage.textContent = "Location permission was denied. Please allow location access.";
                } else if (error.code === error.POSITION_UNAVAILABLE) {
                    errorMessage.textContent = "Your location is unavailable. Try again or search manually.";
                } else if (error.code === error.TIMEOUT) {
                    errorMessage.textContent = "Location request timed out. Try again.";
                } else {
                    errorMessage.textContent = "Unable to get your location.";
                }
            }
        },
        {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 0
        }
    );
}


/* =========================================================
   WEATHER BY GPS
========================================================= */
function getWeatherByLocation(latitude, longitude, displayName = "Your Location") {
    const errorMessage = getElement("error-message");
    const cityElement = getElement("city");
    const conditionElement = getElement("condition");
    const forecastLocation = getElement("forecast-location");

    if (cityElement) cityElement.textContent = "Loading...";
    if (conditionElement) conditionElement.textContent = "Loading your local weather...";
    if (forecastLocation) forecastLocation.textContent = "Loading...";
    setLoadingState();

    const reversePromise = fetch(`/reverse?lat=${latitude}&lon=${longitude}`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);

    const weatherPromise = fetch(`/weather-full?lat=${latitude}&lon=${longitude}`)
        .then(response => {
            if (!response.ok) throw new Error(`GPS request failed: ${response.status}`);
            return response.json();
        });

    Promise.all([reversePromise, weatherPromise])
        .then(([reverseData, payload]) => {
            if (!payload || !payload.weather || !payload.forecast) {
                throw new Error("Invalid combined response");
            }

            const w = payload.weather;
            const f = payload.forecast;

            const preciseName = (reverseData && reverseData.name) ? reverseData.name : displayName;
            const preciseState = (reverseData && reverseData.state) ? reverseData.state : "";
            const preciseCountry = (reverseData && reverseData.country) ? reverseData.country : "";

            w.searched_location = {
                name: preciseName || w.name,
                country: preciseCountry || w.sys?.country || "",
                state: preciseState || ""
            };
            f.searched_location = {
                name: preciseName || w.name,
                country: preciseCountry || w.sys?.country || "",
                state: preciseState || ""
            };

            displayWeather(w);
            renderHourlyForecast(f);
            renderForecast(f);

            if (errorMessage) errorMessage.textContent = "";
        })
        .catch(error => {
            console.error("GPS weather error:", error);
            if (conditionElement) conditionElement.textContent = "Unable to load local weather.";
            if (errorMessage) errorMessage.textContent = "Unable to load your local weather.";
        });
}


/* =========================================================
   SEARCH SETUP
========================================================= */
function setupSearch() {
    const input = getElement("city-input");
    const searchButton = getElement("search-button");
    const clearButton = getElement("clear-search");
    const searchHint = getElement("search-hint");

    if (!input || !searchButton) return;

    input.addEventListener("focus", () => {
        if (searchHint) searchHint.style.display = "block";
    });
    input.addEventListener("input", () => {
        if (searchHint) {
            searchHint.style.display = input.value.trim().length > 0 ? "block" : "none";
        }
    });
    document.addEventListener("click", (event) => {
        if (!event.target.closest(".search-box") && !event.target.closest("#location-results")) {
            if (searchHint) searchHint.style.display = "none";
        }
    });

    searchButton.addEventListener("click", () => {
        const city = input.value.trim();
        if (!city) return;
        searchLocations(city);
    });

    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            const city = input.value.trim();
            if (!city) return;
            searchLocations(city);
        }
    });

    if (clearButton) {
        clearButton.addEventListener("click", () => {
            input.value = "";
            input.focus();
            if (searchHint) searchHint.style.display = "block";
            const results = getElement("location-results");
            if (results) {
                results.innerHTML = "";
                results.style.display = "none";
            }
            setControlsVisibility(true);
        });
    }
}


/* =========================================================
   LOCATION BUTTON SETUP
========================================================= */
function setupLocationButton() {
    const button = getElement("location-button");
    if (!button) return;
    button.addEventListener("click", useMyLocation);
}


/* =========================================================
   THEME BUTTON SETUP
========================================================= */
function setupThemeButton() {
    const btn = getElement("theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", cycleTheme);
}


/* =========================================================
   AUTO-REFRESH
========================================================= */
function refreshCurrentLocation() {
    const loc = window._loadedLocation;
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return;
    getWeatherByCoordinates(loc.lat, loc.lon, loc.name, loc.country, loc.state);
}

function startAutoRefresh() {
    stopAutoRefresh();
    autoRefreshTimer = setInterval(refreshCurrentLocation, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }
}

/* Refresh instantly when the user comes back to the tab */
let lastFocusRefresh = 0;
function setupVisibilityRefresh() {
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;

        const now = Date.now();
        if (now - lastFocusRefresh < 2 * 60 * 1000) return;

        if (!window._loadedLocation) return;
        lastFocusRefresh = now;

        console.log("🔄 Refreshing on tab focus");
        refreshCurrentLocation();
    });
}


/* =========================================================
   SAVED LOCATIONS
========================================================= */
function isLocationSaved(lat, lon) {
    return savedLocations.some(l =>
        Math.abs(l.lat - lat) < 0.001 && Math.abs(l.lon - lon) < 0.001
    );
}

function renderSavedLocations() {
    const container = getElement("saved-locations");
    if (!container) return;
    container.innerHTML = "";

    savedLocations.forEach((loc, index) => {
        const chip = document.createElement("div");
        chip.className = "saved-chip";

        const label = document.createElement("span");
        label.className = "chip-label";
        label.textContent = "📍 " + (loc.name || "Unknown");
        label.title = "Load " + (loc.name || "this location");
        label.addEventListener("click", () => {
            getWeatherByCoordinates(loc.lat, loc.lon, loc.name, loc.country, loc.state);
        });
        chip.appendChild(label);

        const remove = document.createElement("button");
        remove.className = "remove-chip";
        remove.type = "button";
        remove.textContent = "✕";
        remove.title = "Remove from saved";
        remove.addEventListener("click", (e) => {
            e.stopPropagation();
            savedLocations.splice(index, 1);
            localStorage.setItem("weatherSavedLocations", JSON.stringify(savedLocations));
            renderSavedLocations();
            updateSaveButtonState();
        });
        chip.appendChild(remove);

        container.appendChild(chip);
    });

    updateSavedMarkers();
    updateEarthSaveButton();
    renderCitiesGlance();
}


/* =========================================================
   GLOBAL CATASTROPHE WATCH
========================================================= */
function getDisasterIcon(type) {
    const map = {
        "EQ": "🌋",
        "TC": "🌀",
        "FL": "🌊",
        "VO": "🌋",
        "DR": "🏜️",
        "WF": "🔥"
    };
    return map[type] || "⚠️";
}

function getDisasterName(type) {
    const map = {
        "EQ": "Earthquake",
        "TC": "Tropical Cyclone",
        "FL": "Flood",
        "VO": "Volcano",
        "DR": "Drought",
        "WF": "Wildfire"
    };
    return map[type] || "Disaster";
}

async function renderCatastropheWatch() {
    const container = getElement("catastrophe-list");
    if (!container) return;

    try {
        const res = await fetch("/global-alerts");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const alerts = data.alerts || [];

        if (alerts.length === 0) {
            container.innerHTML = `
                <div class="catastrophe-empty">
                    ✅ No major global disasters reported in the last 30 days
                </div>
            `;
            return;
        }

        container.innerHTML = "";
        alerts.forEach(a => {
            const card = document.createElement("a");
            card.className = `catastrophe-card ${(a.alertlevel || "").toLowerCase()}`;
            card.href = a.url;
            card.target = "_blank";
            card.rel = "noopener noreferrer";

            const icon = getDisasterIcon(a.type);
            const typeLabel = getDisasterName(a.type);

            card.innerHTML = `
                <div class="catastrophe-icon">${icon}</div>
                <div class="catastrophe-info">
                    <div class="catastrophe-type">${typeLabel}</div>
                    <div class="catastrophe-name" title="${a.name}">${a.name}</div>
                    <div class="catastrophe-meta">
                        <span class="catastrophe-badge ${(a.alertlevel || "").toLowerCase()}">
                            ${a.alertlevel || "Green"}
                        </span>
                        <span>${a.country || ""}</span>
                        <span class="catastrophe-view">View report →</span>
                    </div>
                </div>
            `;
            container.appendChild(card);
        });

        if (typeof mpTrack === "function") {
            mpTrack("catastrophe_watch_loaded", { count: alerts.length });
        }

    } catch (err) {
        console.error("Catastrophe watch error:", err);
        container.innerHTML = `
            <div class="catastrophe-empty">
                ⚠️ Unable to load global alerts
            </div>
        `;
    }
}


/* =========================================================
   SAVED CITIES AT A GLANCE
========================================================= */
const cityCardCache = {};
const CARD_CACHE_TTL = 5 * 60 * 1000;

function renderCitiesGlance() {
    const container = getElement("cities-glance");
    if (!container) return;

    if (!savedLocations || savedLocations.length === 0) {
        container.innerHTML = `
            <div class="cities-empty">
                💡 Save a location with the ♡ button to see it here
            </div>
        `;
        return;
    }

    container.innerHTML = "";
    const cards = [];

    savedLocations.forEach(loc => {
        const card = document.createElement("div");
        card.className = "city-card loading";
        card.title = "Click to load " + (loc.name || "this location");

        card.innerHTML = `
            <div class="city-card-name">📍 ${loc.name || "Unknown"}</div>
            <div class="city-card-spinner"></div>
        `;

        card.addEventListener("click", () => {
            getWeatherByCoordinates(loc.lat, loc.lon, loc.name, loc.country, loc.state);
            window.scrollTo({ top: 0, behavior: "smooth" });
        });

        container.appendChild(card);
        cards.push({ card, loc });
    });

    cards.forEach(({ card, loc }) => {
        const key = `${loc.lat},${loc.lon}`;
        const cached = cityCardCache[key];

        if (cached && Date.now() - cached.time < CARD_CACHE_TTL) {
            fillCityCard(card, loc, cached.data);
            return;
        }

        fetch(`/weather?lat=${loc.lat}&lon=${loc.lon}`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (!data || (data.cod !== 200 && data.cod !== "200")) {
                    throw new Error("No data");
                }
                cityCardCache[key] = { data, time: Date.now() };
                fillCityCard(card, loc, data);
            })
            .catch(() => {
                card.classList.remove("loading");
                card.classList.add("error");
                card.innerHTML = `
                    <div class="city-card-name">📍 ${loc.name || "Unknown"}</div>
                    <div class="city-card-feels">⚠️ Unavailable</div>
                `;
            });
    });
}

function fillCityCard(card, loc, data) {
    card.classList.remove("loading");

    const w = data.weather?.[0] || {};
    const wId = Number(w.id);
    const icon = getWeatherIcon(wId, w.icon);
    const temp = Number(data.main?.temp);
    const feels = Number(data.main?.feels_like);

    const rawName = loc.name || data.name || "Unknown";
    const shortName = rawName.length > 18 ? rawName.slice(0, 16) + "…" : rawName;

    card.innerHTML = `
        <div class="city-card-name" title="${rawName}">📍 ${shortName}</div>
        <div class="city-card-icon">${icon}</div>
        <div class="city-card-temp">${formatTemp(temp, 0)}${tempUnit()}</div>
        <div class="city-card-feels">feels ${formatTemp(feels, 0)}${tempUnit()}</div>
    `;
}

function clearCityCardCache() {
    Object.keys(cityCardCache).forEach(k => delete cityCardCache[k]);
}

function updateSaveButtonState() {
    const btn = getElement("save-location-btn");
    if (!btn) return;

    const loc = window._loadedLocation;

    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) {
        btn.textContent = "♡ Save Location";
        btn.classList.remove("saved");
        btn.disabled = true;
        return;
    }

    btn.disabled = false;

    if (isLocationSaved(loc.lat, loc.lon)) {
        btn.textContent = "♥ Saved";
        btn.classList.add("saved");
    } else {
        btn.textContent = "♡ Save Location";
        btn.classList.remove("saved");
    }
}

function setupSaveButton() {
    const btn = getElement("save-location-btn");
    if (!btn) return;

    btn.addEventListener("click", () => {
        const loc = window._loadedLocation;
        if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return;

        if (isLocationSaved(loc.lat, loc.lon)) {
            savedLocations = savedLocations.filter(l =>
                !(Math.abs(l.lat - loc.lat) < 0.001 && Math.abs(l.lon - loc.lon) < 0.001)
            );
        } else {
            savedLocations.push({
                name: loc.name,
                state: loc.state,
                country: loc.country,
                lat: loc.lat,
                lon: loc.lon
            });
        }

        if (typeof mpTrack === "function") {
            mpTrack(isLocationSaved(loc.lat, loc.lon) ? "location_unsaved" : "location_saved", {
                city: loc.name,
                country: loc.country
            });
        }

        localStorage.setItem("weatherSavedLocations", JSON.stringify(savedLocations));
        renderSavedLocations();
        updateSaveButtonState();
    });
}


/* =========================================================
   TOAST HELPER
========================================================= */
function showToast(message, duration = 2200) {
    const toast = getElement("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => {
        toast.classList.remove("show");
    }, duration);
}


/* =========================================================
   SHARE CURRENT WEATHER
========================================================= */
function buildShareText() {
    const data = window._currentWeatherData;
    if (!data) return null;

    const weather = data.weather?.[0] || {};
    const main = data.main || {};
    const wind = data.wind || {};
    const weatherId = Number(weather.id);
    const condition = getConditionText(weatherId, weather.description);
    const icon = getWeatherIcon(weatherId, weather.icon);

    const loc = data.searched_location || {};
    const city = loc.name || data.name || "Unknown";
    const state = loc.state || "";
    const country = loc.country || data.sys?.country || "";
    const locationText = formatLocation(city, state, country);

    const temp = Number(main.temp);
    const feelsLike = Number(main.feels_like);
    const humidity = Number(main.humidity);
    const windSpeed = Number(wind.speed);
    const windDeg = Number(wind.deg);

    let text = `${icon} ${locationText} — ${formatTemp(temp)}${tempUnit()}, ${condition}\n`;
    text += `Feels like ${formatTemp(feelsLike)}${tempUnit()} | `;
    text += `Humidity ${humidity}% | `;
    text += `Wind ${formatSpeed(windSpeed)} ${speedUnit()}`;
    if (Number.isFinite(windDeg)) text += ` ${degreesToCompass(windDeg)}`;
    text += `\n\n${window.location.href}`;

    return text;
}


/* =========================================================
   QR CODE MODAL
========================================================= */
function openQRModal() {
    const overlay = getElement("qr-overlay");
    const qrContainer = getElement("qr-code");
    if (!overlay || !qrContainer) return;

    qrContainer.innerHTML = "";

    const url = window.location.origin;

    if (typeof QRCode !== "undefined") {
        new QRCode(qrContainer, {
            text: url,
            width: 220,
            height: 220,
            colorDark: "#0f172a",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.H
        });
    } else {
        qrContainer.innerHTML =
            '<p style="color:#0f172a;font-size:12px;padding:20px;">QR library failed to load</p>';
    }

    overlay.classList.add("show");
}

function closeQRModal() {
    const overlay = getElement("qr-overlay");
    if (overlay) overlay.classList.remove("show");
}

function setupQRModal() {
    const overlay = getElement("qr-overlay");
    const closeBtn = getElement("qr-close");
    const copyBtn = getElement("qr-copy-url");
    if (!overlay) return;

    if (closeBtn) closeBtn.addEventListener("click", closeQRModal);

    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeQRModal();
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeQRModal();
    });

    if (copyBtn) {
        copyBtn.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(window.location.origin);
                showToast("✅ Link copied");
            } catch {
                showToast("❌ Copy failed");
            }
        });
    }
}


/* =========================================================
   SHARE — custom menu
========================================================= */
function openShareMenu() {
    const overlay = getElement("share-menu-overlay");
    const preview = getElement("share-preview");
    const nativeBtn = getElement("share-native-btn");

    if (!overlay) return;

    const text = buildShareText();
    if (!text) {
        showToast("No weather data to share yet.");
        return;
    }

    if (preview) {
        preview.textContent = text.split("\n")[0];
    }

    if (nativeBtn) {
        nativeBtn.style.display = (typeof navigator.share === "function") ? "flex" : "none";
    }

    overlay.classList.add("show");
}

function closeShareMenu() {
    const overlay = getElement("share-menu-overlay");
    if (overlay) overlay.classList.remove("show");
}

function handleShareOption(platform) {
    const text = buildShareText();
    if (!text) {
        showToast("No weather data to share yet.");
        return;
    }

    const pageUrl = window.location.href;
    const encodedText = encodeURIComponent(text);
    const encodedUrl = encodeURIComponent(pageUrl);

    let shareUrl = "";

    switch (platform) {
        case "whatsapp":
            shareUrl = `https://wa.me/?text=${encodedText}`;
            break;
        case "facebook":
            shareUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}&quote=${encodedText}`;
            break;
        case "twitter":
            shareUrl = `https://twitter.com/intent/tweet?text=${encodedText}`;
            break;
        case "telegram":
            shareUrl = `https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`;
            break;
        case "native":
            closeShareMenu();
            if (typeof navigator.share === "function") {
                navigator.share({ title: "8X Weather", text })
                    .catch(() => { /* user cancelled */ });
            }
            return;

        case "qr":
            closeShareMenu();
            openQRModal();
            return;

        case "copy":
            navigator.clipboard.writeText(text)
                .then(() => {
                    showToast("✅ Weather copied to clipboard");
                    closeShareMenu();
                })
                .catch(() => {
                    const ta = document.createElement("textarea");
                    ta.value = text;
                    ta.style.position = "fixed";
                    ta.style.opacity = "0";
                    document.body.appendChild(ta);
                    ta.select();
                    try { document.execCommand("copy"); showToast("✅ Copied"); } catch {}
                    document.body.removeChild(ta);
                    closeShareMenu();
                });
            return;
        default:
            return;
    }

    window.open(shareUrl, "_blank", "noopener,noreferrer");
    closeShareMenu();
}

function setupShareMenu() {
    const overlay = getElement("share-menu-overlay");
    const closeBtn = getElement("share-close");
    if (!overlay) return;

    overlay.querySelectorAll("[data-share]").forEach(btn => {
        btn.addEventListener("click", () => {
            handleShareOption(btn.dataset.share);
        });
    });

    if (closeBtn) closeBtn.addEventListener("click", closeShareMenu);

    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeShareMenu();
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeShareMenu();
    });
}

function shareCurrentWeather() {
    openShareMenu();
}

function setupShareButton() {
    const btn = getElement("share-btn");
    if (!btn) return;
    btn.addEventListener("click", shareCurrentWeather);
}


/* =========================================================
   BACK TO TOP
========================================================= */
function setupBackToTop() {
    const btn = getElement("back-to-top");
    if (!btn) return;

    btn.addEventListener("click", () => {
        window.scrollTo({ top: 0, behavior: "smooth" });
    });

    window.addEventListener("scroll", () => {
        if (window.scrollY > 400) {
            btn.classList.add("visible");
        } else {
            btn.classList.remove("visible");
        }
    }, { passive: true });
}


/* =========================================================
   FEEDBACK WIDGET
========================================================= */
let feedbackCategory = "general";

function setupFeedback() {
    const openBtn = getElement("feedback-btn");
    const overlay = getElement("feedback-overlay");
    const closeBtn = getElement("feedback-close");
    const submitBtn = getElement("feedback-submit");
    const message = getElement("feedback-message");
    const email = getElement("feedback-email");
    const catBtns = document.querySelectorAll(".fb-cat");

    if (!openBtn || !overlay) return;

    openBtn.addEventListener("click", () => {
        overlay.classList.add("show");
        if (typeof mpTrack === "function") mpTrack("feedback_opened");
    });

    closeBtn.addEventListener("click", () => {
        overlay.classList.remove("show");
    });

    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.classList.remove("show");
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") overlay.classList.remove("show");
    });

    catBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            catBtns.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            feedbackCategory = btn.dataset.cat;
        });
    });

    submitBtn.addEventListener("click", () => {
        const msg = message.value.trim();

        if (msg.length < 5) {
            showToast("Please write a bit more (5+ chars)");
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = "Sending...";

        if (typeof mpTrack === "function") {
            mpTrack("feedback_submitted", {
                category: feedbackCategory,
                message: msg.slice(0, 1000),
                email: email.value.trim() || "(not provided)",
                message_length: msg.length,
                page_url: window.location.href,
                current_city: window._loadedLocation?.name || "unknown"
            });
        }

        fetch("/feedback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                category: feedbackCategory,
                message: msg,
                email: email.value.trim(),
                city: window._loadedLocation?.name || "",
                page_url: window.location.href
            })
        }).catch(err => console.warn("Feedback email failed:", err));

        setTimeout(() => {
            message.value = "";
            email.value = "";
            submitBtn.disabled = false;
            submitBtn.textContent = "Send Feedback";
            overlay.classList.remove("show");
            showToast("✅ Thank you for your feedback!");
        }, 600);
    });
}


/* =========================================================
   HIDE LOCATION RESULTS WHEN CLICKING OUTSIDE
========================================================= */
function setupOutsideClick() {
    document.addEventListener("click", (event) => {
        const results = getElement("location-results");
        const searchBox = document.querySelector(".search-box");
        if (!results || !searchBox) return;
        if (!searchBox.contains(event.target) && !results.contains(event.target)) {
            results.innerHTML = "";
            results.style.display = "none";
            setControlsVisibility(true);
        }
    });
}


/* =========================================================
   MIXPANEL ANALYTICS
========================================================= */
function mpTrack(eventName, properties = {}) {
    if (typeof mixpanel === "undefined") return;
    try {
        mixpanel.track(eventName, {
            ...properties,
            app_version: "1.0",
            unit_mode: unitMode,
            theme: themeMode
        });
    } catch (e) {
        console.warn("Mixpanel track failed:", e);
    }
}


/* =========================================================
   DEFAULT WEATHER
========================================================= */
async function loadDefaultWeather() {
    const input = getElement("city-input");

    // 0. Show cached data instantly (0 ms) — then fetch fresh in background
    const cachedWeather = loadWeatherFromCache();
    const cachedForecast = loadForecastFromCache();

    if (cachedWeather) {
        // Render cached weather right away
        displayWeather(cachedWeather);
        if (cachedForecast) {
            renderHourlyForecast(cachedForecast);
            renderForecast(cachedForecast);
        }

        // Now fetch fresh data in background — prefer coordinates for precision
        const lastCoordsRaw = localStorage.getItem("weatherLastCoords");
        if (lastCoordsRaw) {
            try {
                const lc = JSON.parse(lastCoordsRaw);
                if (lc && Number.isFinite(lc.lat) && Number.isFinite(lc.lon)) {
                    if (input) input.value = lc.name || "";
                    getWeatherByCoordinates(lc.lat, lc.lon, lc.name, lc.country, lc.state);
                    return;
                }
            } catch (e) { /* fall through */ }
        }

        // Fallback: name-based restore
        const lastCity = localStorage.getItem("weatherLastCity");
        if (lastCity) {
            if (input) input.value = lastCity;
            getWeather(lastCity);
        } else if (cachedWeather.coord) {
            getWeatherByCoordinates(
                cachedWeather.coord.lat,
                cachedWeather.coord.lon,
                cachedWeather.name || "",
                cachedWeather.sys?.country || "",
                ""
            );
        }
        return;
    }

    // 1. No cache — restore last location (prefer coordinates for precision)
    const lastCoordsRaw = localStorage.getItem("weatherLastCoords");
    if (lastCoordsRaw) {
        try {
            const lc = JSON.parse(lastCoordsRaw);
            if (lc && Number.isFinite(lc.lat) && Number.isFinite(lc.lon)) {
                if (input) input.value = lc.name || "";
                getWeatherByCoordinates(lc.lat, lc.lon, lc.name, lc.country, lc.state);
                return;
            }
        } catch (e) { /* fall through */ }
    }

    const lastCity = localStorage.getItem("weatherLastCity");
    if (lastCity) {
        if (input) input.value = lastCity;
        getWeather(lastCity);
        return;
    }

    // 2. First visit — try IP-based location (no permission needed)
    if (input) input.value = "Finding your location...";

    try {
        const res = await fetch("/my-location");
        if (res.ok) {
            const data = await res.json();
            if (
                data &&
                data.name &&
                Number.isFinite(data.lat) &&
                Number.isFinite(data.lon)
            ) {
                getWeatherByCoordinates(
                    data.lat,
                    data.lon,
                    data.name,
                    data.country,
                    data.state
                );
                return;
            }
        }
    } catch (err) {
        console.warn("IP geolocation failed:", err);
    }

    // 3. Everything failed — fall back to Kisumu
    if (input) input.value = "Kisumu";
    getWeather("Kisumu");
}


/* =========================================================
   START APPLICATION
========================================================= */
document.addEventListener("DOMContentLoaded", () => {
    const searchHint = getElement("search-hint");
    if (searchHint) searchHint.style.display = "none";

    applyTheme();

    setupSearch();
    setupLocationButton();
    setupThemeButton();
    setupUnitButton();
    setupRefreshButton();
    startAutoRefresh();
    setupVisibilityRefresh();
    setupSaveButton();
    setupShareButton();
    setupShareMenu();
    setupQRModal();
    renderSavedLocations();
    renderCatastropheWatch();
    renderCitiesGlance();
    updateSaveButtonState();
    setupOutsideClick();
    setupBackToTop();
    setupCalendarNav();
    setupFeedback();
    initEarth();

    updateDateTime();
    setInterval(updateDateTime, 1000);

    setInterval(updateSunCountdown, 30000);

    loadDefaultWeather();

    if ("serviceWorker" in navigator) {
        window.addEventListener("load", () => {
            navigator.serviceWorker.register("/service-worker.js")
                .then((reg) => {
                    console.log("✅ Service worker registered");

                    reg.update();

                    reg.addEventListener("updatefound", () => {
                        const newWorker = reg.installing;
                        if (!newWorker) return;

                        newWorker.addEventListener("statechange", () => {
                            if (newWorker.state === "installed" &&
                                navigator.serviceWorker.controller) {
                                newWorker.postMessage("SKIP_WAITING");
                            }
                        });
                    });
                })
                .catch(err => console.warn("Service worker failed:", err));

            let refreshing = false;
            navigator.serviceWorker.addEventListener("controllerchange", () => {
                if (refreshing) return;
                refreshing = true;
                console.log("🔄 New version activated — reloading");
                window.location.reload();
            });
        });
    }
});