/* 8X Weather → Mkuu helper context.
 * Builds a short plain-text summary of the weather the page is showing, so Mkuu
 * can answer "will it rain this afternoon?" for the place the user is viewing.
 * Uses the globals app.js already sets: window._currentWeatherData and
 * window._lastForecastData, plus its unit helpers so °C/°F matches the UI. */
(function () {
    "use strict";

    function num(v) {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }

    function temp(c) {
        if (num(c) === null) return "?";
        if (typeof formatTemp === "function" && typeof tempUnit === "function") {
            return formatTemp(c, 0) + tempUnit();
        }
        return Math.round(c) + "°C";
    }

    function speed(mps) {
        if (num(mps) === null) return "?";
        if (typeof formatSpeed === "function" && typeof speedUnit === "function") {
            return formatSpeed(mps, 1) + " " + speedUnit();
        }
        return mps.toFixed(1) + " m/s";
    }

    // Local "HH:MM" / weekday for a unix time at the location's UTC offset
    function localTime(dt, tz) {
        return new Date((dt + tz) * 1000).toISOString().slice(11, 16);
    }

    function weekday(dateStr) {
        const d = new Date(dateStr + "T12:00:00Z");
        return d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
    }

    function placeName(data) {
        const loc = (data && data.searched_location) || {};
        const name = loc.name || (data && data.name) || "";
        const country = loc.country || (data && data.sys && data.sys.country) || "";
        const state = loc.state && loc.state !== name ? loc.state : "";
        return [name, state, country].filter(Boolean).join(", ");
    }

    window.MkuuHelperContext = function () {
        const w = window._currentWeatherData;
        const f = window._lastForecastData;
        if (!w || !w.main) return "";

        const tz = num(f && f.timezone) ?? num(w.timezone) ?? 0;
        const now = Math.floor(Date.now() / 1000);
        const cond = (w.weather && w.weather[0] && w.weather[0].description) || "";
        const lines = [];

        lines.push("Weather on the user's screen (8X Weather):");
        lines.push(`Place: ${placeName(w) || "unknown"}. Local time: ${localTime(now, tz)}.`);
        lines.push(
            `Now: ${temp(w.main.temp)}, feels like ${temp(w.main.feels_like)}, ${cond}, ` +
            `humidity ${w.main.humidity ?? "?"}%, wind ${speed(w.wind && w.wind.speed)}.`
        );

        if (w.uv && num(w.uv.value) !== null) {
            const max = num(w.uv.max_today);
            lines.push(`UV now ${Math.round(w.uv.value)}${max !== null ? `, max today ${Math.round(max)}` : ""}.`);
        }

        if (w.sys && w.sys.sunrise && w.sys.sunset) {
            lines.push(`Sunrise ${localTime(w.sys.sunrise, tz)}, sunset ${localTime(w.sys.sunset, tz)}.`);
        }

        // Next ~24 hours in 3-hour steps
        const slots = ((f && f.list) || []).filter(i => num(i.dt) !== null && i.dt >= now).slice(0, 8);
        if (slots.length) {
            lines.push("Next hours (local time, temp, rain chance, sky):");
            lines.push(slots.map(i => {
                const d = (i.weather && i.weather[0] && i.weather[0].description) || "";
                return `${localTime(i.dt, tz)} ${temp(i.main && i.main.temp)} ${Math.round((num(i.pop) || 0) * 100)}% ${d}`;
            }).join("; ") + ".");
        }

        // Daily outlook (up to 7 days)
        const days = ((f && f.daily) || []).slice(0, 7);
        if (days.length) {
            lines.push("Daily (low/high, rain chance, sky):");
            lines.push(days.map(d => {
                const pop = num(d.pop) !== null ? Math.round(d.pop * 100) + "%" : "?";
                const desc = (d.weather && d.weather.description) || "";
                return `${weekday(d.date)} ${d.date.slice(5)} ${temp(d.temp_min)}/${temp(d.temp_max)} ${pop} ${desc}`;
            }).join("; ") + ".");
        }

        return lines.join("\n");
    };
})();
