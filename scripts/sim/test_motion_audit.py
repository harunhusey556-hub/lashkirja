"""Unit tests for motion-audit.py and motion-gate.py (batch H1): no vacuous PASS, no false FIXED,
spinner pages and late shifts after a stalled presentation caught.
usage: python3 -m unittest discover -s scripts/sim -p 'test_*.py'
Synthetic frames stand in for ffmpeg; the gate runs as the workflow runs it, as a script."""
import importlib.util, json, os, subprocess, sys, tempfile, unittest
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("motion_audit", os.path.join(HERE, "motion-audit.py"))
ma = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ma)

H = 874  # an iPhone 16 Pro frame at the analysis width (402 pt)
CANVAS, CARD, INK = 242, 255, 60


def screen(cards, text_w=220):
    """A light screen: nav title, cards with a line of text each, tab bar icons."""
    f = np.full((H, ma.W), CANVAS, np.uint8)
    f[90:104, 150:250] = 40
    for y in cards:
        f[y:y + 80, 16:386] = CARD
        f[y + 16:y + 26, 32:32 + text_w] = INK
        f[y + 44:y + 52, 32:32 + text_w // 2] = INK
    f[790:, :] = 250
    for x in (40, 115, 190, 265, 340):
        f[805:830, x:x + 25] = 70
    return f


A = screen([150, 250, 350, 450, 550, 650])
B = screen([170, 290, 410, 530, 650], text_w=300)


def analyze(times, data, tap_s=0.5, step="x-open"):
    ma.frames = lambda video: (times, np.stack(data))
    hold = (ma.GESTURE_HOLD_S, ma.GESTURE_HOLD_S + 0.4) if ma.GESTURE.search(step) else (ma.HOLD_S, ma.QUIET_S)
    return ma.analyze_video("-", tap_s, *hold)


def probe(lines):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "probe.log")
        with open(p, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        return ma.probe_events(p)


def walk(root, suite, steps, videos, probe_lines=(), notes=()):
    """One walk's directory as the workflow leaves it, analysed with fake videos."""
    d = os.path.join(root, suite)
    os.makedirs(d)
    with open(os.path.join(d, "steps.json"), "w", encoding="utf-8") as f:
        json.dump(steps, f)
    for name in videos:
        open(os.path.join(d, name), "wb").close()
    for name, lines in (("probe.log", probe_lines), ("notes.txt", notes)):
        if lines:
            with open(os.path.join(d, name), "w", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")
    ma.frames = lambda video: videos[os.path.basename(video)]
    argv, out = sys.argv, sys.stdout
    sys.argv, sys.stdout = ["motion-audit.py", root], open(os.devnull, "w")
    try:
        ma.main()
    finally:
        sys.stdout.close()
        sys.argv, sys.stdout = argv, out
    with open(os.path.join(root, "motion-report.json"), encoding="utf-8") as f:
        return {r["id"]: r for r in json.load(f)}


def step(sid, kind="nav", reached=True, skipped=False, video=True):
    return {"id": sid, "suite": "s", "from": "A", "to": "B", "action": sid, "kind": kind, "expect": "",
            "tapAt": 100.5, "doneAt": 101.0, "recStart": 100.0, "recEnd": 104.0,
            "video": f"m-{sid}.mov" if video else None, "reached": reached, "skipped": skipped}


def gate(reports):
    """motion-gate.py as the workflow runs it: (stdout, exit code)."""
    with tempfile.TemporaryDirectory() as d:
        paths = []
        for name, rows in zip(("baseline", "pr-run1", "pr-run2"), reports):
            paths.append(os.path.join(d, name + ".json"))
            with open(paths[-1], "w", encoding="utf-8") as f:
                json.dump(rows, f)
        p = subprocess.run([sys.executable, "-I", os.path.join(HERE, "motion-gate.py"), *paths], capture_output=True, text=True)
        return p.stdout, p.returncode


def count(text, label):
    line = next(x for x in text.splitlines() if x.startswith(label))
    return int(line.rsplit(":", 1)[1])


def row(sid, **checks):
    return {"suite": "s", "id": sid, "crashed": checks.pop("crashed", False),
            "checks": {k: checks.get(k, "PASS") for k in ("intermediate", "flash", "shift_video", "shift_probe")}}


class NoVacuousPass(unittest.TestCase):
    def test_one_frame_video_is_not_pass(self):
        # M004/M019: the push ran after filming stopped; the video holds the start screen only.
        with tempfile.TemporaryDirectory() as root:
            r = walk(root, "s", [step("one")], {"m-one.mov": ([0.1], A[None])})["one"]
        for k in ("intermediate", "flash", "shift_video"):
            self.assertNotEqual(r["checks"][k], "PASS", k)
            self.assertEqual(r["checks"][k], "NO-MOTION", k)

    def test_unreached_step_is_not_pass(self):
        # M052: asetukset-close missed its target yet read PASS four times.
        frames = ([0.1, 0.6, 0.7, 0.8, 1.5], np.stack([A, B, B, B, B]))
        with tempfile.TemporaryDirectory() as root:
            r = walk(root, "s", [step("close", kind="sheet", reached=False)], {"m-close.mov": frames},
                     probe_lines=["MOVE 100.700 s n=1 max=40 HostingView@0,0,402x874:0,40", "QUIET 101.200 s"])["close"]
        self.assertEqual(set(r["checks"].values()), {"UNREACHED"})

    def test_step_skipped_before_recording_has_a_row(self):
        # M052: 'SKIP asetukset/help: no Ohje' never reached steps.json, so the gate could not see it.
        with tempfile.TemporaryDirectory() as root:
            rows = walk(root, "s", [step("a")], {"m-a.mov": ([0.1, 0.6, 1.5], np.stack([A, B, B]))},
                        notes=["STEP s/a: A -> B", "SKIP asetukset/help: no Ohje"])
        self.assertIn("help", rows)
        self.assertEqual(set(rows["help"]["checks"].values()), {"SKIPPED"})


class Gate(unittest.TestCase):
    def test_baseline_fail_against_pr_no_motion_is_not_fixed(self):
        # The PR walks filmed one frame each: today's analyzer called that PASS and the gate FIXED.
        base = [row("one", intermediate="FAIL")]
        prs = []
        for _ in range(2):
            with tempfile.TemporaryDirectory() as root:
                rows = walk(root, "s", [step("one")], {"m-one.mov": ([0.1], A[None])})
                prs.append([{"suite": "s", "id": "one", "crashed": False, "checks": rows["one"]["checks"]}])
        out, _ = gate([base, *prs])
        self.assertEqual(count(out, "FIXED"), 0)

    def test_fixed_needs_a_real_baseline_fail(self):
        out, _ = gate([[row("a", crashed=True)], [row("a")], [row("a")]])
        self.assertEqual(count(out, "FIXED"), 0)
        out, _ = gate([[row("a", flash="FAIL")], [row("a")], [row("a")]])
        self.assertEqual(count(out, "FIXED"), 1)

    def test_new_miss_exits_1_and_walks_print_their_counts(self):
        miss = [[row("a")], [row("a", intermediate="NO-MOTION")], [row("a", intermediate="UNREACHED")]]
        out, code = gate(miss)
        self.assertEqual(code, 1)
        self.assertEqual(count(out, "NEW MISS"), 1)
        self.assertIn("pr-run1: intermediate 0, flash 0, shift_video 0, shift_probe 0, crashed 0, steps 1; not judged: NO-MOTION 1", out)
        # One PR walk that still judged the check is not a miss, as one noisy run is not a NEW FAIL.
        out, code = gate([[row("a")], [row("a", intermediate="NO-MOTION")], [row("a")]])
        self.assertEqual((count(out, "NEW MISS"), code), (0, 0))


class ProbeShift(unittest.TestCase):
    def test_lasku_new_title_shift_after_presented_is_late(self):
        # pr-run1 lasku-new (M097): the sheet's slide wrote no MOVE, so the title shift was the
        # first move and its own QUIET hid it. The 25 pt move lands 0.64 s after the mark, inside
        # PRESENTED_S; its 17 pt and 10 pt continuation comes after it.
        ev = probe(["STALL 1792288309.258 tab.myynti ms=1535",
                    "MARK 1792288309.258 presented",
                    "MOVE 1792288309.895 tab.myynti n=8 max=25 HostedViewWrapper@135,83,132x34:-25,0 _UINavigationBarTitleControl@135,83,132x34:-25,0 _UIIntrinsicContentSizeInvalidationForwardingWrapperView@135,83,132x34:-25,0",
                    "MOVE 1792288310.023 tab.myynti n=2 max=17 _UIInteractionView@152,83,81x20:17,0 _SwiftUILayerDelegate@152,83,81x20:17,0",
                    "MOVE 1792288310.123 tab.myynti n=3 max=10 _SwiftUILayerDelegate@134,104,133x11:10,-1",
                    "QUIET 1792288310.608 tab.myynti"])
        late, settled = ma.probe_shift(ev, 1792288306.638, 1792288315.021)
        self.assertEqual([e["max"] for e in late], [17, 10])
        self.assertIsNotNone(settled)

    def test_presented_sheet_without_moves_settles(self):
        # koti-settings-sheet (M020): only 'MARK presented' in the window used to mean no settle point.
        late, settled = ma.probe_shift(probe(["ROOT 101.0 settings-sheet 402x778", "MARK 102.0 presented"]), 100.0, 105.0)
        self.assertEqual((late, settled), ([], 2700))
        late, settled = ma.probe_shift(probe(["MARK 104.5 presented"]), 100.0, 105.0)
        self.assertIsNone(settled)

    def test_nav_title_move_after_quiet_is_late(self):
        ev = probe(["MOVE 101.0 purchaseInvoices n=22 max=121 HostingView@-121,0,402x874:-121,0",
                    "QUIET 101.5 purchaseInvoices",
                    "MOVE 101.8 purchaseInvoices n=1 max=85 _UINavigationBarTitleControl@72,73,86x20:-85,0"])
        late, _ = ma.probe_shift(ev, 100.0, 104.0)
        self.assertEqual([e["max"] for e in late], [85])
        # Bar chrome alone is still transition machinery.
        ev[-1] = probe(["MOVE 101.8 purchaseInvoices n=1 max=85 _UINavigationBarContentView@72,73,86x20:-85,0"])[0]
        self.assertEqual(ma.probe_shift(ev, 100.0, 104.0)[0], [])

    def test_scrolljump_before_quiet_fails(self):
        # pankki-accounts-open (M079): the jump came before the probe's QUIET.
        lines = ["SCREEN 100.9 bankAccounts", "MOVE 101.0 bankAccounts n=40 max=300 HostingView@0,0,402x874:300,0",
                 "SCROLLJUMP 101.1 bankAccounts dy=-226", "QUIET 101.6 bankAccounts"]
        late, _ = ma.probe_shift(probe(lines), 100.0, 104.0)
        self.assertEqual([e["kind"] for e in late], ["SCROLLJUMP"])
        with tempfile.TemporaryDirectory() as root:
            r = walk(root, "s", [step("pankki-accounts-open", video=False)], {}, probe_lines=lines)
        self.assertEqual(r["pankki-accounts-open"]["checks"]["shift_probe"], "FAIL")

    def test_refresh_rebound_is_not_a_jump(self):
        # The list going back up when a pull-to-refresh ends is the system's, as on the video.
        base = ["MOVE 101.0 tab.koti n=11 max=60 _UITouchPassthroughView@0,-300,402x874:0,-60", "QUIET 102.0 tab.koti"]
        with tempfile.TemporaryDirectory() as root:
            r = walk(root, "s", [step("koti-refresh", kind="load", video=False)], {},
                     probe_lines=base[:1] + ["SCROLLJUMP 101.5 tab.koti dy=3"] + base[1:])
        self.assertEqual(r["koti-refresh"]["checks"]["shift_probe"], "PASS")
        with tempfile.TemporaryDirectory() as root:
            r = walk(root, "s", [step("koti-refresh", kind="load", video=False)], {},
                     probe_lines=base[:1] + ["SCROLLJUMP 101.5 tab.koti dy=-60"] + base[1:])
        self.assertEqual(r["koti-refresh"]["checks"]["shift_probe"], "FAIL")

    def test_refresh_jump_after_quiet_still_fails(self):
        # w33d-gate3 baseline koti-refresh: dy=4 and dy=26 jumps 4 s after its settle, late before H1 too.
        lines = ["MOVE 101.0 tab.koti n=11 max=60 _UITouchPassthroughView@0,-300,402x874:0,-60", "QUIET 102.0 tab.koti",
                 "SCROLLJUMP 103.3 tab.koti dy=26"]
        with tempfile.TemporaryDirectory() as root:
            r = walk(root, "s", [step("koti-refresh", kind="load", video=False)], {}, probe_lines=lines)
        self.assertEqual(r["koti-refresh"]["probe_shift"], [lines[-1]])
        self.assertEqual(r["koti-refresh"]["checks"]["shift_probe"], "FAIL")


class Intermediate(unittest.TestCase):
    def test_partly_flat_grey_held_frame_is_intermediate(self):
        # M045/M079: a light loading page sits under DISTINCT from both screens.
        loading = B.copy()
        loading[300:300 + int(H * 0.3)] = CANVAS
        loading[420:432, 195:207] = 150  # the spinner
        res = analyze([0.0, 0.6, 0.7, 1.0, 1.1, 1.2], [A, loading, loading, loading, B, B])
        self.assertEqual([x["frame"] for x in res["intermediate"]], [1])
        self.assertLess(res["intermediate"][0]["d_end"], ma.DISTINCT)

    def test_cross_fade_is_not_flagged(self):
        blend = [np.round(A * (1 - a) + B * a).astype(np.uint8) for a in (0.2, 0.4, 0.6, 0.8)]
        res = analyze([0.0, 0.6, 0.7, 0.8, 0.9, 1.0, 1.6], [A, *blend, B, B])
        self.assertEqual(res["intermediate"], [])

    def test_short_finger_pause_is_not_flagged(self):
        # An edge swipe-back held mid-drag: the source dimmed on the left, the screen it leaves on the right.
        mid = np.concatenate([(B[:, :160] * 0.8).astype(np.uint8), A[:, :242]], axis=1)
        pause = analyze([0.0, 0.6, 0.7, 1.1, 1.2, 1.3], [A, mid, mid, mid, B, B], step="periods-swipeback")
        self.assertEqual(pause["intermediate"], [])
        held = analyze([0.0, 0.6, 0.7, 1.6, 1.7, 1.8], [A, mid, mid, mid, B, B], step="periods-swipeback")
        self.assertEqual([x["frame"] for x in held["intermediate"]], [1])


if __name__ == "__main__":
    unittest.main()
