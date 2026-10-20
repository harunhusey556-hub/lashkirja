#!/usr/bin/env python3
"""Loopback TCP proxy for the simulator walk: 127.0.0.1:<listen> -> 127.0.0.1:<target>.

While <flag-file> exists every new connection is dropped at once, so a UI test can take the
API "offline" and back by creating and removing that file (WalkTestCase.goOffline/goOnline).
While lose-answer.flag exists next to it, a request still reaches the API, but the phone's
connection is closed instead of being handed the answer (WalkTestCase.loseAnswers/keepAnswers):
the server has done the work and the app cannot know, the case an Idempotency-Key or a chat
clientId is for.

One line per request on stdout: time, connection, method, path, status, ms. No headers and no
bodies, and the query by its keys only: a value can be a search or a token.
usage: api-proxy.py <listen-port> <target-port> <flag-file>
"""
import collections, datetime, itertools, os, re, socket, sys, threading, time

listen, target, flag = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
lose = os.path.join(os.path.dirname(flag), "lose-answer.flag")
live = set()
lock = threading.Lock()
out = threading.Lock()
links = itertools.count(1)
HEAD_MAX = 64 * 1024


def access(conn, *fields):
    line = " ".join([datetime.datetime.now().isoformat(timespec="milliseconds"), f"c{conn}", *map(str, fields)])
    with out:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


class Request:
    __slots__ = ("method", "path", "started")

    def __init__(self, method, target):
        path, _, query = target.partition("?")
        self.method = method
        self.path = path + ("?" + "&".join(p.partition("=")[0] for p in query.split("&")) if query else "")
        self.started = time.monotonic()


class Messages:
    """Where each HTTP/1.1 message starts and ends in one direction of a connection. feed() hands
    the bytes back in order as ("head", message, raw), ("body", None, raw) and ("end", message, b"").
    A stream it cannot follow is passed through as body from then on: the relay never waits on it."""

    def __init__(self, waiting=None):
        self.waiting = waiting  # answers: the requests this connection has sent and not been answered
        self.buf = b""
        self.state = "head"
        self.left = 0
        self.current = None

    def feed(self, data):
        events, buf, i = [], self.buf + data, 0
        while i < len(buf):
            if self.state in ("raw", "close"):
                events.append(("body", None, buf[i:]))
                i = len(buf)
            elif self.state == "head":
                if buf.startswith(b"\r\n", i):
                    events.append(("body", None, b"\r\n"))
                    i += 2
                    continue
                start = buf[i:i + 18]
                if not self.plausible(start):
                    self.state = "raw"
                    continue
                end = buf.find(b"\r\n\r\n", i)
                if end < 0:
                    if len(buf) - i > HEAD_MAX:
                        self.state = "raw"
                        continue
                    break
                raw = buf[i:end + 4]
                i = end + 4
                events.extend(self.head(raw))
            elif self.state in ("length", "chunk"):
                n = min(self.left, len(buf) - i)
                events.append(("body", None, buf[i:i + n]))
                i += n
                self.left -= n
                if self.left == 0:
                    if self.state == "chunk":
                        self.state = "size"
                    else:
                        events.append(self.end())
            else:  # "size" or "trailer": one line at a time
                end = buf.find(b"\r\n", i)
                if end < 0:
                    if len(buf) - i > HEAD_MAX:
                        self.state = "raw"
                        continue
                    break
                line = buf[i:end + 2]
                i = end + 2
                events.append(("body", None, line))
                if self.state == "trailer":
                    if line == b"\r\n":
                        events.append(self.end())
                    continue
                try:
                    size = int(line.split(b";")[0].strip(), 16)
                except ValueError:
                    self.state = "raw"
                    continue
                self.state, self.left = ("trailer", 0) if size == 0 else ("chunk", size + 2)
        self.buf = buf[i:]
        return events

    def plausible(self, start):
        if self.waiting is not None:
            return len(start) < 5 and b"HTTP/".startswith(start) or start.startswith(b"HTTP/")
        if b" " not in start and len(start) < 18:
            return re.fullmatch(rb"[A-Z]*", start) is not None
        return re.match(rb"[A-Z]{1,16} ", start) is not None

    def head(self, raw):
        lines = raw.decode("latin-1").split("\r\n")
        first = lines[0].split(" ")
        fields = {}
        for line in lines[1:]:
            name, _, value = line.partition(":")
            fields[name.strip().lower()] = value.strip().lower()
        try:
            length = int(fields.get("content-length", "0").split(",")[0] or 0)
            status = int(first[1]) if self.waiting is not None else 0
        except (ValueError, IndexError):
            self.state = "raw"
            return [("body", None, raw)]
        if self.waiting is None:
            if len(first) != 3:
                self.state = "raw"
                return [("body", None, raw)]
            self.current = Request(first[0], first[1])
            bodyless = False
        elif 100 <= status < 200 and status != 101:
            # An interim answer (100 Continue): the request is still owed its real one.
            return [("head", None, raw)]
        else:
            request = self.waiting.popleft() if self.waiting else None
            self.current = (request, status)
            bodyless = status in (204, 304) or request is not None and request.method == "HEAD"
            if status == 101:
                self.state = "raw"
                return [("head", self.current, raw), ("end", self.current, b"")]
        if bodyless:
            return [("head", self.current, raw), self.end()]
        if "chunked" in fields.get("transfer-encoding", ""):
            self.state = "size"
        elif length:
            self.state, self.left = "length", length
        elif self.waiting is not None and "content-length" not in fields:
            self.state = "close"  # an answer with no length runs until the connection closes
        else:
            return [("head", self.current, raw), self.end()]
        return [("head", self.current, raw)]

    def end(self):
        self.state = "head"
        return ("end", self.current, b"")

    def finish(self):
        """The connection closed: an answer that runs until then is complete."""
        return [self.end()] if self.state == "close" else []


class Link:
    """One phone connection, its upstream, the requests sent on it that wait for an answer, and
    the answer on its way."""

    def __init__(self, client, upstream):
        self.id = next(links)
        self.client, self.upstream = client, upstream
        self.waiting = collections.deque()
        self.answering = None

    def requests(self):
        reader = Messages()
        while data := self.client.recv(65536):
            for kind, message, raw in reader.feed(data):
                if kind == "head":
                    self.waiting.append(message)  # before its bytes go: the answer can only follow them
                if raw:
                    self.upstream.sendall(raw)

    def answers(self):
        reader = Messages(self.waiting)
        lost = False
        while True:
            data = self.upstream.recv(65536)
            for kind, message, raw in reader.feed(data) if data else reader.finish():
                if kind == "head" and message is not None:
                    self.answering = message
                    # Read to its end, so the API finishes the work, then cut the phone off.
                    lost = os.path.exists(lose)
                if raw and not lost:
                    self.client.sendall(raw)
                if kind == "end":
                    self.answering = None
                    self.line(*message, "LOST answer" if lost else "")
                    if lost:
                        return
            if not data:
                return

    def line(self, request, status, note):
        ms = "-" if request is None else f"{(time.monotonic() - request.started) * 1000:.0f}ms"
        fields = ["?", "?"] if request is None else [request.method, request.path]
        access(self.id, *fields, status, ms, *([note] if note else []))

    def unanswered(self):
        offline = os.path.exists(flag)
        if self.answering is not None:
            self.line(*self.answering, "CUT offline" if offline else "CUT")
        while self.waiting:
            self.line(self.waiting.popleft(), "-", "CUT offline" if offline else "no answer")


def cut_when_offline():
    # URLSession keeps connections alive, so going offline must also cut the open ones.
    while True:
        if os.path.exists(flag):
            with lock:
                for s in list(live):
                    try: s.shutdown(socket.SHUT_RDWR)
                    except OSError: pass
        time.sleep(0.2)


def pipe(link, work):
    try:
        work()
    except OSError:
        pass
    finally:
        # Both directions end here; whichever finishes second closes the pair (no fd leak) and
        # writes the line of each request that got no answer.
        for s in (link.client, link.upstream):
            try: s.shutdown(socket.SHUT_RDWR)
            except OSError: pass
        with lock:
            second = link.client not in live
            live.discard(link.client); live.discard(link.upstream)
        if second:
            for s in (link.client, link.upstream):
                try: s.close()
                except OSError: pass
            link.unanswered()


def serve(client):
    if os.path.exists(flag):
        access(next(links), "DROP offline")
        client.close(); return
    try:
        upstream = socket.create_connection(("127.0.0.1", target), timeout=10)
    except OSError:
        access(next(links), "DROP no-upstream")
        client.close(); return
    link = Link(client, upstream)
    with lock:
        live.update((client, upstream))
    threading.Thread(target=pipe, args=(link, link.requests), daemon=True).start()
    threading.Thread(target=pipe, args=(link, link.answers), daemon=True).start()


threading.Thread(target=cut_when_offline, daemon=True).start()
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", listen)); srv.listen(64)
while True:
    conn, _ = srv.accept()
    serve(conn)
