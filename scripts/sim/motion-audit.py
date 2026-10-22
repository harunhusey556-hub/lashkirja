#!/usr/bin/env python3
"""Motion audit analyzer: videos + probe log from MotionAuditTests -> motion-report.md/.json.

usage: motion-audit.py <out-dir>     (<out-dir>/<suite>/{steps.json, m-*.mov, probe.log, xcui.log})

Per step (docs/quality/SIMULATOR.md §4):
  intermediate  a settled screen (two consecutive captured frames alike) that is neither the
                start nor the end screen: the owner sees a screen that should not be there. "Neither"
                is a signature distance over DISTINCT, or more than INTER_AREA of the signature's
                cells off by CELL_DIFF against both, or a loading page: a LOADING_BAND-tall band
                flatter than LOADING_STD where the start and end screens both show content. A hold
                the probe saw moving all through is the recorder stalling, not a screen.
  flash         a frame whose mean luminance jumps past FLASH_LUMA against both neighbours, or a
                blank frame (nearly uniform).
  shift-video   after the step's motion went quiet (QUIET_S without a new frame, and no move of the
                step in the probe meanwhile), the screen changes again over more than SHIFT_AREA of
                its area: content popping in late, a list jumping, a scroll position reset. Not a
                shift: a cross-fade (late frames that mix the screen before into the one after
                within BLEND_S), and in a "load" step the answer arriving under unchanged content.
  shift-probe   the app's own MotionProbe saw layers move more than PROBE_MIN_PT after the step's
                layout settled (its QUIET line: 0.4 s of ticks with nothing moving; after its
                'MARK presented' line, that QUIET or PRESENTED_S, whichever comes first). Moves made
                only of system chrome (CHROME) are transition machinery, not a shift; a SCROLLJUMP
                counts anywhere after the tap. Catches what 4 fps misses.
  jank          frames missing against 60 fps while the screen moved. The Haswell simulator emits
                ~4 fps, so this is reported, never judged (in-app signposts are the jank tool).
  settle_ms     from the touch to the last frame that moved.
  stall         the longest main-thread stall (the probe's STALL lines) inside the step, less the
                time XCUITest was driving the app (xcui.log: from 'XCUI begin' to the step's TOUCH,
                or to 'XCUI end' when nothing touched the app): its element snapshots run on the
                app's main thread. app_stall_ms of STALL_MS or more is a FAIL (M003, M069, M098).
  prebuild      once per walk, a row of its own ("prebuild-freed"): the tab copies the app builds
                after launch and throws away (Shell/TabPrebuild.swift) must be gone 2 s later. The
                probe's 'MARK prebuild-<tab>-freed=false' for any of them is a FAIL (M086, M032).
A step's t = 0 is its TOUCH, the probe's line for the finger reaching the app (steps.json touchAt,
else the first TOUCH after tapAt), not tapAt: XCUITest may take seconds between the two (M046).
A check that saw nothing is never PASS: NO-MOTION (no video, fewer than MIN_FRAMES frames, or no
frame moved on a step that must move), UNREACHED (the step missed its target), SKIPPED (the walk
never ran it), MISS-WINDOW (the recording ended within MISS_WINDOW_S of the action, M029, M096),
NO-TOUCH (a step that pressed the app has no TOUCH: its t = 0 is unknown) and 'n/a (no settle)'
(nothing settled inside the window); the time-based checks (intermediate, shift-video) read
'n/a (bad timestamps)' when the frame times go backwards.
The simulator writes a frame only when the screen changes, so frames are read at their own
timestamps (variable rate), not resampled: a 30 fps resample would make every frame look settled.
"""
import json, os, re, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw

W = 402                 # analysis width: 1 px = 1 pt on a 402-pt-wide iPhone 16 Pro
STATUS_BAR = 0.065      # top share of the screen ignored (clock, battery)
STATIC_DIFF = 1.2       # mean abs diff (0-255) under which two frames are the same screen
DISTINCT = 9.0          # signature distance over which a screen is not the start/end screen
# A light loading screen sits under DISTINCT from any light card screen (M045, M079): the
# share of cells that changed sees it where the mean does not.
CELL_DIFF = 24          # a signature cell this far off has changed
INTER_AREA = 0.10       # share of changed cells over which a screen is not the start/end screen
LOADING_STD = 6.0       # a band this flat where the start and end screens show content: a loading page
LOADING_BAND = 0.25     # ... and this tall (share of the screen under the status bar)
FLASH_LUMA = 40.0       # mean-luminance spike against both neighbours
BLANK_STD = 2.0         # a frame this uniform is blank
HOLD_S = 0.25           # an intermediate screen stands at least this long
GESTURE_HOLD_S = 0.8    # ... in a drag-driven step, where XCTest's finger pauses mid-drag
# Steps driven by a drag (edge swipe-back, a sheet pulled down): a frame held mid-drag is the
# finger, not the app. Matched by id so a "before" run's steps.json reads the same way.
REFRESH = re.compile(r"refresh|online-again")
GESTURE = re.compile(r"swipe|chat-close|zip-close|^kirjanpito-.*-back$|^pankki-feed-back$")
QUIET_S = 0.6           # no new frame for this long: the step's motion is over
SHIFT_AREA = 0.015      # share of the screen that must change after settling to call it a shift
SHIFT_SEARCH = 400      # vertical moves searched (pt): a refresh rebound lands ~215 pt in one frame (M014)
BLEND_S = 0.5           # a cross-fade's frames all fall within this long (CaptureFlow's is 0.4 s)
PROBE_MIN_PT = 3        # probe moves smaller than this are rounding
# A shift that lands within 0.4 s of a sheet's slide runs into it, and the probe's QUIET after
# both hides it (M097). In run 39081865005, before the probe read presentation layers, the slide
# wrote no MOVE at all and the late shift was the first move.
PRESENTED_S = 0.7      # a sheet has landed this long after the probe's 'MARK presented'
MIN_FRAMES = 3          # fewer frames than this: the step's motion was not filmed
MISS_WINDOW_S = 1.0     # a recording must run this long past the action to have filmed its result
STALL_MS = 500          # an app-side stall this long fails the step (section 7: harness below it)
TOUCH_SLACK_S = 0.05    # a TOUCH this far before tapAt still belongs to the step (clock rounding)
MOTION_KINDS = ("nav", "sheet", "swap", "scroll")  # steps where no moving frame means not filmed
CALIBRATION = """Thresholds were set on test00_Calibration: good = tab switch to Kirjanpito, push to
Kuukauden sulku and its swipe-back; bad = the w32 brief's item 7 (capture upload, the screen moves
when the reading finishes). Item 7 is fixed (row 7): the queue now cross-fades into the form in
0.4 s, one transition by the BLEND_S rule, so bad-capture-upload's shift-video PASSes and the step
is no calibration point any more. Nor is item 9 ("Näytä tarkistettavat", bad-show-review): its
cover now goes down once onto Kuitit, and in run 39081865005 it shows no defect (PASS in both PR
walks, no baseline step). See the calibration table below for what each check said about
them. INTER_AREA was set the way DISTINCT was, on test00 alone (the contact sheets of run
39081865005): just under the smallest bad screen's share (0.118, the system prompt over the
Asetukset sheet in bad-link-over-sheet); no good step holds a screen with a changed cell against
both ends."""


def ffmpeg():
    return os.environ.get("FFMPEG", "ffmpeg")


def monotonic(times):
    return all(b >= a for a, b in zip(times, times[1:]))


def frames(video):
    """All frames as they were captured: (times_s, gray uint8 [n, h, W]). The times are the frames'
    own pts. ffmpeg stamps a decoded frame with its best_effort_timestamp, which falls back to the
    DTS once two pts tie, and the simulator's DTS run up to 1.2 s behind (M042, M067): read with
    the DTS ignored, and only when those pts go backwards fall back to best effort. Times that
    still go backwards are left for analyze_video to call bad."""
    for flags in (["-fflags", "+igndts"], []):
        probe = subprocess.run([ffmpeg(), "-v", "info", *flags, "-i", video, "-fps_mode", "passthrough",
                                "-vf", f"scale={W}:-2,format=gray,showinfo", "-f", "rawvideo", "-"],
                               capture_output=True)
        times = [float(m) for m in re.findall(rb"pts_time:\s*([0-9.]+)", probe.stderr)]
        if monotonic(times):
            break
    size = re.search(rb"Stream #0:0.*?, (\d+)x(\d+)", probe.stderr)
    raw = np.frombuffer(probe.stdout, dtype=np.uint8)
    if not times or raw.size == 0:
        return [], None
    h = raw.size // (len(times) * W)
    data = raw[: len(times) * W * h].reshape(len(times), h, W)
    return times, data


def sig(frame):
    """Small blurred thumbnail: a screen signature that ignores antialiasing."""
    img = Image.fromarray(frame).resize((24, 52), Image.BILINEAR)
    return np.asarray(img, dtype=np.float32)


def loading_page(frame, start, end):
    """A LOADING_BAND-tall band of frame flatter than LOADING_STD where start and end both show
    content: a spinner or a blank body standing in for the screen. The chrome around it keeps the
    whole frame's std far above BLANK_STD (M079)."""
    h = frame.shape[0]
    band = max(1, int(h * LOADING_BAND))
    for y in range(0, h - band + 1, max(1, band // 8)):
        if frame[y:y + band].std() < LOADING_STD and start[y:y + band].std() >= LOADING_STD \
                and end[y:y + band].std() >= LOADING_STD:
            return True
    return False


def vertical_shift(a, b):
    """Best vertical displacement (pt) of b against a over the changed rows, or 0."""
    rows_a, rows_b = a.mean(axis=1), b.mean(axis=1)
    best, best_err = 0, np.abs(rows_a - rows_b).mean()
    for dy in range(-SHIFT_SEARCH, SHIFT_SEARCH + 1):
        if dy == 0:
            continue
        x = rows_a[max(0, -dy): len(rows_a) - max(0, dy)]
        y = rows_b[max(0, dy): len(rows_b) - max(0, -dy)]
        err = np.abs(x - y).mean()
        if err < best_err * 0.6:
            best, best_err = dy, err
    return best


def probe_moved(probe, a, b, still_s):
    """The probe saw the screen move all through (a, b): two or more of its MOVEs inside, none of
    the stretches between them or to either end as long as still_s. One move is only the change
    that starts or ends a hold, which the video shows 0.2-0.4 s after the probe."""
    ts = [t for t, kind in probe if kind == "MOVE" and a < t < b]
    edges = [a, *ts, b]
    return len(ts) >= 2 and max(y - x for x, y in zip(edges, edges[1:])) < still_s


def cross_fade(before, run):
    """run (frames, oldest first) fades before into its last frame: each earlier frame is a mix of
    the two plus a constant, the old screen fading out over the canvas as the new one fades in, with
    more of the new and less of the old than the frame before, but for under SHIFT_AREA of its pixels."""
    if len(run) < 2:
        return False
    basis = np.stack([run[-1].ravel(), before.ravel(), np.ones(before.size, np.float32)]).astype(np.float64)
    gram = basis @ basis.T
    if abs(np.linalg.det(gram)) < 1e-6 * np.prod(np.diag(gram)):  # the same screen twice, or a blank one
        return False
    new, old = 0.0, 1.0
    for f in run[:-1]:
        mix = np.linalg.solve(gram, basis @ f.ravel())
        if not (new < mix[0] < 1 and mix[1] < old) or (np.abs(mix @ basis - f.ravel()) > 24).mean() > SHIFT_AREA:
            return False
        new, old = mix[0], mix[1]
    return True


def appended(before, after):
    """after changes before only under rows that are unchanged and show content: an answer
    arriving below its question, nothing above it touched. analyze_video also wants the change to
    last into the end screen, so content that comes and goes again is still a pop."""
    rows = np.nonzero((np.abs(after - before) > 24).mean(axis=1) > SHIFT_AREA)[0]
    return len(rows) > 0 and rows[0] > 0 and before[:rows[0]].std() >= LOADING_STD


def analyze_video(video, tap_s, hold_s=HOLD_S, quiet_s=QUIET_S, probe=()):
    """probe: the step's own motion as MotionProbe logged it, (video time, 'MOVE' or 'MARK')."""
    times, data = frames(video)
    if not times:
        return {"error": "no frames"}
    top = int(data.shape[1] * STATUS_BAR)
    body = data[:, top:, :].astype(np.float32)
    n = len(times)
    diff = [0.0] + [float(np.abs(body[i] - body[i - 1]).mean()) for i in range(1, n)]
    luma = body.mean(axis=(1, 2))
    std = body.std(axis=(1, 2))
    sigs = [sig(data[i, top:, :]) for i in range(n)]
    tap_i = next((i for i, t in enumerate(times) if t >= tap_s), n - 1)
    moving = [i for i in range(1, n) if diff[i] > STATIC_DIFF and times[i] >= tap_s - 0.05]
    # The step's own motion: from the first change after the tap until a pause of QUIET_S. A pause
    # the probe saw the step move in, or a sheet start its slide in, is the recorder (or the main
    # thread before a presentation) holding the picture, not the motion ending (M013, M014, M042).
    settle_i = None
    if moving:
        last = moving[0]
        for i in moving[1:]:
            if times[i] - times[last] > quiet_s and not any(times[last] < t < times[i] for t, _ in probe):
                break
            last = i
        settle_i = last
    late = [i for i in moving if settle_i is not None and i > settle_i]
    start_i = max(0, tap_i - 1)
    start_sig = sigs[start_i]
    end_sig = sigs[-1]
    flags = set()

    # Intermediate: a screen that stood still (two alike frames in a row, held HOLD_S) and is far
    # from both start and end. A finger pausing mid-swipe holds a frame for less than that. In a
    # "load" step a progress state is the expected middle, so only shifts are judged there.
    inter = []
    run = None
    for i in range(max(1, tap_i + 1), n + 1):
        still = i < n and diff[i] <= STATIC_DIFF
        if still and run is None:
            run = i - 1
        if not still and run is not None:
            held = (times[i] if i < n else times[-1]) - times[run]
            d_start = float(np.abs(sigs[run] - start_sig).mean())
            d_end = float(np.abs(sigs[run] - end_sig).mean())
            a_start = float((np.abs(sigs[run] - start_sig) > CELL_DIFF).mean())
            a_end = float((np.abs(sigs[run] - end_sig) > CELL_DIFF).mean())
            # Time the recorder wrote nothing while the probe saw the screen move is the recorder
            # stalling, not the screen holding (M093: one frame twice, then 0.37 s mid-fling).
            stalled = sum(times[j + 1] - times[j] for j in range(run, min(i, n - 1))
                          if probe_moved(probe, times[j], times[j + 1], hold_s))
            if held - stalled >= hold_s and i < n:
                loading = loading_page(body[run], body[start_i], body[-1])
                if (d_start > DISTINCT and d_end > DISTINCT) or (a_start > INTER_AREA and a_end > INTER_AREA) or loading:
                    inter.append({"frame": run, "t": round(times[run] - tap_s, 2), "held_s": round(held, 2),
                                  "d_start": round(d_start, 1), "d_end": round(d_end, 1),
                                  "a_start": round(a_start, 3), "a_end": round(a_end, 3), "loading": loading})
                    flags.add(run)
            run = None
    # Flash: a luminance spike against both neighbours, or a blank frame.
    flash = []
    for i in range(1, n - 1):
        up, down = luma[i] - luma[i - 1], luma[i] - luma[i + 1]
        if (abs(up) > FLASH_LUMA and abs(down) > FLASH_LUMA and np.sign(up) == np.sign(down)) or std[i] < BLANK_STD:
            flash.append((i, round(float(luma[i]), 1)))
            flags.add(i)
    if std[-1] < BLANK_STD or std[0] < BLANK_STD:
        flash.append((n - 1 if std[-1] < BLANK_STD else 0, "blank"))
    # Late change after settling, big enough to see. Late frames that blend into the last of them
    # within BLEND_S, with nothing changing for BLEND_S after it, are one cross-fade: the calm
    # change the owner rules allow. Split over 2-4 frames at ~4 fps, each used to read as a pop (M002).
    shifts = []
    fade = set()
    for k, i in enumerate(late):
        if i in fade:
            continue
        burst = [j for j in late[k:] if times[j] - times[i] <= BLEND_S]
        rest = late[k + len(burst):]
        if (not rest or times[rest[0]] - times[burst[-1]] > BLEND_S) \
                and cross_fade(body[i - 1], [body[j] for j in burst]):
            fade.update(burst)
            continue
        mask = np.abs(body[i] - body[i - 1]) > 24
        changed = mask.mean()
        if changed > SHIFT_AREA:
            dy = vertical_shift(body[i - 1], body[i])
            stays = (mask & (np.abs(body[i] - body[-1]) > 24)).mean() <= SHIFT_AREA
            what = "move" if abs(dy) > 2 else "append" if stays and appended(body[i - 1], body[i]) else "pop"
            shifts.append({"t": round(times[i] - tap_s, 2), "area": round(float(changed), 3),
                           "dy_pt": int(dy), "what": what})
            flags.add(i)
    # Jank estimate against 60 fps while moving (reported only).
    jank = None
    if moving and settle_i is not None:
        span = times[settle_i] - times[moving[0]]
        got = len([i for i in moving if i <= settle_i])
        jank = max(0, int(round(span * 60)) - got)
    settle_ms = int((times[settle_i] - tap_s) * 1000) if settle_i is not None else None
    return {"frames": n, "times": times, "tap_i": tap_i, "settle_i": settle_i, "intermediate": inter,
            "flash": flash, "shift": shifts, "jank_dropped": jank, "settle_ms": settle_ms,
            "bad_times": not monotonic(times), "flags": sorted(flags), "data": data}


def sheet_frames(res):
    """The frames a contact sheet shows: every flagged frame, the first, the tap, the settle and the
    last, then evenly spread ones up to 32. A cut at 40 used to drop the tail of 41-57-frame videos,
    settle and last frame included (M021)."""
    n = len(res["times"])
    keep = set(res["flags"]) | ({res["settle_i"]} if res["settle_i"] is not None else set()) | {0, n - 1, res["tap_i"]}
    spare = max(0, 32 - len(keep))
    return sorted(keep | ({int(i) for i in np.linspace(0, n - 1, spare).round()} if spare else set()))


def contact_sheet(path, res, tap_s):
    data, times = res["data"], res["times"]
    idx = sheet_frames(res)
    tw, th = 134, int(134 * data.shape[1] / data.shape[2])
    cols = 10
    rows = (len(idx) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (tw + 6), rows * (th + 22)), "white")
    draw = ImageDraw.Draw(sheet)
    for k, i in enumerate(idx):
        x, y = (k % cols) * (tw + 6), (k // cols) * (th + 22)
        sheet.paste(Image.fromarray(data[i]).resize((tw, th)).convert("RGB"), (x + 3, y + 3))
        colour = "red" if i in res["flags"] else ("blue" if i == res["settle_i"] else "black")
        if i in res["flags"]:
            draw.rectangle([x + 1, y + 1, x + tw + 4, y + th + 4], outline="red", width=3)
        draw.text((x + 4, y + th + 6), f"#{i} {times[i] - tap_s:+.2f}s", fill=colour)
    sheet.save(path)


def probe_events(path):
    out = []
    if not os.path.exists(path):
        return out
    for line in open(path, encoding="utf-8", errors="replace"):
        parts = line.split()
        if len(parts) < 3 or parts[0] not in ("MOVE", "SCROLLJUMP", "SCREEN", "ROOT", "QUIET", "MARK", "TOUCH", "STALL"):
            continue
        try:
            t = float(parts[1])
        except ValueError:
            continue
        ev = {"kind": parts[0], "t": t, "screen": parts[2], "raw": line.strip()}
        m = re.search(r"max=(\d+)", line)
        ev["max"] = int(m.group(1)) if m else (abs(int(re.search(r"dy=(-?\d+)", line).group(1))) if "dy=" in line else 0)
        if parts[0] == "STALL":
            ms = re.search(r"ms=(\d+)", line)
            ev["ms"] = int(ms.group(1)) if ms else 0
        out.append(ev)
    # A log from a probe without QUIET lines: a 0.5 s gap between moves stands for one.
    if out and not any(e["kind"] == "QUIET" for e in out):
        moves = [e for e in out if e["kind"] in ("MOVE", "SCROLLJUMP")]
        for a, b in zip(moves, moves[1:] + [None]):
            if b is None or b["t"] - a["t"] > 0.5:
                out.append({"kind": "QUIET", "t": a["t"] + 0.5, "screen": a["screen"], "raw": "", "max": 0})
        out.sort(key=lambda e: e["t"])
    return out


# System chrome that moves by design during a transition (sheet shadow, bars, large title,
# recycled list decorations): a MOVE made only of these is not a layout shift. The title control
# is not chrome: it moves after settling when the title's own content changes width (M097).
CHROME = re.compile(r"^(UIDropShadowView|UITransitionView|_UIBarBackground|UIVisualEffectView|_UIVisualEffect\w*|"
                    r"_UINavigationBar(?!TitleControl)\w*|_UIButtonBarStackView|_UICollectionViewListLayoutSectionBackgroundColorDecorationView|"
                    r"UIRefreshControl|_UIRefreshControl\w*|UIActivityIndicatorView|_UISystemBackgroundView|UIView)@")


def chrome_only(raw):
    parts = raw.split()[5:]
    return bool(parts) and all(CHROME.match(p) for p in parts)


def probe_shift(events, start, end):
    """MOVEs after the step's layout settled and SCROLLJUMPs anywhere, within [start, end], and
    the settle point in ms after start (None: nothing settled inside the window). Settled is the
    probe's own QUIET line (written only after ticks that ran) after the first move, or after a
    'MARK presented' line that QUIET or PRESENTED_S, whichever comes first (M020, M097). A scroll
    offset that jumps with no finger on it is never part of a transition (M079)."""
    window = [e for e in events if start <= e["t"] <= end]
    mark = next((e["t"] for e in window if e["kind"] == "MARK" and e["screen"] == "presented"), None)
    if mark is not None:
        quiet = next((e["t"] for e in window if e["kind"] == "QUIET" and e["t"] > mark), None)
        settled = min(mark + PRESENTED_S, quiet) if quiet is not None else mark + PRESENTED_S
    else:
        first_move = next((i for i, e in enumerate(window) if e["kind"] in ("MOVE", "SCROLLJUMP")), None)
        settled = None if first_move is None else next((e["t"] for e in window[first_move:] if e["kind"] == "QUIET"), None)
    if settled is not None and settled > end:
        settled = None
    late = [e for e in window if e["max"] >= PROBE_MIN_PT and (
        e["kind"] == "SCROLLJUMP"
        or (e["kind"] == "MOVE" and settled is not None and e["t"] > settled and not chrome_only(e["raw"])))]
    return late, int((settled - start) * 1000) if settled is not None else None


def xcui_windows(path):
    """xcui.log as (begin, end, step) stretches, from the walk's 'XCUI begin|end <t> <step>' lines;
    None without the file (a walk from before it)."""
    if not os.path.exists(path):
        return None
    out, open_at = [], {}
    for line in open(path, encoding="utf-8", errors="replace"):
        parts = line.split()
        if len(parts) < 4 or parts[0] != "XCUI":
            continue
        try:
            t = float(parts[2])
        except ValueError:
            continue
        if parts[1] == "begin":
            open_at[parts[3]] = t
        elif parts[1] == "end" and parts[3] in open_at:
            out.append((open_at.pop(parts[3]), t, parts[3]))
    return out


def first_touch(events, after, until):
    """The first TOUCH in [after - TOUCH_SLACK_S, until], or None."""
    return next((e["t"] for e in events if e["kind"] == "TOUCH" and after - TOUCH_SLACK_S <= e["t"] <= until), None)


def app_stall_ms(events, windows, start, end):
    """The longest main-thread stall inside [start, end] less the time XCUITest drove the app in it.
    A stretch counts up to the first TOUCH inside it: the element look-up and the check for
    interrupting alerts before a tap are snapshots on the app's main thread, while after the touch
    XCUITest only waits for the app to go idle, which is the app's own time. A stretch that touched
    nothing (typed text, a wait for an element to go) counts whole."""
    busy = []
    for begin, finish, _ in windows:
        touch = first_touch(events, begin + TOUCH_SLACK_S, finish)
        busy.append((begin, finish if touch is None else touch))
    longest = 0
    for e in events:
        if e["kind"] != "STALL":
            continue
        a, b = max(start, e["t"] - e["ms"] / 1000), min(end, e["t"])
        if b <= a:
            continue
        driven = sum(max(0.0, min(b, y) - max(a, x)) for x, y in busy)
        longest = max(longest, int(round((b - a - driven) * 1000)))
    return longest


KS = ("intermediate", "flash", "shift_video", "shift_probe", "stall")
MISSES = ("NO-MOTION", "UNREACHED", "SKIPPED", "MISS-WINDOW", "NO-TOUCH", "n/a (no settle)", "n/a (bad timestamps)")
# 'prebuild-<tab>-freed=<bool>' is the copy; '-host-freed' and '-window-freed' say which half stays.
PREBUILD_FREED = re.compile(r"^prebuild-(.+?)(-host|-window)?-freed=(true|false)$")


def prebuild_copies(events):
    """[(tab, freed)] in log order, one per copy per launch: TabPrebuild logs it 2 s after it
    discarded the copy. One still alive keeps its views and their tasks, and what UIKit holds
    with them (M086, M032)."""
    return [(m.group(1), m.group(3) == "true") for e in events
            if e["kind"] == "MARK" and (m := PREBUILD_FREED.match(e["screen"])) and not m.group(2)]


def prebuild_row(suite, copies, probe_seen):
    """The suite's launch as one row of the report: no step, so the video checks do not apply."""
    kept = [tab for tab, freed in copies if not freed]
    return {"suite": suite, "id": "prebuild-freed", "from": "launch", "to": "launch", "kind": "launch",
            "expect": "every prebuilt tab copy is released", "reached": True, "skipped": False, "crashed": False,
            "probe_shift": [], "probe_settle_ms": None, "app_stall_ms": None, "probe_seen": probe_seen,
            "prebuild_kept": kept, "checks": {**dict.fromkeys(KS, "n/a"), "prebuild": "FAIL" if kept else "PASS"}}


def checks(row, probe_seen, late):
    """Each check's verdict. PASS needs the step reached and its motion seen: an empty finding
    list from a video or a window that missed the motion is not a PASS (M004, M019, M052), nor is
    one whose recording stopped at the action or whose t = 0 is unknown (M029, M046, M096)."""
    kind = row["kind"]
    if row["skipped"]:
        return dict.fromkeys(KS, "SKIPPED")
    if not row["reached"] and not row["crashed"]:
        return dict.fromkeys(KS, "UNREACHED")
    if row.get("window_cut"):
        return dict.fromkeys(KS, "MISS-WINDOW")
    if row.get("no_touch"):
        return dict.fromkeys(KS, "NO-TOUCH")
    filmed = "error" not in row and row["frames"] >= MIN_FRAMES

    def video(judged, found, timed=True):
        if not judged:
            return "n/a"
        if not filmed or (row["settle_ms"] is None and kind in MOTION_KINDS):
            return "NO-MOTION"
        if timed and row.get("bad_times"):
            return "n/a (bad timestamps)"
        if row["settle_ms"] is None:
            return "n/a (no settle)"
        return "FAIL" if found else "PASS"
    return {
        "intermediate": video(kind != "load", row.get("intermediate")),
        # Frame order alone finds a flash, so wrong frame times leave it judged.
        "flash": video(True, row.get("flash"), timed=False),
        "shift_video": video(kind != "scroll", row.get("shift")),
        # A scroll step's late moves were never judged, so its old PASS said nothing.
        "shift_probe": "n/a" if not probe_seen or kind == "scroll" else (
            "FAIL" if late else "n/a (no settle)" if row["probe_settle_ms"] is None else "PASS"),
        "stall": "n/a" if not probe_seen or row.get("app_stall_ms") is None else (
            "FAIL" if row["app_stall_ms"] >= STALL_MS else "PASS"),
    }


def skipped_in_notes(path, known):
    """Steps the walk gave up on before recording them ('SKIP <suite>/<id>: no <label>' in
    notes.txt): without a row they would hide from the report and the gate (M052)."""
    out = []
    if not os.path.exists(path):
        return out
    for line in open(path, encoding="utf-8", errors="replace"):
        m = re.match(r"SKIP (\S+)/(\S+): (.*)$", line.strip())
        if m and m.group(2) not in known:
            out.append((m.group(1), m.group(2), m.group(3)))
    return out


def main():
    out = sys.argv[1]
    rows = []
    for suite in sorted(os.listdir(out)):
        d = os.path.join(out, suite)
        steps_path = os.path.join(d, "steps.json")
        if not os.path.isfile(steps_path):
            continue
        steps = json.load(open(steps_path, encoding="utf-8"))
        events = probe_events(os.path.join(d, "probe.log"))
        windows = xcui_windows(os.path.join(d, "xcui.log"))
        for s in steps:
            row = {"suite": s.get("suite") or suite, "id": s["id"], "from": s["from"], "to": s["to"], "kind": s["kind"],
                   "expect": s["expect"], "reached": s["reached"], "skipped": s["skipped"],
                   "crashed": bool(s.get("crashed"))}
            end = s.get("recEnd") or (s["doneAt"] + 4)
            # t = 0 is the finger reaching the app. A steps.json from before TOUCH has neither
            # field, and each of its steps pressed the app.
            touch = s.get("touchAt") or first_touch(events, s["tapAt"], s["doneAt"] + 0.5)
            t0 = s["tapAt"] if touch is None else touch
            row["touch_ms"] = None if touch is None else int(round((touch - s["tapAt"]) * 1000))
            row["no_touch"] = s.get("pressed", True) and touch is None and not s["skipped"]
            row["window_cut"] = bool(s.get("recEnd")) and not s["skipped"] and s["recEnd"] < s["doneAt"] + MISS_WINDOW_S
            if s.get("foundAt") is not None:
                row["stamp_ms"] = int(round((s["tapAt"] - s["foundAt"]) * 1000))
            late, probe_settle = probe_shift(events, t0, end)
            row["app_stall_ms"] = None if windows is None or not events else app_stall_ms(events, windows, t0, end)
            if s.get("video") and s.get("recStart") and os.path.exists(os.path.join(d, s["video"])):
                tap_s = t0 - s["recStart"]
                # The step's own motion in the probe, on the video's clock: what moved before the
                # probe settled, and a sheet's slide starting. Later moves are shifts, not motion.
                own = [] if probe_settle is None else [
                    (e["t"] - s["recStart"], e["kind"]) for e in events
                    if t0 <= e["t"] <= t0 + probe_settle / 1000
                    and ((e["kind"] == "MOVE" and e["max"] >= PROBE_MIN_PT) or (e["kind"] == "MARK" and e["screen"] == "presented"))]
                res = analyze_video(os.path.join(d, s["video"]), tap_s,
                                    *((GESTURE_HOLD_S, GESTURE_HOLD_S + 0.4) if GESTURE.search(s["id"]) else (HOLD_S, QUIET_S)),
                                    probe=own)
                if "error" not in res:
                    sheet = f"{suite}/sheet-{s['id']}.png"  # the run's directory
                    contact_sheet(os.path.join(out, sheet), res, tap_s)
                    row.update({k: res[k] for k in ("intermediate", "flash", "shift", "jank_dropped", "settle_ms", "frames", "bad_times")})
                    # Pull-to-refresh: the list sliding back up when the refresh ends is the
                    # system's rebound, not a shift; content popping in still counts.
                    if REFRESH.search(s["id"]):
                        row["shift"] = [x for x in row["shift"] if not (x["what"] == "move" and x["dy_pt"] < 0)]
                    # A load step's answer arriving under what was already there is its end (M065).
                    if s["kind"] == "load":
                        row["shift"] = [x for x in row["shift"] if x["what"] != "append"]
                    row["sheet"] = sheet
                else:
                    row["error"] = res["error"]
            else:
                row["error"] = "no video"
            # The same rebound as above, seen by the probe as the offset going back up. Only the
            # jumps that counting them anywhere newly adds: one after the settle was late before H1.
            if REFRESH.search(s["id"]):
                late = [e for e in late
                        if not (e["kind"] == "SCROLLJUMP" and int(re.search(r"dy=(-?\d+)", e["raw"]).group(1)) > 0
                                and (probe_settle is None or e["t"] <= t0 + probe_settle / 1000))]
            row["probe_shift"] = [e["raw"] for e in late][:5]
            row["probe_settle_ms"] = probe_settle
            row["probe_seen"] = bool(events)
            row["checks"] = checks(row, bool(events), late)
            rows.append(row)
        copies = prebuild_copies(events)
        if copies:
            rows.append(prebuild_row(suite, copies, bool(events)))
        for name, sid, why in skipped_in_notes(os.path.join(d, "notes.txt"), {s["id"] for s in steps}):
            rows.append({"suite": name, "id": sid, "from": "", "to": "", "kind": "", "expect": "", "reached": False,
                         "skipped": True, "crashed": False, "error": why, "probe_shift": [], "probe_settle_ms": None,
                         "app_stall_ms": None, "probe_seen": bool(events), "checks": dict.fromkeys(KS, "SKIPPED")})
    json.dump(rows, open(os.path.join(out, "motion-report.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False, default=str)

    def count(check):
        return sum(1 for r in rows if r["checks"].get(check) == "FAIL")

    def unseen(verdict):
        return sum(1 for r in rows if verdict in r["checks"].values())
    lines = ["# Motion audit", "", f"{len(rows)} steps. FAIL: intermediate {count('intermediate')}, flash {count('flash')}, "
             f"shift (video) {count('shift_video')}, shift (probe) {count('shift_probe')}, stall {count('stall')}, "
             f"prebuild copies kept {count('prebuild')}; "
             f"crashes {sum(1 for r in rows if r['crashed'])}. Not judged: "
             + ", ".join(f"{v} {unseen(v)}" for v in MISSES) + ".", "",
             # The walk's own timing: each count is 0 on a walk that stamps and films as it should.
             f"Walk timing: {sum(1 for r in rows if r.get('window_cut'))} recordings ended within {MISS_WINDOW_S:g} s "
             f"of the action, {sum(1 for r in rows if r.get('no_touch'))} pressed steps have no TOUCH, "
             f"{sum(1 for r in rows if (r.get('stamp_ms') or 0) >= 50)} taps went out 50 ms or more after their "
             f"element was found.", "",
             "## Calibration", "", CALIBRATION, "",
             f"Thresholds: STATIC_DIFF={STATIC_DIFF}, DISTINCT={DISTINCT}, INTER_AREA={INTER_AREA} (cells off by {CELL_DIFF}), "
             f"LOADING_STD={LOADING_STD} (band {LOADING_BAND}), HOLD_S={HOLD_S} (drag steps {GESTURE_HOLD_S}, quiet {GESTURE_HOLD_S + 0.4}), FLASH_LUMA={FLASH_LUMA}, QUIET_S={QUIET_S}, "
             f"SHIFT_AREA={SHIFT_AREA}, PROBE_MIN_PT={PROBE_MIN_PT}, PRESENTED_S={PRESENTED_S}, MIN_FRAMES={MIN_FRAMES}, "
             f"MISS_WINDOW_S={MISS_WINDOW_S}, STALL_MS={STALL_MS}.", "",
             "Jank is not judged: the simulator writes ~4 frames a second, so 'dropped' counts every animation.", "",
             "## Steps", "",
             "| suite | step | from → to | kind | reached | intermediate | flash | shift video | shift probe | stall | settle ms | app stall ms | dropped@60 | sheet |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        c = r["checks"]
        stall = "" if r.get("app_stall_ms") is None else r["app_stall_ms"]
        lines.append(f"| {r['suite']} | {r['id']} | {r['from']} → {r['to']} | {r['kind']} | {'CRASH' if r['crashed'] else ('yes' if r['reached'] else 'NO')} | "
                     f"{c['intermediate']} | {c['flash']} | {c['shift_video']} | {c['shift_probe']} | {c['stall']} | {r.get('settle_ms', '')} | "
                     f"{stall} | {r.get('jank_dropped', '')} | {'[png](' + r['sheet'] + ')' if r.get('sheet') else r.get('error', '')} |")
    lines += ["", "## Details of FAIL rows", ""]
    for r in rows:
        if "FAIL" in r["checks"].values():
            lines.append(f"- **{r['suite']}/{r['id']}** ({r['from']} → {r['to']}): "
                         + "; ".join(x for x in [
                             f"intermediate screens {r['intermediate']}" if r.get("intermediate") else "",
                             f"flash {r['flash']}" if r.get("flash") else "",
                             f"late change {r['shift']}" if r.get("shift") and r["kind"] != "scroll" else "",
                             f"probe {r['probe_shift'][:3]}" if r["probe_shift"] and r["kind"] != "scroll" else "",
                             f"the app held its main thread {r['app_stall_ms']} ms" if r["checks"]["stall"] == "FAIL" else "",
                             f"tab copies still alive 2 s after they were thrown away: {', '.join(r['prebuild_kept'])}" if r.get("prebuild_kept") else ""] if x))
    open(os.path.join(out, "motion-report.md"), "w", encoding="utf-8").write("\n".join(lines) + "\n")
    print("\n".join(lines[:5]))


if __name__ == "__main__":
    main()
