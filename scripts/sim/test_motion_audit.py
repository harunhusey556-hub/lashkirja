"""Unit tests for motion-audit.py and motion-gate.py (batch H1): no vacuous PASS, no false FIXED,
spinner pages and late shifts after a stalled presentation caught. Batch H6: frame times, the
contact sheet, and the motion a step is expected to make, each rule with a case it must still fail.
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


if __name__ == "__main__":
    unittest.main()
