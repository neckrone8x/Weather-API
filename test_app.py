"""
Offline tests for the weather backend. Upstream APIs are mocked (or served by
a tiny local fake server), so no key or internet is needed:
    python -m unittest test_app -v
"""
import ast
import json
import os
import signal
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

import requests

os.environ.setdefault("OPENWEATHER_API_KEY", "test-secret-key")
import app as weather_app  # noqa: E402

SECRET = os.environ["OPENWEATHER_API_KEY"]
SENDGRID_SECRET = "SG.test-sendgrid-secret"


class FakeResp:
    """Stands in for a streamed requests.Response."""

    def __init__(self, status=200, payload=None):
        self.status_code = status
        self._payload = payload if payload is not None else {}
        self.ok = 200 <= status < 300

    def json(self):
        return self._payload

    def iter_content(self, chunk_size=1):
        yield json.dumps(self._payload).encode()

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
    if "nominatim" in url:
        return FakeResp(200, {"address": {"town": "Kisumu", "state": "Kisumu",
                                          "country_code": "ke"}})
    if "ipapi.co" in url:
        return FakeResp(200, {"city": "Kisumu", "region": "Kisumu", "country_code": "KE",
                              "latitude": -0.1, "longitude": 34.75})
    if "gdacs" in url:
        return FakeResp(200, {"features": [{"properties": {
            "eventid": 1, "eventtype": "FL", "name": "Flood", "alertlevel": "Red",
            "country": "Kenya", "fromdate": "2026-11-01"},
            "geometry": {"coordinates": [34.7, -0.1]}}]})
    if "weather.gov" in url:
        return FakeResp(400)      # not a US point
    if "usgs" in url:
        return FakeResp(200, {"features": []})
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

    def test_feedback_rate_limited(self):
        weather_app.SENDGRID_API_KEY = "x"
        try:
            with mock.patch.object(weather_app.http, "post",
                                   return_value=FakeResp(202)):
                codes = [self.client.post("/feedback", json={"message": "hi"}).status_code
                         for _ in range(6)]
            self.assertEqual(codes[:5], [200] * 5)
            self.assertEqual(codes[5], 429)
        finally:
            weather_app.SENDGRID_API_KEY = None


class SlowServiceTests(unittest.TestCase):
    """A slow outside service must never hold a request past the budget:
    under gthread nothing else would ever free that thread."""

    def setUp(self):
        weather_app.cache.clear()
        self.client = weather_app.app.test_client()
        self._saved = (weather_app.REQUEST_BUDGET, weather_app.OPEN_METEO_WAIT)
        weather_app.REQUEST_BUDGET, weather_app.OPEN_METEO_WAIT = 1.0, 0.3

    def tearDown(self):
        weather_app.REQUEST_BUDGET, weather_app.OPEN_METEO_WAIT = self._saved

    def slow(self, which, seconds):
        def handler(url, params=None, **kw):
            if which in url:
                time.sleep(seconds)
            return router(url, params, **kw)
        return mock.patch.object(weather_app.http, "get", side_effect=handler)

    def test_slow_open_meteo_is_skipped_not_waited_for(self):
        with self.slow("open-meteo", 2.0):
            t = time.monotonic()
            r = self.client.get("/weather-full?lat=-0.1&lon=34.75")
            took = time.monotonic() - t
        self.assertEqual(r.status_code, 200)
        self.assertLess(took, 1.0)                       # did not wait the 2 s
        self.assertNotIn("daily", r.get_json()["forecast"])

    def test_slow_openweathermap_gives_a_clean_504_in_time(self):
        with self.slow("api.openweathermap.org", 3.0):
            t = time.monotonic()
            r = self.client.get("/weather-full?lat=1.5&lon=2.5")
            took = time.monotonic() - t
        self.assertEqual(r.status_code, 504)
        self.assertLess(took, 1.6)
        self.assertNotIn(SECRET, r.get_data(as_text=True))

    def test_after_an_open_meteo_failure_it_is_skipped_for_a_while(self):
        calls = []

        def handler(url, params=None, **kw):
            if "open-meteo" in url:
                calls.append(url)
                raise requests.exceptions.ConnectTimeout("slow")
            return router(url, params, **kw)
        with mock.patch.object(weather_app.http, "get", side_effect=handler):
            self.client.get("/weather-full?lat=3&lon=4")
            self.client.get("/weather-full?lat=5&lon=6")   # another place
            self.client.get("/uv?lat=7&lon=8")
        self.assertEqual(len(calls), 1)

    def test_retries_never_repeat_a_slow_read(self):
        retry = weather_app.http.get_adapter("https://x").max_retries
        self.assertEqual(retry.read, 0)
        self.assertLessEqual(retry.total, 1)
        self.assertEqual(weather_app.UPSTREAM_TIMEOUT, (3, 6))

    # ---- every endpoint answers fast when its upstream hangs ----

    def assert_fast(self, path, status, which="api.openweathermap.org", method="get", **kw):
        with self.slow(which, 3.0), \
                mock.patch.object(weather_app.http, "post",
                                  side_effect=lambda *a, **k: time.sleep(3) or FakeResp(202)):
            t = time.monotonic()
            r = getattr(self.client, method)(path, **kw)
            took = time.monotonic() - t
        self.assertEqual(r.status_code, status, path)
        self.assertLess(took, 1.6, path)
        self.assertTrue(r.is_json, path)
        return r

    def test_slow_upstream_never_hangs_any_endpoint(self):
        self.assert_fast("/weather?lat=1&lon=1", 504)
        self.assert_fast("/weather?city=Nairobi", 504)          # geocoding inside
        self.assert_fast("/weather-full?city=Mombasa", 504)     # geocoding inside
        self.assert_fast("/forecast?lat=2&lon=2", 504)
        self.assert_fast("/locations?city=Eldoret", 504)
        r = self.assert_fast("/air?lat=3&lon=3", 200)
        self.assertIsNone(r.get_json()["aqi"])
        self.assert_fast("/reverse?lat=4&lon=4", 200, which="nominatim")
        self.assert_fast("/my-location", 200, which="ipapi.co",
                         headers={"X-Forwarded-For": "8.8.8.8"})
        self.assert_fast("/global-alerts", 200, which="gdacs")
        self.assert_fast("/local-alerts?lat=5&lon=5", 200, which="usgs")

    def test_slow_uv_answers_in_time(self):
        def handler(url, params=None, **kw):
            time.sleep(3)
            return router(url, params, **kw)
        with mock.patch.object(weather_app.http, "get", side_effect=handler):
            t = time.monotonic()
            r = self.client.get("/uv?lat=6&lon=6")
            took = time.monotonic() - t
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(r.get_json()["value"])
        self.assertLess(took, 1.6)

    def test_slow_sendgrid_gives_504(self):
        weather_app.SENDGRID_API_KEY = SENDGRID_SECRET
        try:
            r = self.assert_fast("/feedback", 504, method="post", json={"message": "hi"})
            self.assertFalse(r.get_json()["ok"])
            self.assertNotIn(SENDGRID_SECRET, r.get_data(as_text=True))
        finally:
            weather_app.SENDGRID_API_KEY = None


class SendGridTests(unittest.TestCase):
    def setUp(self):
        weather_app.cache.clear()
        self.client = weather_app.app.test_client()
        weather_app.SENDGRID_API_KEY = SENDGRID_SECRET

    def tearDown(self):
        weather_app.SENDGRID_API_KEY = None

    def post(self, **post_kw):
        with mock.patch.object(weather_app.http, "post", **post_kw) as m:
            r = self.client.post("/feedback", json={"message": "hi", "email": "a@b.co"})
        self.assertNotIn(SENDGRID_SECRET, r.get_data(as_text=True))
        return r, m

    def test_sendgrid_success_sends_the_right_mail(self):
        r, m = self.post(return_value=FakeResp(202))
        self.assertEqual(r.status_code, 200)
        args, kw = m.call_args
        self.assertEqual(args[0], weather_app.SENDGRID_URL)
        self.assertEqual(kw["headers"]["Authorization"], f"Bearer {SENDGRID_SECRET}")
        self.assertEqual(kw["json"]["reply_to"], {"email": "a@b.co"})
        self.assertIn("hi", kw["json"]["content"][0]["value"])
        self.assertIsNotNone(kw["timeout"])

    def test_sendgrid_error_reply_gives_502(self):
        r, m = self.post(return_value=FakeResp(500))
        self.assertEqual(r.status_code, 502)
        self.assertFalse(r.get_json()["ok"])
        self.assertEqual(m.call_count, 1)          # POST is never retried

    def test_sendgrid_connection_failure_gives_502_without_retry(self):
        r, m = self.post(side_effect=requests.exceptions.ConnectionError(SENDGRID_SECRET))
        self.assertEqual(r.status_code, 502)
        self.assertEqual(m.call_count, 1)

    def test_sendgrid_timeout_gives_504(self):
        r, m = self.post(side_effect=requests.exceptions.ReadTimeout("slow"))
        self.assertEqual(r.status_code, 504)


class UpstreamHelperTests(unittest.TestCase):
    def setUp(self):
        weather_app.cache.clear()
        self.client = weather_app.app.test_client()

    def test_only_the_helper_touches_the_network(self):
        """Static check: http.get/post (or requests.*) appear only in _attempt."""
        with open(weather_app.__file__, encoding="utf-8") as fh:
            src = fh.read()
        offenders = []

        class Visitor(ast.NodeVisitor):
            func = None

            def visit_FunctionDef(self, node):
                outer, self.func = self.func, node.name
                self.generic_visit(node)
                self.func = outer

            def visit_Attribute(self, node):
                if (isinstance(node.value, ast.Name) and node.value.id in ("http", "requests")
                        and node.attr in ("get", "post", "put", "request", "Session")):
                    if self.func not in ("_attempt", "_make_session"):
                        offenders.append(f"{node.value.id}.{node.attr} in {self.func}")
                self.generic_visit(node)
        Visitor().visit(ast.parse(src))
        self.assertEqual(offenders, [])
        self.assertNotIn("from sendgrid", src)        # its client has no timeout

    def test_every_endpoint_call_goes_through_helper_with_timeout(self):
        seen = []

        def spy_get(url, **kw):
            seen.append((url, kw))
            return router(url, **kw)

        def spy_post(url, **kw):
            seen.append((url, kw))
            return FakeResp(202)

        weather_app.SENDGRID_API_KEY = SENDGRID_SECRET
        try:
            with mock.patch.object(weather_app.http, "get", side_effect=spy_get), \
                    mock.patch.object(weather_app.http, "post", side_effect=spy_post), \
                    mock.patch.object(weather_app, "upstream", wraps=weather_app.upstream) as up:
                for path in ["/weather-full?city=Kisumu", "/weather?lat=1&lon=1",
                             "/forecast?lat=2&lon=2", "/air?lat=3&lon=3",
                             "/locations?city=Nairobi", "/reverse?lat=4&lon=4",
                             "/global-alerts", "/local-alerts?lat=5&lon=5"]:
                    self.assertEqual(self.client.get(path).status_code, 200, path)
                self.client.get("/my-location", headers={"X-Forwarded-For": "8.8.8.8"})
                weather_app.cache.set("om:down", True, 60)     # force the One Call fallback
                self.client.get("/uv?lat=6&lon=6")
                self.client.post("/feedback", json={"message": "hi"})
        finally:
            weather_app.SENDGRID_API_KEY = None

        providers = {c.args[0] for c in up.call_args_list}
        self.assertEqual(providers, {"openweathermap", "open-meteo", "nominatim", "ipapi",
                                     "gdacs", "nws", "usgs", "sendgrid"})
        self.assertEqual(len(seen), up.call_count)       # no retries, so one each
        for url, kw in seen:
            connect, read = kw["timeout"]
            self.assertLessEqual(connect, 3, url)
            self.assertLessEqual(read, 6, url)
            self.assertTrue(kw["stream"], url)

    def test_connection_error_is_retried_once_but_a_timeout_is_not(self):
        calls = []

        def flaky(url, **kw):
            calls.append(url)
            if len(calls) == 1:
                raise requests.exceptions.ConnectionError("reset")
            return router(url, **kw)
        with mock.patch.object(weather_app.http, "get", side_effect=flaky):
            self.assertEqual(self.client.get("/weather?lat=1&lon=2").status_code, 200)
        self.assertEqual(len(calls), 2)

        with mock.patch.object(weather_app.http, "get",
                               side_effect=requests.exceptions.ReadTimeout("slow")) as m:
            self.assertEqual(self.client.get("/weather?lat=3&lon=4").status_code, 504)
        self.assertEqual(m.call_count, 1)

    def test_bad_gateway_is_retried_once(self):
        replies = [FakeResp(503), FakeResp(200, CURRENT)]
        with mock.patch.object(weather_app.http, "get", side_effect=lambda *a, **k: replies.pop(0)):
            self.assertEqual(self.client.get("/weather?lat=7&lon=8").status_code, 200)

    def test_slow_request_is_logged_with_upstream(self):
        def slowish(url, **kw):
            time.sleep(0.2)
            return router(url, **kw)
        with mock.patch.object(weather_app, "SLOW_REQUEST_LOG", 0.1), \
                mock.patch.object(weather_app.http, "get", side_effect=slowish), \
                self.assertLogs("weather", level="WARNING") as logs:
            self.client.get("/weather?lat=9&lon=9")
        line = "\n".join(logs.output)
        self.assertIn("SLOW request /weather", line)
        self.assertIn("openweathermap", line)
        self.assertNotIn(SECRET, line)

    def test_health_unchanged(self):
        r = self.client.get("/health")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["ok"])


class FakeSlowServer:
    """A real local HTTP server that misbehaves, for the hard-deadline tests."""

    def __init__(self, mode):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                try:
                    if mode == "silent":            # accepts, never answers
                        time.sleep(5)
                        return
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", "2000")
                    self.end_headers()
                    for _ in range(100):             # trickles: 1 byte / 0.1 s
                        self.wfile.write(b" ")
                        self.wfile.flush()
                        time.sleep(0.1)
                except OSError:
                    pass
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class HardDeadlineTests(unittest.TestCase):
    """Real sockets: a byte every 0.1 s keeps resetting requests' read timeout,
    so only the helper's own deadline stops it."""

    def setUp(self):
        env = mock.patch.dict(os.environ, {"NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1"})
        env.start()
        self.addCleanup(env.stop)

    def check(self, mode):
        srv = FakeSlowServer(mode)
        self.addCleanup(srv.close)
        t = time.monotonic()
        with self.assertRaises(weather_app.UpstreamError) as cm:
            weather_app.upstream("fake", srv.url, total=1.0)
        took = time.monotonic() - t
        self.assertEqual(cm.exception.kind, "timeout")
        self.assertLess(took, 1.5)

    def test_trickling_reply_is_cut_off_at_the_deadline(self):
        self.check("trickle")

    def test_silent_server_is_cut_off_at_the_deadline(self):
        self.check("silent")

    def test_dns_or_pool_stall_is_cut_off(self):
        # Simulate a lookup that blocks: socket timeouts can't help here.
        with mock.patch.object(weather_app.http, "get", side_effect=lambda *a, **k: time.sleep(3)):
            t = time.monotonic()
            with self.assertRaises(weather_app.UpstreamError):
                weather_app.upstream("fake", "https://example.invalid/", total=0.5)
            self.assertLess(time.monotonic() - t, 1.0)


class WatchdogTests(unittest.TestCase):
    def tearDown(self):
        weather_app._watchdog_fired = False
        with weather_app._inflight_lock:
            weather_app._inflight.pop(-1, None)

    def test_stuck_request_restarts_the_worker(self):
        now = time.monotonic()
        with weather_app._inflight_lock:
            weather_app._inflight[-1] = (now - weather_app.STUCK_REQUEST_LIMIT - 1, "/weather")
        with mock.patch.object(weather_app.os, "kill") as kill, \
                self.assertLogs("weather", level="ERROR") as logs:
            self.assertTrue(weather_app._watchdog_tick(now))
        kill.assert_called_once_with(os.getpid(), signal.SIGTERM)
        self.assertIn("STUCK request /weather", "\n".join(logs.output))

    def test_healthy_requests_are_left_alone(self):
        with weather_app._inflight_lock:
            weather_app._inflight[-1] = (time.monotonic(), "/weather")
        with mock.patch.object(weather_app.os, "kill") as kill:
            self.assertFalse(weather_app._watchdog_tick())
        kill.assert_not_called()

    def test_finished_requests_leave_the_inflight_list(self):
        with mock.patch.object(weather_app.http, "get", side_effect=router):
            weather_app.app.test_client().get("/health")
        self.assertNotIn(threading.get_ident(), weather_app._inflight)


if __name__ == "__main__":
    unittest.main()
