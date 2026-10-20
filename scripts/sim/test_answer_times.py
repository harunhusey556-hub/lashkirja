"""Unit tests for answer-times.py (batch H4, F002): a slow answer fails its class unless other routes
beside it in api-proxy.log were slow too (the host stalled), lines before the warm-up are not read,
and an answer the proxy log cannot place still fails.
usage: python3 -m unittest discover -s scripts/sim -p 'test_answer_times.py'"""
import importlib.util, io, os, tempfile, unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("answer_times", os.path.join(HERE, "answer-times.py"))
answer_times = importlib.util.module_from_spec(spec)
spec.loader.exec_module(answer_times)


def server_line(route, ms, status=200):
    return f'{{"observe":true,"kind":"request","message":"{route}","route":"{route}","status":{status},"durationMs":{ms}}}\n'


class AnswerTimes(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        os.environ.pop("GITHUB_STEP_SUMMARY", None)

    def write(self, name, text):
        path = os.path.join(self.dir.name, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def run_check(self, server, proxy=None, warm=1):
        argv = ["answer-times.py", "OwnerScreensTests", server, str(warm)] + ([proxy] if proxy else [])
        out = io.StringIO()
        with redirect_stdout(out):
            code = answer_times.main(argv)
        return code, out.getvalue()

    def test_a_slow_list_beside_slow_other_routes_is_a_host_stall(self):
        # Run 39341689130's launch: the list and three other routes in the same seconds.
        server = self.write("api-server.log", "warm\n" + server_line("GET /api/receipts", 3566))
        proxy = self.write("api-proxy.log", "\n".join([
            "2026-10-20T01:01:36.900 c3 GET /api/sync/version 200 6542ms",
            "2026-10-20T01:01:36.200 c4 GET /api/bootstrap 200 5853ms",
            "2026-10-20T01:01:34.100 c5 GET /api/receipts 200 3601ms",
            "2026-10-20T01:01:40.000 c6 GET /api/receipts 200 140ms",
        ]) + "\n")
        code, out = self.run_check(server, proxy)
        self.assertEqual(code, 0, out)
        self.assertIn("::warning::api-server.log:2: GET /api/receipts 200 3566 ms (host stall: GET /api/sync/version 6542 ms", out)
        self.assertNotIn("::error::", out)

    def test_a_slow_list_alone_fails_its_class(self):
        server = self.write("api-server.log", "warm\n" + server_line("GET /api/receipts", 3566))
        proxy = self.write("api-proxy.log", "\n".join([
            "2026-10-20T01:01:34.100 c5 GET /api/receipts 200 3601ms",
            "2026-10-20T01:01:33.000 c3 GET /api/sync/version 200 40ms",
            "2026-10-20T01:01:29.000 c7 GET /api/bootstrap 200 4100ms",
        ]) + "\n")
        code, out = self.run_check(server, proxy)
        self.assertEqual(code, 1, out)
        self.assertIn("::error::api-server.log:2: GET /api/receipts 200 3566 ms", out)

    def test_an_answer_the_proxy_log_cannot_place_fails(self):
        server = self.write("api-server.log", "warm\n" + server_line("GET /api/receipts", 5284))
        code, out = self.run_check(server, self.write("api-proxy.log", "2026-10-20T01:01:34.100 c5 GET /api/receipts 200 900ms\n"))
        self.assertEqual(code, 1, out)
        code, out = self.run_check(server)
        self.assertEqual(code, 1, out)

    def test_the_warm_up_and_quick_answers_are_not_read(self):
        server = self.write("api-server.log", server_line("GET /api/receipts", 8000) + server_line("GET /api/receipts", 300))
        code, out = self.run_check(server, warm=1)
        self.assertEqual(code, 0, out)
        self.assertIn("0 requests over 2000 ms", out)

    def test_each_proxy_line_places_one_answer(self):
        # Two slow lists, one stalled launch: the second list cannot borrow the first one's line.
        server = self.write("api-server.log", "warm\n" + server_line("GET /api/receipts", 3566) + server_line("GET /api/receipts", 3500))
        proxy = self.write("api-proxy.log", "\n".join([
            "2026-10-20T01:01:34.100 c5 GET /api/receipts 200 3601ms",
            "2026-10-20T01:01:36.900 c3 GET /api/sync/version 200 6542ms",
        ]) + "\n")
        code, out = self.run_check(server, proxy)
        self.assertEqual(code, 1, out)
        self.assertEqual(out.count("::warning::"), 1, out)
        self.assertEqual(out.count("::error::"), 1, out)


if __name__ == "__main__":
    unittest.main()
