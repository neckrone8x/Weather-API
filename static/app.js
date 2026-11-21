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

/* Names from a saved city, a search result, a URL or an outside service are
   text, never HTML: escape them before they go into innerHTML. */
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}

/* Only http(s) links from outside data (so never "javascript:"). "" otherwise. */
function safeHttpUrl(url) {
    try {
        const u = new URL(String(url || ""));
        return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
    } catch { return ""; }
}


/* =========================================================
   NETWORK — every request gives up after 20 s
   (the timer keeps running while the body is read, so a reply
   that stalls half-way is cut off too; aborting a finished
   request does nothing)
========================================================= */
const FETCH_TIMEOUT_MS = 20000;

function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal });
}

/* When was this reply's data fetched, if it is a saved copy? null = it's fresh.
   - the server marks replies built from its saved copies (X-Stale-Saved-At, unix s),
     e.g. while OpenWeatherMap rejects our key
   - the service worker marks replies it served from its own saved copy */
function savedCopyTime(response) {
    if (!response) return null;
    const serverSaved = Number(response.headers.get("X-Stale-Saved-At"));
    if (Number.isFinite(serverSaved) && serverSaved > 0) return serverSaved * 1000;
    if (response.headers.get("X-SW-Fallback") !== "1") return null;
    const t = Date.parse(response.headers.get("X-SW-Saved-At") || response.headers.get("Date") || "");
    return Number.isFinite(t) ? t : 0;
}


/* =========================================================
   "SHOWING SAVED DATA" NOTE + RETRY
========================================================= */
window._dataTime = null;   // when the weather on screen was fetched

function formatSavedTime(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "earlier";
    const d = new Date(ms);
    const time = d.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit", hour12: false });
    if (d.toDateString() === new Date().toDateString()) return time;
    return `${d.toLocaleDateString("en-KE", { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
}

function getDataStatusElement() {
    let el = getElement("data-status");
    if (el) return el;
    const anchor = getElement("error-message");
    if (!anchor || !anchor.parentNode) return null;
    el = document.createElement("div");
    el.id = "data-status";
    el.className = "data-status";
    el.setAttribute("role", "status");
    el.hidden = true;
    anchor.parentNode.insertBefore(el, anchor.nextSibling);
    return el;
}

/* savedTime: ms of the data on screen (null = nothing saved).
   onRetry: shows a Retry button. updating: a load is already running. */
function showDataStatus(savedTime, onRetry, { updating = false } = {}) {
    const el = getDataStatusElement();
    if (!el) return;
    el.textContent = "";

    const text = document.createElement("span");
    if (savedTime === null) {
        text.textContent = "Couldn't load the weather right now.";
    } else {
        text.textContent = `Showing saved data from ${formatSavedTime(savedTime)}` +
            (updating ? " · updating…" : "");
    }
    el.appendChild(text);

    if (onRetry && !updating) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "data-status-retry";
        btn.textContent = "Retry";
        btn.addEventListener("click", () => {
            btn.disabled = true;
            btn.textContent = "Retrying…";
            onRetry();
        });
        el.appendChild(btn);
    }
    el.hidden = false;
}

function clearDataStatus() {
    const el = getElement("data-status");
    if (el) {
        el.hidden = true;
        el.textContent = "";
    }
}


/* =========================================================
   LOCAL CACHE — instant load on next visit
========================================================= */
const WEATHER_CACHE_KEY = "neckrone8x_weather_cache";
const FORECAST_CACHE_KEY = "neckrone8x_forecast_cache";

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

/* The last saved copy, however old: { data, time } or null.
   (Shown with a "saved data from <time>" note, so age is no reason to hide it.) */
function loadCacheEntry(key) {
    try {
        const entry = JSON.parse(localStorage.getItem(key) || "null");
        return entry && entry.data ? entry : null;
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

    if (window._currentWeatherData && window.EarthGlobe) {
        window.EarthGlobe.renderPanel(window._currentWeatherData);
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
            let ok;
            if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
                ok = await refreshByCoordinates(loc.lat, loc.lon, loc.name, loc.country, loc.state);
            } else if (input && input.value.trim()) {
                ok = await refreshByCity(input.value.trim());
            } else {
                ok = await refreshByCity("Kisumu");
            }

            clearCityCardCache();
            renderCitiesGlance();

            showToast(ok ? "✅ Weather updated" : "⚠️ Couldn't update — showing saved data");
        } catch (err) {
            console.error("Refresh failed:", err);
            showToast("❌ Refresh failed");
        } finally {
            btn.classList.remove("spinning");
            btn.disabled = false;
        }
    });
}

/* Both resolve true only when fresh weather actually arrived. */
function refreshByCoordinates(lat, lon, name = "", country = "", state = "") {
    return getWeatherByCoordinates(lat, lon, name, country, state, { keepCurrent: true });
}

function refreshByCity(city) {
    return getWeather(city, { keepCurrent: true });
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

    const temp = Number.isFinite(Number(main.feels_like))
        ? Number(main.feels_like)
        : Number(main.temp);
    const weatherId = Number(weather.id);

    if (!Number.isFinite(temp)) {
        return { icon: "👕", text: "No advice available" };
    }

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

    if (isThunder) {
        return { icon: "⛈️", text: "Stay indoors if possible — thunderstorms nearby" };
    }

    if (isSnowing) {
        return { icon: "🧥", text: "Heavy winter coat, gloves, and waterproof boots" };
    }

    if (isHeavyRain || (isAnyRain && !isLightRain)) {
        if (temp >= 25) {
            return { icon: "☔", text: "Rainy — light waterproof clothes and an umbrella" };
        } else if (temp >= 18) {
            return { icon: "🧥", text: "Rainy — waterproof jacket and umbrella" };
        } else {
            return { icon: "🧥", text: "Cold and rainy — raincoat and boots" };
        }
    }

    if (isLightRain) {
        if (temp >= 25) {
            return { icon: "☔", text: "Light rain — t-shirt with an umbrella" };
        } else if (temp >= 15) {
            return { icon: "☔", text: "Light rain — jacket and umbrella" };
        } else {
            return { icon: "🧥", text: "Cold and damp — warm coat with umbrella" };
        }
    }

    if (rainSoon) {
        if (temp >= 25) {
            return { icon: "☔", text: "Light clothes + bring an umbrella — rain coming soon" };
        } else if (temp >= 15) {
            return { icon: "☔", text: "Light jacket + umbrella — rain in the next few hours" };
        } else {
            return { icon: "🧥", text: "Warm coat + umbrella — cold rain on the way" };
        }
    }

    if (temp >= 30) {
        return { icon: "🩳", text: "Shorts, t-shirt, and sun protection — very hot day" };
    }
    if (temp >= 25) {
        return { icon: "👕", text: "Light t-shirt and shorts or jeans — warm day" };
    }
    if (temp >= 20) {
        return { icon: "👕", text: "T-shirt and jeans — comfortable day" };
    }
    if (temp >= 15) {
        return { icon: "🧥", text: "Light jacket or long sleeves recommended" };
    }
    if (temp >= 10) {
        return { icon: "🧥", text: "Sweater or hoodie recommended" };
    }
    if (temp >= 5) {
        return { icon: "🧥", text: "Warm coat and long pants" };
    }
    return { icon: "🧣", text: "Heavy coat, scarf, and warm layers" };
}

function renderWhatToWear(data) {
    const card = getElement("what-to-wear");
    const iconEl = getElement("wtw-icon");
    const textEl = getElement("wtw-text");
    if (!card || !iconEl || !textEl) return;

    const advice = getWhatToWear(data);
    iconEl.textContent = advice.icon;
    textEl.textContent = advice.text;
    iconEl.classList.remove("wtw-svg");
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
/* Free for every user: no login, plan or premium check anywhere here.

   Checked for every place shown (live, saved, failed loads, searched,
   located, saved cities) as soon as its coordinates are known.
   - the banner is only replaced when an answer arrives; a failed check
     keeps whatever is shown
   - a counter stops an older answer from overwriting a newer one
   - the X remembers a dismissed quake by its USGS id; a new quake still shows */
const DISMISSED_QUAKES_KEY = "neckrone8x_dismissed_quakes";
const ALERT_RECHECK_MS = 60 * 1000;     // same place again within a minute: skip
let alertCheckSeq = 0;
let lastAlertCheck = { key: "", time: 0 };
let shownSafetyAlert = null;            // { kind: "alert" | "quake", id }

function loadDismissedQuakes() {
    try {
        const list = JSON.parse(localStorage.getItem(DISMISSED_QUAKES_KEY) || "[]");
        return Array.isArray(list) ? list : [];
    } catch { return []; }
}

function dismissQuake(id) {
    if (!id) return;
    try {
        const list = loadDismissedQuakes().filter(x => x !== id);
        list.push(id);
        localStorage.setItem(DISMISSED_QUAKES_KEY, JSON.stringify(list.slice(-50)));
    } catch (e) { /* storage blocked: it just won't be remembered */ }
}

function formatAgo(ms) {
    const mins = Math.round((Date.now() - Number(ms)) / 60000);
    if (!Number.isFinite(mins) || mins < 0) return "";
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return `${hrs} h ago`;
    const days = Math.round(hrs / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
}

/* "M4.8 earthquake" + "46 km SE of Ikungi, Tanzania · 120 km from you · 10 km deep · 2 days ago" */
function quakeBannerText(q) {
    const mag = Number(q.magnitude);
    const parts = [q.place || "Nearby"];
    if (Number.isFinite(Number(q.distance_km)) && q.distance_km !== null) {
        parts.push(`${Math.round(Number(q.distance_km))} km from you`);
    }
    if (q.depth !== null && q.depth !== undefined && Number.isFinite(Number(q.depth))) {
        parts.push(`${Math.round(Number(q.depth))} km deep`);
    }
    const ago = formatAgo(q.time);
    if (ago) parts.push(ago);
    return {
        title: `M${Number.isFinite(mag) ? mag.toFixed(1) : "?"} earthquake`,
        text: parts.join(" · ")
    };
}

function renderSafetyBanner(data) {
    const banner = getElement("safety-alert");
    const titleEl = getElement("safety-alert-title");
    const textEl = getElement("safety-alert-text");
    const iconEl = getElement("safety-alert-icon");
    const closeBtn = getElement("safety-alert-close");
    if (!banner || !titleEl || !textEl) return;

    const alerts = Array.isArray(data && data.alerts) ? data.alerts : [];
    const quakes = Array.isArray(data && data.quakes) ? data.quakes : [];
    banner.className = "safety-alert";

    if (alerts.length > 0) {
        const top = alerts[0];
        const sev = (top.severity || "").toLowerCase();
        if (iconEl) iconEl.textContent = "⚠️";
        titleEl.textContent = top.event || "Weather Alert";
        textEl.textContent = top.headline || top.description || "";
        banner.classList.add(sev === "extreme" || sev === "severe" ? "severity-moderate" : "severity-minor");
        banner.style.display = "flex";
        shownSafetyAlert = { kind: "alert", id: top.event || "" };
        if (typeof mpTrack === "function") {
            mpTrack("safety_alert_shown", { event: top.event, severity: top.severity });
        }
    } else {
        // The server sends quakes best-first; skip any the user dismissed.
        const dismissed = loadDismissedQuakes();
        const q = quakes.find(item => !(item.id && dismissed.includes(item.id)));
        if (q) {
            const { title, text } = quakeBannerText(q);
            if (iconEl) iconEl.textContent = "🌋";
            titleEl.textContent = title;
            textEl.textContent = text;
            banner.classList.add("severity-moderate");
            banner.style.display = "flex";
            shownSafetyAlert = { kind: "quake", id: q.id || "" };
            if (typeof mpTrack === "function") {
                mpTrack("earthquake_alert_shown", {
                    magnitude: q.magnitude, place: q.place, distance_km: q.distance_km
                });
            }
        } else {
            banner.style.display = "none";
            shownSafetyAlert = null;
        }
    }

    if (closeBtn) {
        closeBtn.onclick = () => {
            banner.style.display = "none";
            if (shownSafetyAlert && shownSafetyAlert.kind === "quake") {
                dismissQuake(shownSafetyAlert.id);
            }
        };
    }
}

async function checkLocationAlerts(lat, lon) {
    lat = Number(lat);
    lon = Number(lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const now = Date.now();
    if (lastAlertCheck.key === key && now - lastAlertCheck.time < ALERT_RECHECK_MS) return;
    lastAlertCheck = { key, time: now };
    const seq = ++alertCheckSeq;

    try {
        const res = await fetchWithTimeout(`/local-alerts?lat=${lat}&lon=${lon}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (seq !== alertCheckSeq) return;          // a newer check took over

        // Shared with the Mkuu helper (mkuu-weather-context.js). Only ever
        // replaced by a newer answer, never cleared.
        window._lastLocalAlerts = data;
        window.dispatchEvent(new Event("mkuu:context-changed"));
        renderSafetyBanner(data);
    } catch (err) {
        // Keep whatever is shown; let the next display of this place try again.
        if (seq === alertCheckSeq) lastAlertCheck = { key: "", time: 0 };
        console.warn("Alert check failed:", err);
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
    const isStars = type === "stars";
    const isFog = type === "fog";

    const _wData = window._currentWeatherData;
    const _wId = Number(_wData?.weather?.[0]?.id || 0);
    const isThunder = type === "rain-heavy" && _wId >= 200 && _wId <= 232;

    const count = type === "rain-heavy" ? 160 :
                  type === "rain"       ? 70  :
                  type === "snow"       ? 45  :
                  (isStars || isFog)    ? 0   :
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

        const t = performance.now();

        // ⭐ Stars (clear nights)
        if (isStars) {
            drawStarField(weatherCtx, weatherCanvas.width, weatherCanvas.height, t);
        }

        // 🌫️ Fog layers
        if (isFog) {
            drawFogLayer(weatherCtx, weatherCanvas.width, weatherCanvas.height, t);
        }

        // ⚡ Lightning (thunderstorms only)
        if (isThunder) {
            drawLightning(weatherCtx, weatherCanvas.width, weatherCanvas.height, t);
        }

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

/* =========================================================
   LIGHTNING — forked bolts during thunderstorms
========================================================= */
const _lightning = {
    active: false,
    path: null,
    startTime: 0,
    nextStrike: 0
};

function drawLightning(ctx, w, h, t) {
    if (!_lightning.nextStrike) {
        _lightning.nextStrike = t + 2000 + Math.random() * 3000;
    }

    if (!_lightning.active && t >= _lightning.nextStrike) {
        _lightning.active = true;
        _lightning.startTime = t;
        _lightning.path = generateBoltPath(w, h);
        _lightning.nextStrike = t + 5000 + Math.random() * 7000;
    }

    if (!_lightning.active) return;

    const age = t - _lightning.startTime;
    const DURATION = 320;

    if (age > DURATION) {
        _lightning.active = false;
        _lightning.path = null;
        return;
    }

    // Fullscreen white flash for the first ~90ms
    if (age < 90) {
        const flash = 1 - age / 90;
        ctx.fillStyle = `rgba(255, 255, 255, ${flash * 0.30})`;
        ctx.fillRect(0, 0, w, h);
    }

    const alpha = Math.max(0, 1 - age / DURATION);
    drawBolt(ctx, _lightning.path, alpha);
}

function generateBoltPath(w, h) {
    const main = [];
    let x = w * (0.25 + Math.random() * 0.5);
    let y = -10;
    main.push({ x, y });

    const segments = 10 + Math.floor(Math.random() * 6);
    const stepY = (h * 0.80) / segments;

    for (let i = 0; i < segments; i++) {
        x += (Math.random() - 0.5) * (w * 0.10);
        y += stepY + (Math.random() * stepY * 0.35);
        main.push({ x, y });
    }

    // 1-2 branches
    const branches = [];
    const branchCount = 1 + Math.floor(Math.random() * 2);
    for (let b = 0; b < branchCount; b++) {
        const startIdx = 3 + Math.floor(Math.random() * Math.max(1, segments - 5));
        const startPt = main[startIdx] || main[0];
        const branchPts = [{ x: startPt.x, y: startPt.y }];
        let bx = startPt.x;
        let by = startPt.y;
        const bSegs = 3 + Math.floor(Math.random() * 3);
        for (let i = 0; i < bSegs; i++) {
            bx += (Math.random() - 0.25) * (w * 0.09);
            by += stepY * 0.7;
            branchPts.push({ x: bx, y: by });
        }
        branches.push(branchPts);
    }

    return { main, branches };
}

function drawBolt(ctx, path, alpha) {
    if (!path) return;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Outer glow
    ctx.strokeStyle = `rgba(150, 195, 255, ${alpha * 0.55})`;
    ctx.lineWidth = 8;
    strokePath(ctx, path.main);
    path.branches.forEach(b => strokePath(ctx, b));

    // Middle glow
    ctx.strokeStyle = `rgba(210, 230, 255, ${alpha * 0.85})`;
    ctx.lineWidth = 4;
    strokePath(ctx, path.main);
    path.branches.forEach(b => strokePath(ctx, b));

    // Bright core
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.lineWidth = 2;
    strokePath(ctx, path.main);
    path.branches.forEach(b => strokePath(ctx, b));
}

function strokePath(ctx, points) {
    if (!points || points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
}


/* =========================================================
   FOG LAYER — soft drifting bands for foggy weather
========================================================= */
let _fogBlobs = null;
let _fogBlobSize = { w: 0, h: 0 };

function drawFogLayer(ctx, w, h, t) {
    if (!_fogBlobs || _fogBlobSize.w !== w || _fogBlobSize.h !== h) {
        _fogBlobs = [];
        _fogBlobSize = { w, h };

        const count = 14;
        for (let i = 0; i < count; i++) {
            _fogBlobs.push({
                x: Math.random() * w,
                y: h * (0.10 + Math.random() * 0.80),
                rx: w * (0.22 + Math.random() * 0.30),
                ry: h * (0.08 + Math.random() * 0.14),
                drift: (Math.random() - 0.5) * 0.00015,
                offset: Math.random() * Math.PI * 2,
                alpha: 0.10 + Math.random() * 0.10
            });
        }
    }

    _fogBlobs.forEach(b => {
        const wobbleX = Math.sin(t * 0.0003 + b.offset) * 30;
        const wobbleY = Math.sin(t * 0.0005 + b.offset) * 8;

        const cx = ((b.x + t * b.drift + wobbleX) % (w * 1.4) + w * 1.4) % (w * 1.4) - w * 0.2;
        const cy = b.y + wobbleY;

        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, b.rx);
        grad.addColorStop(0,    `rgba(235, 240, 250, ${b.alpha})`);
        grad.addColorStop(0.55, `rgba(220, 228, 242, ${b.alpha * 0.5})`);
        grad.addColorStop(1,    "rgba(210, 220, 240, 0)");

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(cx, cy, b.rx, b.ry, 0, 0, Math.PI * 2);
        ctx.fill();
    });
}

/* =========================================================
   STAR FIELD — twinkling stars for clear nights
========================================================= */
let _starField = null;
let _starFieldSize = { w: 0, h: 0 };

function drawStarField(ctx, w, h, t) {
    // Rebuild the star list if canvas size changed (or first run)
    if (!_starField || _starFieldSize.w !== w || _starFieldSize.h !== h) {
        _starField = [];
        _starFieldSize = { w, h };

        // Density scales with area, capped so mobile stays light
        const density = Math.floor((w * h) / 3000);
        const maxCount = Math.min(density, 120);

        for (let i = 0; i < maxCount; i++) {
            _starField.push({
                x: Math.random() * w,
                y: Math.random() * h * 0.85,   // keep clear of bottom edge
                r: 0.6 + Math.random() * 1.4,
                phase: Math.random() * Math.PI * 2,
                speed: 0.5 + Math.random() * 1.5
            });
        }
    }

    _starField.forEach(s => {
        const twinkle = 0.55 + 0.45 * Math.sin(t * 0.001 * s.speed + s.phase);

        // Star dot
        ctx.fillStyle = `rgba(255, 255, 255, ${twinkle})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();

        // Bigger stars get a soft 4-point glow
        if (s.r > 1.6) {
            ctx.strokeStyle = `rgba(255, 255, 255, ${twinkle * 0.35})`;
            ctx.lineWidth = 0.8;
            const arm = s.r * 3;
            ctx.beginPath();
            ctx.moveTo(s.x - arm, s.y);
            ctx.lineTo(s.x + arm, s.y);
            ctx.moveTo(s.x, s.y - arm);
            ctx.lineTo(s.x, s.y + arm);
            ctx.stroke();
        }
    });
}

/* =========================================================
   SKY LAYER — sun and moon
========================================================= */
function drawSkyLayer(ctx, w, h) {
    const data = window._currentWeatherData;
    if (!data || !data.sys) return;

    const sys = data.sys;
    if (!sys.sunrise || !sys.sunset) return;

    const weather = data.weather?.[0] || {};
    const weatherId = Number(weather.id);
    const iconCode = String(weather.icon || "");
    const clouds = Number(data.clouds?.all ?? 0);

    const now = Math.floor(Date.now() / 1000);
    const tz = Number(data.timezone || 0);
    const localNow = now + tz;
    const localSunrise = Number(sys.sunrise) + tz;
    const localSunset = Number(sys.sunset) + tz;

    const isNight = localNow < localSunrise || localNow >= localSunset;

    // Decide if the sky body is visible given the current weather
    const showSun  = !isNight && (weatherId === 800 || weatherId === 801);
    const showMoon =  isNight && clouds < 40;

    if (!showSun && !showMoon) return;

    // Progress through the sun's (or moon's) arc: 0 = rise, 1 = set
    let progress;
    if (!isNight) {
        progress = (localNow - localSunrise) / Math.max(1, localSunset - localSunrise);
    } else {
        let nightStart = localSunset;
        let nightEnd = localSunrise + 86400;
        let nightNow = localNow < localSunrise ? localNow + 86400 : localNow;
        progress = (nightNow - nightStart) / Math.max(1, nightEnd - nightStart);
    }
    progress = Math.max(0, Math.min(1, progress));

    // Arc across the upper part of the card
    const cx = w * (0.15 + progress * 0.70);
    const cy = h * 0.60 - Math.sin(progress * Math.PI) * h * 0.38;

    const radius = Math.min(w, h) * 0.085;

    if (showSun) {
        drawSun(ctx, cx, cy, radius);
    } else {
        drawMoon(ctx, cx, cy, radius);
    }
}

function drawSun(ctx, cx, cy, r) {
    // Soft outer glow
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 3.2);
    glow.addColorStop(0,    "rgba(255, 230, 140, 0.55)");
    glow.addColorStop(0.35, "rgba(255, 205, 90, 0.25)");
    glow.addColorStop(1,    "rgba(255, 180, 40, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 3.2, 0, Math.PI * 2);
    ctx.fill();

    // Sun body
    const body = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r);
    body.addColorStop(0,   "#fffbe0");
    body.addColorStop(0.5, "#ffdf70");
    body.addColorStop(1,   "#f5b400");
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // Slowly rotating rays
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Date.now() * 0.00015);
    ctx.strokeStyle = "rgba(255, 220, 120, 0.75)";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    const rays = 12;
    const innerR = r * 1.30;
    const outerR = r * 1.70;
    for (let i = 0; i < rays; i++) {
        const a = (i / rays) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * innerR, Math.sin(a) * innerR);
        ctx.lineTo(Math.cos(a) * outerR, Math.sin(a) * outerR);
        ctx.stroke();
    }
    ctx.restore();
}

function drawMoon(ctx, cx, cy, r) {
    // Soft glow
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.8);
    glow.addColorStop(0,   "rgba(220, 230, 255, 0.40)");
    glow.addColorStop(0.5, "rgba(180, 200, 255, 0.15)");
    glow.addColorStop(1,   "rgba(150, 170, 220, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 2.8, 0, Math.PI * 2);
    ctx.fill();

    // Moon disc
    const body = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r);
    body.addColorStop(0,   "#ffffff");
    body.addColorStop(0.7, "#e8ecf5");
    body.addColorStop(1,   "#c5cede");
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // Craters
    ctx.fillStyle = "rgba(170, 180, 200, 0.35)";
    const craters = [
        { x: -0.30, y: -0.20, r: 0.18 },
        { x:  0.20, y:  0.10, r: 0.22 },
        { x: -0.10, y:  0.35, r: 0.14 },
        { x:  0.35, y: -0.35, r: 0.12 },
        { x: -0.40, y:  0.15, r: 0.10 }
    ];
    craters.forEach(c => {
        ctx.beginPath();
        ctx.arc(cx + c.x * r, cy + c.y * r, c.r * r, 0, Math.PI * 2);
        ctx.fill();
    });

    // Phase shadow — dark circle sliding off to one side
    if (typeof getMoonPhase === "function") {
        const phase = getMoonPhase().phase; // 0 = new, 0.5 = full, 1 = new
        const shadowFrac = (1 + Math.cos(phase * 2 * Math.PI)) / 2;
        const offset = (1 - shadowFrac) * 2 * r;
        const waxing = phase < 0.5;
        const dir = waxing ? -1 : 1;

        if (offset < 2 * r - 1) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.clip();
            ctx.fillStyle = "rgba(8, 12, 25, 0.90)";
            ctx.beginPath();
            ctx.arc(cx + dir * offset, cy, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }
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
function applyWeatherBackground(weatherId, iconCode, clouds) {
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
        canvasType = "fog";
    } else if (weatherId === 800) {
        cls = "weather-sunny";
    } else if (weatherId >= 801 && weatherId <= 804) {
        cls = "weather-cloudy";
    }

    // Clear night → stars
    if (!canvasType) {
        const cloudPct = Number(clouds ?? 100);
        const isNight = String(iconCode).endsWith("n");
        const isClear = weatherId === 800 || weatherId === 801;
        if (isNight && isClear && cloudPct < 30) {
            canvasType = "stars";
        }
    }

    hero.classList.add(cls);

    if (canvasType) {
        setTimeout(() => startWeatherCanvas(canvasType), 50);
    }
}


/* =========================================================
   DISPLAY CURRENT WEATHER
========================================================= */
/* opts.saved: this is a saved copy, so don't fetch extras/alerts or track it. */
function displayWeather(data, opts = {}) {
    const live = !opts.saved;
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

    applyWeatherBackground(weatherId, iconCode, clouds);

    const cityElement = getElement("city");
    if (cityElement) cityElement.textContent = locationText;

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
        if (live) fetchExtraData(data.coord.lat, data.coord.lon);   // UV + air: live only
        checkLocationAlerts(data.coord.lat, data.coord.lon);        // alerts: every place shown
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
        if (window.EarthGlobe) {
            window.EarthGlobe.updateCurrentMarker(data.coord.lat, data.coord.lon);
            window.EarthGlobe.rotateGlobeTo(data.coord.lat, data.coord.lon);
        }

        // ⭐ Precipitation radar: recenter and update label
        setRadarLocation(data.coord.lat, data.coord.lon, locationText);
    }

    if (live && typeof mpTrack === "function") {
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

    if (window.EarthGlobe) window.EarthGlobe.renderPanel(data);
    // Saving happens in loadWeatherFull, once weather AND its forecast are in,
    // so the saved pair always belongs together.
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
/* Show the UV tile with `text`, or hide the whole tile when text is null
   (no UV available: better no tile than an error). */
function setUvTile(text) {
    const el = getElement("uv-index");
    if (!el) return;
    const tile = typeof el.closest === "function" ? el.closest(".extra-detail") : null;
    if (text === null) {
        el.textContent = "--";
        if (tile) tile.style.display = "none";
        return;
    }
    el.textContent = text;
    if (tile) tile.style.display = "";
}

function fetchExtraData(lat, lon) {
    fetchWithTimeout(`/uv?lat=${lat}&lon=${lon}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            if (data && Number.isFinite(Number(data.value)) && data.value !== null) {
                const val = Math.round(Number(data.value));
                let label = "";
                if (val <= 2) label = "Low";
                else if (val <= 5) label = "Moderate";
                else if (val <= 7) label = "High";
                else if (val <= 10) label = "Very High";
                else label = "Extreme";
                setUvTile(`${val} (${label})`);
            } else {
                setUvTile(null);
            }
        })
        .catch(() => setUvTile(null));

    fetchWithTimeout(`/air?lat=${lat}&lon=${lon}`)
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

        const nextSlot = data.list.find(item => Number(item.dt) >= now) || data.list[0];
        const nowRain = nextSlot && nextSlot.pop !== undefined
            ? `${Math.round(Number(nextSlot.pop) * 100)}%` : "--";

        const nowCard = document.createElement("div");
        nowCard.className = "hourly-card now-card";
        nowCard.innerHTML = `
            <div class="hourly-time">Now</div>
            <div class="hourly-icon">${icon}</div>
            <div class="hourly-temperature">${formatTemp(temp, 0)}${tempUnit()}</div>
            <div class="hourly-rain">💧 ${nowRain}</div>
            <div class="hourly-condition">${escapeHtml(condition)}</div>
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
            <div class="hourly-condition">${escapeHtml(condition)}</div>
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
        const stamp = item.dt_txt_local || item.dt_txt;
        if (!stamp) return;
        const dateString = stamp.split(" ")[0];
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

        const daily = (data.daily || []).find(d => d.date === dateString);
        const high = Number.isFinite(daily?.temp_max) ? daily.temp_max : Math.max(...temperatures);
        const low = Number.isFinite(daily?.temp_min) ? daily.temp_min : Math.min(...temperatures);

        const rainChance = Number.isFinite(daily?.pop)
            ? Math.round(daily.pop * 100)
            : Math.round(Math.max(...entries.map(item => (Number(item.pop) || 0) * 100)));

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
            <div class="forecast-condition">${escapeHtml(condition)}</div>
        `;
        container.appendChild(card);
    });

    if (container.children.length === 0) {
        container.innerHTML = "Forecast unavailable.";
    }

    // (Saved by loadWeatherFull, not here: re-rendering a saved copy or
    // toggling °C/°F must not stamp old data with a new time.)
    if (window._currentWeatherData) {
        renderWhatToWear(window._currentWeatherData);
    }
}


/* =========================================================
   RENDER MONTHLY CALENDAR
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

    const weatherMap = {};
    const dateGroups = {};
    data.list.forEach(item => {
        const stamp = item.dt_txt_local || item.dt_txt;
        if (!stamp) return;
        const dateString = stamp.split(" ")[0];
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

    (data.daily || []).forEach(d => {
        if (!d || !d.date || weatherMap[d.date]) return;
        weatherMap[d.date] = getWeatherIcon(Number(d.weather?.id), d.weather?.icon);
    });

    const now = Math.floor(Date.now() / 1000);
    const localNow = new Date((now + timezone) * 1000);
    const todayYear = localNow.getUTCFullYear();
    const todayMonth = localNow.getUTCMonth();
    const todayDate = localNow.getUTCDate();

    _calWeatherMap = weatherMap;
    _calTodayKey = `${todayYear}-${String(todayMonth + 1).padStart(2, "0")}-${String(todayDate).padStart(2, "0")}`;

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
/* =========================================================
   SHARED WEATHER LOADER
   One place that fetches /weather-full, with a timeout, and on any
   failure keeps (or brings back) the last saved weather + a Retry note.
   Resolves true when fresh weather was shown, false otherwise. Never rejects.
========================================================= */
let weatherLoadSeq = 0;
const WEATHER_UNAVAILABLE_MESSAGE =
    "Weather is temporarily unavailable. Please try again in a few minutes.";
const SEARCH_UNAVAILABLE_MESSAGE =
    "City search is temporarily unavailable. Please try again in a few minutes.";
// 429: the server's per-address limit (many phones can share one address).
const RATE_LIMITED_MESSAGE =
    "Too many requests from your network right now. Please wait a minute, then tap Retry.";
const RATE_LIMITED_SEARCH_MESSAGE =
    "Too many searches from your network right now. Please wait a minute, then try again.";

function isShowingPlace(lat, lon) {
    const loc = window._loadedLocation;
    return !!(window._currentWeatherData && loc &&
        Math.abs(Number(loc.lat) - Number(lat)) < 0.01 &&
        Math.abs(Number(loc.lon) - Number(lon)) < 0.01);
}

function showWeatherPair(weather, forecast, opts = {}) {
    displayWeather(weather, opts);
    renderHourlyForecast(forecast);
    renderForecast(forecast);
}

function setLoadingUi(message) {
    const cityElement = getElement("city");
    const conditionElement = getElement("condition");
    const temperatureElement = getElement("temperature");
    const forecastLocation = getElement("forecast-location");
    if (cityElement) cityElement.textContent = "Loading...";
    if (conditionElement) conditionElement.textContent = message;
    if (temperatureElement) temperatureElement.textContent = `--${tempUnit()}`;
    if (forecastLocation) forecastLocation.textContent = "Loading...";
    setLoadingState();
    window._currentWeatherData = null;
}

function showSavedWeatherFallback(retry, failMessage) {
    // Still showing weather (a refresh failed): keep it on screen.
    if (window._currentWeatherData) {
        showDataStatus(window._dataTime, retry);
        return;
    }
    // Screen was cleared for a new place: bring back the last saved weather.
    const w = loadCacheEntry(WEATHER_CACHE_KEY);
    const f = loadCacheEntry(FORECAST_CACHE_KEY);
    if (w) {
        displayWeather(w.data, { saved: true });
        if (f) {
            renderHourlyForecast(f.data);
            renderForecast(f.data);
        }
        window._dataTime = w.time;
        showDataStatus(w.time, retry);
        const errorMessage = getElement("error-message");
        if (errorMessage) errorMessage.textContent = failMessage;
        return;
    }
    // Nothing saved at all.
    const cityElement = getElement("city");
    const conditionElement = getElement("condition");
    const forecastLocation = getElement("forecast-location");
    const errorMessage = getElement("error-message");
    if (cityElement) cityElement.textContent = "Weather unavailable";
    if (conditionElement) conditionElement.textContent = failMessage;
    if (forecastLocation) forecastLocation.textContent = "";
    if (errorMessage) errorMessage.textContent = failMessage;
    ["hourly-forecast", "forecast"].forEach(id => {
        const el = getElement(id);
        if (el) el.textContent = "Forecast unavailable.";
    });
    showDataStatus(null, retry);
}

/* url: the /weather-full URL.  retry: re-runs this same load.
   adjust(weather, forecast): optional, may return a promise.
   keepCurrent: leave the weather on screen while loading. */
function loadWeatherFull(url, { retry, adjust, keepCurrent = false, coords = null,
                                loadingMessage = "Loading weather...",
                                failMessage = "Unable to load weather." } = {}) {
    const seq = ++weatherLoadSeq;
    const errorMessage = getElement("error-message");
    if (errorMessage) errorMessage.textContent = "";

    // Coordinates already known (searched, located, saved place): check for
    // alerts now, so a quake shows even if the weather itself fails.
    if (coords) checkLocationAlerts(coords.lat, coords.lon);

    if (!(keepCurrent && window._currentWeatherData)) {
        setLoadingUi(loadingMessage);
    }

    return fetchWithTimeout(url)
        .then(async response => {
            if (!response.ok) {
                const err = new Error(`Weather request failed: ${response.status}`);
                err.status = response.status;
                throw err;
            }
            const savedAt = savedCopyTime(response);
            const payload = await response.json();
            if (!payload || !payload.weather || !payload.forecast) {
                throw new Error("Invalid combined response");
            }
            if (adjust) await adjust(payload.weather, payload.forecast);
            if (seq !== weatherLoadSeq) return false;      // a newer load took over

            if (savedAt !== null) {
                // The service worker answered from its saved copy (server hung/offline).
                showWeatherPair(payload.weather, payload.forecast, { saved: true });
                window._dataTime = savedAt;
                showDataStatus(savedAt, retry);
                return false;
            }

            showWeatherPair(payload.weather, payload.forecast);
            saveWeatherToCache(payload.weather, payload.forecast);
            window._dataTime = Date.now();
            clearDataStatus();
            return true;
        })
        .catch(error => {
            if (seq !== weatherLoadSeq) return false;
            console.error("Weather error:", error);
            // 503 = the weather service is down on our side (e.g. its key is
            // being replaced); 429 = too many requests from this address.
            // Say so plainly instead of a generic failure.
            const status = error && error.status;
            const message = status === 429 ? RATE_LIMITED_MESSAGE
                : status === 503 ? WEATHER_UNAVAILABLE_MESSAGE : failMessage;
            showSavedWeatherFallback(retry, message);
            // With weather still on screen the bar only says "saved data";
            // a 429 also says why, so the user knows to wait before Retry.
            if (status === 429 && errorMessage) errorMessage.textContent = RATE_LIMITED_MESSAGE;
            return false;
        });
}


function getWeather(city, opts = {}) {
    city = String(city || "").trim();
    if (!city) return Promise.resolve(false);

    return loadWeatherFull(`/weather-full?city=${encodeURIComponent(city)}`, {
        keepCurrent: !!opts.keepCurrent,
        retry: () => getWeather(city, { keepCurrent: true })
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
function getWeatherByCoordinates(latitude, longitude, searchedName = "", searchedCountry = "", searchedState = "", opts = {}) {
    // Same place already on screen (refresh, auto-refresh, startup): keep it while loading.
    const keepCurrent = opts.keepCurrent !== undefined
        ? !!opts.keepCurrent
        : isShowingPlace(latitude, longitude);

    return loadWeatherFull(`/weather-full?lat=${latitude}&lon=${longitude}`, {
        keepCurrent,
        coords: { lat: latitude, lon: longitude },
        retry: () => getWeatherByCoordinates(latitude, longitude, searchedName,
                                             searchedCountry, searchedState, { keepCurrent: true }),
        adjust: (w, f) => {
            const place = {
                name: searchedName || w.name,
                country: searchedCountry || w.sys?.country || "",
                state: searchedState || ""
            };
            w.searched_location = { ...place };
            f.searched_location = { ...place };
        }
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

    fetchWithTimeout(`/locations?city=${encodeURIComponent(city)}`)
        .then(response => response.json()
            .catch(() => ({}))                      // e.g. an HTML error page
            .then(data => ({ status: response.status, data: data || {} })))
        .then(({ status, data }) => {
            resultsContainer.innerHTML = "";

            if (status === 429 || data.error === "rate_limited") {
                showSearchProblem(city, RATE_LIMITED_SEARCH_MESSAGE);
                return;
            }
            if (status === 503 || data.error === "weather_unavailable") {
                showSearchProblem(city, SEARCH_UNAVAILABLE_MESSAGE);
                return;
            }
            if (status === 404 || data.cod === 404 || data.cod === "404") {
                if (errorMessage) errorMessage.textContent = "City not found. Please try again.";
                resultsContainer.style.display = "none";
                if (searchHint) searchHint.style.display = "none";
                setControlsVisibility(true);
                return;
            }
            if (status !== 200 && data.cod !== 200 && data.cod !== "200") {
                showSearchProblem(city, "Unable to search locations right now.");
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
                    <strong>📍 ${escapeHtml(location.name || "Unknown location")}</strong>
                    ${location.state ? `<small>📌 ${escapeHtml(location.state)}</small>` : ""}
                    <small>🌍 ${escapeHtml(countryName)}</small>
                `;
                button.addEventListener("click", () => selectLocation(location));
                resultsContainer.appendChild(button);
            });
        })
        .catch(error => {
            console.error("Location search error:", error);
            showSearchProblem(city, "Unable to search locations right now.");
        });
}

/* Search failed (503, timeout, error): a clear message + Retry where the
   results would be. The weather on screen is left as it is. */
function showSearchProblem(city, message) {
    const resultsContainer = getElement("location-results");
    const errorMessage = getElement("error-message");
    const searchHint = getElement("search-hint");
    if (searchHint) searchHint.style.display = "none";
    if (errorMessage) errorMessage.textContent = "";
    setControlsVisibility(true);
    if (!resultsContainer) return;

    resultsContainer.innerHTML = "";
    const box = document.createElement("div");
    box.className = "location-heading search-problem";
    box.setAttribute("role", "alert");
    const text = document.createElement("div");
    text.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "data-status-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => searchLocations(city));
    box.appendChild(text);
    box.appendChild(retry);
    resultsContainer.appendChild(box);
    resultsContainer.style.display = "block";
}


/* =========================================================
   USE MY LOCATION
========================================================= */
const GEO_MAX_WAIT_MS = 30000;            // keep watching for a fix up to 30 s
const GEO_GOOD_ENOUGH_M = 100;            // stop as soon as a fix is this accurate
const GEO_MAX_AGE_MS = 10 * 60 * 1000;    // a fix the phone already has, up to 10 min old
const GEO_CACHED_AFTER_MS = 2000;         // a fix older than this came from the phone's cache
const LOCATION_FAILED_MESSAGE = "Couldn't find your location. Try searching for your city.";

/* One high-accuracy watchPosition, up to GEO_MAX_WAIT_MS.
   - a fix the phone already had (up to 10 min old) is accepted straight away
   - otherwise stop as soon as a fix is within ~100 m
   - when time runs out, use the best (most accurate) fix seen, however rough
   onProgress(best) is called while it keeps looking for a better fix.
   Resolves { position, error }; position is null only if there was no fix at all. */
function locateWithWatch(onProgress) {
    return new Promise(resolve => {
        const geo = navigator.geolocation;
        let best = null;
        let lastError = null;
        let watchId = null;
        let done = false;

        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (watchId !== null) {
                try { geo.clearWatch(watchId); } catch (e) { /* ignore */ }
            }
            resolve({ position: best, error: lastError });
        };
        const timer = setTimeout(finish, GEO_MAX_WAIT_MS);

        try {
            watchId = geo.watchPosition(pos => {
                const accuracy = Number(pos.coords.accuracy);
                if (!best || accuracy < Number(best.coords.accuracy)) best = pos;
                const age = Date.now() - Number(pos.timestamp || Date.now());
                if (age > GEO_CACHED_AFTER_MS && age <= GEO_MAX_AGE_MS) return finish();
                if (accuracy <= GEO_GOOD_ENOUGH_M) return finish();
                if (onProgress) onProgress(best);
            }, err => {
                lastError = err;
                // Denied won't change by waiting; other errors may (GPS warming up).
                if (err && err.code === err.PERMISSION_DENIED) finish();
            }, {
                enableHighAccuracy: true,
                maximumAge: GEO_MAX_AGE_MS,
                timeout: GEO_MAX_WAIT_MS
            });
        } catch (e) {
            lastError = e;
            finish();
        }
    });
}

/* "Approximate location · Search for your city" under the search box. */
function showApproximateLocationNote() {
    const errorMessage = getElement("error-message");
    if (!errorMessage) return;
    errorMessage.textContent = "📍 Approximate location (from your internet connection). ";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "data-status-retry";
    btn.textContent = "Search for your city";
    btn.addEventListener("click", () => {
        const input = getElement("city-input");
        if (input) {
            input.focus();
            if (typeof input.select === "function") input.select();
        }
    });
    errorMessage.appendChild(btn);
}

/* No GPS/network fix at all: fall back to the IP location. */
async function useIpLocationFallback() {
    try {
        const res = await fetchWithTimeout("/my-location");
        const data = res.ok ? await res.json() : null;
        if (data && Number.isFinite(data.lat) && Number.isFinite(data.lon)) {
            const ok = await getWeatherByCoordinates(
                data.lat, data.lon, "Approximate location", data.country || "", data.name || "");
            if (ok) showApproximateLocationNote();
            return true;
        }
    } catch (err) {
        console.warn("IP location failed:", err);
    }
    return false;
}

function useMyLocation() {
    const errorMessage = getElement("error-message");
    const searchInput = getElement("city-input");
    const searchHint = getElement("search-hint");
    const resultsContainer = getElement("location-results");
    const locationBtn = getElement("location-button");

    if (locationBtn) {
        locationBtn.disabled = true;
        locationBtn.textContent = "📍 Locating...";
    }
    if (errorMessage) errorMessage.textContent = "📍 Finding your location...";

    if (searchInput) searchInput.value = "";
    if (searchHint) searchHint.style.display = "none";
    if (resultsContainer) {
        resultsContainer.innerHTML = "";
        resultsContainer.style.display = "none";
    }
    setControlsVisibility(true);
    // The weather on screen stays while we look; it is replaced only once
    // there is a place to show.

    if (typeof mpTrack === "function") {
        mpTrack("use_my_location");
    }

    const resetButton = () => {
        if (locationBtn) {
            locationBtn.disabled = false;
            locationBtn.textContent = "📍 Use My Location";
        }
    };

    (async () => {
        let position = null;
        let lastError = null;

        if (navigator.geolocation) {
            ({ position, error: lastError } = await locateWithWatch(best => {
                if (errorMessage) {
                    errorMessage.textContent =
                        `📡 Improving accuracy (±${Math.round(best.coords.accuracy)} m)...`;
                }
            }));
        }
        resetButton();

        if (position) {
            const { latitude, longitude, accuracy } = position.coords;
            getWeatherByLocation(latitude, longitude, `Your Location (±${Math.round(accuracy)}m)`);
            return;
        }

        if (typeof mpTrack === "function") {
            mpTrack("geolocation_failed", {
                code: lastError && lastError.code,
                message: lastError && lastError.message
            });
        }

        // No fix at all: an approximate place beats nothing.
        if (errorMessage) errorMessage.textContent = "📍 Finding an approximate location...";
        if (await useIpLocationFallback()) return;

        if (errorMessage) errorMessage.textContent = LOCATION_FAILED_MESSAGE;
    })();
}


/* =========================================================
   WEATHER BY GPS
========================================================= */
function getWeatherByLocation(latitude, longitude, displayName = "Your Location", opts = {}) {
    // Place name runs in parallel; it is optional, so a failure just means no name.
    const reversePromise = fetchWithTimeout(`/reverse?lat=${latitude}&lon=${longitude}`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);

    const keepCurrent = opts.keepCurrent !== undefined
        ? !!opts.keepCurrent
        : isShowingPlace(latitude, longitude);

    return loadWeatherFull(`/weather-full?lat=${latitude}&lon=${longitude}`, {
        keepCurrent,
        coords: { lat: latitude, lon: longitude },
        loadingMessage: "Loading your local weather...",
        failMessage: "Unable to load your local weather.",
        retry: () => getWeatherByLocation(latitude, longitude, displayName, { keepCurrent: true }),
        adjust: async (w, f) => {
            const reverseData = await reversePromise;
            const place = {
                name: (reverseData && reverseData.name) || displayName || w.name,
                country: (reverseData && reverseData.country) || w.sys?.country || "",
                state: (reverseData && reverseData.state) || ""
            };
            w.searched_location = { ...place };
            f.searched_location = { ...place };
        }
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

        if (window.EarthGlobe) {
        window.EarthGlobe.updateSavedMarkers(savedLocations);
        window.EarthGlobe.updateSaveButton();
    }
    updateSwipeHint();
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
        const res = await fetchWithTimeout("/global-alerts");
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
            // GDACS data: the level becomes a class name (letters only), the
            // link must be http(s), and every text is escaped.
            const level = String(a.alertlevel || "").toLowerCase().replace(/[^a-z]/g, "");
            card.className = `catastrophe-card ${level}`;
            const link = safeHttpUrl(a.url);
            if (link) card.href = link;
            card.target = "_blank";
            card.rel = "noopener noreferrer";

            const icon = getDisasterIcon(a.type);
            const typeLabel = getDisasterName(a.type);
            const name = escapeHtml(a.name);

            card.innerHTML = `
                <div class="catastrophe-icon">${icon}</div>
                <div class="catastrophe-info">
                    <div class="catastrophe-type">${typeLabel}</div>
                    <div class="catastrophe-name" title="${name}">${name}</div>
                    <div class="catastrophe-meta">
                        <span class="catastrophe-badge ${level}">
                            ${escapeHtml(a.alertlevel || "Green")}
                        </span>
                        <span>${escapeHtml(a.country || "")}</span>
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
            <div class="city-card-name">📍 ${escapeHtml(loc.name || "Unknown")}</div>
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

        fetchWithTimeout(`/weather?lat=${loc.lat}&lon=${loc.lon}`)
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
                    <div class="city-card-name">📍 ${escapeHtml(loc.name || "Unknown")}</div>
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

    const rawName = String(loc.name || data.name || "Unknown");
    const shortName = rawName.length > 18 ? rawName.slice(0, 16) + "…" : rawName;

    card.innerHTML = `
        <div class="city-card-name" title="${escapeHtml(rawName)}">📍 ${escapeHtml(shortName)}</div>
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

        fetchWithTimeout("/feedback", {
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
    if (typeof mixpanel.track !== "function") return;
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
   HELPERS BRIDGE — exposed for earth.js
========================================================= */
window.WeatherHelpers = {
    getElement,
    formatLocation,
    formatTemp,
    tempUnit,
    speedUnit,
    convertTemp,
    convertSpeed,
    getConditionText,
    getWeatherIcon,
    formatTimeFromUnix,
    isLocationSaved,
    showToast,
    getWeatherByLocation,
    shareCurrentWeather,
    mpTrack,
    getSavedLocations: () => savedLocations
};


/* =========================================================
   DEFAULT WEATHER
========================================================= */
async function loadDefaultWeather() {
    const input = getElement("city-input");

    // Show the last saved weather at once (however old, with a note), then
    // update it in place: the loads below keep it on screen if they fail.
    const savedEntry = loadCacheEntry(WEATHER_CACHE_KEY);
    const cachedWeather = savedEntry ? savedEntry.data : null;
    const forecastEntry = loadCacheEntry(FORECAST_CACHE_KEY);
    const cachedForecast = forecastEntry ? forecastEntry.data : null;

    if (cachedWeather) {
        displayWeather(cachedWeather, { saved: true });
        if (cachedForecast) {
            renderHourlyForecast(cachedForecast);
            renderForecast(cachedForecast);
        }
        window._dataTime = savedEntry.time;
        showDataStatus(savedEntry.time, null, { updating: true });

        const lastCoordsRaw = localStorage.getItem("weatherLastCoords");
        if (lastCoordsRaw) {
            try {
                const lc = JSON.parse(lastCoordsRaw);
                if (lc && Number.isFinite(lc.lat) && Number.isFinite(lc.lon)) {
                    if (input) input.value = lc.name || "";
                    getWeatherByCoordinates(lc.lat, lc.lon, lc.name, lc.country, lc.state,
                                            { keepCurrent: true });
                    return;
                }
            } catch (e) { /* fall through */ }
        }

        const lastCity = localStorage.getItem("weatherLastCity");
        if (lastCity) {
            if (input) input.value = lastCity;
            getWeather(lastCity, { keepCurrent: true });
        } else if (cachedWeather.coord) {
            getWeatherByCoordinates(
                cachedWeather.coord.lat,
                cachedWeather.coord.lon,
                cachedWeather.name || "",
                cachedWeather.sys?.country || "",
                "",
                { keepCurrent: true }
            );
        } else {
            showDataStatus(savedEntry.time, () => getWeather("Kisumu"));
        }
        return;
    }

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

    if (input) input.value = "Finding your location...";

    try {
        const res = await fetchWithTimeout("/my-location");
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
    setupVoiceSearch();
    setupSavedCitySwipe();
    updateSwipeHint();
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

    // ⭐ Earth globe is initialised by earth.js
    if (window.EarthGlobe) window.EarthGlobe.init();

    // ⭐ Precipitation radar
    initRadarMap();
    setupRadarControls();
    loadRadarFrames();

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


/* =========================================================
   PRECIPITATION RADAR MAP
========================================================= */
let radarMap = null;
let radarLayer = null;
let radarFrames = [];
let radarCurrentFrame = 0;
let radarPlayTimer = null;
let radarInitialized = false;

function initRadarMap() {
    if (radarInitialized) return;

    const mapEl = document.getElementById("radar-map");
    if (!mapEl) {
        console.warn("Radar: #radar-map not found in HTML");
        return;
    }
    if (typeof L === "undefined") {
        console.warn("Radar: Leaflet (L) not loaded");
        return;
    }

    radarMap = L.map("radar-map", {
        center: [0, 0],
        zoom: 6,
        zoomControl: true,
        attributionControl: false
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        subdomains: "abc"
    }).addTo(radarMap);

    radarInitialized = true;
}

async function loadRadarFrames() {
    try {
        const res = await fetchWithTimeout("https://api.rainviewer.com/public/weather-maps.json");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const host = data.host || "https://tilecache.rainviewer.com";
        const past = (data.radar && data.radar.past) || [];

        radarFrames = past.map((frame) => ({
            time: frame.time,
            path: frame.path,
            url: `${host}${frame.path}/256/{z}/{x}/{y}/4/1_1.png`
        }));

        if (radarFrames.length === 0) return;

        radarCurrentFrame = radarFrames.length - 1;
        renderRadarFrame();
        updateRadarTime();

        const playBtn = document.getElementById("radar-play");
        if (playBtn) playBtn.disabled = false;
    } catch (err) {
        console.warn("Radar frames failed to load:", err);
    }
}

function renderRadarFrame() {
    if (!radarMap || radarFrames.length === 0) return;

    const frame = radarFrames[radarCurrentFrame];
    if (!frame) return;

    if (radarLayer) {
        radarMap.removeLayer(radarLayer);
        radarLayer = null;
    }

    radarLayer = L.tileLayer(frame.url, {
        opacity: 0.75,
        transparent: true,
        zIndex: 10
    }).addTo(radarMap);
}

function updateRadarTime() {
    const el = document.getElementById("radar-time");
    if (!el || radarFrames.length === 0) return;

    const frame = radarFrames[radarCurrentFrame];
    if (!frame) return;

    const d = new Date(frame.time * 1000);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    el.textContent = `${hh}:${mm}`;
}

function radarStep(delta) {
    if (radarFrames.length === 0) return;
    radarCurrentFrame = (radarCurrentFrame + delta + radarFrames.length) % radarFrames.length;
    renderRadarFrame();
    updateRadarTime();
}

function radarTogglePlay() {
    const btn = document.getElementById("radar-play");
    if (!btn) return;

    if (radarPlayTimer) {
        clearInterval(radarPlayTimer);
        radarPlayTimer = null;
        btn.textContent = "▶ Play";
        return;
    }

    btn.textContent = "⏸ Pause";
    radarPlayTimer = setInterval(() => radarStep(1), 700);
}

function setRadarLocation(lat, lon, label) {
    if (!radarInitialized) return;

    radarMap.setView([lat, lon], 7, { animate: true });

    const el = document.getElementById("radar-location");
    if (el && label) el.textContent = label;
}

function setupRadarControls() {
    const prev = document.getElementById("radar-prev");
    const next = document.getElementById("radar-next");
    const play = document.getElementById("radar-play");

    if (prev) prev.addEventListener("click", () => radarStep(-1));
    if (next) next.addEventListener("click", () => radarStep(1));
    if (play) {
        play.disabled = true;
        play.addEventListener("click", radarTogglePlay);
    }
}

/* =========================================================
   VOICE SEARCH  (with language picker)
========================================================= */
const VOICE_LANGUAGES = [
    { code: "en-GB", label: "🇬🇧 UK" },
    { code: "en-US", label: "🇺🇸 US" },
    { code: "en-KE", label: "🇰🇪 EN" },
    { code: "sw-KE", label: "🇰🇪 SW" },
    { code: "fr-FR", label: "🇫🇷 FR" },
    { code: "es-ES", label: "🇪🇸 ES" },
    { code: "de-DE", label: "🇩🇪 DE" },
    { code: "pt-PT", label: "🇵🇹 PT" },
    { code: "ar-SA", label: "🇸🇦 AR" },
    { code: "hi-IN", label: "🇮🇳 HI" }
];

let voiceRecognition = null;
let voiceListening = false;

function setupVoiceSearch() {
    const btn = getElement("voice-search");
    const input = getElement("city-input");
    const langSelect = getElement("voice-lang");
    if (!btn || !input) return;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
        btn.style.display = "none";
        if (langSelect) langSelect.style.display = "none";
        return;
    }

    /* ---------- Language picker ---------- */
    if (langSelect) {
        VOICE_LANGUAGES.forEach(({ code, label }) => {
            const opt = document.createElement("option");
            opt.value = code;
            opt.textContent = label;
            langSelect.appendChild(opt);
        });

        const savedLang = localStorage.getItem("voiceSearchLang");
        const browserLang = navigator.language || "en-US";
        const preferred = savedLang || browserLang;

        const exact = VOICE_LANGUAGES.find(l => l.code === preferred);
        const partial = VOICE_LANGUAGES.find(
            l => l.code.split("-")[0] === preferred.split("-")[0]
        );
        langSelect.value = (exact || partial || VOICE_LANGUAGES[0]).code;
    }

    /* ---------- Recognition ---------- */
    voiceRecognition = new SR();
    voiceRecognition.lang = langSelect ? langSelect.value : "en-US";
    voiceRecognition.interimResults = false;
    voiceRecognition.continuous = false;
    voiceRecognition.maxAlternatives = 1;

    voiceRecognition.onstart = () => {
        voiceListening = true;
        btn.classList.add("listening");
        btn.textContent = "⏹";
        btn.title = "Listening… tap to stop";
        if (typeof mpTrack === "function") mpTrack("voice_search_started");
    };

    voiceRecognition.onresult = (event) => {
        const transcript = (event.results[0][0].transcript || "").trim();
        if (!transcript) return;

        input.value = transcript;
        showToast(`🎤 "${transcript}"`);

        if (typeof mpTrack === "function") {
            mpTrack("voice_search_result", {
                transcript: transcript,
                confidence: event.results[0][0].confidence
            });
        }

        searchLocations(transcript);
    };

    voiceRecognition.onerror = (event) => {
        const code = event.error;

        if (code === "not-allowed" || code === "service-not-allowed") {
            showToast("🎤 Microphone access denied");
        } else if (code === "no-speech") {
            showToast("🎤 Didn't catch that — try again");
        } else if (code === "audio-capture") {
            showToast("🎤 No microphone found");
        } else if (code === "network") {
            showToast("🎤 Network error — check connection");
        } else if (code === "aborted") {
            // User cancelled — silent
        } else {
            showToast("🎤 Voice search failed");
        }

        if (typeof mpTrack === "function") {
            mpTrack("voice_search_error", { error: code });
        }
    };

    voiceRecognition.onend = () => {
        voiceListening = false;
        btn.classList.remove("listening");
        // Restore the SVG mic
        btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 14.5a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 1 0-7 0v5a3.5 3.5 0 0 0 3.5 3.5z"/><path d="M18 11a1 1 0 1 0-2 0 4 4 0 1 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.91V19H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.09A6 6 0 0 0 18 11z"/></svg>`;
        btn.title = "Search by voice";
    };

    btn.addEventListener("click", () => {
        if (voiceListening) {
            voiceRecognition.stop();
            return;
        }
        try {
            voiceRecognition.start();
        } catch (err) {
            console.warn("Voice start failed:", err);
        }
    });

    /* ---------- Language change ---------- */
    if (langSelect) {
        langSelect.addEventListener("change", () => {
            voiceRecognition.lang = langSelect.value;
            localStorage.setItem("voiceSearchLang", langSelect.value);
            showToast(`🎤 Language: ${langSelect.options[langSelect.selectedIndex].text}`);
        });
    }
}

/* =========================================================
   SWIPE BETWEEN SAVED CITIES
========================================================= */
let swipeStartX = 0;
let swipeStartY = 0;
let swipeTracking = false;
const SWIPE_THRESHOLD = 60;      // minimum horizontal px to count
const SWIPE_MAX_VERTICAL = 80;   // ignore if mostly vertical

function findSavedIndex(loc) {
    if (!loc || !Array.isArray(savedLocations)) return -1;
    return savedLocations.findIndex(l =>
        Math.abs(l.lat - loc.lat) < 0.001 &&
        Math.abs(l.lon - loc.lon) < 0.001
    );
}

function goToSavedCity(delta) {
    if (savedLocations.length < 2) return;

    const current = window._loadedLocation;
    let idx = findSavedIndex(current);

    if (idx === -1) {
        // Current city not saved → jump to first
        idx = 0;
    } else {
        idx = (idx + delta + savedLocations.length) % savedLocations.length;
    }

    const next = savedLocations[idx];
    if (!next) return;

    showToast(`📍 ${next.name || "Saved location"}`);
    getWeatherByCoordinates(next.lat, next.lon, next.name, next.country, next.state);
}

function updateSwipeHint() {
    const hint = getElement("swipe-hint");
    if (!hint) return;
    hint.style.display = savedLocations.length >= 2 ? "block" : "none";
}

function setupSavedCitySwipe() {
    const target = document.querySelector(".cw-hero");
    if (!target) return;

    target.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 1) return;
        swipeStartX = e.touches[0].clientX;
        swipeStartY = e.touches[0].clientY;
        swipeTracking = true;
    }, { passive: true });

    target.addEventListener("touchend", (e) => {
        if (!swipeTracking) return;
        swipeTracking = false;

        const t = e.changedTouches[0];
        if (!t) return;

        const dx = t.clientX - swipeStartX;
        const dy = t.clientY - swipeStartY;

        if (Math.abs(dy) > SWIPE_MAX_VERTICAL) return;
        if (Math.abs(dx) < SWIPE_THRESHOLD) return;

        if (dx < 0) goToSavedCity(1);
        else        goToSavedCity(-1);
    }, { passive: true });

    // Desktop: left/right arrow keys
    document.addEventListener("keydown", (e) => {
        const tag = (e.target.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") return;

        if (e.key === "ArrowRight") goToSavedCity(1);
        if (e.key === "ArrowLeft")  goToSavedCity(-1);
    });

        // Click/tap on the arrow buttons
    document.querySelectorAll(".swipe-nav-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const delta = parseInt(btn.dataset.nav, 10);
            goToSavedCity(delta);
        });
    });
}

/* =========================================================
   OUTFIT ICONS — SVG illustrations for "What to wear"
========================================================= */
const OUTFIT_ICONS = {
    hot: `
        <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="44" cy="18" r="7" fill="#fbbf24"/>
            <g stroke="#fbbf24" stroke-width="2" stroke-linecap="round">
                <path d="M44 4v4M44 28v4M30 18h4M54 18h4M34 8l3 3M54 28l-3-3M54 8l-3 3M34 28l3-3"/>
            </g>
            <path d="M14 32l6-6h24l6 6-6 5v17H20V37z" fill="#ef4444" stroke="#b91c1c" stroke-width="2" stroke-linejoin="round"/>
            <path d="M20 32h24" stroke="#b91c1c" stroke-width="2"/>
            <path d="M26 26l-2 6M38 26l2 6" stroke="#b91c1c" stroke-width="2" stroke-linecap="round"/>
        </svg>`,
    warm: `
        <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="46" cy="16" r="5" fill="#fcd34d"/>
            <path d="M14 26l6-6h24l6 6-6 5v23H20V31z" fill="#38bdf8" stroke="#0284c7" stroke-width="2" stroke-linejoin="round"/>
            <path d="M20 26h24" stroke="#0284c7" stroke-width="2"/>
            <path d="M26 20l-2 6M38 20l2 6" stroke="#0284c7" stroke-width="2" stroke-linecap="round"/>
        </svg>`,
    mild: `
        <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M14 26l6-6h24l6 6-6 5v23H20V31z" fill="#e5e7eb" stroke="#6b7280" stroke-width="2" stroke-linejoin="round"/>
            <path d="M20 26h24" stroke="#6b7280" stroke-width="2"/>
            <path d="M26 20l-2 6M38 20l2 6" stroke="#6b7280" stroke-width="2" stroke-linecap="round"/>
        </svg>`,
    cool: `
        <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 26l8-6h24l8 6-8 6v22H20V32z" fill="#3b82f6" stroke="#1e3a8a" stroke-width="2" stroke-linejoin="round"/>
            <path d="M20 26h24" stroke="#1e3a8a" stroke-width="2"/>
            <path d="M26 20l-2 6M38 20l2 6" stroke="#1e3a8a" stroke-width="2" stroke-linecap="round"/>
            <path d="M32 26v28" stroke="#1e3a8a" stroke-width="2"/>
            <circle cx="30" cy="40" r="1.5" fill="#1e3a8a"/>
            <circle cx="30" cy="46" r="1.5" fill="#1e3a8a"/>
            <circle cx="34" cy="40" r="1.5" fill="#1e3a8a"/>
            <circle cx="34" cy="46" r="1.5" fill="#1e3a8a"/>
        </svg>`,
    chilly: `
        <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 26l8-6h24l8 6-8 6v22H20V32z" fill="#8b5cf6" stroke="#5b21b6" stroke-width="2" stroke-linejoin="round"/>
            <path d="M20 26h24" stroke="#5b21b6" stroke-width="2"/>
            <path d="M26 20l-2 6M38 20l2 6" stroke="#5b21b6" stroke-width="2" stroke-linecap="round"/>
            <path d="M24 34c4 4 12 4 16 0" stroke="#5b21b6" stroke-width="2" stroke-linecap="round" fill="none"/>
        </svg>`,
    cold: `
        <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M10 28l10-8h24l10 8-10 8v20H20V36z" fill="#1e40af" stroke="#0f172a" stroke-width="2" stroke-linejoin="round"/>
            <path d="M20 28h24" stroke="#0f172a" stroke-width="2"/>
            <path d="M26 20l-2 8M38 20l2 8" stroke="#0f172a" stroke-width="2" stroke-linecap="round"/>
            <path d="M32 28v26" stroke="#0f172a" stroke-width="2"/>
            <circle cx="30" cy="40" r="1.5" fill="#0f172a"/>
            <circle cx="30" cy="46" r="1.5" fill="#0f172a"/>
            <circle cx="34" cy="40" r="1.5" fill="#0f172a"/>
            <circle cx="34" cy="46" r="1.5" fill="#0f172a"/>
            <path d="M14 36v8M50 36v8" stroke="#0f172a" stroke-width="2" stroke-linecap="round"/>
        </svg>`,
    freezing: `
        <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 30l10-8h20l10 8-10 8v18H22V38z" fill="#1e40af" stroke="#0f172a" stroke-width="2" stroke-linejoin="round"/>
            <path d="M22 30h20" stroke="#0f172a" stroke-width="2"/>
            <path d="M32 30v26" stroke="#0f172a" stroke-width="2"/>
            <circle cx="30" cy="42" r="1.5" fill="#0f172a"/>
            <circle cx="34" cy="42" r="1.5" fill="#0f172a"/>
            <path d="M26 22c2-4 10-4 12 0" stroke="#dc2626" stroke-width="3" stroke-linecap="round" fill="none"/>
            <path d="M50 42v-8M50 34l-2 2M50 34l2 2" stroke="#e5e7eb" stroke-width="2" stroke-linecap="round"/>
            <circle cx="50" cy="46" r="1" fill="#e5e7eb"/>
            <circle cx="52" cy="50" r="1" fill="#e5e7eb"/>
            <circle cx="48" cy="50" r="1" fill="#e5e7eb"/>
        </svg>`,
    rain: `
        <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M14 22h30c4 0 6 3 6 6s-2 6-6 6H14c-4 0-6-3-6-6s2-6 6-6z" fill="#38bdf8" stroke="#0284c7" stroke-width="2"/>
            <path d="M24 22c0-6 4-10 10-10s10 4 10 10" fill="#38bdf8" stroke="#0284c7" stroke-width="2"/>
            <g stroke="#0284c7" stroke-width="2" stroke-linecap="round">
                <path d="M18 40l-2 6M28 40l-2 6M38 40l-2 6M48 40l-2 6"/>
            </g>
            <path d="M40 46v-6M40 40l-3-3M40 40l3-3" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"/>
        </svg>`,
    storm: `
        <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 24h34c4 0 6 3 6 6s-2 6-6 6H12c-4 0-6-3-6-6s2-6 6-6z" fill="#64748b" stroke="#334155" stroke-width="2"/>
            <path d="M22 24c0-6 4-10 10-10s10 4 10 10" fill="#64748b" stroke="#334155" stroke-width="2"/>
            <path d="M32 40l-4 10h6l-3 8 10-12h-6l3-6z" fill="#fbbf24" stroke="#b45309" stroke-width="1.5" stroke-linejoin="round"/>
            <g stroke="#334155" stroke-width="2" stroke-linecap="round">
                <path d="M16 44l-1 5M48 44l-1 5"/>
            </g>
        </svg>`,
    snow: `
        <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M8 26h32c4 0 6 3 6 6s-2 6-6 6H8c-4 0-6-3-6-6s2-6 6-6z" fill="#e0e7ff" stroke="#6366f1" stroke-width="2"/>
            <path d="M16 26c0-6 4-10 10-10s10 4 10 10" fill="#e0e7ff" stroke="#6366f1" stroke-width="2"/>
            <g stroke="#38bdf8" stroke-width="2" stroke-linecap="round">
                <path d="M40 44v10M36 48l8 4M44 48l-8 4M36 49h8M40 44l-2 2M40 44l2 2"/>
            </g>
        </svg>`
};

function renderOutfitIcon(key) {
    return OUTFIT_ICONS[key] || "";
}