"""Unit tests for api-proxy.py (batch H4): the answer is relayed, lose-answer.flag cuts the phone
off once the API has done the work, one access line per request (keep-alive too) without headers,
bodies or query values, a dropped connection says so, no descriptor leaks over many requests, and
no control flow leaves a finally block (U011: Python 3.14's SyntaxWarning in api-proxy.log).
usage: python3 -m unittest discover -s scripts/sim -p 'test_api_proxy.py'
The proxy runs as the workflow runs it, as a script, in front of a small HTTP/1.1 server."""
import ast, http.client, http.server, json, os, shutil, socket, subprocess, sys, tempfile, threading, time, unittest, warnings

HERE = os.path.dirname(os.path.abspath(__file__))
PROXY = os.path.join(HERE, "api-proxy.py")
# A Windows venv's python.exe is a launcher that runs the interpreter as its child: the proxy's
# descriptors would be counted on the wrong process.
PYTHON = getattr(sys, "_base_executable", None) or sys.executable


class Api(http.server.BaseHTTPRequestHandler):
    """The demo API's part: answers with a length, or chunked as Next streams, on a kept-alive
    connection, and remembers every request it was given."""
    protocol_version = "HTTP/1.1"
    seen = []

    def answer(self, status):
        length = int(self.headers.get("content-length") or 0)
        if length:
            self.rfile.read(length)
        Api.seen.append((self.command, self.path))
        body = json.dumps({"path": self.path}).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        if self.path.startswith("/chunked"):
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            for piece in (body[:5], body[5:], b""):
                self.wfile.write(b"%x\r\n%s\r\n" % (len(piece), piece))
        else:
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def do_GET(self):
        self.answer(200)

    def do_POST(self):
        self.answer(201)

    def log_message(self, *args):
        pass


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def open_fds(pid):
    """The proxy process's open descriptors (handles on Windows)."""
    if os.path.isdir(f"/proc/{pid}/fd"):
        return len(os.listdir(f"/proc/{pid}/fd"))
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.GetProcessHandleCount.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        count = wintypes.DWORD()
        try:
            if not kernel.GetProcessHandleCount(handle, ctypes.byref(count)):
                raise OSError(ctypes.get_last_error(), "GetProcessHandleCount")
        finally:
            kernel.CloseHandle(handle)
        return count.value
    # macOS: no /proc; lsof lists the same fixed rows each time, plus one per open descriptor.
    return len(subprocess.run(["lsof", "-n", "-P", "-p", str(pid)], capture_output=True, text=True, check=True).stdout.splitlines())


def escapes(node, in_loop=False):
    """return/break/continue under node that would leave an enclosing finally block."""
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
        return []
    if isinstance(node, ast.Return) or isinstance(node, (ast.Break, ast.Continue)) and not in_loop:
        return [node]
    in_loop = in_loop or isinstance(node, (ast.For, ast.AsyncFor, ast.While))
    return [hit for child in ast.iter_child_nodes(node) for hit in escapes(child, in_loop)]


class ProxyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Api)
        threading.Thread(target=cls.api.serve_forever, daemon=True).start()
        cls.dir = tempfile.mkdtemp(prefix="api-proxy-")
        cls.offline = os.path.join(cls.dir, "offline.flag")
        cls.lose = os.path.join(cls.dir, "lose-answer.flag")
        cls.log_path = os.path.join(cls.dir, "api-proxy.log")
        cls.port = free_port()
        cls.log = open(cls.log_path, "w")
        cls.proxy = subprocess.Popen([PYTHON, PROXY, str(cls.port), str(cls.api.server_address[1]), cls.offline],
                                     stdout=cls.log, stderr=subprocess.STDOUT)
        deadline = time.time() + 10
        while True:
            try:
                socket.create_connection(("127.0.0.1", cls.port), timeout=1).close()
                break
            except OSError:
                if time.time() > deadline or cls.proxy.poll() is not None:
                    raise
                time.sleep(0.05)

    @classmethod
    def tearDownClass(cls):
        cls.proxy.kill()
        cls.proxy.wait()
        cls.log.close()
        cls.api.shutdown()
        cls.api.server_close()
        shutil.rmtree(cls.dir, ignore_errors=True)

    def tearDown(self):
        for f in (self.offline, self.lose):
            if os.path.exists(f):
                os.remove(f)

    def lines(self, until=lambda lines: True, timeout=5):
        """The access log once `until` holds for it (the proxy writes each line as it ends)."""
        deadline = time.time() + timeout
        while True:
            with open(self.log_path, encoding="utf-8", errors="replace") as f:
                lines = f.read().splitlines()
            if until(lines) or time.time() > deadline:
                return lines

    def connection(self):
        return http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)

    def test_answer_is_relayed(self):
        c = self.connection()
        c.request("GET", "/api/profile")
        r = c.getresponse()
        self.assertEqual((r.status, json.loads(r.read())), (200, {"path": "/api/profile"}))
        c.close()

    def test_lost_answer_reaches_the_api_and_closes_the_connection(self):
        open(self.lose, "w").close()
        before = len(Api.seen)
        s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        s.sendall(b"POST /api/invoices/i1/duplicate HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\n"
                  b"idempotency-key: k1\r\ncontent-length: 2\r\n\r\n{}")
        got, closed = b"", False
        try:
            while chunk := s.recv(65536):
                got += chunk
            closed = True
        except ConnectionError:
            closed = True
        except TimeoutError:
            pass
        s.close()
        self.assertEqual(got, b"", "the phone was handed the answer")
        self.assertTrue(closed, "the phone's connection was left open")
        self.assertEqual(Api.seen[before:], [("POST", "/api/invoices/i1/duplicate")], "the API did not do the work once")
        lines = self.lines(lambda ls: any("/api/invoices/i1/duplicate" in l for l in ls))
        line = next(l for l in lines if "/api/invoices/i1/duplicate" in l)
        self.assertIn(" POST /api/invoices/i1/duplicate 201 ", line)
        self.assertTrue(line.endswith("LOST answer"), line)
        # Without the flag the next request is answered again.
        os.remove(self.lose)
        c = self.connection()
        c.request("POST", "/api/invoices/i1/duplicate", body=b"{}")
        self.assertEqual(c.getresponse().status, 201)
        c.close()

    def test_keep_alive_requests_give_one_line_each(self):
        c = self.connection()
        c.request("GET", "/chunked/receipts?cursor=abc123&limit=50", headers={"authorization": "Bearer secret-token-1"})
        first = c.getresponse()
        self.assertEqual(json.loads(first.read()), {"path": "/chunked/receipts?cursor=abc123&limit=50"})
        sock = c.sock
        c.request("POST", "/api/ai/chat", body=b'{"message":"body-text-1"}', headers={"content-type": "application/json"})
        second = c.getresponse()
        self.assertEqual(second.status, 201)
        second.read()
        self.assertIs(c.sock, sock, "the second request did not reuse the connection")
        c.close()
        lines = self.lines(lambda ls: any(" POST /api/ai/chat " in l for l in ls))
        got = [l for l in lines if " GET /chunked/receipts?cursor&limit " in l or " POST /api/ai/chat " in l]
        self.assertEqual(len(got), 2, lines)
        self.assertEqual(got[0].split()[1], got[1].split()[1], "two connection ids for one connection")
        self.assertRegex(got[0], r" c\d+ GET /chunked/receipts\?cursor&limit 200 \d+ms$")
        self.assertRegex(got[1], r" c\d+ POST /api/ai/chat 201 \d+ms$")
        text = "\n".join(lines)
        for secret in ("secret-token-1", "abc123", "body-text-1", "authorization"):
            self.assertNotIn(secret, text)

    def test_offline_drop_is_logged(self):
        open(self.offline, "w").close()
        s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        try:
            got = s.recv(1)
        except ConnectionError:
            got = b""
        s.close()
        self.assertEqual(got, b"")
        self.assertTrue(any(l.endswith(" DROP offline") for l in self.lines(lambda ls: any("DROP offline" in l for l in ls))))

    def test_descriptors_stay_flat_over_200_cycles(self):
        def cycle(lost):
            # Every other answer lost: that path closes the connection itself.
            if lost:
                open(self.lose, "w").close()
            c = self.connection()
            c.request("GET", "/api/sync/version")
            try:
                c.getresponse().read()
                self.assertFalse(lost, "the answer came although lose-answer.flag was set")
            except (ConnectionError, http.client.HTTPException):
                self.assertTrue(lost, "an answer was lost without lose-answer.flag")
            c.close()
            if lost:
                os.remove(self.lose)

        def settled(limit):
            deadline = time.time() + 5
            while (n := open_fds(self.proxy.pid)) > limit and time.time() < deadline:
                time.sleep(0.1)
            return n

        for i in range(20):
            cycle(i % 2 == 1)
        baseline, deadline = open_fds(self.proxy.pid), time.time() + 5
        while time.time() < deadline:
            time.sleep(0.1)
            n = open_fds(self.proxy.pid)
            if n == baseline:
                break
            baseline = n
        for i in range(200):
            cycle(i % 2 == 1)
        # One leaked socket per cycle would be 200 more (400 with its upstream).
        self.assertLessEqual(settled(baseline + 2), baseline + 2)

    def test_log_has_no_warnings(self):
        self.assertFalse([l for l in self.lines() if "Warning" in l])

    def test_no_control_flow_leaves_a_finally_block(self):
        with open(PROXY, encoding="utf-8") as f:
            source = f.read()
        with warnings.catch_warnings():
            warnings.simplefilter("error", SyntaxWarning)
            compile(source, PROXY, "exec")
        tree = ast.parse(source)
        hits = [f"line {hit.lineno}" for node in ast.walk(tree) if isinstance(node, ast.Try)
                for stmt in node.finalbody for hit in escapes(stmt)]
        self.assertEqual(hits, [])


if __name__ == "__main__":
    unittest.main()
