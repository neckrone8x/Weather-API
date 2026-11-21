/* =========================================================
   STORAGE — never let blocked storage (private mode, settings) stop the page
========================================================= */
function storageGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
    try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function storageRemove(key) {
    try { localStorage.removeItem(key); } catch { /* blocked */ }
}
function storageJson(key, fallback) {
    try {
        const v = JSON.parse(storageGet(key) || "null");
        return v === null ? fallback : v;
    } catch { return fallback; }
}

/* =========================================================
   GLOBAL STATE
========================================================= */
let currentLocation = null;
let selectedTimezoneOffset = 0;

let themeMode = ["auto", "light", "dark"].includes(storageGet("weatherTheme")) ? storageGet("weatherTheme") : "auto";

let currentSunrise = null;
let currentSunset = null;
let currentTimezone = null;

window._currentWeatherData = null;
window._lastForecastData = null;

let autoRefreshTimer = null;
const AUTO_REFRESH_MS = 5 * 60 * 1000;   // 5 minutes
window._loadedLocation = null;
let savedLocations = (() => { const v = storageJson("weatherSavedLocations", []); return Array.isArray(v) ? v : []; })();

let unitMode = storageGet("weatherUnit") === "imperial" ? "imperial" : "metric";


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
   LANGUAGE — English / Kiswahili
   Every text a visitor sees is in I18N, one entry per key with en and sw.
   t(key, {name: value}) fills in {name}; a missing sw entry falls back to
   English. The template marks its texts with data-i18n (text),
   data-i18n-placeholder, data-i18n-title and data-i18n-aria.
========================================================= */
const LANG_STORAGE_KEY = "weatherLang";
const LANGS = ["en", "sw"];

const I18N = {
    // --- header, search, buttons ---
    lang_switch:        { en: "Language", sw: "Lugha" },
    unit_toggle:        { en: "Toggle °C/°F", sw: "Badili °C/°F" },
    refresh:            { en: "Refresh weather", sw: "Onyesha hali ya hewa upya" },
    theme_auto:         { en: "Theme: Auto (follows sun) — click for Light", sw: "Mandhari: Otomatiki (kufuata jua) — gusa kwa Mwanga" },
    theme_light:        { en: "Theme: Light — click for Dark", sw: "Mandhari: Mwanga — gusa kwa Giza" },
    theme_dark:         { en: "Theme: Dark — click for Auto", sw: "Mandhari: Giza — gusa kwa Otomatiki" },
    search_placeholder: { en: "Search city or place...", sw: "Tafuta mji au mahali..." },
    search:             { en: "Search", sw: "Tafuta" },
    clear_search:       { en: "Clear search", sw: "Futa utafutaji" },
    voice_lang:         { en: "Voice search language", sw: "Lugha ya kutafuta kwa sauti" },
    voice_search:       { en: "Search by voice", sw: "Tafuta kwa sauti" },
    voice_listening:    { en: "Listening… tap to stop", sw: "Inasikiliza… gusa kusimamisha" },
    search_hint:        { en: "💡 For a more specific location, try:", sw: "💡 Kwa mahali mahususi zaidi, jaribu:" },
    use_my_location:    { en: "📍 Use My Location", sw: "📍 Tumia mahali nilipo" },
    locating:           { en: "📍 Locating...", sw: "📍 Inatafuta..." },
    save_location:      { en: "♡ Save Location", sw: "♡ Hifadhi mahali" },
    save_location_title:{ en: "Save this location", sw: "Hifadhi mahali hapa" },
    saved:              { en: "♥ Saved", sw: "♥ Pamehifadhiwa" },
    share:              { en: "Share", sw: "Shiriki" },
    close:              { en: "Close", sw: "Funga" },
    back_to_top:        { en: "Back to top", sw: "Rudi juu" },
    footer:             { en: "Powered by A Neckrone8x Production", sw: "Imetengenezwa na Neckrone8x Production" },

    // --- quick nav ---
    nav_now:      { en: "Now", sw: "Sasa" },
    nav_hourly:   { en: "Hourly", sw: "Kwa saa" },
    nav_radar:    { en: "Radar", sw: "Rada" },
    nav_5day:     { en: "5-Day", sw: "Siku 5" },
    nav_calendar: { en: "Calendar", sw: "Kalenda" },
    nav_cities:   { en: "Cities", sw: "Miji" },
    nav_alerts:   { en: "Alerts", sw: "Tahadhari" },
    nav_globe:    { en: "Globe", sw: "Dunia" },

    // --- current weather card ---
    loading:              { en: "Loading...", sw: "Inapakia..." },
    loading_date:         { en: "Loading date...", sw: "Inapakia tarehe..." },
    loading_weather:      { en: "Loading weather...", sw: "Inapakia hali ya hewa..." },
    loading_local:        { en: "Loading your local weather...", sw: "Inapakia hali ya hewa ya hapo ulipo..." },
    switch_cities:        { en: "Switch cities", sw: "Badili mji" },
    prev_city:            { en: "Previous saved city", sw: "Mji uliohifadhiwa uliotangulia" },
    next_city:            { en: "Next saved city", sw: "Mji uliohifadhiwa unaofuata" },
    what_to_wear:         { en: "WHAT TO WEAR TODAY", sw: "UVAE NINI LEO" },
    feels_like:           { en: "FEELS LIKE", sw: "INAHISI KAMA" },
    humidity:             { en: "HUMIDITY", sw: "UNYEVU" },
    wind:                 { en: "WIND", sw: "UPEPO" },
    clouds:               { en: "CLOUDS", sw: "MAWINGU" },
    clouds_title:         { en: "Total sky area covered by clouds", sw: "Sehemu ya anga iliyofunikwa na mawingu" },
    clouds_shower:        { en: "{pct}% (shower)", sw: "{pct}% (rasharasha)" },
    sunrise:              { en: "🌅 SUNRISE", sw: "🌅 MACHEO" },
    sunset:               { en: "🌇 SUNSET", sw: "🌇 MACHWEO" },
    sunrise_word:         { en: "Sunrise", sw: "Macheo" },
    sunset_word:          { en: "Sunset", sw: "Machweo" },
    uv_index:             { en: "☀️ UV INDEX", sw: "☀️ KIWANGO CHA UV" },
    air_quality:          { en: "😷 AIR QUALITY", sw: "😷 UBORA WA HEWA" },
    moon:                 { en: "🌙 MOON", sw: "🌙 MWEZI" },
    sunrise_in:           { en: "🌅 SUNRISE IN", sw: "🌅 MACHEO BAADA YA" },
    sunset_in:            { en: "🌇 SUNSET IN", sw: "🌇 MACHWEO BAADA YA" },
    until_sunrise:        { en: "Until sunrise", sw: "Hadi jua lichomoze" },
    until_sunset:         { en: "Until sunset", sw: "Hadi jua litue" },
    until_tomorrow_sunrise:{ en: "Until tomorrow's sunrise", sw: "Hadi jua lichomoze kesho" },
    countdown_hm:         { en: "{h}h {m}m", sw: "saa {h} dk {m}" },
    countdown_m:          { en: "{m}m", sw: "dk {m}" },
    weather_details:      { en: "WEATHER DETAILS", sw: "MAELEZO YA HALI YA HEWA" },
    pressure:             { en: "🌡️ PRESSURE", sw: "🌡️ SHINIKIZO LA HEWA" },
    visibility:           { en: "👁️ VISIBILITY", sw: "👁️ MWONEKANO" },
    wind_direction:       { en: "🌬️ WIND DIRECTION", sw: "🌬️ MWELEKEO WA UPEPO" },
    wind_gust:            { en: "💨 WIND GUST", sw: "💨 UPEPO WA GHAFLA" },
    now:                  { en: "Now", sw: "Sasa" },
    unknown_location:     { en: "Unknown location", sw: "Mahali pasipojulikana" },
    unknown:              { en: "Unknown", sw: "Haijulikani" },
    no_advice:            { en: "No advice available", sw: "Hakuna ushauri kwa sasa" },

    // --- UV and air quality levels ---
    uv_low:       { en: "Low", sw: "Chini" },
    uv_moderate:  { en: "Moderate", sw: "Wastani" },
    uv_high:      { en: "High", sw: "Juu" },
    uv_very_high: { en: "Very High", sw: "Juu sana" },
    uv_extreme:   { en: "Extreme", sw: "Kali sana" },
    uv_max_title: { en: "Max UV index", sw: "Kiwango cha juu cha UV" },
    aqi_1:        { en: "Good", sw: "Nzuri" },
    aqi_2:        { en: "Fair", sw: "Ya kuridhisha" },
    aqi_3:        { en: "Moderate", sw: "Wastani" },
    aqi_4:        { en: "Poor", sw: "Mbaya" },
    aqi_5:        { en: "Very Poor", sw: "Mbaya sana" },

    // --- moon phases ---
    moon_new:             { en: "New Moon", sw: "Mwezi mchanga" },
    moon_waxing_crescent: { en: "Waxing Crescent", sw: "Hilali inayokua" },
    moon_first_quarter:   { en: "First Quarter", sw: "Robo ya kwanza" },
    moon_waxing_gibbous:  { en: "Waxing Gibbous", sw: "Mwezi unaokua" },
    moon_full:            { en: "Full Moon", sw: "Mwezi mpevu" },
    moon_waning_gibbous:  { en: "Waning Gibbous", sw: "Mwezi unaopungua" },
    moon_last_quarter:    { en: "Last Quarter", sw: "Robo ya mwisho" },
    moon_waning_crescent: { en: "Waning Crescent", sw: "Hilali inayopungua" },
    moon_title:           { en: "{name} — {pct}% illuminated", sw: "{name} — {pct}% inang'aa" },

    // --- weather conditions (by OpenWeatherMap id) ---
    cond_sunny:         { en: "Sunny", sw: "Anga safi" },
    cond_partly_cloudy: { en: "Partly cloudy", sw: "Mawingu kiasi" },
    cond_scattered:     { en: "Scattered clouds", sw: "Mawingu yaliyotawanyika" },
    cond_broken:        { en: "Broken clouds", sw: "Mawingu mengi" },
    cond_overcast:      { en: "Overcast", sw: "Mawingu mazito" },
    cond_thunder:       { en: "Thunderstorm", sw: "Radi na mvua" },
    cond_drizzle:       { en: "Drizzle", sw: "Manyunyu" },
    cond_light_rain:    { en: "Light rain", sw: "Mvua nyepesi" },
    cond_rain:          { en: "Rain", sw: "Mvua" },
    cond_heavy_rain:    { en: "Heavy rain", sw: "Mvua kubwa" },
    cond_freezing_rain: { en: "Freezing rain", sw: "Mvua ya barafu" },
    cond_snow:          { en: "Snow", sw: "Theluji" },
    cond_sleet:         { en: "Sleet", sw: "Theluji na mvua" },
    cond_fog:           { en: "Foggy", sw: "Ukungu" },
    cond_smoke:         { en: "Smoky", sw: "Moshi" },
    cond_dust:          { en: "Dusty", sw: "Vumbi" },
    cond_ash:           { en: "Volcanic ash", sw: "Majivu ya volkano" },
    cond_squall:        { en: "Squalls", sw: "Upepo mkali" },
    cond_tornado:       { en: "Tornado", sw: "Kimbunga" },
    cond_unknown:       { en: "Unknown", sw: "Haijulikani" },

    // --- compass (the report and the wind direction tile) ---
    compass:      { en: ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                         "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"],
                    sw: ["kaskazini", "kaskazini-mashariki", "kaskazini-mashariki", "kaskazini-mashariki",
                         "mashariki", "kusini-mashariki", "kusini-mashariki", "kusini-mashariki",
                         "kusini", "kusini-magharibi", "kusini-magharibi", "kusini-magharibi",
                         "magharibi", "kaskazini-magharibi", "kaskazini-magharibi", "kaskazini-magharibi"] },

    // --- the sentence under the temperature ---
    report_now:          { en: "Currently {temp} with {cond}.", sw: "Kwa sasa ni {temp}, {cond}." },
    report_warmer:       { en: " It feels warmer at {temp}.", sw: " Inahisi joto zaidi, kama {temp}." },
    report_cooler:       { en: " It feels cooler at {temp}.", sw: " Inahisi baridi zaidi, kama {temp}." },
    report_humidity:     { en: " Humidity is at {pct}%", sw: " Unyevu ni {pct}%" },
    report_wind:         { en: " and wind is blowing at {speed}", sw: " na upepo unavuma kwa {speed}" },
    report_wind_from:    { en: " from the {dir} ({deg}°)", sw: " kutoka {dir} ({deg}°)" },
    report_clouds:       { en: " Cloud cover is around {pct}%.", sw: " Mawingu yamefunika takriban {pct}% ya anga." },
    report_clear:        { en: " Skies are clear.", sw: " Anga ni safi." },
    report_vis_low:      { en: " Visibility is reduced to {km} km.", sw: " Mwonekano umepungua hadi km {km}." },
    report_vis_high:     { en: " Visibility is excellent at {km} km.", sw: " Mwonekano ni mzuri sana, km {km}." },

    // --- what to wear ---
    wear_thunder:     { en: "Stay indoors if possible — thunderstorms nearby", sw: "Kaa ndani ukiweza — kuna radi karibu" },
    wear_snow:        { en: "Heavy winter coat, gloves, and waterproof boots", sw: "Koti zito la baridi, glavu na buti zisizoingiza maji" },
    wear_rain_hot:    { en: "Rainy — light waterproof clothes and an umbrella", sw: "Mvua — nguo nyepesi zisizoingiza maji na mwavuli" },
    wear_rain_mild:   { en: "Rainy — waterproof jacket and umbrella", sw: "Mvua — koti la mvua na mwavuli" },
    wear_rain_cold:   { en: "Cold and rainy — raincoat and boots", sw: "Baridi na mvua — koti la mvua na buti" },
    wear_light_hot:   { en: "Light rain — t-shirt with an umbrella", sw: "Mvua nyepesi — fulana na mwavuli" },
    wear_light_mild:  { en: "Light rain — jacket and umbrella", sw: "Mvua nyepesi — jaketi na mwavuli" },
    wear_light_cold:  { en: "Cold and damp — warm coat with umbrella", sw: "Baridi na unyevu — koti zito na mwavuli" },
    wear_soon_hot:    { en: "Light clothes + bring an umbrella — rain coming soon", sw: "Nguo nyepesi + beba mwavuli — mvua inakuja hivi karibuni" },
    wear_soon_mild:   { en: "Light jacket + umbrella — rain in the next few hours", sw: "Jaketi jepesi + mwavuli — mvua ndani ya saa chache" },
    wear_soon_cold:   { en: "Warm coat + umbrella — cold rain on the way", sw: "Koti zito + mwavuli — mvua ya baridi inakuja" },
    wear_30:          { en: "Shorts, t-shirt, and sun protection — very hot day", sw: "Kaptula, fulana na kinga ya jua — siku ya joto kali" },
    wear_25:          { en: "Light t-shirt and shorts or jeans — warm day", sw: "Fulana nyepesi na kaptula au jinzi — siku ya joto" },
    wear_20:          { en: "T-shirt and jeans — comfortable day", sw: "Fulana na jinzi — siku nzuri" },
    wear_15:          { en: "Light jacket or long sleeves recommended", sw: "Jaketi jepesi au nguo za mikono mirefu" },
    wear_10:          { en: "Sweater or hoodie recommended", sw: "Sweta au koti lenye kofia" },
    wear_5:           { en: "Warm coat and long pants", sw: "Koti zito na suruali ndefu" },
    wear_cold:        { en: "Heavy coat, scarf, and warm layers", sw: "Koti zito, skafu na nguo nyingi za joto" },

    // --- saved-data bar, errors, status ---
    status_failed:     { en: "Couldn't load the weather right now.", sw: "Imeshindikana kupakia hali ya hewa kwa sasa." },
    status_saved:      { en: "Showing saved data from {time}", sw: "Inaonyesha data iliyohifadhiwa ya {time}" },
    status_updating:   { en: " · updating…", sw: " · inasasisha…" },
    saved_ago:         { en: "Saved {ago}", sw: "Imehifadhiwa {ago}" },
    rel_min_1:         { en: "1 minute ago", sw: "dakika 1 iliyopita" },
    rel_min:           { en: "{n} minutes ago", sw: "dakika {n} zilizopita" },
    rel_h_1:           { en: "1 hour ago", sw: "saa 1 iliyopita" },
    rel_h:             { en: "{n} hours ago", sw: "saa {n} zilizopita" },
    old_data:          { en: "Old data, may be wrong", sw: "Data ya zamani, huenda si sahihi" },
    earlier:           { en: "earlier", sw: "awali" },
    retry:             { en: "Retry", sw: "Jaribu tena" },
    retrying:          { en: "Retrying…", sw: "Inajaribu tena…" },
    city_not_found:    { en: "City not found. Please try again.", sw: "Mji haujapatikana. Tafadhali jaribu tena." },
    weather_unavailable_title: { en: "Weather unavailable", sw: "Hali ya hewa haipatikani" },
    weather_unavailable: { en: "Weather is temporarily unavailable. Please try again in a few minutes.",
                           sw: "Hali ya hewa haipatikani kwa muda. Tafadhali jaribu tena baada ya dakika chache." },
    search_unavailable:  { en: "City search is temporarily unavailable. Please try again in a few minutes.",
                           sw: "Utafutaji wa miji haupatikani kwa muda. Tafadhali jaribu tena baada ya dakika chache." },
    rate_limited:        { en: "Too many requests from your network right now. Please wait a minute, then tap Retry.",
                           sw: "Maombi ni mengi mno kutoka mtandao wako sasa hivi. Tafadhali subiri dakika moja, kisha gusa Jaribu tena." },
    rate_limited_search: { en: "Too many searches from your network right now. Please wait a minute, then try again.",
                           sw: "Utafutaji ni mwingi mno kutoka mtandao wako sasa hivi. Tafadhali subiri dakika moja, kisha ujaribu tena." },
    search_failed:       { en: "Unable to search locations right now.", sw: "Imeshindikana kutafuta maeneo kwa sasa." },
    load_failed:         { en: "Unable to load weather.", sw: "Imeshindikana kupakia hali ya hewa." },
    load_local_failed:   { en: "Unable to load your local weather.", sw: "Imeshindikana kupakia hali ya hewa ya hapo ulipo." },
    invalid_coords:      { en: "Invalid location coordinates.", sw: "Viwianishi vya mahali si sahihi." },
    hourly_unavailable:  { en: "Hourly forecast unavailable.", sw: "Utabiri wa kila saa haupatikani." },
    forecast_unavailable:{ en: "Forecast unavailable.", sw: "Utabiri haupatikani." },
    choose_location:     { en: "📍 Choose your location", sw: "📍 Chagua mahali" },
    choose_location_sub: { en: "Select a location below to view its weather.", sw: "Chagua mahali hapa chini ili kuona hali yake ya hewa." },

    // --- my location ---
    location_failed:     { en: "Couldn't find your location. Try searching for your city.", sw: "Imeshindikana kupata mahali ulipo. Jaribu kutafuta mji wako." },
    finding_location:    { en: "📍 Finding your location...", sw: "📍 Inatafuta mahali ulipo..." },
    finding_location_input: { en: "Finding your location...", sw: "Inatafuta mahali ulipo..." },
    finding_approximate: { en: "📍 Finding an approximate location...", sw: "📍 Inatafuta mahali pa takriban..." },
    improving_accuracy:  { en: "📡 Improving accuracy (±{m} m)...", sw: "📡 Inaboresha usahihi (±{m} m)..." },
    approximate_note:    { en: "📍 Approximate location (from your internet connection). ", sw: "📍 Mahali pa takriban (kutoka muunganisho wako wa intaneti). " },
    approximate_place:   { en: "Approximate location", sw: "Mahali pa takriban" },
    search_your_city:    { en: "Search for your city", sw: "Tafuta mji wako" },
    your_location:       { en: "Your Location", sw: "Mahali ulipo" },
    your_location_acc:   { en: "Your Location (±{m}m)", sw: "Mahali ulipo (±{m}m)" },

    // --- earthquake / weather alert banner ---
    weather_alert:   { en: "Weather Alert", sw: "Tahadhari ya hali ya hewa" },
    quake_title:     { en: "M{mag} earthquake", sw: "Tetemeko la ardhi M{mag}" },
    quake_from_you:  { en: "{km} km from you", sw: "km {km} kutoka ulipo" },
    quake_depth:     { en: "{km} km deep", sw: "kina cha km {km}" },
    nearby:          { en: "Nearby", sw: "Karibu nawe" },
    ago_now:         { en: "just now", sw: "sasa hivi" },
    ago_min:         { en: "{n} min ago", sw: "dakika {n} zilizopita" },
    ago_min_1:       { en: "1 min ago", sw: "dakika 1 iliyopita" },
    ago_h:           { en: "{n} h ago", sw: "saa {n} zilizopita" },
    ago_h_1:         { en: "1 h ago", sw: "saa 1 iliyopita" },
    ago_days:        { en: "{n} days ago", sw: "siku {n} zilizopita" },
    ago_day_1:       { en: "1 day ago", sw: "siku 1 iliyopita" },
    dismiss:         { en: "Dismiss", sw: "Ondoa" },

    // --- sections ---
    hourly_forecast:  { en: "HOURLY FORECAST", sw: "UTABIRI WA KILA SAA" },
    radar_title:      { en: "PRECIPITATION RADAR", sw: "RADA YA MVUA" },
    radar_prev:       { en: "Previous frame", sw: "Picha iliyotangulia" },
    radar_next:       { en: "Next frame", sw: "Picha inayofuata" },
    radar_play_title: { en: "Play/Pause", sw: "Cheza/Simamisha" },
    radar_play:       { en: "▶ Play", sw: "▶ Cheza" },
    radar_pause:      { en: "⏸ Pause", sw: "⏸ Simamisha" },
    radar_data:       { en: "Radar data ©", sw: "Data ya rada ©" },
    map_credit:       { en: "Map ©", sw: "Ramani ©" },
    forecast_5day:    { en: "5-DAY FORECAST", sw: "UTABIRI WA SIKU 5" },
    calendar_title:   { en: "MONTHLY CALENDAR", sw: "KALENDA YA MWEZI" },
    prev_month:       { en: "Previous month", sw: "Mwezi uliopita" },
    next_month:       { en: "Next month", sw: "Mwezi ujao" },
    saved_cities:     { en: "YOUR SAVED CITIES", sw: "MIJI ULIYOHIFADHI" },
    cities_empty:     { en: "💡 Save a location with the ♡ button to see it here", sw: "💡 Hifadhi mahali kwa kitufe cha ♡ ili kupaona hapa" },
    unavailable:      { en: "⚠️ Unavailable", sw: "⚠️ Haipatikani" },
    feels_short:      { en: "feels {temp}", sw: "inahisi {temp}" },
    load_place:       { en: "Load {name}", sw: "Fungua {name}" },
    click_to_load:    { en: "Click to load {name}", sw: "Gusa kufungua {name}" },
    this_location:    { en: "this location", sw: "mahali hapa" },
    remove_saved:     { en: "Remove from saved", sw: "Ondoa kwenye zilizohifadhiwa" },
    saved_location:   { en: "Saved location", sw: "Mahali palipohifadhiwa" },

    // --- global disasters ---
    catastrophe_title:    { en: "GLOBAL CATASTROPHE WATCH", sw: "MAJANGA DUNIANI" },
    catastrophe_subtitle: { en: "Active major disasters worldwide (last 30 days)", sw: "Majanga makubwa yanayoendelea duniani (siku 30 zilizopita)" },
    severity:         { en: "Severity:", sw: "Uzito:" },
    level_red:        { en: "Red", sw: "Nyekundu" },
    level_orange:     { en: "Orange", sw: "Machungwa" },
    level_green:      { en: "Green", sw: "Kijani" },
    emergency:        { en: "Emergency", sw: "Dharura" },
    warning:          { en: "Warning", sw: "Onyo" },
    advisory:         { en: "Advisory", sw: "Ushauri" },
    types:            { en: "Types:", sw: "Aina:" },
    dis_earthquake:   { en: "Earthquake", sw: "Tetemeko la ardhi" },
    dis_flood:        { en: "Flood", sw: "Mafuriko" },
    dis_cyclone:      { en: "Cyclone", sw: "Kimbunga" },
    dis_tropical_cyclone: { en: "Tropical Cyclone", sw: "Kimbunga cha kitropiki" },
    dis_volcano:      { en: "Volcano", sw: "Volkano" },
    dis_drought:      { en: "Drought", sw: "Ukame" },
    dis_wildfire:     { en: "Wildfire", sw: "Moto wa nyika" },
    dis_other:        { en: "Other", sw: "Mengineyo" },
    dis_disaster:     { en: "Disaster", sw: "Janga" },
    no_disasters:     { en: "✅ No major global disasters reported in the last 30 days", sw: "✅ Hakuna majanga makubwa yaliyoripotiwa katika siku 30 zilizopita" },
    disasters_failed: { en: "⚠️ Unable to load global alerts", sw: "⚠️ Imeshindikana kupakia tahadhari za dunia" },
    view_report:      { en: "View report →", sw: "Tazama ripoti →" },

    // --- globe panel ---
    our_planet:       { en: "OUR PLANET", sw: "SAYARI YETU" },
    globe_clouds:     { en: "☁️ Clouds", sw: "☁️ Mawingu" },
    globe_clouds_title: { en: "Toggle cloud layer", sw: "Onyesha/ficha mawingu" },
    globe_stars:      { en: "✨ Stars", sw: "✨ Nyota" },
    globe_stars_title:{ en: "Toggle stars", sw: "Onyesha/ficha nyota" },
    globe_rotate:     { en: "🔓 Auto-rotate", sw: "🔓 Zungusha" },
    globe_lock_title: { en: "Lock globe on searched city", sw: "Funga dunia kwenye mji uliotafutwa" },
    globe_loading:    { en: "Loading Earth view...", sw: "Inapakia picha ya dunia..." },
    search_a_location:{ en: "Search a location", sw: "Tafuta mahali" },
    coordinates:      { en: "🧭 Coordinates", sw: "🧭 Viwianishi" },
    local_time:       { en: "🕒 Local time", sw: "🕒 Saa ya huko" },
    timezone:         { en: "🌍 Timezone", sw: "🌍 Ukanda wa saa" },
    temperature:      { en: "🌡️ Temperature", sw: "🌡️ Halijoto" },
    condition:        { en: "🌤️ Condition", sw: "🌤️ Hali" },
    sunrise_row:      { en: "🌅 Sunrise", sw: "🌅 Macheo" },
    sunset_row:       { en: "🌇 Sunset", sw: "🌇 Machweo" },
    save_this_place:  { en: "♡ Save this place", sw: "♡ Hifadhi mahali hapa" },
    globe_locked:     { en: "🔒 Locked on city", sw: "🔒 Imefungwa kwenye mji" },
    globe_caption:    { en: "🕒 UTC {time}  •  Drag to rotate · Scroll/pinch to zoom · Click to load weather",
                        sw: "🕒 UTC {time}  •  Buruta kuzungusha · Sogeza/bana kukuza · Gusa kupata hali ya hewa" },
    globe_loading_at: { en: "📍 Loading weather at {lat}°, {lon}°", sw: "📍 Inapakia hali ya hewa ya {lat}°, {lon}°" },
    globe_point:      { en: "Point ({lat}, {lon})", sw: "Sehemu ({lat}, {lon})" },
    share_this_place: { en: "Share this place", sw: "Shiriki mahali hapa" },

    // --- share, QR ---
    share_title:      { en: "Share this weather", sw: "Shiriki hali hii ya hewa" },
    copy_text:        { en: "Copy text", sw: "Nakili maandishi" },
    more:             { en: "More…", sw: "Zaidi…" },
    qr_code:          { en: "QR Code", sw: "Msimbo wa QR" },
    cancel:           { en: "Cancel", sw: "Ghairi" },
    qr_title:         { en: "Scan to open 8X Weather", sw: "Changanua ili kufungua 8X Weather" },
    qr_sub:           { en: "Point your phone camera at this code to open the app", sw: "Elekeza kamera ya simu yako kwenye msimbo huu ili kufungua programu" },
    qr_hint_iphone:   { en: "📱 On iPhone: tap Share → Add to Home Screen", sw: "📱 Kwenye iPhone: gusa Share → Add to Home Screen" },
    qr_hint_android:  { en: "🤖 On Android: tap ⋮ → Install app", sw: "🤖 Kwenye Android: gusa ⋮ → Install app" },
    copy_link:        { en: "📋 Copy link", sw: "📋 Nakili kiungo" },
    qr_failed:        { en: "QR library failed to load", sw: "Imeshindikana kupakia QR" },
    share_feels:      { en: "Feels like {temp}", sw: "Inahisi kama {temp}" },
    share_humidity:   { en: "Humidity {pct}%", sw: "Unyevu {pct}%" },
    share_wind:       { en: "Wind {speed}", sw: "Upepo {speed}" },

    // --- toasts ---
    toast_updated:       { en: "✅ Weather updated", sw: "✅ Hali ya hewa imesasishwa" },
    toast_update_saved:  { en: "⚠️ Couldn't update — showing saved data", sw: "⚠️ Imeshindikana kusasisha — inaonyesha data iliyohifadhiwa" },
    toast_refresh_failed:{ en: "❌ Refresh failed", sw: "❌ Kusasisha kumeshindikana" },
    toast_link_copied:   { en: "✅ Link copied", sw: "✅ Kiungo kimenakiliwa" },
    toast_copy_failed:   { en: "❌ Copy failed", sw: "❌ Kunakili kumeshindikana" },
    toast_nothing_share: { en: "No weather data to share yet.", sw: "Bado hakuna hali ya hewa ya kushiriki." },
    toast_weather_copied:{ en: "✅ Weather copied to clipboard", sw: "✅ Hali ya hewa imenakiliwa" },
    toast_copied:        { en: "✅ Copied", sw: "✅ Imenakiliwa" },
    toast_write_more:    { en: "Please write a bit more (5+ chars)", sw: "Tafadhali andika zaidi kidogo (herufi 5 au zaidi)" },
    toast_thanks:        { en: "✅ Thank you for your feedback!", sw: "✅ Asante kwa maoni yako!" },
    toast_mic_denied:    { en: "🎤 Microphone access denied", sw: "🎤 Ruhusa ya maikrofoni imekataliwa" },
    toast_no_speech:     { en: "🎤 Didn't catch that — try again", sw: "🎤 Sikusikia vizuri — jaribu tena" },
    toast_no_mic:        { en: "🎤 No microphone found", sw: "🎤 Hakuna maikrofoni" },
    toast_voice_network: { en: "🎤 Network error — check connection", sw: "🎤 Hitilafu ya mtandao — angalia muunganisho" },
    toast_voice_failed:  { en: "🎤 Voice search failed", sw: "🎤 Kutafuta kwa sauti kumeshindikana" },
    toast_voice_lang:    { en: "🎤 Language: {lang}", sw: "🎤 Lugha: {lang}" },

    // --- feedback ---
    feedback_open:    { en: "Send feedback", sw: "Tuma maoni" },
    feedback_title:   { en: "Send Feedback", sw: "Tuma maoni" },
    feedback_sub:     { en: "Help us improve the app — what's on your mind?", sw: "Tusaidie kuboresha programu — una lipi akilini?" },
    fb_bug:           { en: "🐛 Bug", sw: "🐛 Hitilafu" },
    fb_general:       { en: "💬 General", sw: "💬 Jumla" },
    fb_feature:       { en: "💡 Feature", sw: "💡 Wazo jipya" },
    fb_message:       { en: "Tell us what happened, or what you'd like to see...", sw: "Tuambie kilichotokea, au ungependa kuona nini..." },
    fb_email:         { en: "Email (optional — for a reply)", sw: "Barua pepe (si lazima — ili tukujibu)" },
    fb_sending:       { en: "Sending...", sw: "Inatuma..." },

    // --- Mkuu helper ---
    mkuu_subtitle:    { en: "Weather helper", sw: "Msaidizi wa hali ya hewa" },
    mkuu_placeholder: { en: "Ask about the weather…", sw: "Uliza kuhusu hali ya hewa…" },
    mkuu_welcome:     { en: "Niaje! I am Mkuu. Ask me about the weather here: rain, what to wear, or the best time to go out.",
                        sw: "Niaje! Mimi ni Mkuu. Niulize kuhusu hali ya hewa hapa: mvua, uvae nini, au wakati bora wa kutoka." },
    mkuu_chips:       { en: "Will it rain today?|What should I wear?|Best time to go out this week?",
                        sw: "Je, mvua itanyesha leo?|Nivae nini?|Wakati gani bora wa kutoka wiki hii?" },
    mkuu_note:        { en: "Mkuu is an AI and can make mistakes. Please do not share personal details.",
                        sw: "Mkuu ni AI na anaweza kukosea. Tafadhali usishiriki taarifa zako binafsi." },
    mkuu_ask:         { en: "Ask Mkuu", sw: "Uliza Mkuu" },
    mkuu_new_chat:    { en: "Start a new chat", sw: "Anza mazungumzo mapya" },
    mkuu_message:     { en: "Your message to Mkuu", sw: "Ujumbe wako kwa Mkuu" },
    mkuu_send:        { en: "Send", sw: "Tuma" },
    mkuu_ask_alert:   { en: "Ask Mkuu (1 new alert)", sw: "Uliza Mkuu (tahadhari 1 mpya)" },
    mkuu_waking:      { en: "Mkuu is waking up, one moment…", sw: "Mkuu anaamka, subiri kidogo…" },
    mkuu_no_answer:   { en: "Mkuu could not answer that. Please try again.", sw: "Mkuu hakuweza kujibu hilo. Tafadhali jaribu tena." },
    mkuu_empty:       { en: "I got an empty reply. Please try again.", sw: "Nimepata jibu tupu. Tafadhali jaribu tena." },
    mkuu_offline:     { en: "I cannot reach Mkuu right now. Please check your internet and try again.",
                        sw: "Siwezi kumfikia Mkuu kwa sasa. Tafadhali angalia intaneti yako kisha ujaribu tena." },
    mkuu_err_429:     { en: "You are sending messages too fast. Please wait a minute.",
                        sw: "Unatuma ujumbe haraka mno. Tafadhali subiri dakika moja." },
    mkuu_err_503:     { en: "Mkuu has reached its limit for today. Please try again tomorrow.",
                        sw: "Mkuu amefikia kikomo chake cha leo. Tafadhali jaribu tena kesho." },
    mkuu_err_other:   { en: "Mkuu is having trouble right now. Please try again in a moment.",
                        sw: "Mkuu ana tatizo kwa sasa. Tafadhali jaribu tena baada ya muda mfupi." },
    mkuu_read_story:  { en: "Read full story", sw: "Soma hadithi yote" },
    mkuu_story:       { en: "Story", sw: "Hadithi" },
    mkuu_heads_up:    { en: "**Heads up:**", sw: "**Tahadhari:**" },
    mkuu_quake_line:  { en: "a magnitude {mag} earthquake, {place}", sw: "tetemeko la ardhi la ukubwa {mag}, {place}" },
    mkuu_ask_more:    { en: "Ask me if you want to know more.", sw: "Niulize ukitaka kujua zaidi." },
    mkuu_alert_for:   { en: "for {place}", sw: "kwa {place}" },
    mkuu_alert_plans: { en: "Ask me what this means for your plans.", sw: "Niulize hii inamaanisha nini kwa mipango yako." },

    // --- day and month names ---
    days:         { en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
                    sw: ["Jumapili", "Jumatatu", "Jumanne", "Jumatano", "Alhamisi", "Ijumaa", "Jumamosi"] },
    days_short:   { en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
                    sw: ["Jpi", "Jtt", "Jnn", "Jtn", "Alh", "Iju", "Jmo"] },
    months:       { en: ["January", "February", "March", "April", "May", "June",
                         "July", "August", "September", "October", "November", "December"],
                    sw: ["Januari", "Februari", "Machi", "Aprili", "Mei", "Juni",
                         "Julai", "Agosti", "Septemba", "Oktoba", "Novemba", "Desemba"] },
    months_short: { en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
                    sw: ["Jan", "Feb", "Mac", "Apr", "Mei", "Jun", "Jul", "Ago", "Sep", "Okt", "Nov", "Des"] }
};

// For Mkuu (an AI): put first in the page context it already sends.
const MKUU_LANGUAGE_NOTE = {
    en: "",
    sw: "The user chose Kiswahili. Always reply in simple, natural Kenyan Kiswahili. " +
        "(Mtumiaji amechagua Kiswahili: jibu kwa Kiswahili rahisi.)"
};

function detectLanguage() {
    try {
        const saved = storageGet(LANG_STORAGE_KEY);
        if (LANGS.includes(saved)) return saved;
    } catch { /* storage blocked */ }
    let nav = "";
    try { nav = String(navigator.language || "").toLowerCase(); } catch { nav = ""; }
    return nav.startsWith("sw") ? "sw" : "en";
}

let currentLang = detectLanguage();

/* The text for key in the current language (English if sw is missing). */
function t(key, params) {
    const entry = I18N[key];
    let s = entry ? (entry[currentLang] ?? entry.en) : key;
    if (typeof s === "string" && params) {
        s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined && params[k] !== null ? String(params[k]) : m));
    }
    return s;
}

/* The page's API calls carry ?lang= so the server answers in the same
   language (and browser / service-worker copies are per language). */
const LANG_API_PATHS = ["/weather", "/locations", "/uv", "/air", "/reverse",
                        "/my-location", "/local-alerts", "/global-alerts", "/feedback"];
function withLang(url) {
    if (typeof url !== "string" || !url.startsWith("/")) return url;
    const path = url.split("?")[0];
    if (!LANG_API_PATHS.some(p => path === p || path.startsWith(p + "-") || path.startsWith(p + "/"))) return url;
    if (/[?&]lang=/.test(url)) return url;
    return url + (url.includes("?") ? "&" : "?") + "lang=" + currentLang;
}

/* Template texts marked with data-i18n*. */
function applyStaticTranslations(root) {
    const scope = root || document;
    if (!scope || typeof scope.querySelectorAll !== "function") return;
    const set = (attr, fn) => {
        scope.querySelectorAll(`[${attr}]`).forEach(el => fn(el, el.getAttribute(attr)));
    };
    set("data-i18n", (el, key) => { el.textContent = t(key); });
    set("data-i18n-placeholder", (el, key) => { el.setAttribute("placeholder", t(key)); });
    set("data-i18n-title", (el, key) => { el.setAttribute("title", t(key)); });
    set("data-i18n-aria", (el, key) => { el.setAttribute("aria-label", t(key)); });
    set("data-i18n-day", (el, i) => { el.textContent = t("days_short")[Number(i)] || el.textContent; });
    try { document.documentElement.lang = currentLang; } catch { /* no DOM */ }
}

/* First texts of elements the page fills in later (city, buttons that change):
   set once at start only, so a language switch never overwrites live text. */
function applyInitialTexts() {
    if (typeof document === "undefined" || !document.querySelectorAll) return;
    document.querySelectorAll("[data-i18n-init]").forEach(el => {
        el.textContent = t(el.getAttribute("data-i18n-init"));
    });
}

function updateLanguageSwitch() {
    document.querySelectorAll("[data-lang-choice]").forEach(btn => {
        const on = btn.getAttribute("data-lang-choice") === currentLang;
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
}

function setLanguage(lang) {
    if (!LANGS.includes(lang) || lang === currentLang) return;
    currentLang = lang;
    try { storageSet(LANG_STORAGE_KEY, lang); } catch { /* storage blocked */ }
    applyStaticTranslations();
    updateLanguageSwitch();
    rerenderForLanguage();
    if (typeof mpTrack === "function") mpTrack("language_changed", { lang });
}

function setupLanguageSwitch() {
    document.querySelectorAll("[data-lang-choice]").forEach(btn => {
        btn.addEventListener("click", () => setLanguage(btn.getAttribute("data-lang-choice")));
    });
    updateLanguageSwitch();
}

/* Everything already on screen, again in the new language. */
function rerenderForLanguage() {
    applyTheme();
    updateDateTime();
    updateSaveButtonState();
    const locBtn = getElement("location-button");
    if (locBtn && !locBtn.disabled) locBtn.textContent = t("use_my_location");
    const fbBtn = getElement("feedback-submit");
    if (fbBtn && !fbBtn.disabled) fbBtn.textContent = t("feedback_title");
    const play = getElement("radar-play");
    if (play) play.textContent = radarPlayTimer ? t("radar_pause") : t("radar_play");

    if (window._currentWeatherData) displayWeather(window._currentWeatherData, { saved: true, rerender: true });
    if (window._lastForecastData) {
        renderHourlyForecast(window._lastForecastData);
        renderForecast(window._lastForecastData);
    }
    renderExtraTiles();
    if (lastDataStatus) showDataStatus(...lastDataStatus);

    // Server-made texts (e.g. the quake's place) come again in the new language.
    if (window._lastLocalAlerts) renderSafetyBanner(window._lastLocalAlerts);
    const loc = window._loadedLocation;
    if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
        lastAlertCheck = { key: "", time: 0 };
        checkLocationAlerts(loc.lat, loc.lon);
    }
    renderSavedLocations();
    renderCatastropheWatch();
    paintCalendar();
    if (window.EarthGlobe && typeof window.EarthGlobe.refreshLanguage === "function") {
        window.EarthGlobe.refreshLanguage();
    }
    updateMkuuLanguage();
    try { window.dispatchEvent(new Event("mkuu:context-changed")); } catch { /* old browser */ }
}

/* Mkuu: labels before the widget starts (called from the template, right
   after the widget's script tag), the language note in the context it sends
   with every message, and the one-time "heads up" in Kiswahili. */
let _mkuuWrapped = false;
function prepareMkuuLanguage(script) {
    try {
        if (script && script.setAttribute) {
            script.setAttribute("data-subtitle", t("mkuu_subtitle"));
            script.setAttribute("data-placeholder", t("mkuu_placeholder"));
            script.setAttribute("data-welcome", t("mkuu_welcome"));
            script.setAttribute("data-chips", t("mkuu_chips"));
        }
    } catch { /* keep the template's English */ }
    if (_mkuuWrapped) return;
    _mkuuWrapped = true;
    const baseContext = window.MkuuHelperContext;
    window.MkuuHelperContext = function () {
        const ctx = typeof baseContext === "function" ? String(baseContext() || "") : "";
        const note = MKUU_LANGUAGE_NOTE[currentLang] || "";
        return note ? (note + (ctx ? "\n" + ctx : "")) : ctx;
    };
    const baseNotice = window.MkuuHelperNotice;
    window.MkuuHelperNotice = function () {
        const n = typeof baseNotice === "function" ? baseNotice() : null;
        if (!n || currentLang === "en") return n;
        const text = mkuuNoticeText();
        return text ? { id: n.id, text } : n;       // same id: a notice seen once stays seen
    };
}

/* Texts for the Mkuu widget (mkuu-helper.js asks each time it shows one). For
   the error replies English returns null, so the widget keeps its own wording
   (which may include the Mkuu server's own explanation). */
const MKUU_TEXT_KEYS = {
    ask: "mkuu_ask", askAlert: "mkuu_ask_alert", newChat: "mkuu_new_chat", close: "close",
    message: "mkuu_message", send: "mkuu_send", note: "mkuu_note", welcome: "mkuu_welcome",
    chips: "mkuu_chips", waking: "mkuu_waking", noAnswer: "mkuu_no_answer", empty: "mkuu_empty",
    offline: "mkuu_offline", err429: "mkuu_err_429", err503: "mkuu_err_503",
    errOther: "mkuu_err_other", readStory: "mkuu_read_story", story: "mkuu_story"
};
window.MkuuHelperText = function (key) {
    const k = MKUU_TEXT_KEYS[key];
    if (!k) return null;
    if (currentLang === "en" && /^err/.test(key)) return null;
    return t(k);
};

/* The heads-up text, built from the alert data in the current language. */
function mkuuNoticeText() {
    const d = window._lastLocalAlerts || {};
    const alerts = Array.isArray(d.alerts) ? d.alerts : [];
    const quakes = Array.isArray(d.quakes) ? d.quakes : [];
    const w = window._currentWeatherData || {};
    const loc = w.searched_location || {};
    const place = [loc.name || w.name || "", loc.country || (w.sys && w.sys.country) || ""].filter(Boolean).join(", ");
    if (alerts.length) {
        const a = alerts[0];
        const where = place ? " " + t("mkuu_alert_for", { place }) : "";
        return `${t("mkuu_heads_up")} ${a.event || t("weather_alert")}${where}.` +
            (a.headline ? `\n${a.headline}` : "") + `\n${t("mkuu_alert_plans")}`;
    }
    if (quakes.length) {
        const q = quakes[0];
        const mag = Number(q.magnitude);
        const { text } = quakeBannerText(q);
        const rest = text.split(" · ").slice(1).join(", ");
        return `${t("mkuu_heads_up")} ${t("mkuu_quake_line", {
            mag: Number.isFinite(mag) ? mag.toFixed(1) : "?", place: q.place || t("nearby") })}` +
            (rest ? `, ${rest}` : "") + `.\n${t("mkuu_ask_more")}`;
    }
    return "";
}

/* The widget is already on screen: change its texts in place. */
function updateMkuuLanguage() {
    const script = document.querySelector("script[data-site='weather']");
    prepareMkuuLanguage(script);
    const rootEl = document.querySelector(".mkh-root");
    if (!rootEl) return;
    const q = sel => rootEl.querySelector(sel);
    const sub = q(".mkh-title small");
    if (sub) sub.textContent = t("mkuu_subtitle");
    const panel = q(".mkh-panel");
    if (panel) panel.setAttribute("aria-label", "Mkuu, " + t("mkuu_subtitle"));
    const input = q(".mkh-input");
    if (input) {
        input.placeholder = t("mkuu_placeholder");
        input.setAttribute("aria-label", t("mkuu_message"));
    }
    const note = q(".mkh-note");
    if (note) note.textContent = t("mkuu_note");
    const fab = q(".mkh-fab");
    if (fab) fab.setAttribute("aria-label", t("mkuu_ask"));
    const send = q(".mkh-send");
    if (send) send.setAttribute("aria-label", t("mkuu_send"));
    const buttons = rootEl.querySelectorAll(".mkh-head .mkh-iconbtn");
    if (buttons[0]) buttons[0].setAttribute("aria-label", t("mkuu_new_chat"));
    if (buttons[1]) buttons[1].setAttribute("aria-label", t("close"));

    // Only the welcome so far: show it in the new language.
    const log = q(".mkh-log");
    if (log && log.children.length === 1 && log.children[0].classList.contains("mkh-bot")) {
        log.children[0].textContent = t("mkuu_welcome");
    }
    // Suggestion chips: new labels that send the new text.
    const chips = q(".mkh-chips");
    const form = q(".mkh-form");
    if (chips && form && input) {
        chips.textContent = "";
        t("mkuu_chips").split("|").forEach(label => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "mkh-chipbtn";
            b.textContent = label;
            b.addEventListener("click", () => {
                input.value = label;
                if (typeof form.requestSubmit === "function") form.requestSubmit();
                else form.dispatchEvent(new Event("submit", { cancelable: true }));
            });
            chips.appendChild(b);
        });
    }
}

/* fn() with English texts (e.g. a search string saved for later). */
function inEnglish(fn) {
    const saved = currentLang;
    currentLang = "en";
    try { return fn(); } finally { currentLang = saved; }
}

/* Day / month names and short dates in the current language. */
function dayName(date, short = false) {
    return t(short ? "days_short" : "days")[date.getDay()];
}
function monthName(index, short = false) {
    return t(short ? "months_short" : "months")[index];
}

/* Placeholder names that were saved in one language, shown in the current one. */
function displayPlaceName(name) {
    const s = String(name || "");
    const acc = s.match(/^(?:Your Location|Mahali ulipo) \(±(\d+)m\)$/);
    if (acc) return t("your_location_acc", { m: acc[1] });
    if (s === "Your Location" || s === "Mahali ulipo") return t("your_location");
    if (s === "Approximate location" || s === "Mahali pa takriban") return t("approximate_place");
    const pt = s.match(/^(?:Point|Sehemu) \((-?[\d.]+), (-?[\d.]+)\)$/);
    if (pt) return t("globe_point", { lat: pt[1], lon: pt[2] });
    return s;
}

// Before anything is drawn: <html lang> and the template's texts.
applyStaticTranslations();
applyInitialTexts();


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
    return fetch(withLang(url), { ...options, signal: controller.signal });
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
    if (!Number.isFinite(ms) || ms <= 0) return t("earlier");
    const d = new Date(ms);
    const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (d.toDateString() === new Date().toDateString()) return time;
    return `${dayName(d, true)} ${d.getDate()} ${monthName(d.getMonth(), true)}, ${time}`;
}

let lastDataStatus = null;   // the bar's arguments, to redraw it in another language
const OLD_DATA_MS = 24 * 60 * 60 * 1000;   // saved longer ago than this: "may be wrong"
let pendingOnlineRetry = null;             // the Retry of the saved data on screen

/* "2 hours ago" (words, for the saved-data bar). */
function savedAgo(ms, now = Date.now()) {
    const mins = Math.floor((now - Number(ms)) / 60000);
    if (!Number.isFinite(mins) || mins < 1) return t("ago_now");
    if (mins < 60) return mins === 1 ? t("rel_min_1") : t("rel_min", { n: mins });
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) return hrs === 1 ? t("rel_h_1") : t("rel_h", { n: hrs });
    const days = Math.floor(hrs / 24);
    return days === 1 ? t("ago_day_1") : t("ago_days", { n: days });
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
    lastDataStatus = [savedTime, onRetry, { updating }];
    el.textContent = "";

    const known = savedTime !== null && Number.isFinite(savedTime) && savedTime > 0;
    const old = known && Date.now() - savedTime > OLD_DATA_MS;
    if (el.classList) el.classList.toggle("data-status-old", old);

    const text = document.createElement("span");
    if (savedTime === null) {
        text.textContent = t("status_failed");
    } else {
        text.textContent = t("status_saved", { time: formatSavedTime(savedTime) }) +
            (known ? " · " + t("saved_ago", { ago: savedAgo(savedTime) }) : "") +
            (updating ? t("status_updating") : "");
    }
    el.appendChild(text);

    if (old) {
        const warn = document.createElement("strong");
        warn.className = "data-status-warning";
        warn.textContent = "⚠️ " + t("old_data");
        el.appendChild(warn);
    }

    // Saved data on screen: a live load is tried again when the connection
    // comes back (once per "online" event, never on a timer).
    pendingOnlineRetry = onRetry || null;

    if (onRetry && !updating) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "data-status-retry";
        btn.textContent = t("retry");
        btn.addEventListener("click", () => {
            btn.disabled = true;
            btn.textContent = t("retrying");
            pendingOnlineRetry = null;
            onRetry();
        });
        el.appendChild(btn);
    }
    el.hidden = false;
}

/* Back online: one live load of what is on screen (Retry does the same). */
function onBackOnline() {
    const retry = pendingOnlineRetry;
    pendingOnlineRetry = null;
    if (typeof retry === "function") retry();
}
window.addEventListener("online", onBackOnline);

function clearDataStatus() {
    const el = getElement("data-status");
    lastDataStatus = null;
    pendingOnlineRetry = null;
    if (el) {
        el.hidden = true;
        el.textContent = "";
    }
}


/* =========================================================
   SAVED FORECASTS — the last live weather of up to 8 places, on the phone
   One list in localStorage, newest first:
     { key: "lat,lon" (2 decimals), lat, lon, name, state, country,
       search (English "City, Country", lower case), weather, forecast, time }
   - saved after every live load (never a reply that is itself saved data)
   - shown when a live load fails, with the "saved data" bar + Retry
   - storage full: drop the oldest place and try once more, then give up
   (Shown however old, with a note: age is no reason to hide it.)
========================================================= */
const SAVED_PLACES_KEY = "neckrone8x_saved_forecasts";
const SAVED_PLACES_MAX = 8;
// Before W-7b2 one copy (any place) was kept under these two keys.
const WEATHER_CACHE_KEY = "neckrone8x_weather_cache";
const FORECAST_CACHE_KEY = "neckrone8x_forecast_cache";

function placeKey(lat, lon) {
    const a = Number(lat), b = Number(lon);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return "";
    return `${a.toFixed(2)},${b.toFixed(2)}`;
}

function readSavedPlaces() {
    const list = storageJson(SAVED_PLACES_KEY, []);
    if (!Array.isArray(list)) return [];
    return list.filter(p => p && typeof p.key === "string" && p.weather && p.forecast &&
                            Number.isFinite(p.time));
}

function writeSavedPlaces(list) {
    if (storageSet(SAVED_PLACES_KEY, JSON.stringify(list))) return true;
    // Full (or blocked): drop the oldest place and try once more.
    if (list.length > 1 && storageSet(SAVED_PLACES_KEY, JSON.stringify(list.slice(0, -1)))) return true;
    return false;
}

/* Save a live weather + forecast pair for its place. Quietly does nothing
   when storage is full or blocked. Returns true when it was saved. */
function savePlaceForecast(weather, forecast, now = Date.now()) {
    const coord = weather && weather.coord;
    const key = placeKey(coord && coord.lat, coord && coord.lon);
    if (!key || !forecast) return false;
    const loc = weather.searched_location || {};
    const name = loc.name || weather.name || "";
    const state = loc.state || "";
    const country = loc.country || (weather.sys && weather.sys.country) || "";
    const entry = {
        key, lat: Number(coord.lat), lon: Number(coord.lon), name, state, country,
        search: inEnglish(() => formatLocation(name, state, country)).toLowerCase(),
        weather, forecast, time: now
    };
    // The old single copy is replaced by this list: free its space first.
    storageRemove(WEATHER_CACHE_KEY);
    storageRemove(FORECAST_CACHE_KEY);
    const list = [entry, ...readSavedPlaces().filter(p => p.key !== key)].slice(0, SAVED_PLACES_MAX);
    try {
        return writeSavedPlaces(list);
    } catch { return false; }
}

/* The saved copy for a place: by coordinates, else by the searched text. */
function findSavedPlace({ coords = null, search = "" } = {}) {
    const list = readSavedPlaces();
    if (coords) {
        const key = placeKey(coords.lat, coords.lon);
        const hit = key && list.find(p => p.key === key);
        if (hit) return hit;
    }
    const q = String(search || "").trim().toLowerCase();
    if (q) {
        return list.find(p => p.search === q) ||
               list.find(p => String(p.name || "").toLowerCase() === q) ||
               list.find(p => p.search && p.search.startsWith(q + ",")) || null;
    }
    return null;
}

/* The place viewed last (newest saved), or the pre-W-7b2 single copy. */
function latestSavedPlace() {
    const list = readSavedPlaces();
    if (list.length) return list[0];
    const w = storageJson(WEATHER_CACHE_KEY, null);
    const f = storageJson(FORECAST_CACHE_KEY, null);
    if (w && w.data && f && f.data) return { weather: w.data, forecast: f.data, time: Number(w.time) || 0 };
    return null;
}

/* Put a saved copy on screen with the "saved data" bar and Retry. */
function showSavedPlace(entry, retry) {
    showWeatherPair(entry.weather, entry.forecast, { saved: true });
    window._dataTime = entry.time;
    showDataStatus(entry.time, retry);
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
        return new Intl.DisplayNames([currentLang === "sw" ? "sw" : "en", "en"], { type: "region" }).of(countryCode);
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
function conditionKey(weatherId) {
    const id = Number(weatherId);
    if (id === 800) return "cond_sunny";
    if (id === 801) return "cond_partly_cloudy";
    if (id === 802) return "cond_scattered";
    if (id === 803) return "cond_broken";
    if (id === 804) return "cond_overcast";
    if (id >= 200 && id <= 232) return "cond_thunder";
    if (id >= 300 && id <= 321) return "cond_drizzle";
    if (id === 500 || id === 520) return "cond_light_rain";
    if (id === 502 || id === 503 || id === 504 || id === 522) return "cond_heavy_rain";
    if (id === 511) return "cond_freezing_rain";
    if (id >= 500 && id <= 531) return "cond_rain";
    if (id >= 611 && id <= 616) return "cond_sleet";
    if (id >= 600 && id <= 622) return "cond_snow";
    if (id === 711) return "cond_smoke";
    if (id === 731 || id === 751 || id === 761) return "cond_dust";
    if (id === 762) return "cond_ash";
    if (id === 771) return "cond_squall";
    if (id === 781) return "cond_tornado";
    if (id >= 701 && id <= 781) return "cond_fog";
    return "";
}

function getConditionText(weatherId, description = "") {
    const key = conditionKey(weatherId);
    if (key) return t(key);
    return description || t("cond_unknown");
}


/* =========================================================
   WIND DIRECTION TO COMPASS
========================================================= */
function degreesToCompass(deg) {
    if (!Number.isFinite(deg)) return "";
    return t("compass")[Math.round(deg / 22.5) % 16];
}


/* =========================================================
   FORMAT LOCATION
========================================================= */
function formatLocation(name, state, country) {
    let result = displayPlaceName(name) || t("unknown_location");

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
            btn.title = t("theme_auto");
        } else if (themeMode === "light") {
            btn.textContent = "☀️";
            btn.title = t("theme_light");
        } else {
            btn.textContent = "🌙";
            btn.title = t("theme_dark");
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

    storageSet("weatherTheme", themeMode);
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
    storageSet("weatherUnit", unitMode);
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

            showToast(ok ? t("toast_updated") : t("toast_update_saved"));
        } catch (err) {
            console.error("Refresh failed:", err);
            showToast(t("toast_refresh_failed"));
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
        dateElement.textContent = `${dayName(locationTime)}, ${locationTime.getDate()} ` +
            `${monthName(locationTime.getMonth())} ${locationTime.getFullYear()}`;
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
        return { icon: "👕", text: t("no_advice") };
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
        return { icon: "⛈️", text: t("wear_thunder") };
    }

    if (isSnowing) {
        return { icon: "🧥", text: t("wear_snow") };
    }

    if (isHeavyRain || (isAnyRain && !isLightRain)) {
        if (temp >= 25) {
            return { icon: "☔", text: t("wear_rain_hot") };
        } else if (temp >= 18) {
            return { icon: "🧥", text: t("wear_rain_mild") };
        } else {
            return { icon: "🧥", text: t("wear_rain_cold") };
        }
    }

    if (isLightRain) {
        if (temp >= 25) {
            return { icon: "☔", text: t("wear_light_hot") };
        } else if (temp >= 15) {
            return { icon: "☔", text: t("wear_light_mild") };
        } else {
            return { icon: "🧥", text: t("wear_light_cold") };
        }
    }

    if (rainSoon) {
        if (temp >= 25) {
            return { icon: "☔", text: t("wear_soon_hot") };
        } else if (temp >= 15) {
            return { icon: "☔", text: t("wear_soon_mild") };
        } else {
            return { icon: "🧥", text: t("wear_soon_cold") };
        }
    }

    if (temp >= 30) {
        return { icon: "🩳", text: t("wear_30") };
    }
    if (temp >= 25) {
        return { icon: "👕", text: t("wear_25") };
    }
    if (temp >= 20) {
        return { icon: "👕", text: t("wear_20") };
    }
    if (temp >= 15) {
        return { icon: "🧥", text: t("wear_15") };
    }
    if (temp >= 10) {
        return { icon: "🧥", text: t("wear_10") };
    }
    if (temp >= 5) {
        return { icon: "🧥", text: t("wear_5") };
    }
    return { icon: "🧣", text: t("wear_cold") };
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

    let report = t("report_now", { temp: `${formatTemp(temp)}${tempUnit()}`, cond: condition.toLowerCase() });

    if (Number.isFinite(feelsLike)) {
        const diff = feelsLike - temp;
        if (diff > 2) {
            report += t("report_warmer", { temp: `${formatTemp(feelsLike)}${tempUnit()}` });
        } else if (diff < -2) {
            report += t("report_cooler", { temp: `${formatTemp(feelsLike)}${tempUnit()}` });
        }
    }

    report += t("report_humidity", { pct: humidity });

    if (Number.isFinite(windSpeed)) {
        report += t("report_wind", { speed: `${formatSpeed(windSpeed)} ${speedUnit()}` });
        if (Number.isFinite(windDeg)) {
            report += t("report_wind_from", { dir: degreesToCompass(windDeg), deg: windDeg });
        }
        report += ".";
    } else {
        report += ".";
    }

    if (clouds > 0) {
        report += t("report_clouds", { pct: clouds });
    } else {
        report += t("report_clear");
    }

    if (Number.isFinite(visibility)) {
        const km = visibility / 1000;
        if (km < 5) {
            report += t("report_vis_low", { km: km.toFixed(1) });
        } else if (km > 15) {
            report += t("report_vis_high", { km: km.toFixed(0) });
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
        const list = JSON.parse(storageGet(DISMISSED_QUAKES_KEY) || "[]");
        return Array.isArray(list) ? list : [];
    } catch { return []; }
}

function dismissQuake(id) {
    if (!id) return;
    try {
        const list = loadDismissedQuakes().filter(x => x !== id);
        list.push(id);
        storageSet(DISMISSED_QUAKES_KEY, JSON.stringify(list.slice(-50)));
    } catch (e) { /* storage blocked: it just won't be remembered */ }
}

function formatAgo(ms) {
    const mins = Math.round((Date.now() - Number(ms)) / 60000);
    if (!Number.isFinite(mins) || mins < 0) return "";
    if (mins < 1) return t("ago_now");
    if (mins < 60) return mins === 1 ? t("ago_min_1") : t("ago_min", { n: mins });
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return hrs === 1 ? t("ago_h_1") : t("ago_h", { n: hrs });
    const days = Math.round(hrs / 24);
    return days === 1 ? t("ago_day_1") : t("ago_days", { n: days });
}

/* "M4.8 earthquake" + "46 km SE of Ikungi, Tanzania · 120 km from you · 10 km deep · 2 days ago" */
function quakeBannerText(q) {
    const mag = Number(q.magnitude);
    const parts = [q.place || t("nearby")];
    if (Number.isFinite(Number(q.distance_km)) && q.distance_km !== null) {
        parts.push(t("quake_from_you", { km: Math.round(Number(q.distance_km)) }));
    }
    if (q.depth !== null && q.depth !== undefined && Number.isFinite(Number(q.depth))) {
        parts.push(t("quake_depth", { km: Math.round(Number(q.depth)) }));
    }
    const ago = formatAgo(q.time);
    if (ago) parts.push(ago);
    return {
        title: t("quake_title", { mag: Number.isFinite(mag) ? mag.toFixed(1) : "?" }),
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
        titleEl.textContent = top.event || t("weather_alert");
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
   ANIMATED WEATHER CANVAS
   pickWeatherEffect() turns the real data (condition id, rain/snow mm per
   hour, wind, day/night) into an effect; effectParticleCount() decides how
   many particles this screen and phone can afford. Both are pure (no DOM),
   so they are easy to test; the drawing below only follows what they say.
   Hidden test switch: open the page with ?fx=<kind> (see WEATHER_FX_KINDS),
   e.g. ?fx=rain-heavy or ?fx=clear-night. No visible UI.
========================================================= */
const WEATHER_FX_KINDS = [
    "drizzle", "rain-light", "rain", "rain-heavy", "freezing-rain", "thunder",
    "snow-light", "snow", "snow-heavy", "sleet", "fog", "dust", "squall",
    "clear-day", "clear-night", "clouds", "clouds-night", "none"
];
// Intensity bands, mm per hour (OpenWeatherMap rain["1h"] / snow["1h"]).
const RAIN_MM_MODERATE = 2.5;
const RAIN_MM_HEAVY = 7.6;
const SNOW_MM_MODERATE = 1;
const SNOW_MM_HEAVY = 3;
// Particles for a 400 x 300 px weather card on a normal phone.
const FX_BASE_PARTICLES = {
    "drizzle": 35, "rain-light": 55, "rain": 95, "rain-heavy": 160,
    "freezing-rain": 90, "thunder": 170, "snow-light": 35, "snow": 60,
    "snow-heavy": 110, "sleet": 80, "squall": 90, "dust": 25
};
const FX_REFERENCE_AREA = 400 * 300;
const FX_MIN_PARTICLES = 6;
const FX_MAX_PARTICLES = 220;          // hard cap, whatever the screen or phone
const FX_LOW_BATTERY = 0.2;            // not charging and at or below 20%: fewer particles
const FX_CALM_FRAME_MS = 33;           // fog, haze, clouds, sun, stars: ~30 fps is plenty
const RAIN_LEVELS = ["rain-light", "rain", "rain-heavy"];
const SNOW_LEVELS = ["snow-light", "snow", "snow-heavy"];

function fxNumber(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function fxClamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

/* input: { id, rainMm, snowMm, windSpeed (m/s), windDeg (where it blows FROM),
            night, clouds (%) }
   -> { kind, night, windX (m/s across the screen, + = to the right),
        windSpeed, clouds } */
function pickWeatherEffect(input = {}) {
    const id = Number(input.id) || 0;
    const rainMm = fxNumber(input.rainMm);
    const snowMm = fxNumber(input.snowMm);
    const windSpeed = Math.max(0, fxNumber(input.windSpeed) ?? 0);
    const windDeg = fxNumber(input.windDeg);
    // Wind from the west (270°) pushes rain to the right.
    const windX = windDeg === null ? 0
        : Math.round(-Math.sin(windDeg * Math.PI / 180) * windSpeed * 100) / 100;
    const clouds = fxClamp(fxNumber(input.clouds) ?? 0, 0, 100);
    const night = !!input.night;

    const rainLevelFromMm = rainMm === null ? -1
        : rainMm >= RAIN_MM_HEAVY ? 2 : rainMm >= RAIN_MM_MODERATE ? 1 : 0;
    const snowLevelFromMm = snowMm === null ? -1
        : snowMm >= SNOW_MM_HEAVY ? 2 : snowMm >= SNOW_MM_MODERATE ? 1 : 0;

    let kind;
    if (id >= 200 && id <= 232) kind = "thunder";
    else if (id >= 300 && id <= 321) kind = "drizzle";
    else if (id === 511) kind = "freezing-rain";
    else if (id >= 500 && id <= 531) {
        const fromId = (id === 500 || id === 520) ? 0 : id === 501 ? 1 : 2;
        kind = RAIN_LEVELS[Math.max(fromId, rainLevelFromMm)];   // mm/h can only make it stronger
    }
    else if (id >= 611 && id <= 616) kind = "sleet";
    else if (id >= 600 && id <= 622) {
        const fromId = (id === 600 || id === 620) ? 0 : (id === 602 || id === 622) ? 2 : 1;
        kind = SNOW_LEVELS[Math.max(fromId, snowLevelFromMm)];
    }
    else if (id === 701 || id === 721 || id === 741) kind = "fog";
    else if ([711, 731, 751, 761, 762].includes(id)) kind = "dust";
    else if (id === 771 || id === 781) kind = "squall";
    else if (id === 800 || (id === 801 && clouds < 30)) kind = night ? "clear-night" : "clear-day";
    else if (id >= 801 && id <= 804) kind = "clouds";
    else kind = "none";

    return { kind, night, windX, windSpeed, clouds: kind === "clouds" ? Math.max(clouds, 20) : clouds };
}

/* How many particles to draw. env: { width, height, cores, memoryGb,
   lowPower, reducedMotion }. 0 for effects without particles. */
function effectParticleCount(kind, env = {}) {
    const base = FX_BASE_PARTICLES[kind] || 0;
    if (!base) return 0;
    const area = Math.max(0, Number(env.width) || 0) * Math.max(0, Number(env.height) || 0);
    const sizeScale = fxClamp(area / FX_REFERENCE_AREA, 0.5, 2);
    const cores = Number(env.cores) || 0;          // 0 = unknown: assume a normal phone
    const memory = Number(env.memoryGb) || 0;
    let device = 1;
    if ((cores && cores <= 2) || (memory && memory <= 1)) device = 0.5;
    else if ((cores && cores <= 4) || (memory && memory <= 2)) device = 0.75;
    if (env.lowPower) device *= 0.5;
    if (env.reducedMotion) device *= 0.5;
    return fxClamp(Math.round(base * sizeScale * device), FX_MIN_PARTICLES, FX_MAX_PARTICLES);
}

/* The effect the hidden ?fx= switch asks for, or null. */
function forcedWeatherEffect(search, real) {
    let fx = "";
    try { fx = String(new URLSearchParams(search || "").get("fx") || "").toLowerCase(); } catch { fx = ""; }
    if (!WEATHER_FX_KINDS.includes(fx)) return null;
    const base = real || pickWeatherEffect({});
    const night = fx.endsWith("-night");
    const kind = fx === "clouds-night" ? "clouds" : fx;
    return { ...base, kind, night, clouds: kind === "clouds" ? 70 : base.clouds,
             windX: base.windX || 3, windSpeed: base.windSpeed || 3 };
}

/* What pickWeatherEffect needs, from a /weather reply. */
function weatherEffectInput(data) {
    const w = (data && data.weather && data.weather[0]) || {};
    const per = (o) => {
        if (!o) return null;
        const h1 = fxNumber(o["1h"]);
        if (h1 !== null) return h1;
        const h3 = fxNumber(o["3h"]);
        return h3 === null ? null : h3 / 3;
    };
    let night = String(w.icon || "").endsWith("n");
    if (!w.icon && data && data.sys && data.sys.sunrise && data.sys.sunset) {
        const now = Date.now() / 1000;
        night = now < data.sys.sunrise || now >= data.sys.sunset;
    }
    return {
        id: w.id, rainMm: per(data && data.rain), snowMm: per(data && data.snow),
        windSpeed: data && data.wind && data.wind.speed, windDeg: data && data.wind && data.wind.deg,
        clouds: data && data.clouds && data.clouds.all, night
    };
}

/* Particle look and motion per effect. speed = px per 60 fps frame. */
const FX_STYLES = {
    "drizzle":       { drop: "rain", len: [4, 7], speed: [2.6, 3.6], width: 0.8, alpha: 0.55, color: "#cfe8fb" },
    "rain-light":    { drop: "rain", len: [7, 11], speed: [4, 5.5], width: 1.1, alpha: 0.75, color: "#bae6fd" },
    "rain":          { drop: "rain", len: [9, 15], speed: [5, 7.5], width: 1.3, alpha: 0.85, color: "#bae6fd" },
    "rain-heavy":    { drop: "rain", len: [13, 24], speed: [7, 10.5], width: 1.5, alpha: 0.9, color: "#bfdbfe" },
    "thunder":       { drop: "rain", len: [13, 24], speed: [7, 10.5], width: 1.5, alpha: 0.9, color: "#c7d2fe" },
    "freezing-rain": { drop: "rain", len: [5, 9], speed: [5, 7], width: 1.3, alpha: 0.9, color: "#f0f9ff" },
    "squall":        { drop: "streak", len: [28, 55], speed: [9, 14], width: 1, alpha: 0.5, color: "#e2e8f0" },
    "snow-light":    { drop: "snow", r: [1.2, 2.4], speed: [0.5, 1.1], alpha: 0.85, color: "#ffffff" },
    "snow":          { drop: "snow", r: [1.5, 3], speed: [0.7, 1.4], alpha: 0.9, color: "#ffffff" },
    "snow-heavy":    { drop: "snow", r: [1.8, 3.8], speed: [0.9, 1.8], alpha: 0.95, color: "#ffffff" },
    "sleet":         { drop: "sleet", len: [6, 10], r: [1.3, 2.4], speed: [3, 5], width: 1.1, alpha: 0.85, color: "#e0f2fe" },
    "dust":          { drop: "speck", r: [0.7, 1.5], speed: [0.15, 0.4], alpha: 0.6, color: "#d6b98c" }
};
const FX_LAYERS = [                    // far, middle, near: depth without extra cost
    { alpha: 0.45, width: 0.7, speed: 0.7 },
    { alpha: 0.7, width: 1, speed: 1 },
    { alpha: 1, width: 1.3, speed: 1.25 }
];
const FX_HERO_CLASS = {
    "thunder": "weather-thunder", "drizzle": "weather-rain", "rain-light": "weather-rain",
    "rain": "weather-rain", "rain-heavy": "weather-rain", "freezing-rain": "weather-rain",
    "squall": "weather-rain", "snow-light": "weather-snow", "snow": "weather-snow",
    "snow-heavy": "weather-snow", "sleet": "weather-snow", "fog": "weather-fog",
    "dust": "weather-dust", "clear-day": "weather-sunny", "clear-night": "weather-sunny",
    "clouds": "weather-cloudy", "none": "weather-cloudy"
};

let weatherCanvas = null;
let weatherCtx = null;
let weatherParticles = [];
let weatherAnimFrame = null;
let weatherParticleType = null;        // the running effect's kind (null = nothing drawn)
let weatherEffect = null;              // the running effect
let weatherFxGen = 0;                  // bumps on every start/stop, so an old loop stops itself
let weatherFxLastT = 0;
let weatherFxLastDraw = 0;
let fxLowPower = false;

function fxRandom(range) {
    return range[0] + Math.random() * (range[1] - range[0]);
}

function fxReducedMotion() {
    try {
        return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch { return false; }
}

function fxEnvironment(width, height) {
    let cores = 0, memoryGb = 0;
    try { cores = Number(navigator.hardwareConcurrency) || 0; } catch {}
    try { memoryGb = Number(navigator.deviceMemory) || 0; } catch {}
    return { width, height, cores, memoryGb, lowPower: fxLowPower, reducedMotion: fxReducedMotion() };
}

/* Battery saver isn't exposed to pages; "low and not charging" (or Data
   Saver) is the closest sign. Checked once, then on battery changes. */
function watchPowerState() {
    try {
        if (navigator.connection && navigator.connection.saveData) fxLowPower = true;
    } catch {}
    try {
        if (typeof navigator.getBattery !== "function") return;
        navigator.getBattery().then(battery => {
            const update = () => {
                const low = !battery.charging && battery.level <= FX_LOW_BATTERY;
                const saveData = !!(navigator.connection && navigator.connection.saveData);
                const next = low || saveData;
                if (next !== fxLowPower) {
                    fxLowPower = next;
                    if (weatherEffect) startWeatherCanvas(weatherEffect);   // rebuild with the new count
                }
            };
            update();
            battery.addEventListener("levelchange", update);
            battery.addEventListener("chargingchange", update);
        }).catch(() => {});
    } catch {}
}

function stopWeatherCanvas() {
    weatherFxGen++;
    if (weatherAnimFrame) {
        cancelAnimationFrame(weatherAnimFrame);
        weatherAnimFrame = null;
    }
    if (weatherCtx && weatherCanvas) {
        weatherCtx.clearRect(0, 0, weatherCanvas.width, weatherCanvas.height);
    }
    weatherParticles = [];
    weatherParticleType = null;
    weatherEffect = null;
}

function makeParticle(style, effect, w, h, anywhere) {
    const layer = Math.floor(Math.random() * FX_LAYERS.length);
    const L = FX_LAYERS[layer];
    const drop = style.drop === "sleet" ? (Math.random() < 0.5 ? "rain" : "snow") : style.drop;
    const p = {
        layer, drop,
        x: Math.random() * w,
        y: anywhere ? Math.random() * h : -20 - Math.random() * 30,
        vy: fxRandom(style.speed) * L.speed * (1 + Math.min(effect.windSpeed, 20) / 40),
        len: style.len ? fxRandom(style.len) * (drop === "snow" ? 0 : 1) : 0,
        r: style.r ? fxRandom(style.r) * (0.7 + layer * 0.2) : 0,
        wobble: Math.random() * Math.PI * 2,
        wobbleSpeed: 0.02 + Math.random() * 0.03
    };
    if (drop === "snow") p.vy *= 0.6;                     // sleet flakes fall slower than its drops
    return p;
}

/* Sideways movement per px of fall, from the wind across the screen. */
function fxSlant(effect, drop) {
    const wx = effect.windX;
    if (drop === "streak") {
        const dir = wx < 0 ? -1 : 1;
        return dir * fxClamp(0.9 + Math.abs(wx) / 15, 0.9, 2);
    }
    if (drop === "rain") return wx === 0 ? 0.08 : fxClamp(wx / 10, -0.7, 0.7);
    return 0;   // snow / specks drift instead (see fxDrift)
}

function fxDrift(effect, drop) {
    if (drop === "snow") return fxClamp(effect.windX * 0.25, -3, 3);
    if (drop === "speck") return fxClamp(effect.windX * 0.35, -4, 4) || 0.3;
    return 0;
}

function startWeatherCanvas(effect) {
    stopWeatherCanvas();
    if (!effect || effect.kind === "none") return;
    weatherCanvas = document.getElementById("weather-canvas");
    if (!weatherCanvas || !weatherCanvas.parentElement) return;

    const rect = weatherCanvas.parentElement.getBoundingClientRect();
    weatherCanvas.width = Math.round(rect.width);
    weatherCanvas.height = Math.round(rect.height);
    weatherCtx = weatherCanvas.getContext("2d");
    if (!weatherCtx) return;

    const gen = weatherFxGen;
    weatherEffect = effect;
    weatherParticleType = effect.kind;
    const w = weatherCanvas.width, h = weatherCanvas.height;
    const env = fxEnvironment(w, h);
    const style = FX_STYLES[effect.kind];
    const count = effectParticleCount(effect.kind, env);
    weatherParticles = [];
    for (let i = 0; i < count && style; i++) weatherParticles.push(makeParticle(style, effect, w, h, true));

    _lightning.nextStrike = 0;           // first flash a few seconds after the storm appears
    _lightning.active = false;
    weatherFxLastT = 0;
    weatherFxLastDraw = 0;

    if (env.reducedMotion) {             // a still, calm picture: one frame, no lightning
        drawWeatherFrame(effect, style, 1, 0, true);
        return;
    }

    const calm = !style || style.drop === "speck";
    function loop(t) {
        if (gen !== weatherFxGen) return;                 // a newer effect took over
        if (document.visibilityState === "hidden") {      // paused; resumes on visibilitychange
            weatherAnimFrame = null;
            return;
        }
        weatherAnimFrame = requestAnimationFrame(loop);
        if (calm && weatherFxLastDraw && t - weatherFxLastDraw < FX_CALM_FRAME_MS) return;
        const dt = weatherFxLastT ? fxClamp(t - weatherFxLastT, 0, 50) : 16.7;
        weatherFxLastT = t;
        weatherFxLastDraw = t;
        drawWeatherFrame(effect, style, dt / 16.7, t, false);
    }
    weatherAnimFrame = requestAnimationFrame(loop);
}

function resumeWeatherCanvas() {
    if (!weatherEffect || weatherAnimFrame || fxReducedMotion()) return;
    startWeatherCanvas(weatherEffect);
}

/* One frame. f = elapsed time in 60 fps frames (1 = 16.7 ms). */
function drawWeatherFrame(effect, style, f, t, still) {
    const ctx = weatherCtx;
    if (!ctx || !weatherCanvas) return;
    const w = weatherCanvas.width, h = weatherCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = 1;

    const kind = effect.kind;
    if (kind === "clear-day") drawSunGlow(ctx, w, h, t);
    if (kind === "clear-night") drawStarField(ctx, w, h, t);
    if (kind === "clouds") drawCloudLayer(ctx, w, h, t, effect);
    if (kind === "fog") drawFogLayer(ctx, w, h, t);
    if (kind === "dust") drawFogLayer(ctx, w, h, t, "214, 185, 140");
    if (kind === "thunder" && !still) drawLightning(ctx, w, h, t || performance.now());

    if (style && weatherParticles.length) {
        drawParticles(ctx, style, effect, w, h, f, still);
    }
    ctx.globalAlpha = 1;
}

/* Particles are drawn one layer at a time as ONE path each (a single
   stroke/fill call per layer), which keeps cheap phones smooth. */
function drawParticles(ctx, style, effect, w, h, f, still) {
    const lineSlant = {
        rain: fxSlant(effect, "rain"),
        streak: fxSlant(effect, "streak")
    };
    ctx.strokeStyle = style.color;
    ctx.fillStyle = style.color;
    ctx.lineCap = "round";

    for (let layer = 0; layer < FX_LAYERS.length; layer++) {
        const L = FX_LAYERS[layer];
        ctx.globalAlpha = style.alpha * L.alpha;

        // Lines: rain, drizzle, freezing rain, squall streaks, sleet drops
        ctx.lineWidth = (style.width || 1) * L.width;
        ctx.beginPath();
        let lines = 0;
        for (const p of weatherParticles) {
            if (p.layer !== layer || (p.drop !== "rain" && p.drop !== "streak")) continue;
            const s = lineSlant[p.drop];
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x + p.len * s, p.y + p.len);
            lines++;
        }
        if (lines) ctx.stroke();

        // Dots: snow flakes, sleet flakes, dust specks
        ctx.beginPath();
        let dots = 0;
        for (const p of weatherParticles) {
            if (p.layer !== layer || (p.drop !== "snow" && p.drop !== "speck")) continue;
            ctx.moveTo(p.x + p.r, p.y);
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            dots++;
        }
        if (dots) ctx.fill();
    }

    if (still) return;
    for (const p of weatherParticles) {
        if (p.drop === "rain" || p.drop === "streak") {
            const dy = p.vy * f;
            p.y += dy;
            p.x += dy * lineSlant[p.drop];
        } else {
            p.wobble += p.wobbleSpeed * f;
            p.y += p.vy * f;
            p.x += (fxDrift(effect, p.drop) + Math.sin(p.wobble) * 0.4) * f;
        }
        if (p.y > h + 30) {
            p.y = -20 - Math.random() * 20;
            p.x = Math.random() * w;
        }
        if (p.x < -40) p.x += w + 80;
        else if (p.x > w + 40) p.x -= w + 80;
    }
}

/* Clear day: a soft warm glow in the top corner, breathing slowly. */
function drawSunGlow(ctx, w, h, t) {
    const cx = w * 0.85, cy = h * 0.12;
    const r = Math.max(w, h) * (0.55 + 0.03 * Math.sin((t || 0) * 0.0008));
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, "rgba(255, 230, 150, 0.45)");
    g.addColorStop(0.35, "rgba(255, 200, 90, 0.16)");
    g.addColorStop(1, "rgba(255, 180, 60, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
}

/* Clouds: one soft cloud picture made once, then copied (cheap), drifting
   at a speed from the wind. More cloud cover = more clouds. */
let _cloudSprite = null;
let _cloudSpriteNight = null;
let _clouds = null;
let _cloudsKey = "";

function makeCloudSprite(night) {
    try {
        const c = document.createElement("canvas");
        c.width = 220; c.height = 110;
        const g = c.getContext && c.getContext("2d");
        if (!g) return null;
        const tone = night ? "150, 160, 180" : "255, 255, 255";
        [[70, 65, 45], [115, 50, 55], [160, 68, 42], [110, 75, 50]].forEach(([x, y, r]) => {
            const grad = g.createRadialGradient(x, y, 0, x, y, r);
            grad.addColorStop(0, `rgba(${tone}, 0.55)`);
            grad.addColorStop(0.6, `rgba(${tone}, 0.25)`);
            grad.addColorStop(1, `rgba(${tone}, 0)`);
            g.fillStyle = grad;
            g.beginPath();
            g.arc(x, y, r, 0, Math.PI * 2);
            g.fill();
        });
        return c;
    } catch { return null; }
}

function drawCloudLayer(ctx, w, h, t, effect) {
    const night = !!effect.night;
    const sprite = night ? (_cloudSpriteNight ||= makeCloudSprite(true))
                         : (_cloudSprite ||= makeCloudSprite(false));
    if (!sprite) return;
    const count = 2 + Math.round((effect.clouds / 100) * 4);         // 2..6
    const key = `${w}x${h}x${count}`;
    if (!_clouds || _cloudsKey !== key) {
        _cloudsKey = key;
        _clouds = [];
        for (let i = 0; i < count; i++) {
            _clouds.push({ x: Math.random() * w, y: h * (0.02 + Math.random() * 0.45),
                           scale: 0.7 + Math.random() * 0.8, alpha: 0.5 + Math.random() * 0.4,
                           speed: 0.6 + Math.random() * 0.8 });
        }
    }
    // px per second: a breeze barely moves them, a strong wind pushes them along.
    const wind = effect.windX || effect.windSpeed || 1;
    const pxPerSec = fxClamp(4 + Math.abs(wind) * 2.5, 4, 45) * (wind < 0 ? -1 : 1);
    const span = w + 260;
    for (const c of _clouds) {
        const x = (((c.x + (t / 1000) * pxPerSec * c.speed) % span) + span) % span - 220;
        ctx.globalAlpha = c.alpha;
        ctx.drawImage(sprite, x, c.y, 220 * c.scale, 110 * c.scale);
    }
    ctx.globalAlpha = 1;
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

/* tint: "r, g, b" of the haze (default cool fog; dust/sand/smoke pass a warm one). */
function drawFogLayer(ctx, w, h, t, tint) {
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
        if (tint) {
            grad.addColorStop(0,    `rgba(${tint}, ${b.alpha * 1.3})`);
            grad.addColorStop(0.55, `rgba(${tint}, ${b.alpha * 0.6})`);
            grad.addColorStop(1,    `rgba(${tint}, 0)`);
        } else {
            grad.addColorStop(0,    `rgba(235, 240, 250, ${b.alpha})`);
            grad.addColorStop(0.55, `rgba(220, 228, 242, ${b.alpha * 0.5})`);
            grad.addColorStop(1,    "rgba(210, 220, 240, 0)");
        }

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

// Resize / rotate: rebuild the running effect for the new size (once it settles).
let _fxResizeTimer = null;
window.addEventListener("resize", () => {
    if (!weatherEffect) return;
    clearTimeout(_fxResizeTimer);
    _fxResizeTimer = setTimeout(() => { if (weatherEffect) startWeatherCanvas(weatherEffect); }, 250);
});

// Hidden tab: the loop stops itself; it starts again when the tab is back.
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
        if (weatherAnimFrame) cancelAnimationFrame(weatherAnimFrame);
        weatherAnimFrame = null;
    } else {
        resumeWeatherCanvas();
    }
});
watchPowerState();


/* =========================================================
   WEATHER BACKGROUND FOR HERO CARD
========================================================= */
let _fxStartTimer = null;
function applyWeatherBackground(data) {
    const hero = document.querySelector(".cw-hero");
    if (!hero) return;

    stopWeatherCanvas();
    clearTimeout(_fxStartTimer);

    hero.classList.remove(...new Set(Object.values(FX_HERO_CLASS)));

    const real = pickWeatherEffect(weatherEffectInput(data));
    let search = "";
    try { search = window.location.search || ""; } catch {}
    const effect = forcedWeatherEffect(search, real) || real;

    hero.classList.add(FX_HERO_CLASS[effect.kind] || "weather-cloudy");
    if (effect.kind !== "none") {
        // Let the card finish laying out first, so the canvas gets its real size.
        _fxStartTimer = setTimeout(() => startWeatherCanvas(effect), 50);
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
        if (errorMessage) errorMessage.textContent = t("city_not_found");
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
    const cityName = searchedLocation.name || data.name || "";
    const stateName = searchedLocation.state || "";
    const countryCode = searchedLocation.country || sys.country || "";
    const locationText = formatLocation(cityName, stateName, countryCode);

    const timezone = Number(data.timezone || 0);
    selectedTimezoneOffset = timezone;
    updateTheme(sys.sunrise, sys.sunset, timezone);
    updateDateTime();

    applyWeatherBackground(data);

    const cityElement = getElement("city");
    if (cityElement) cityElement.textContent = locationText;

    try {
        // A search text for later: always English (the geocoder's language).
        storageSet("weatherLastCity", inEnglish(() => formatLocation(cityName, stateName, countryCode)));
        if (data.coord && Number.isFinite(data.coord.lat) && Number.isFinite(data.coord.lon)) {
            storageSet("weatherLastCoords", JSON.stringify({
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
            cloudsLabel = t("clouds_shower", { pct: clouds });
        }
        cloudsElement.textContent = cloudsLabel;
        cloudsElement.title = t("clouds_title");
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
    if (phase < 0.0625)      { name = t("moon_new");             emoji = "🌑"; }
    else if (phase < 0.1875) { name = t("moon_waxing_crescent"); emoji = "🌒"; }
    else if (phase < 0.3125) { name = t("moon_first_quarter");   emoji = "🌓"; }
    else if (phase < 0.4375) { name = t("moon_waxing_gibbous");  emoji = "🌔"; }
    else if (phase < 0.5625) { name = t("moon_full");            emoji = "🌕"; }
    else if (phase < 0.6875) { name = t("moon_waning_gibbous");  emoji = "🌖"; }
    else if (phase < 0.8125) { name = t("moon_last_quarter");    emoji = "🌗"; }
    else if (phase < 0.9375) { name = t("moon_waning_crescent"); emoji = "🌘"; }
    else                     { name = t("moon_new");             emoji = "🌑"; }

    return { phase, illumination, name, emoji };
}

function renderMoonCard() {
    const el = getElement("moon-phase");
    if (!el) return;

    const moon = getMoonPhase();
    const pct = Math.round(moon.illumination * 100);
    el.textContent = `${moon.emoji} ${pct}%`;
    el.title = t("moon_title", { name: moon.name, pct });
}


/* =========================================================
   SUNRISE / SUNSET COUNTDOWN
========================================================= */
function formatCountdown(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "--";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return t("countdown_hm", { h, m });
    return t("countdown_m", { m });
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
        valueEl.title = t("until_sunrise");
        if (labelEl) labelEl.textContent = t("sunrise_in");
    } else if (now < sunset) {
        const secs = sunset - now;
        valueEl.textContent = formatCountdown(secs);
        valueEl.title = t("until_sunset");
        if (labelEl) labelEl.textContent = t("sunset_in");
    } else {
        const tomorrowSunrise = sunrise + 86400;
        const secs = tomorrowSunrise - now;
        valueEl.textContent = formatCountdown(secs);
        valueEl.title = t("until_tomorrow_sunrise");
        if (labelEl) labelEl.textContent = t("sunrise_in");
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

function uvLabel(val) {
    if (val <= 2) return t("uv_low");
    if (val <= 5) return t("uv_moderate");
    if (val <= 7) return t("uv_high");
    if (val <= 10) return t("uv_very_high");
    return t("uv_extreme");
}

function aqiLabel(aqi) {
    return I18N[`aqi_${aqi}`] ? t(`aqi_${aqi}`) : t("unknown");
}

let lastUvValue = null;    // shown numbers, so a language switch can relabel them
let lastAqiValue = null;

/* UV and air tiles from the last numbers (labels in the current language). */
function renderExtraTiles() {
    if (lastUvValue !== null) setUvTile(`${lastUvValue} (${uvLabel(lastUvValue)})`);
    const el = getElement("air-quality");
    if (el && lastAqiValue !== null) el.textContent = `${lastAqiValue} (${aqiLabel(lastAqiValue)})`;
}

function fetchExtraData(lat, lon) {
    fetchWithTimeout(`/uv?lat=${lat}&lon=${lon}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            if (data && Number.isFinite(Number(data.value)) && data.value !== null) {
                lastUvValue = Math.round(Number(data.value));
                renderExtraTiles();
            } else {
                lastUvValue = null;
                setUvTile(null);
            }
        })
        .catch(() => { lastUvValue = null; setUvTile(null); });

    fetchWithTimeout(`/air?lat=${lat}&lon=${lon}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            const el = getElement("air-quality");
            if (!el) return;
            if (data && data.aqi) {
                lastAqiValue = data.aqi;
                renderExtraTiles();
            } else {
                lastAqiValue = null;
                el.textContent = "--";
            }
        })
        .catch(() => {
            lastAqiValue = null;
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
        container.textContent = t("hourly_unavailable");
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
            <div class="hourly-time">${escapeHtml(t("now"))}</div>
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
function uvLevelClass(uv) {
    if (uv <= 2) return "uv-low";
    if (uv <= 5) return "uv-moderate";
    if (uv <= 7) return "uv-high";
    if (uv <= 10) return "uv-very-high";
    return "uv-extreme";
}

/* Sunrise, sunset (the place's local time) and max UV for one day of the
   daily outlook. Each part is left out when missing; "" when all are. */
function forecastDayExtraHtml(daily) {
    if (!daily) return "";
    const hhmm = v => (typeof v === "string" && /^\d\d:\d\d$/.test(v) ? v : "");
    const rise = hhmm(daily.sunrise);
    const set = hhmm(daily.sunset);
    const uv = daily.uv_max === null || daily.uv_max === undefined ? NaN : Number(daily.uv_max);
    const parts = [];
    if (rise || set) {
        parts.push(`<div class="forecast-sun">` +
            (rise ? `<span title="${escapeHtml(t("sunrise_word"))}">🌅 ${rise}</span>` : "") +
            (rise && set ? " · " : "") +
            (set ? `<span title="${escapeHtml(t("sunset_word"))}">🌇 ${set}</span>` : "") + `</div>`);
    }
    if (Number.isFinite(uv)) {
        const val = Math.round(uv);
        parts.push(`<div class="forecast-uv ${uvLevelClass(val)}" title="${escapeHtml(t("uv_max_title"))}">UV ${val}</div>`);
    }
    return parts.length ? `<div class="forecast-extra">${parts.join("")}</div>` : "";
}
function renderForecast(data) {
    const container = getElement("forecast");
    if (!container) return;

    if (!data || (data.cod !== 200 && data.cod !== "200") || !Array.isArray(data.list) || data.list.length === 0) {
        container.textContent = t("forecast_unavailable");
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
        const day = dayName(date, true);
        const forecastDate = `${date.getDate()} ${monthName(date.getMonth(), true)}`;

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
            ${forecastDayExtraHtml(daily)}
        `;
        container.appendChild(card);
    });

    if (container.children.length === 0) {
        container.textContent = t("forecast_unavailable");
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

    label.textContent = `${monthName(month)} ${year}`;

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
// Messages: t("weather_unavailable"), t("search_unavailable"), and for a
// 429: the server's per-address limit (many phones can share one address).
// t("rate_limited") / t("rate_limited_search").

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
    if (cityElement) cityElement.textContent = t("loading");
    if (conditionElement) conditionElement.textContent = message;
    if (temperatureElement) temperatureElement.textContent = `--${tempUnit()}`;
    if (forecastLocation) forecastLocation.textContent = t("loading");
    setLoadingState();
    window._currentWeatherData = null;
}

/* place: { coords, search } of the load that failed, to find its saved copy. */
function showSavedWeatherFallback(retry, failMessage, place = null) {
    // Still showing weather (a refresh failed): keep it on screen.
    if (window._currentWeatherData) {
        showDataStatus(window._dataTime, retry);
        return;
    }
    // This place was saved before: show its last forecast at once.
    const own = place ? findSavedPlace(place) : null;
    if (own) {
        showSavedPlace(own, retry);
        return;
    }
    // Screen was cleared for a new place: bring back the last saved weather.
    const last = latestSavedPlace();
    if (last) {
        showSavedPlace(last, retry);
        const errorMessage = getElement("error-message");
        if (errorMessage) errorMessage.textContent = failMessage;
        return;
    }
    // Nothing saved at all.
    const cityElement = getElement("city");
    const conditionElement = getElement("condition");
    const forecastLocation = getElement("forecast-location");
    const errorMessage = getElement("error-message");
    if (cityElement) cityElement.textContent = t("weather_unavailable_title");
    if (conditionElement) conditionElement.textContent = failMessage;
    if (forecastLocation) forecastLocation.textContent = "";
    if (errorMessage) errorMessage.textContent = failMessage;
    ["hourly-forecast", "forecast"].forEach(id => {
        const el = getElement(id);
        if (el) el.textContent = t("forecast_unavailable");
    });
    showDataStatus(null, retry);
}

/* url: the /weather-full URL.  retry: re-runs this same load.
   adjust(weather, forecast): optional, may return a promise.
   keepCurrent: leave the weather on screen while loading. */
function loadWeatherFull(url, { retry, adjust, keepCurrent = false, coords = null, search = "",
                                loadingMessage = t("loading_weather"),
                                failMessage = t("load_failed") } = {}) {
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
            savePlaceForecast(payload.weather, payload.forecast);
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
            const message = status === 429 ? t("rate_limited")
                : status === 503 ? t("weather_unavailable") : failMessage;
            // No live data (offline, timeout, 5xx, or 429): this place's saved
            // forecast. A 4xx such as "city not found" is an answer, not an outage.
            const outage = !status || status >= 500 || status === 429;
            showSavedWeatherFallback(retry, message, outage ? { coords, search } : null);
            // With weather still on screen the bar only says "saved data";
            // a 429 also says why, so the user knows to wait before Retry.
            if (status === 429 && errorMessage) errorMessage.textContent = t("rate_limited");
            return false;
        });
}


function getWeather(city, opts = {}) {
    city = String(city || "").trim();
    if (!city) return Promise.resolve(false);

    return loadWeatherFull(`/weather-full?city=${encodeURIComponent(city)}`, {
        keepCurrent: !!opts.keepCurrent,
        search: city,
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
        if (errorMessage) errorMessage.textContent = t("invalid_coords");
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
                showSearchProblem(city, t("rate_limited_search"));
                return;
            }
            if (status === 503 || data.error === "weather_unavailable") {
                showSearchProblem(city, t("search_unavailable"));
                return;
            }
            if (status === 404 || data.cod === 404 || data.cod === "404") {
                if (errorMessage) errorMessage.textContent = t("city_not_found");
                resultsContainer.style.display = "none";
                if (searchHint) searchHint.style.display = "none";
                setControlsVisibility(true);
                return;
            }
            if (status !== 200 && data.cod !== 200 && data.cod !== "200") {
                showSearchProblem(city, t("search_failed"));
                return;
            }
            if (!Array.isArray(data.locations) || data.locations.length === 0) {
                if (errorMessage) errorMessage.textContent = t("city_not_found");
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
                ${escapeHtml(t("choose_location"))}
                <small class="location-instruction">${escapeHtml(t("choose_location_sub"))}</small>
            `;
            resultsContainer.appendChild(heading);

            data.locations.forEach(location => {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "location-item";
                const countryName = getCountryName(location.country);
                button.innerHTML = `
                    <strong>📍 ${escapeHtml(location.name || t("unknown_location"))}</strong>
                    ${location.state ? `<small>📌 ${escapeHtml(location.state)}</small>` : ""}
                    <small>🌍 ${escapeHtml(countryName)}</small>
                `;
                button.addEventListener("click", () => selectLocation(location));
                resultsContainer.appendChild(button);
            });
        })
        .catch(error => {
            console.error("Location search error:", error);
            showSearchProblem(city, t("search_failed"));
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
    retry.textContent = t("retry");
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
    errorMessage.textContent = t("approximate_note");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "data-status-retry";
    btn.textContent = t("search_your_city");
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
                data.lat, data.lon, t("approximate_place"), data.country || "", data.name || "");
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
        locationBtn.textContent = t("locating");
    }
    if (errorMessage) errorMessage.textContent = t("finding_location");

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
            locationBtn.textContent = t("use_my_location");
        }
    };

    (async () => {
        let position = null;
        let lastError = null;

        if (navigator.geolocation) {
            ({ position, error: lastError } = await locateWithWatch(best => {
                if (errorMessage) {
                    errorMessage.textContent =
                        t("improving_accuracy", { m: Math.round(best.coords.accuracy) });
                }
            }));
        }
        resetButton();

        if (position) {
            const { latitude, longitude, accuracy } = position.coords;
            getWeatherByLocation(latitude, longitude, t("your_location_acc", { m: Math.round(accuracy) }));
            return;
        }

        if (typeof mpTrack === "function") {
            mpTrack("geolocation_failed", {
                code: lastError && lastError.code,
                message: lastError && lastError.message
            });
        }

        // No fix at all: an approximate place beats nothing.
        if (errorMessage) errorMessage.textContent = t("finding_approximate");
        if (await useIpLocationFallback()) return;

        if (errorMessage) errorMessage.textContent = t("location_failed");
    })();
}


/* =========================================================
   WEATHER BY GPS
========================================================= */
function getWeatherByLocation(latitude, longitude, displayName = t("your_location"), opts = {}) {
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
        loadingMessage: t("loading_local"),
        failMessage: t("load_local_failed"),
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
        label.textContent = "📍 " + (displayPlaceName(loc.name) || t("unknown"));
        label.title = t("load_place", { name: displayPlaceName(loc.name) || t("this_location") });
        label.addEventListener("click", () => {
            getWeatherByCoordinates(loc.lat, loc.lon, loc.name, loc.country, loc.state);
        });
        chip.appendChild(label);

        const remove = document.createElement("button");
        remove.className = "remove-chip";
        remove.type = "button";
        remove.textContent = "✕";
        remove.title = t("remove_saved");
        remove.addEventListener("click", (e) => {
            e.stopPropagation();
            savedLocations.splice(index, 1);
            storageSet("weatherSavedLocations", JSON.stringify(savedLocations));
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
        "EQ": "dis_earthquake",
        "TC": "dis_tropical_cyclone",
        "FL": "dis_flood",
        "VO": "dis_volcano",
        "DR": "dis_drought",
        "WF": "dis_wildfire"
    };
    return t(map[type] || "dis_disaster");
}

/* GDACS level (Red / Orange / Green) in the current language. */
function levelName(level) {
    const key = `level_${String(level || "green").toLowerCase()}`;
    return I18N[key] ? t(key) : String(level || "");
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
                    ${escapeHtml(t("no_disasters"))}
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
                            ${escapeHtml(levelName(a.alertlevel))}
                        </span>
                        <span>${escapeHtml(a.country || "")}</span>
                        <span class="catastrophe-view">${escapeHtml(t("view_report"))}</span>
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
                ${escapeHtml(t("disasters_failed"))}
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
                ${escapeHtml(t("cities_empty"))}
            </div>
        `;
        return;
    }

    container.innerHTML = "";
    const cards = [];

    savedLocations.forEach(loc => {
        const card = document.createElement("div");
        card.className = "city-card loading";
        card.title = t("click_to_load", { name: displayPlaceName(loc.name) || t("this_location") });

        card.innerHTML = `
            <div class="city-card-name">📍 ${escapeHtml(displayPlaceName(loc.name) || t("unknown"))}</div>
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
                    <div class="city-card-name">📍 ${escapeHtml(displayPlaceName(loc.name) || t("unknown"))}</div>
                    <div class="city-card-feels">${escapeHtml(t("unavailable"))}</div>
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

    const rawName = String(displayPlaceName(loc.name || data.name) || t("unknown"));
    const shortName = rawName.length > 18 ? rawName.slice(0, 16) + "…" : rawName;

    card.innerHTML = `
        <div class="city-card-name" title="${escapeHtml(rawName)}">📍 ${escapeHtml(shortName)}</div>
        <div class="city-card-icon">${icon}</div>
        <div class="city-card-temp">${formatTemp(temp, 0)}${tempUnit()}</div>
        <div class="city-card-feels">${escapeHtml(t("feels_short", { temp: `${formatTemp(feels, 0)}${tempUnit()}` }))}</div>
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
        btn.textContent = t("save_location");
        btn.classList.remove("saved");
        btn.disabled = true;
        return;
    }

    btn.disabled = false;

    if (isLocationSaved(loc.lat, loc.lon)) {
        btn.textContent = t("saved");
        btn.classList.add("saved");
    } else {
        btn.textContent = t("save_location");
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

        storageSet("weatherSavedLocations", JSON.stringify(savedLocations));
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
    const city = loc.name || data.name || t("unknown");
    const state = loc.state || "";
    const country = loc.country || data.sys?.country || "";
    const locationText = formatLocation(city, state, country);

    const temp = Number(main.temp);
    const feelsLike = Number(main.feels_like);
    const humidity = Number(main.humidity);
    const windSpeed = Number(wind.speed);
    const windDeg = Number(wind.deg);

    let text = `${icon} ${locationText} — ${formatTemp(temp)}${tempUnit()}, ${condition}\n`;
    text += t("share_feels", { temp: `${formatTemp(feelsLike)}${tempUnit()}` }) + " | ";
    text += t("share_humidity", { pct: humidity }) + " | ";
    text += t("share_wind", { speed: `${formatSpeed(windSpeed)} ${speedUnit()}` });
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
            `<p style="color:#0f172a;font-size:12px;padding:20px;">${escapeHtml(t("qr_failed"))}</p>`;
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
                showToast(t("toast_link_copied"));
            } catch {
                showToast(t("toast_copy_failed"));
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
        showToast(t("toast_nothing_share"));
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
        showToast(t("toast_nothing_share"));
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
                    showToast(t("toast_weather_copied"));
                    closeShareMenu();
                })
                .catch(() => {
                    const ta = document.createElement("textarea");
                    ta.value = text;
                    ta.style.position = "fixed";
                    ta.style.opacity = "0";
                    document.body.appendChild(ta);
                    ta.select();
                    try { document.execCommand("copy"); showToast(t("toast_copied")); } catch {}
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
            showToast(t("toast_write_more"));
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = t("fb_sending");

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
            submitBtn.textContent = t("feedback_title");
            overlay.classList.remove("show");
            showToast(t("toast_thanks"));
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
    getSavedLocations: () => savedLocations,
    t
};


/* =========================================================
   DEFAULT WEATHER
========================================================= */
async function loadDefaultWeather() {
    const input = getElement("city-input");

    // Show the saved forecast of the place viewed last at once (however old,
    // with a note; this is what an offline start shows), then update it in
    // place: the loads below keep it on screen if they fail.
    const lastCoords = storageJson("weatherLastCoords", null);
    const savedEntry = (lastCoords && findSavedPlace({ coords: lastCoords })) || latestSavedPlace();
    const cachedWeather = savedEntry ? savedEntry.weather : null;

    if (cachedWeather) {
        showWeatherPair(cachedWeather, savedEntry.forecast, { saved: true });
        window._dataTime = savedEntry.time;
        showDataStatus(savedEntry.time, null, { updating: true });

        const lastCoordsRaw = storageGet("weatherLastCoords");
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

        const lastCity = storageGet("weatherLastCity");
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

    const lastCoordsRaw = storageGet("weatherLastCoords");
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

    const lastCity = storageGet("weatherLastCity");
    if (lastCity) {
        if (input) input.value = lastCity;
        getWeather(lastCity);
        return;
    }

    if (input) input.value = t("finding_location_input");

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

    applyStaticTranslations();
    setupLanguageSwitch();
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
        btn.textContent = t("radar_play");
        return;
    }

    btn.textContent = t("radar_pause");
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

        const savedLang = storageGet("voiceSearchLang");
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
        btn.title = t("voice_listening");
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
            showToast(t("toast_mic_denied"));
        } else if (code === "no-speech") {
            showToast(t("toast_no_speech"));
        } else if (code === "audio-capture") {
            showToast(t("toast_no_mic"));
        } else if (code === "network") {
            showToast(t("toast_voice_network"));
        } else if (code === "aborted") {
            // User cancelled — silent
        } else {
            showToast(t("toast_voice_failed"));
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
        btn.title = t("voice_search");
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
            storageSet("voiceSearchLang", langSelect.value);
            showToast(t("toast_voice_lang", { lang: langSelect.options[langSelect.selectedIndex].text }));
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

    showToast(`📍 ${displayPlaceName(next.name) || t("saved_location")}`);
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