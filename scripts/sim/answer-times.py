"""The UI suite's demo API answer times (H4). A request the server logs over 2000 ms after the
warm-up fails the class: a warm server answers a test well under 2 s, so a slower answer is a product
row on its route (FIX-ROUND.md section 7), not a reason to raise the bar. Unless the whole host
waited: when other routes overlapping it in api-proxy.log took over 1000 ms too, the answer is noted
and the class passes. That is what the simulator's app launch does to a CI runner (UI suite
39341689130: two receipt lists at 3.6 and 5.3 s beside sync/version at 6.5 s and bootstrap at
5.9 s, and the same routes at 130-370 ms a wave later; F002).
usage: answer-times.py <class> <api-server.log> <warm-up lines> [api-proxy.log]"""
import datetime, json, os, sys

SLOW_MS = 2000
STALLED_MS = 1000


def server_slow(path, warm):
    """(log line, 'METHOD /route', status, ms) for each request the server timed over SLOW_MS."""
    slow = []
    with open(path, encoding="utf-8", errors="replace") as log:
        for number, line in enumerate(log, 1):
            start = line.find('{"observe"')
            if number <= warm or start < 0:
                continue
            try:
                event = json.loads(line[start:])
            except ValueError:
                continue
            ms = event.get("durationMs")
            if event.get("kind") == "request" and isinstance(ms, (int, float)) and ms > SLOW_MS:
                slow.append((number, str(event.get("message")), event.get("status"), ms))
    return slow


def proxied(path):
    """(start, end, method, route, ms) for each answered request in the proxy's access log."""
    requests = []
    if not path or not os.path.exists(path):
        return requests
    with open(path, encoding="utf-8", errors="replace") as log:
        for line in log:
            # <time> c<connection> <method> <path> <status> <ms>ms [note]
            parts = line.split()
            if len(parts) < 6 or not parts[5].endswith("ms"):
                continue
            try:
                end = datetime.datetime.fromisoformat(parts[0])
                ms = int(parts[5][:-2])
            except ValueError:
                continue
            requests.append((end - datetime.timedelta(milliseconds=ms), end, parts[2], parts[3].split("?")[0], ms))
    return requests


def classify(slow, requests):
    """Each slow answer with the other routes that were as slow beside it (empty: the route's own)."""
    used, judged = set(), []
    for number, message, status, ms in slow:
        text = f"api-server.log:{number}: {message} {status} {ms} ms"
        method, _, route = message.partition(" ")
        # The paged list names its query keys ("/api/receipts?cursor", run 39360602636); the proxy
        # line is matched on the path alone, as the other routes are.
        route = route.split("?")[0]
        # The proxy's time holds the server's: the closest one at least as long is this answer.
        mine = [i for i, r in enumerate(requests) if i not in used and r[2] == method and r[3] == route and r[4] >= ms]
        if not mine:
            judged.append((text, []))
            continue
        i = min(mine, key=lambda i: requests[i][4] - ms)
        used.add(i)
        start, end = requests[i][0], requests[i][1]
        beside = [r for j, r in enumerate(requests)
                  if j != i and r[3] != route and r[0] < end and r[1] > start and r[4] > STALLED_MS]
        judged.append((text, beside))
    return judged


def main(argv):
    cls, server_log, warm = argv[1], argv[2], int(argv[3])
    judged = classify(server_slow(server_log, warm), proxied(argv[4] if len(argv) > 4 else None))
    failed = [text for text, beside in judged if not beside]
    print(f"{cls}: {len(judged)} requests over {SLOW_MS} ms after the warm-up (log line {warm}), "
          f"{len(judged) - len(failed)} of them while the whole host waited")
    lines = []
    for text, beside in judged:
        if beside:
            others = ", ".join(f"{r[2]} {r[3]} {r[4]} ms" for r in sorted(beside, key=lambda r: -r[4])[:3])
            lines.append(f"{text} (host stall: {others})")
            print(f"::warning::{lines[-1]}")
        else:
            lines.append(text)
            print(f"::error::{text}")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if lines and summary:
        with open(summary, "a", encoding="utf-8") as md:
            md.write(f"### {cls}: {len(lines)} demo API answers over 2 s after the warm-up, {len(failed)} its route's own\n\n")
            md.writelines(f"- {line}\n" for line in lines)
            md.write("\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
