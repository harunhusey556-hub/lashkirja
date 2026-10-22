"""Unit tests for motion-audit.py and motion-gate.py (batch H1): no vacuous PASS, no false FIXED,
spinner pages and late shifts after a stalled presentation caught. Batch H6: frame times, the
contact sheet, and the motion a step is expected to make, each rule with a case it must still fail.
Batch H5: the step's t = 0 is the app's TOUCH, a cut recording is not judged, and a stall counts
against the app only where XCUITest was not driving it.
usage: python3 -m unittest discover -s scripts/sim -p 'test_*.py'
Synthetic frames stand in for ffmpeg; the gate runs as the workflow runs it, as a script."""
import importlib.util, json, os, subprocess, sys, tempfile, unittest
from unittest import mock
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("motion_audit", os.path.join(HERE, "motion-audit.py"))
ma = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ma)
FRAMES = ma.frames  # the ffmpeg reader, before the helpers below swap in synthetic frames

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


def analyze(times, data, tap_s=0.5, step="x-open", probe=()):
    ma.frames = lambda video: (times, np.stack(data))
    hold = (ma.GESTURE_HOLD_S, ma.GESTURE_HOLD_S + 0.4) if ma.GESTURE.search(step) else (ma.HOLD_S, ma.QUIET_S)
    return ma.analyze_video("-", tap_s, *hold, probe=probe)


def probe(lines):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "probe.log")
        with open(p, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        return ma.probe_events(p)


def walk(root, suite, steps, videos, probe_lines=(), notes=(), xcui=()):
    """One walk's directory as the workflow leaves it, analysed with fake videos."""
    d = os.path.join(root, suite)
    os.makedirs(d)
    with open(os.path.join(d, "steps.json"), "w", encoding="utf-8") as f:
        json.dump(steps, f)
    for name in videos:
        open(os.path.join(d, name), "wb").close()
    for name, lines in (("probe.log", probe_lines), ("notes.txt", notes), ("xcui.log", xcui)):
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
    """A step as the walk writes it since H5: the element found and the finger in at the tap."""
    return {"id": sid, "suite": "s", "from": "A", "to": "B", "action": sid, "kind": kind, "expect": "",
            "tapAt": 100.5, "doneAt": 101.0, "recStart": 100.0, "recEnd": 104.0,
            "foundAt": 100.5, "touchAt": 100.5, "pressed": True,
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


class GateNeedsWalks(unittest.TestCase):
    def test_a_walk_with_no_steps_fails_the_gate(self):
        # F003: run 39355446040's walks stopped before their first step; three empty reports read
        # NEW FAIL 0, NEW MISS 0, and the job passed.
        out, code = gate([[], [], []])
        self.assertEqual(code, 1, out)
        self.assertIn("NO WALK: baseline, pr-run1, pr-run2", out)
        out, code = gate([[row("a")], [row("a")], []])
        self.assertEqual(code, 1, out)
        self.assertIn("NO WALK: pr-run2", out)
        out, code = gate([[row("a")], [row("a")], [row("a")]])
        self.assertEqual(code, 0, out)
        self.assertNotIn("NO WALK", out)


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
        self.assertIn("pr-run1: intermediate 0, flash 0, shift_video 0, shift_probe 0, stall 0, crashed 0, steps 1; not judged: NO-MOTION 1", out)
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

    # koti-add-sheet (F011, gate 39636460950): the probe's tick that saw the sheet presented, after
    # a 1.1 s stall, also saw the sheet's list change its offset by 52 pt, 0 to 1 ms after the mark
    # and before the sheet had drawn a frame. Both PR runs read shift_probe FAIL, the baseline's none.
    ADD_SHEET = {
        "pr-run1": (dict(step("koti-add-sheet", kind="sheet", video=False), tapAt=1792603009.7301, doneAt=1792603012.2534,
                          foundAt=1792603009.7301, touchAt=1792603010.087, recStart=1792603008.686, recEnd=1792603016.913),
                    ["TOUCH 1792603010.087 assistant", "MARK 1792603010.170 add-tap", "ROOT 1792603010.374 add-sheet 402x435",
                     "SCREEN 1792603010.375 add-sheet", "STALL 1792603011.185 add-sheet ms=1122", "MARK 1792603011.185 presented",
                     "SCROLLJUMP 1792603011.186 add-sheet dy=52", "STALL 1792603011.442 add-sheet ms=257"]),
        "pr-run2": (dict(step("koti-add-sheet", kind="sheet", video=False), tapAt=1792603402.7449, doneAt=1792603405.6622,
                          foundAt=1792603402.7448, touchAt=1792603403.351, recStart=1792603401.387, recEnd=1792603410.545),
                    ["TOUCH 1792603403.351 assistant",
                     "MOVE 1792603403.410 assistant n=31 max=270 _UILiquidLensView@295,787,90x70:270,-8 UIView@295,787,90x70:270,-8 ClearGlassView@295,787,90x70:270,-8",
                     "MARK 1792603403.434 add-tap", "ROOT 1792603403.613 add-sheet 402x435", "SCREEN 1792603403.613 add-sheet",
                     "STALL 1792603404.515 add-sheet ms=1106", "MARK 1792603404.516 presented", "SCROLLJUMP 1792603404.516 add-sheet dy=52",
                     "MOVE 1792603404.517 add-sheet n=48 max=270 _UILiquidLensView@25,795,74x54:-270,8 UIView@25,795,74x54:-270,8 BackdropView@25,795,74x54:-270,8",
                     "STALL 1792603404.827 add-sheet ms=251", "STALL 1792603405.096 add-sheet ms=269", "QUIET 1792603405.097 add-sheet"]),
    }

    def test_scrolljump_in_the_presented_tick_is_not_a_shift(self):
        for run, (koti, lines) in self.ADD_SHEET.items():
            with tempfile.TemporaryDirectory() as root:
                r = walk(root, "s", [koti], {}, probe_lines=lines)["koti-add-sheet"]
            self.assertEqual((r["probe_shift"], r["checks"]["shift_probe"]), ([], "PASS"), run)

    def test_scrolljump_after_the_presented_tick_still_fails(self):
        # chat-open (gate 39697234353): the jump came 0.159 s after the mark, one tick on, with the
        # sheet already drawing; it stays a shift. So does any jump past SAME_TICK_S, or before the mark.
        mark = "MARK 1792630254.184 presented"
        for jump in ("SCROLLJUMP 1792630254.343 assistant dy=62", "SCROLLJUMP 1792630254.240 assistant dy=62",
                     "SCROLLJUMP 1792630254.183 assistant dy=62"):
            late, _ = ma.probe_shift(probe([mark, jump, "QUIET 1792630254.900 assistant"]), 1792630253.289, 1792630260.75)
            self.assertEqual([e["raw"] for e in late], [jump], jump)


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


def listing(off):
    """A long list scrolled by off pt: a card every 100 pt, each with its own line lengths."""
    f = screen([])
    for k, y in enumerate(range(150 - off, 2000 - off, 100)):
        if 120 < y < 700:
            w = 100 + (k * 67) % 240
            f[y:y + 80, 16:386] = CARD
            f[y + 16:y + 26, 32:32 + w] = INK
            f[y + 44:y + 52, 32:32 + w // 2] = INK
    return f


def pulled(f, dy):
    """f with everything between the status bar and the tab bar pulled down by dy pt."""
    out = f.copy()
    out[60 + dy:790] = f[60:790 - dy]
    out[60:60 + dy] = CANVAS
    return out


def fading(a, b, w):
    """A SwiftUI cross-fade w of the way: b fades in over a fading out over the canvas."""
    return np.round(w * b + (1 - w) ** 2 * a + w * (1 - w) * CANVAS).astype(np.uint8)


def ffmpeg_run(pts, best_effort, h=8):
    """subprocess.run for frames(): showinfo prints the frames' own pts when ffmpeg ignores the
    DTS, its best_effort_timestamp otherwise."""
    def run(cmd, capture_output):
        times = pts if "+igndts" in cmd else best_effort
        err = "".join(f"[Parsed_showinfo_2 @ 0] n:{i} pts:{round(t * 600)} pts_time:{t:g} duration:1\n"
                      for i, t in enumerate(times))
        return subprocess.CompletedProcess(cmd, 0, stdout=bytes(len(times) * ma.W * h), stderr=err.encode())
    return run


def inter_frames(res):
    return [x["frame"] for x in res["intermediate"]]


def chat_screens():
    """Avustaja waiting under the question (the typing dots), and with the three-line answer there."""
    question = screen([150])
    question[290:300, 40:70] = INK
    answer = screen([150])
    answer[270:390, 16:386] = CARD
    for y, w in ((286, 330), (310, 300), (334, 250)):
        answer[y:y + 10, 32:32 + w] = INK
    return question, answer


class Timestamps(unittest.TestCase):
    def test_frames_read_their_own_pts(self):
        # pr-run1 raportit-zip-close (M042): two pts tie, ffmpeg's best effort drops to the DTS,
        # 1.2 s behind, and the contact sheet read #16 +2.21 s, then #18 +1.05 s.
        pts = [0.0, 2.19, 2.75, 2.768, 2.768, 2.93, 4.11]
        with mock.patch.object(ma.subprocess, "run", ffmpeg_run(pts, [0.0, 2.19, 2.75, 2.768, 1.597, 1.75, 2.93])):
            times, data = FRAMES("m.mov")
        self.assertEqual((times, data.shape), (pts, (7, 8, ma.W)))

    def test_best_effort_when_the_pts_go_back(self):
        best = [0.0, 0.5, 0.9, 1.4]
        with mock.patch.object(ma.subprocess, "run", ffmpeg_run([0.0, 0.5, 0.3, 1.4], best)):
            self.assertEqual(FRAMES("m.mov")[0], best)

    def test_times_that_still_go_back_are_not_judged(self):
        frames = ([0.1, 0.6, 0.7, 0.65, 1.5], np.stack([A, B, B, B, B]))
        with tempfile.TemporaryDirectory() as root:
            r = walk(root, "s", [step("a")], {"m-a.mov": frames})["a"]
        self.assertEqual(r["checks"]["intermediate"], "n/a (bad timestamps)")
        self.assertEqual(r["checks"]["shift_video"], "n/a (bad timestamps)")
        self.assertEqual(r["checks"]["flash"], "PASS")  # frame order alone finds a flash

    def test_tied_times_are_judged(self):
        frames = ([0.1, 0.6, 0.7, 0.7, 1.5], np.stack([A, B, B, B, B]))
        with tempfile.TemporaryDirectory() as root:
            r = walk(root, "s", [step("a")], {"m-a.mov": frames})["a"]
        self.assertEqual(set(r["checks"].values()) - {"n/a"}, {"PASS"})


class ContactSheet(unittest.TestCase):
    def shown(self, n, flags=(), settle=None):
        """The frames the sheet shows, read back from the png: frame i is filled with grey 3i + 2."""
        res = {"times": [i * 0.1 for i in range(n)], "flags": list(flags), "tap_i": 1,
               "settle_i": n - 1 if settle is None else settle,
               "data": np.stack([np.full((H, ma.W), 3 * i + 2, np.uint8) for i in range(n)])}
        with tempfile.TemporaryDirectory() as d:
            ma.contact_sheet(os.path.join(d, "sheet.png"), res, 0.0)
            img = np.asarray(Image.open(os.path.join(d, "sheet.png")).convert("L"))
        tw, th = 134, int(134 * H / ma.W)
        tiles = [img[(k // 10) * (th + 22) + 3 + th // 2, (k % 10) * (tw + 6) + 3 + tw // 2]
                 for k in range(img.shape[0] // (th + 22) * 10)]
        return [(int(v) - 2) // 3 for v in tiles if v != 255]

    def test_settle_last_and_flags_are_never_cut(self):
        # koti-settings-sheet (M021): 56 frames, the sheet stopped at #39 and lost the Asetukset sheet.
        for n, flags in ((41, ()), (56, (50,)), (57, ()), (78, (44, 70))):
            got = self.shown(n, flags, settle=n - 2)
            self.assertLessEqual({0, 1, n - 2, n - 1, *flags}, set(got), n)
            self.assertLessEqual(len(got), 40, n)

    def test_long_videos_are_still_sampled(self):
        self.assertEqual(self.shown(20), list(range(20)))
        got = self.shown(84, (70,))
        self.assertLessEqual({0, 1, 70, 83}, set(got))
        self.assertLessEqual(len(got), 33)


class ProbeCrossCheck(unittest.TestCase):
    # lasku-form-scroll baseline (M093): one frame written twice mid-fling, then nothing for 0.37 s
    # while the probe logged the list decelerating every 0.1 s.
    HOLD = ([0.0, 0.6, 0.75, 0.76, 1.13, 1.3, 1.9],
            [listing(0), listing(120), listing(230), listing(230), listing(330), listing(470), listing(470)])
    FLING = [(0.77, "MOVE"), (0.86, "MOVE"), (0.97, "MOVE"), (1.07, "MOVE")]

    def test_hold_the_probe_saw_moving_is_a_recorder_stall(self):
        self.assertEqual(inter_frames(analyze(*self.HOLD)), [2])
        self.assertEqual(inter_frames(analyze(*self.HOLD, probe=self.FLING)), [])

    def test_hold_the_probe_did_not_see_moving_is_a_screen(self):
        # One move is the change that ends the hold (raportit-prev-year's spinner page, M045).
        self.assertEqual(inter_frames(analyze(*self.HOLD, probe=[(1.07, "MOVE")])), [2])
        # Moves over part of the hold leave the rest standing.
        self.assertEqual(inter_frames(analyze(*self.HOLD, probe=[(0.77, "MOVE"), (0.8, "MOVE")])), [2])
        # Frames kept coming: the recorder ran, the screen held (kirjanpito-purchases-open, H1 run).
        t, d = self.HOLD
        kept = ([*t[:3], 0.8, 0.85, 0.9, 0.95, 1.0, 1.05, *t[4:]], [*d[:3], *[d[2]] * 6, *d[4:]])
        self.assertEqual(inter_frames(analyze(*kept, probe=self.FLING)), [2])

    @staticmethod
    def sheet_rise():
        """koti-add-sheet pr-run1 (M013): the tab-bar lens moves until +0.9 s, the main thread
        stalls 0.94 s before the presentation, and the sheet rises from +1.56 s."""
        lens = [A.copy() for _ in range(3)]
        for k, f in enumerate(lens):
            f[795:840, 40 + 60 * k:110 + 60 * k] = 120
        sheets = []
        for top in (700, 560, 440, 440):
            f = A.copy()
            f[top:] = 252
            f[top + 30:top + 44, 150:250] = 40
            sheets.append(f)
        return [0.0, 0.6, 0.75, 0.9, 1.56, 1.62, 1.68, 2.5], [A, *lens, *sheets]

    def test_pause_with_the_sheet_presented_in_it_is_not_the_end(self):
        self.assertNotEqual(analyze(*self.sheet_rise())["shift"], [])
        self.assertEqual(analyze(*self.sheet_rise(), probe=[(1.36, "MARK")])["shift"], [])
        # The presentation before the pause does not reach into it.
        self.assertNotEqual(analyze(*self.sheet_rise(), probe=[(0.8, "MARK")])["shift"], [])

    def test_probe_lines_on_the_video_clock(self):
        t, d = self.sheet_rise()
        lines = ["MOVE 100.700 add-sheet n=1 max=40 _UILiquidLensView@0,0,90x70:40,0", "QUIET 101.100 add-sheet"]
        with tempfile.TemporaryDirectory() as root:
            r = walk(root, "s", [step("add", kind="sheet")], {"m-add.mov": (t, np.stack(d))},
                     probe_lines=lines + ["MARK 101.360 presented"])["add"]
        self.assertEqual(r["checks"]["shift_video"], "PASS")
        # A move after the probe's QUIET is a late shift, not the step still moving.
        with tempfile.TemporaryDirectory() as root:
            r = walk(root, "s", [step("add", kind="sheet")], {"m-add.mov": (t, np.stack(d))},
                     probe_lines=lines + ["MOVE 101.300 add-sheet n=1 max=12 HostingView@0,0,402x874:0,12"])["add"]
        self.assertEqual(r["checks"]["shift_video"], "FAIL")


class ExpectedMotion(unittest.TestCase):
    def test_refresh_rebound_past_80_pt_is_the_rebound(self):
        # koti-refresh baseline (M014): the recorder missed the rebound, and the page came back
        # 215 pt in one frame after a 0.62 s gap; a search of +-80 pt called it a pop.
        koti = screen([150, 260, 330, 480, 600], text_w=260)
        frames = ([0.0, 0.6, 0.9, 1.2, 1.82, 2.5],
                  np.stack([koti, pulled(koti, 100), pulled(koti, 170), pulled(koti, 215), koti, koti]))
        with tempfile.TemporaryDirectory() as root:
            r = walk(root, "s", [step("koti-refresh", kind="load"), step("koti-open")],
                     {"m-koti-refresh.mov": frames, "m-koti-open.mov": frames})
        self.assertEqual(r["koti-refresh"]["checks"]["shift_video"], "PASS")
        # A page jumping up 215 pt is still a shift where no refresh explains it.
        self.assertEqual(r["koti-open"]["checks"]["shift_video"], "FAIL")
        self.assertEqual([(x["what"], x["dy_pt"]) for x in r["koti-open"]["shift"]], [("move", -215)])

    # chat-send baseline (M065): the answer replaces the typing dots under the question 1.5 s after
    # the step went quiet, and nothing above it moves.
    QUESTION, ANSWER = chat_screens()

    def chat(self, kind, frames):
        times = [0.0, 0.6, 0.7, 2.2, 2.6, 3.4][:len(frames)]
        with tempfile.TemporaryDirectory() as root:
            return walk(root, "s", [step("chat-send", kind=kind)], {"m-chat-send.mov": (times, np.stack(frames))})["chat-send"]

    def test_answer_under_unchanged_content_is_the_arrival(self):
        q, a = self.QUESTION, self.ANSWER
        self.assertEqual(self.chat("load", [A, q, q, a, a])["checks"]["shift_video"], "PASS")

    def test_late_content_that_is_not_an_answer_still_fails(self):
        q, a = self.QUESTION, self.ANSWER
        # Not a load step: nothing was asked for.
        self.assertEqual(self.chat("nav", [A, q, q, a, a])["checks"]["shift_video"], "FAIL")
        # Gone again by the end: not where the step lands.
        self.assertEqual(self.chat("load", [A, q, q, a, q, q])["checks"]["shift_video"], "FAIL")
        # The title above changed with it.
        retitled = a.copy()
        retitled[90:104, 150:250] = CANVAS
        retitled[90:104, 120:280] = 40
        self.assertEqual(self.chat("load", [A, q, q, retitled, retitled])["checks"]["shift_video"], "FAIL")

    # bad-capture-upload (M002): the queue page settles, the reading finishes and the page fades
    # into the form in 0.4 s, which at ~4 fps lands as 2-4 frames that each read as a pop.
    QUEUE, FORM = A, B

    def fade(self, times, frames):
        return analyze([0.0, 0.6, 0.7, *times, 4.4], [screen([]), self.QUEUE, self.QUEUE, *frames, self.FORM])["shift"]

    def test_cross_fade_is_one_transition(self):
        q, f = self.QUEUE, self.FORM
        self.assertEqual(self.fade([3.1, 3.2, 3.3, 3.4], [fading(q, f, w) for w in (0.3, 0.6, 0.85)] + [f]), [])

    def test_late_change_that_is_not_one_cross_fade_still_fails(self):
        q, f = self.QUEUE, self.FORM
        # A pop: no frame between the two pages.
        self.assertNotEqual(self.fade([3.1], [f]), [])
        # Slower than BLEND_S.
        self.assertNotEqual(self.fade([3.1, 3.4, 3.7, 4.0], [fading(q, f, w) for w in (0.3, 0.6, 0.85)] + [f]), [])
        # Back and forth.
        self.assertNotEqual(self.fade([3.1, 3.2, 3.3, 3.4], [fading(q, f, w) for w in (0.6, 0.3, 0.85)] + [f]), [])
        # A slide in from the right.
        self.assertNotEqual(self.fade([3.1, 3.2, 3.3], [np.concatenate([q[:, k:], f[:, :k]], axis=1) for k in (140, 280)] + [f]), [])


def legacy(sid, **over):
    """A step as the walk wrote it before H5: tapAt stamped before XCUITest looked for the element,
    no foundAt, touchAt or pressed."""
    out = {k: v for k, v in step(sid).items() if k not in ("foundAt", "touchAt", "pressed")}
    out.update(over)
    return out


# A push whose tap XCUITest delivered 1.5 s after the stamp: the screen moves 0.5 s after the touch.
PUSH = ([0.25, 2.5, 2.75, 3.0, 3.5], np.stack([A, B, B, B, B]))


class TouchIsTimeZero(unittest.TestCase):
    def test_tap_s_comes_from_touch(self):
        # M046/M056: settle_ms held XCUITest's look for the element (tapAt 100.5, touch 102.0).
        with tempfile.TemporaryDirectory() as root:
            r = walk(root, "s", [legacy("push", doneAt=102.2, recEnd=104.0)], {"m-push.mov": PUSH},
                     probe_lines=["TOUCH 102.000 tab.koti"])["push"]
        self.assertEqual(r["settle_ms"], 500)
        self.assertEqual(r["touch_ms"], 1500)
        # The walk's own touchAt is taken first.
        with tempfile.TemporaryDirectory() as root:
            r = walk(root, "s", [dict(step("push"), doneAt=102.2, touchAt=102.0)], {"m-push.mov": PUSH},
                     probe_lines=["TOUCH 101.500 tab.koti"])["push"]
        self.assertEqual(r["settle_ms"], 500)

    def test_pressed_step_without_touch_is_an_error(self):
        # Today's steps.json: no touchAt, and its probe.log has no TOUCH; t = 0 is unknown.
        with tempfile.TemporaryDirectory() as root:
            r = walk(root, "s", [legacy("push", doneAt=102.2)], {"m-push.mov": PUSH},
                     probe_lines=["MOVE 102.300 tab.koti n=4 max=120 HostingView@0,0,402x874:120,0", "QUIET 102.800 tab.koti"])["push"]
        self.assertEqual(set(r["checks"].values()), {"NO-TOUCH"})
        # A link moves no finger on the app: its stamp is its t = 0.
        with tempfile.TemporaryDirectory() as root:
            r = walk(root, "s", [dict(legacy("link"), pressed=False, tapAt=101.8, doneAt=102.0)], {"m-link.mov": PUSH})["link"]
        self.assertNotIn("NO-TOUCH", r["checks"].values())
        self.assertEqual(r["checks"]["intermediate"], "PASS")

    def test_recording_cut_at_the_action_is_not_judged(self):
        # M029/M096: the tap came after the recording had ended, and every check passed on nothing.
        with tempfile.TemporaryDirectory() as root:
            rows = walk(root, "s", [dict(step("cut"), doneAt=103.6), dict(step("full"), doneAt=103.0)],
                        {"m-cut.mov": PUSH, "m-full.mov": PUSH})
        self.assertEqual(set(rows["cut"]["checks"].values()), {"MISS-WINDOW"})
        self.assertNotIn("MISS-WINDOW", rows["full"]["checks"].values())

    def test_walk_timing_is_in_the_report(self):
        with tempfile.TemporaryDirectory() as root:
            walk(root, "s", [dict(step("cut"), doneAt=103.6), dict(step("late"), foundAt=100.3), legacy("old")],
                 {"m-cut.mov": PUSH, "m-late.mov": PUSH, "m-old.mov": PUSH})
            with open(os.path.join(root, "motion-report.md"), encoding="utf-8") as f:
                report = f.read()
        self.assertIn("Walk timing: 1 recordings ended within 1 s of the action, 1 pressed steps have no TOUCH, "
                      "1 taps went out 50 ms or more after their element was found.", report)


# myynti-customer-open in the baseline of gate 39525842170 (F007): the recorder wrote frames at 0,
# 0.662 and 0.667 s, nothing until 4.0 s, then 31 within 0.2 s. The finger came at 1.981 s, the push
# at 2.428 s, a 0.44 s stall ended at 2.88 s and the title moved at 3.115 s: all inside the hole.
# The old analyzer read PASS on intermediate, flash, shift_video and stall there (the report said
# settle_ms 2019, app_stall_ms 438), FAIL on shift_probe.
HOLE_TIMES = [0.0, 0.662, 0.667, 4.0, 4.03, 4.042, 4.048, 4.057, 4.063, 4.073, 4.085, 4.087, 4.09, 4.092, 4.095, 4.102, 4.105,
              4.107, 4.12, 4.122, 4.123, 4.132, 4.133, 4.135, 4.143, 4.145, 4.155, 4.157, 4.158, 4.17, 4.173, 4.175, 4.187, 4.19]
HOLE_STEP = {"id": "myynti-customer-open", "suite": "myynti", "from": "Asiakkaat", "to": "Asiakas", "action": "myynti-customer-open",
             "kind": "nav", "expect": "single destination", "tapAt": 1792554541.5766, "doneAt": 1792554542.2762,
             "recStart": 1792554539.895, "recEnd": 1792554547.655, "foundAt": 1792554541.5766, "touchAt": 1792554541.876,
             "pressed": True, "video": "m-myynti-customer-open.mov", "reached": True, "skipped": False, "crashed": False}
HOLE_PROBE = ["STALL 1792554541.559 customers ms=466", "TOUCH 1792554541.876 customers",
              "SCREEN 1792554542.129 customer", "STALL 1792554542.276 customer ms=415",
              "MOVE 1792554542.323 customer n=9 max=121 HostingView@-121,0,402x874:-121,0",
              "STALL 1792554542.898 customer ms=438", "QUIET 1792554542.899 customer",
              "MOVE 1792554543.010 customer n=5 max=17 HostedViewWrapper@153,73,95x20:-17,0 _UINavigationBarTitleControl@153,73,95x20:-17,0",
              "QUIET 1792554543.461 customer"]
HOLE_XCUI = ["XCUI begin 1792554540.349 myynti-customer-open", "XCUI end 1792554542.276 myynti-customer-open"]
NOT_FILMED = "n/a (not filmed)"


def hole_walk(times=None, probe_lines=HOLE_PROBE):
    """The step walked with a recording that has `times` for frames: the start screen until the
    finger at 1.981 s, the end screen after. Returns the analyzer's row and the report text."""
    times = HOLE_TIMES if times is None else times
    frames = np.stack([A if t < 1.981 else B for t in times])
    with tempfile.TemporaryDirectory() as root:
        r = walk(root, "myynti", [HOLE_STEP], {"m-myynti-customer-open.mov": (times, frames)},
                 probe_lines=probe_lines, xcui=HOLE_XCUI)["myynti-customer-open"]
        with open(os.path.join(root, "motion-report.md"), encoding="utf-8") as f:
            return r, f.read().splitlines()


class RecordingHole(unittest.TestCase):
    def test_step_the_recording_did_not_film_is_not_judged(self):
        # F007: the push, the stall and the title change fell in the hole, and the step read PASS.
        r, _ = hole_walk()
        self.assertAlmostEqual(r["settle_ms"], 2019, delta=1)  # the numbers gate 39525842170 printed
        self.assertEqual(r["app_stall_ms"], 438)
        self.assertEqual(r["film_wait_ms"], 1572)
        self.assertEqual(r["checks"], {"intermediate": NOT_FILMED, "flash": NOT_FILMED, "shift_video": NOT_FILMED,
                                       "shift_probe": "FAIL", "stall": NOT_FILMED})
        # The probe saw the whole step whatever the recorder wrote: without the title move its PASS stands.
        r, _ = hole_walk(probe_lines=HOLE_PROBE[:-2])
        self.assertEqual(r["checks"], {"intermediate": NOT_FILMED, "flash": NOT_FILMED, "shift_video": NOT_FILMED,
                                       "shift_probe": "PASS", "stall": NOT_FILMED})

    def test_the_same_step_with_frames_after_the_push_is_judged(self):
        # The recorder wrote a frame 0.12 s after the push: the step is judged, and its 438 ms stall is a PASS.
        r, _ = hole_walk([*HOLE_TIMES[:3], 2.55, 3.2, *HOLE_TIMES[3:]])
        self.assertEqual(r["film_wait_ms"], 122)
        self.assertEqual(r["checks"], {"intermediate": "PASS", "flash": "PASS", "shift_video": "PASS",
                                       "shift_probe": "FAIL", "stall": "PASS"})

    def test_the_gap_is_where_a_wait_stops_being_filmed(self):
        # filter-late in gate 39697234353 waited 0.97 s for its frame and was filmed.
        self.assertEqual(ma.REC_GAP_S, 1.0)
        for frame_at, verdict in ((2.428 + 0.95, "PASS"), (2.428 + 1.05, NOT_FILMED)):
            r, _ = hole_walk([*HOLE_TIMES[:3], frame_at, *HOLE_TIMES[3:]])
            self.assertEqual(r["checks"]["intermediate"], verdict, frame_at)

    def test_film_wait(self):
        times = [0.0, 0.5, 4.0]
        self.assertEqual(ma.film_wait(times, [], 5.0), 0)
        self.assertAlmostEqual(ma.film_wait(times, [0.4, 2.0], 5.0), 2.0)  # the longer wait counts
        self.assertAlmostEqual(ma.film_wait(times, [4.2], 5.0), 0.8)  # no frame after: until the recording ends
        self.assertEqual(ma.film_wait(times, [5.5], 5.0), 0)  # a move after the recording is MISS-WINDOW's to say

    def test_silence_without_a_move_of_the_step_is_a_still_screen(self):
        # The simulator writes a frame only when the screen changes: the same hole without the push
        # and the title move in the probe is a page that held still.
        r, _ = hole_walk(probe_lines=[x for x in HOLE_PROBE if not x.startswith(("MOVE", "QUIET"))])
        self.assertEqual(r["film_wait_ms"], 0)
        self.assertNotIn(NOT_FILMED, r["checks"].values())

    def test_report_counts_the_steps_and_shows_the_wait(self):
        _, report = hole_walk()
        self.assertIn("1 steps went 1 s or more without a frame after a move of their own.",
                      next(x for x in report if x.startswith("Walk timing")))
        self.assertIn("n/a (not filmed) 1", next(x for x in report if "Not judged" in x))
        header = next(x for x in report if x.startswith("| suite |"))
        row = next(x for x in report if x.startswith("| myynti | myynti-customer-open |"))
        cells = [c.strip() for c in header.split("|")]
        self.assertEqual([c.strip() for c in row.split("|")][cells.index("film wait ms")], "1572")

    def test_gate_does_not_call_the_hole_a_new_fail_nor_a_fix(self):
        # The step's gate rows: the baseline as the analyzer reads it above, the PR runs as gate
        # 39525842170 read them (they filmed the spinner page): there 3 NEW FAIL, now none.
        def report(checks):
            return [{"suite": "myynti", "id": "myynti-customer-open", "crashed": False, "checks": checks}]
        pr = report({"intermediate": "FAIL", "flash": "PASS", "shift_video": "FAIL", "shift_probe": "FAIL", "stall": "FAIL"})
        passed = report(dict.fromkeys(ma.KS, "PASS"))
        out, code = gate([report(hole_walk()[0]["checks"]), pr, pr])
        self.assertEqual((count(out, "NEW FAIL"), count(out, "FIXED"), count(out, "NEW MISS"), code), (0, 0, 0, 0), out)
        self.assertIn("not judged: NO-MOTION 0, UNREACHED 0, SKIPPED 0, MISS-WINDOW 0, NO-TOUCH 0, n/a (no settle) 0, n/a (not filmed) 1", out)
        out, _ = gate([passed, pr, pr])  # a baseline that filmed and passed: the four FAILs are NEW FAILs
        self.assertEqual(count(out, "NEW FAIL"), 4, out)
        out, _ = gate([report(dict.fromkeys(ma.KS, "FAIL")), passed, passed])
        self.assertEqual(count(out, "FIXED"), 5, out)
        out, _ = gate([report(dict.fromkeys(ma.KS, NOT_FILMED)), passed, passed])
        self.assertEqual(count(out, "FIXED"), 0, out)
        lost = report({**dict.fromkeys(ma.KS, NOT_FILMED), "shift_probe": "PASS"})
        out, _ = gate([report(dict.fromkeys(ma.KS, "FAIL")), lost, lost])
        self.assertEqual(count(out, "FIXED"), 1, out)  # a hole fixes nothing but what the probe saw
        # A branch whose recordings lose what the baseline filmed has lost what the gate could see.
        out, code = gate([passed, lost, lost])
        self.assertEqual((count(out, "NEW MISS"), code), (4, 1), out)


# xcui.log of a tap: XCUITest looks the element up until the touch, then waits for the app to idle.
TAP = ["XCUI begin 100.400 push", "XCUI end 103.300 push"]


class StallAttribution(unittest.TestCase):
    def stall(self, probe_lines, xcui=TAP, touch=100.5):
        with tempfile.TemporaryDirectory() as root:
            return walk(root, "s", [dict(step("push"), doneAt=103.3, recEnd=106.0, touchAt=touch)], {"m-push.mov": PUSH},
                        probe_lines=probe_lines, xcui=xcui)["push"]

    def test_stall_after_the_touch_is_the_apps(self):
        # raportit-tab (M040): the main thread held 0.9 s after the tab's touch.
        r = self.stall(["STALL 100.500 tab.koti ms=1400", "TOUCH 100.500 tab.koti", "STALL 101.700 tab.raportit ms=900"])
        self.assertEqual(r["app_stall_ms"], 900)
        self.assertEqual(r["checks"]["stall"], "FAIL")

    def test_xcuitest_snapshots_are_not_the_apps(self):
        # Before the touch XCUITest resolves the element on the app's main thread (M003, M069).
        lines = ["STALL 101.900 tab.koti ms=1300", "TOUCH 102.000 tab.koti"]
        r = self.stall(lines, touch=102.0)
        self.assertEqual(r["app_stall_ms"], 0)
        self.assertEqual(r["checks"]["stall"], "PASS")
        # A wait inside the recording that touched nothing is XCUITest's whole (an element going away).
        until = ["TOUCH 100.500 tab.koti", "STALL 104.800 tab.koti ms=1200"]
        r = self.stall(until, xcui=TAP + ["XCUI begin 103.500 push.until", "XCUI end 105.000 push.until"])
        self.assertEqual(r["app_stall_ms"], 0)
        # Without that stretch the same stall is the app's.
        self.assertEqual(self.stall(until)["app_stall_ms"], 1200)

    def test_short_stall_passes_and_no_log_is_not_judged(self):
        self.assertEqual(self.stall(["TOUCH 100.500 tab.koti", "STALL 101.000 tab.koti ms=400"])["checks"]["stall"], "PASS")
        # A walk without xcui.log cannot tell XCUITest's time from the app's.
        self.assertEqual(self.stall(["TOUCH 100.500 tab.koti", "STALL 101.700 tab.koti ms=900"], xcui=())["checks"]["stall"], "n/a")

    def test_a_stall_just_over_the_line_still_fails(self):
        # asetukset-help-open (gate 39636460950): 526 and 516 ms are FAIL in their runs; the gate's
        # NEW FAIL listing has a margin (GateStall), the verdict of a run has not.
        r = self.stall(["TOUCH 100.500 tab.koti", "STALL 101.100 tab.koti ms=526"])
        self.assertEqual((r["app_stall_ms"], r["checks"]["stall"]), (526, "FAIL"))

    def test_report_has_the_app_stall_column(self):
        with tempfile.TemporaryDirectory() as root:
            walk(root, "s", [dict(step("push"), doneAt=103.3, recEnd=106.0)], {"m-push.mov": PUSH},
                 probe_lines=["TOUCH 100.500 tab.koti", "STALL 101.700 tab.raportit ms=900"], xcui=TAP)
            with open(os.path.join(root, "motion-report.md"), encoding="utf-8") as f:
                report = f.read().splitlines()
        header = next(x for x in report if x.startswith("| suite |"))
        row = next(x for x in report if x.startswith("| s | push |"))
        cells = [c.strip() for c in header.split("|")]
        self.assertIn("app stall ms", cells)
        self.assertEqual([c.strip() for c in row.split("|")][cells.index("app stall ms")], "900")
        self.assertEqual([c.strip() for c in row.split("|")][cells.index("stall")], "FAIL")


class GateStall(unittest.TestCase):
    @staticmethod
    def tab(stall):
        r = row("tab")
        r["checks"]["stall"] = stall
        return r

    def test_stall_is_gated_and_new_fail_says_it_does_not_fail_the_job(self):
        # raportit-tab (M040): the stall check is a row of the gate like the four others.
        out, code = gate([[self.tab("PASS")], [self.tab("FAIL")], [self.tab("FAIL")]])
        self.assertEqual(count(out, "NEW FAIL"), 1)
        self.assertEqual(code, 0)
        line = next(x for x in out.splitlines() if x.startswith("NEW FAIL"))
        self.assertIn("does not fail", line)

    # app_stall_ms (baseline, pr-run1, pr-run2) of the four stall NEW FAILs that gates 39636460950
    # and 39697234353 listed, from their motion-report.json. All four were noise: on the one
    # baseline tree the same steps read 1206 and 418 ms (chat-send), 798, 631 and 451 (prev-year).
    NOISE = {"asetukset-help-open": (493, 526, 516), "raportit-prev-year": (451, 533, 533),
             "raportit-category-picker": (482, 601, 650), "chat-send": (418, 843, 1182)}

    @staticmethod
    def timed(sid, ms, **over):
        r = row(sid, **over)
        r["checks"]["stall"] = "FAIL" if ms >= ma.STALL_MS else "PASS"
        r["app_stall_ms"] = ms
        return r

    def stalls(self, readings):
        """The gate's output for steps whose stall read (baseline, pr-run1, pr-run2)."""
        return gate([[self.timed(sid, r[i]) for sid, r in readings.items()] for i in range(3)])

    def test_noise_between_runs_of_one_tree_is_not_a_new_fail(self):
        out, code = self.stalls(self.NOISE)
        self.assertEqual((count(out, "NEW FAIL"), count(out, "STALL WITHIN MARGIN"), code), (0, 4, 0), out)
        self.assertIn("| raportit-category-picker | stall | PASS | FAIL | FAIL | within margin (482 -> 601, 650 ms) |", out)

    def test_a_big_slowdown_is_still_listed(self):
        # raportit-tab (M040): the main thread held 0.9 s after the tab's touch.
        out, _ = self.stalls({"raportit-tab": (120, 900, 950)})
        self.assertEqual((count(out, "NEW FAIL"), count(out, "STALL WITHIN MARGIN")), (1, 0), out)
        self.assertIn("| raportit-tab | stall | PASS | FAIL | FAIL | NEW FAIL |", out)

    def test_the_margin_is_the_gap_between_the_baseline_and_the_shorter_pr_stall(self):
        m = ma.STALL_MS  # the margin is as long as the line: a run is FAIL from there, the gate waits a line more
        for readings, listed in (((400, 400 + m, 950), 1), ((400, 400 + m - 1, 950), 0),
                                 ((300, 1200, 700), 0), ((300, 800, 1200), 1)):
            out, _ = self.stalls({"a": readings})
            self.assertEqual(count(out, "NEW FAIL"), listed, readings)

    def test_a_crash_and_a_report_without_readings_are_listed_as_before(self):
        base = self.timed("a", 100)
        crashed = self.timed("a", 150, crashed=True)
        crashed["checks"]["stall"] = "FAIL"
        out, _ = gate([[base], [crashed], [crashed]])
        self.assertIn("| a | stall | PASS | CRASH | CRASH | NEW FAIL |", out)
        old = self.timed("a", 900)
        del old["app_stall_ms"]
        out, _ = gate([[base], [old], [old]])
        self.assertEqual((count(out, "NEW FAIL"), count(out, "STALL WITHIN MARGIN")), (1, 0), out)

    def test_cut_or_untouched_pr_walks_are_new_misses(self):
        for miss in ("MISS-WINDOW", "NO-TOUCH"):
            prs = [[{"suite": "s", "id": "a", "crashed": False, "checks": dict.fromkeys(ma.KS, miss)}] for _ in range(2)]
            out, code = gate([[row("a")], *prs])
            self.assertEqual((count(out, "NEW MISS"), code), (4, 1), miss)
            self.assertIn(f"{miss} 1", out)


class PrebuildFreed(unittest.TestCase):
    COPIES = ["MARK 100.100 prebuild-0-skipped", "MARK 100.300 prebuild-1-Myynti", "MARK 100.900 prebuild-Myynti-built_ms=600",
              "MARK 102.900 prebuild-Myynti-freed=%s", "MARK 102.900 prebuild-Myynti-host-freed=true",
              "MARK 102.900 prebuild-Myynti-window-freed=%s",
              "MARK 103.400 prebuild-Kirjanpito-freed=true", "MARK 103.800 prebuild-Lisää-freed=true"]

    def report(self, myynti_freed, extra=()):
        lines = [x % ((myynti_freed,) * x.count("%s")) if "%s" in x else x for x in self.COPIES] + list(extra)
        with tempfile.TemporaryDirectory() as root:
            rows = walk(root, "s", [step("tab", video=False)], {}, probe_lines=lines, xcui=())
            with open(os.path.join(root, "motion-report.md"), encoding="utf-8") as f:
                return rows, f.read()

    def test_a_copy_still_alive_fails_the_walk_and_is_named(self):
        # M086: the Myynti copy was alive 2 s after TabPrebuild threw it away in every CI launch.
        rows, report = self.report("false")
        r = rows["prebuild-freed"]
        self.assertEqual(r["checks"]["prebuild"], "FAIL")
        self.assertEqual(r["prebuild_kept"], ["Myynti"])
        self.assertIn("prebuild copies kept 1", report)
        self.assertIn("tab copies still alive 2 s after they were thrown away: Myynti", report)

    def test_every_copy_released_passes_and_the_controller_line_is_not_a_copy(self):
        rows, report = self.report("true")
        self.assertEqual(rows["prebuild-freed"]["checks"]["prebuild"], "PASS")
        self.assertEqual(rows["prebuild-freed"]["prebuild_kept"], [])
        self.assertIn("prebuild copies kept 0", report)

    def test_a_later_launch_of_the_same_suite_counts_too(self):
        # A walk that relaunches the app: the second launch's copy is judged like the first's.
        again = ["MARK 140.900 prebuild-Myynti-freed=false", "MARK 141.400 prebuild-Kirjanpito-freed=true"]
        rows, _ = self.report("true", again)
        self.assertEqual(rows["prebuild-freed"]["checks"]["prebuild"], "FAIL")

    def test_the_late_look_is_not_a_copy(self):
        # 'prebuild-<tab>-late=' is the same handles 10 s on: it says how long, not which copy.
        rows, _ = self.report("true", ["MARK 110.900 prebuild-Myynti-late=false"])
        self.assertEqual((rows["prebuild-freed"]["checks"]["prebuild"], rows["prebuild-freed"]["prebuild_kept"]), ("PASS", []))

    def test_a_walk_without_the_marks_has_no_such_row(self):
        with tempfile.TemporaryDirectory() as root:
            rows = walk(root, "s", [step("tab", video=False)], {}, probe_lines=["TOUCH 100.500 tab.koti"], xcui=())
        self.assertNotIn("prebuild-freed", rows)


class GatePrebuild(unittest.TestCase):
    @staticmethod
    def walk(verdict=None):
        """A walk's report: one step that passed, and the launch row when the walk logged the marks."""
        launch = [] if verdict is None else [{"suite": "s", "id": "prebuild-freed", "crashed": False, "checks": {"prebuild": verdict}}]
        return [row("a"), *launch]

    def test_copies_released_in_both_pr_walks_are_fixed(self):
        out, code = gate([self.walk("FAIL"), self.walk("PASS"), self.walk("PASS")])
        self.assertEqual((count(out, "FIXED"), code), (1, 0))
        self.assertIn("| s | prebuild-freed | prebuild | FAIL | PASS | PASS | fixed |", out)

    def test_a_copy_kept_in_both_pr_walks_is_new_fail_fails_the_job_and_the_counts_name_it(self):
        out, code = gate([self.walk("PASS"), self.walk("FAIL"), self.walk("FAIL")])
        self.assertEqual((count(out, "NEW FAIL"), code), (1, 1))
        self.assertIn("tab copies kept alive after launch: baseline 0, pr-run1 1, pr-run2 1", out)
        self.assertIn("PREBUILD: a tab copy was kept alive after launch in both PR walks (s)", out)

    def test_a_copy_kept_before_and_after_is_listed_not_failed(self):
        # The baseline leaked too (the open M086): named in the output, but every gate must not go red over it.
        out, code = gate([self.walk("FAIL"), self.walk("FAIL"), self.walk("FAIL")])
        self.assertEqual((count(out, "NEW FAIL"), count(out, "FIXED"), code), (0, 0, 0))
        self.assertIn("PREBUILD: a tab copy kept alive before and after (s), the open M086", out)
        self.assertNotIn("this fails the job", out)

    def test_one_noisy_pr_walk_does_not_fail_the_job(self):
        out, code = gate([self.walk("PASS"), self.walk("FAIL"), self.walk("PASS")])
        self.assertEqual(code, 0)
        self.assertNotIn("PREBUILD:", out)

    def test_the_launch_row_alone_is_not_a_walk(self):
        # F003: three empty walks compare as equal; a launch row must not make a stepless walk look like one that ran.
        launch = self.walk("PASS")[1:]
        out, code = gate([self.walk("PASS"), launch, launch])
        self.assertEqual(code, 1)
        self.assertIn("NO WALK: pr-run1, pr-run2", out)

    def test_a_branch_that_stops_logging_the_marks_is_a_new_miss(self):
        out, code = gate([self.walk("PASS"), self.walk(), self.walk()])
        self.assertEqual((count(out, "NEW MISS"), code), (1, 1))


if __name__ == "__main__":
    unittest.main()
