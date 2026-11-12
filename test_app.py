"""
Offline tests for the weather backend. Upstream APIs are mocked, so no key
or network is needed:   python -m unittest test_app -v
"""
import os
import unittest
from unittest import mock

import requests

os.environ.setdefault("OPENWEATHER_API_KEY", "test-secret-key")
import app as weather_app  # noqa: E402

SECRET = os.environ["OPENWEATHER_API_KEY"]


class FakeResp:
    def __init__(self, status=200, payload=None):
        self.status_code = status
        self._payload = payload if payload is not None else {}
        self.ok = 200 <= status < 300

    def json(self):
        return self._payload

    def raise_for_status(self):
        if not self.ok:
            raise requests.exceptions.HTTPError(
                f"{self.status_code} Error for url: https://x?appid={SECRET}")


CURRENT = {"name": "Kisumu", "sys": {"country": "KE", "sunrise": 1, "sunset": 2},
           "main": {"temp": 25}, "weather": [{"id": 800, "icon": "01d"}], "cod": 200}
FORECAST = {"cod": "200", "city": {"timezone": 10800},
            "list": [{"dt": 1762981200, "dt_txt": "2025-11-12 21:00:00", "main": {"temp": 20}}]}
GEO = [{"name": "Kisumu", "country": "KE", "state": "Kisumu", "lat": -0.1, "lon": 34.75},
       {"name": "Kisumu", "country": "KE", "state": "Kisumu", "lat": -0.1, "lon": 34.75}]
OPEN_METEO = {
    "utc_offset_seconds": 10800,
    "current": {"uv_index": 7.4},
    "daily": {"time": ["2025-11-13", "2025-11-14"], "weather_code": [61, 0],
              "temperature_2m_max": [28.1, 29], "temperature_2m_min": [16, 17],
              "precipitation_probability_max": [80, 5], "precipitation_sum": [6.2, 0],
              "uv_index_max": [9.5, 10]},
}


def router(url, params=None, **kw):
    if "geo/1.0/direct" in url:
        return FakeResp(200, GEO)
    if "data/2.5/weather" in url:
        return FakeResp(200, CURRENT)
    if "data/2.5/forecast" in url:
        return FakeResp(200, FORECAST)
    if "open-meteo" in url:
        return FakeResp(200, OPEN_METEO)
    if "air_pollution" in url:
        return FakeResp(200, {"list": [{"main": {"aqi": 2}, "components": {"pm2_5": 4}}]})
    return FakeResp(404)


class WeatherApiTests(unittest.TestCase):
    def setUp(self):
        weather_app.cache.clear()
        self.client = weather_app.app.test_client()
        patcher = mock.patch.object(weather_app.http, "get", side_effect=router)
        self.mock_get = patcher.start()
        self.addCleanup(patcher.stop)

    def test_weather_full_by_city(self):
        r = self.client.get("/weather-full?city=Kisumu")
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(body["weather"]["searched_location"]["name"], "Kisumu")
        self.assertEqual(body["forecast"]["timezone"], 10800)
        # Local day: 21:00 UTC + 3h = next day 00:00 local
        self.assertEqual(body["forecast"]["list"][0]["dt_txt_local"], "2025-11-13 00:00:00")
        self.assertEqual(len(body["forecast"]["daily"]), 2)
        self.assertEqual(body["forecast"]["daily"][0]["weather"]["id"], 500)
        self.assertAlmostEqual(body["forecast"]["daily"][0]["pop"], 0.8)
        self.assertEqual(body["weather"]["uv"]["value"], 7.4)

    def test_cache_prevents_repeat_upstream_calls(self):
        self.client.get("/weather-full?lat=-0.1&lon=34.75")
        n = self.mock_get.call_count
        self.client.get("/weather-full?lat=-0.1001&lon=34.7502")  # same ~1km cell
        self.assertEqual(self.mock_get.call_count, n)

    def test_cached_objects_not_mutated_between_requests(self):
        self.client.get("/weather-full?city=Kisumu")
        r = self.client.get("/weather-full?lat=-0.1&lon=34.75").get_json()
        # The city request's searched_location must not leak into the cached object
        self.assertNotIn("searched_location", r["weather"])
        self.assertNotIn("state", r["forecast"]["searched_location"])

    def test_weather_full_survives_open_meteo_outage(self):
        def no_om(url, **kw):
            if "open-meteo" in url:
                raise requests.exceptions.ConnectionError("down")
            return router(url, **kw)
        self.mock_get.side_effect = no_om
        r = self.client.get("/weather-full?lat=1&lon=2")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("daily", r.get_json()["forecast"])

    def test_api_key_never_leaks_in_errors(self):
        self.mock_get.side_effect = requests.exceptions.ConnectionError(
            f"Max retries exceeded with url: /data/2.5/weather?appid={SECRET}")
        r = self.client.get("/weather?lat=1&lon=2")
        self.assertEqual(r.status_code, 503)
        self.assertNotIn(SECRET, r.get_data(as_text=True))

        self.mock_get.side_effect = lambda *a, **k: FakeResp(401)
        r = self.client.get("/weather?lat=3&lon=4")
        self.assertEqual(r.status_code, 502)
        self.assertNotIn(SECRET, r.get_data(as_text=True))

    def test_rate_limit_maps_to_503(self):
        self.mock_get.side_effect = lambda *a, **k: FakeResp(429)
        r = self.client.get("/weather?lat=5&lon=6")
        self.assertEqual(r.status_code, 503)

    def test_coordinate_validation(self):
        self.assertEqual(self.client.get("/weather?lat=abc&lon=1").status_code, 400)
        self.assertEqual(self.client.get("/weather?lat=95&lon=1").status_code, 400)
        self.assertEqual(self.client.get("/uv").status_code, 400)

    def test_uv_from_open_meteo(self):
        r = self.client.get("/uv?lat=-0.1&lon=34.75").get_json()
        self.assertEqual(r["value"], 7.4)
        self.assertEqual(r["max_today"], 9.5)

    def test_air(self):
        r = self.client.get("/air?lat=-0.1&lon=34.75").get_json()
        self.assertEqual(r["aqi"], 2)
        self.assertEqual(r["label"], "Fair")

    def test_locations_deduplicated(self):
        r = self.client.get("/locations?city=Kisumu").get_json()
        self.assertEqual(len(r["locations"]), 1)

    def test_private_ip_detection(self):
        self.assertFalse(weather_app.is_public_ip("172.20.0.1"))
        self.assertTrue(weather_app.is_public_ip("172.217.0.1"))   # was wrongly blocked
        self.assertFalse(weather_app.is_public_ip("::1"))

    @unittest.skipUnless(__import__("importlib.util").util.find_spec("sendgrid"), "sendgrid not installed")
    def test_feedback_rate_limited(self):
        weather_app.SENDGRID_API_KEY = "x"
        try:
            with mock.patch("sendgrid.SendGridAPIClient.send",
                            return_value=mock.Mock(status_code=202)):
                codes = [self.client.post("/feedback", json={"message": "hi"}).status_code
                         for _ in range(6)]
            self.assertEqual(codes[:5], [200] * 5)
            self.assertEqual(codes[5], 429)
        finally:
            weather_app.SENDGRID_API_KEY = None


if __name__ == "__main__":
    unittest.main()
