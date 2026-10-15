#!/usr/bin/env python3
"""Motion audit analyzer: videos + probe log from MotionAuditTests -> motion-report.md/.json.

usage: motion-audit.py <out-dir>     (<out-dir>/<suite>/{steps.json, m-*.mov, probe.log})

Per step (docs/quality/SIMULATOR.md §4):
  intermediate  a settled screen (two consecutive captured frames alike) that is neither the
                start nor the end screen: the owner sees a screen that should not be there.
  flash         a frame whose mean luminance jumps past FLASH_LUMA against both neighbours, or a
                blank frame (nearly uniform).
  shift-video   after the step's motion went quiet (QUIET_S without a new frame), the screen
                changes again over more than SHIFT_AREA of its area: content popping in late, a
                list jumping, a scroll position reset.
  shift-probe   the app's own MotionProbe (MOVE/SCROLLJUMP lines) saw layers move more than 2 pt
                after the step's layout had been quiet for PROBE_QUIET_S. Catches what 4 fps misses.
  jank          frames missing against 60 fps while the screen moved. The Haswell simulator emits
                ~4 fps, so this is reported, never judged (in-app signposts are the jank tool).
  settle_ms     from the tap to the last frame that moved.
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
FLASH_LUMA = 40.0       # mean-luminance spike against both neighbours
BLANK_STD = 2.0         # a frame this uniform is blank
HOLD_S = 0.25           # an intermediate screen stands at least this long
QUIET_S = 0.6           # no new frame for this long: the step's motion is over
SHIFT_AREA = 0.015      # share of the screen that must change after settling to call it a shift
PROBE_QUIET_S = 0.5
PROBE_MIN_PT = 3        # probe moves smaller than this are rounding
CALIBRATION = """Thresholds were set on test00_Calibration: good = tab switch to Kirjanpito, push to
Kuukauden sulku and its swipe-back; bad = the w32 brief's item 7 (capture upload, the screen moves
when the reading finishes) and item 9 ("Näytä tarkistettavat": cover closes, tab switches, Kuitit
pushed). See the calibration table below for what each check said about them."""


def ffmpeg():
    return os.environ.get("FFMPEG", "ffmpeg")


def frames(video):
    """All frames as they were captured: (times_s, gray uint8 [n, h, W], luma, std)."""
    probe = subprocess.run([ffmpeg(), "-v", "info", "-i", video, "-fps_mode", "passthrough",
                            "-vf", f"scale={W}:-2,format=gray,showinfo", "-f", "rawvideo", "-"],
                           capture_output=True)
    times = [float(m) for m in re.findall(rb"pts_time:\s*([0-9.]+)", probe.stderr)]
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


def vertical_shift(a, b):
    """Best vertical displacement (pt) of b against a over the changed rows, or 0."""
    rows_a, rows_b = a.mean(axis=1), b.mean(axis=1)
    best, best_err = 0, np.abs(rows_a - rows_b).mean()
    for dy in range(-80, 81):
        if dy == 0:
            continue
        x = rows_a[max(0, -dy): len(rows_a) - max(0, dy)]
        y = rows_b[max(0, dy): len(rows_b) - max(0, -dy)]
        err = np.abs(x - y).mean()
        if err < best_err * 0.6:
            best, best_err = dy, err
    return best


def analyze_video(video, tap_s):
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
    # The step's own motion: from the first change after the tap until a pause of QUIET_S.
    settle_i = None
    if moving:
        last = moving[0]
        for i in moving[1:]:
            if times[i] - times[last] > QUIET_S:
                break
            last = i
        settle_i = last
    late = [i for i in moving if settle_i is not None and i > settle_i]
    start_sig = sigs[max(0, tap_i - 1)] if tap_i > 0 else sigs[0]
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
            if held >= HOLD_S and d_start > DISTINCT and d_end > DISTINCT and i < n:
                inter.append({"frame": run, "t": round(times[run] - tap_s, 2), "held_s": round(held, 2),
                              "d_start": round(d_start, 1), "d_end": round(d_end, 1)})
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
    # Late change after settling, big enough to see.
    shifts = []
    for i in late:
        changed = (np.abs(body[i] - body[i - 1]) > 24).mean()
        if changed > SHIFT_AREA:
            dy = vertical_shift(body[i - 1], body[i])
            shifts.append({"t": round(times[i] - tap_s, 2), "area": round(float(changed), 3),
                           "dy_pt": int(dy), "what": "move" if abs(dy) > 2 else "pop"})
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
            "flags": sorted(flags), "data": data}


def contact_sheet(path, res, tap_s):
    data, times = res["data"], res["times"]
    n = len(times)
    step = max(1, n // 24)
    keep = set(res["flags"]) | ({res["settle_i"]} if res["settle_i"] is not None else set()) | {0, n - 1, res["tap_i"]}
    spare = max(0, 32 - len(keep))
    keep |= set(range(0, n, max(1, n // max(1, spare)))) if spare else set()
    idx = sorted(keep)[:40]
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
        if len(parts) < 3 or parts[0] not in ("MOVE", "SCROLLJUMP", "SCREEN", "ROOT"):
            continue
        try:
            t = float(parts[1])
        except ValueError:
            continue
        ev = {"kind": parts[0], "t": t, "screen": parts[2], "raw": line.strip()}
        m = re.search(r"max=(\d+)", line)
        ev["max"] = int(m.group(1)) if m else (abs(int(re.search(r"dy=(-?\d+)", line).group(1))) if "dy=" in line else 0)
        out.append(ev)
    return out


def probe_shift(events, start, end):
    """MOVE/SCROLLJUMP after the step's layout went quiet, within [start, end]."""
    moves = [e for e in events if e["kind"] in ("MOVE", "SCROLLJUMP") and start <= e["t"] <= end]
    if not moves:
        return [], None
    last = moves[0]["t"]
    settled_at = None
    late = []
    for e in moves[1:]:
        if settled_at is None and e["t"] - last > PROBE_QUIET_S:
            settled_at = last
        if settled_at is not None and e["max"] >= PROBE_MIN_PT:
            late.append(e)
        if settled_at is None:
            last = e["t"]
    return late, int(((settled_at or last) - start) * 1000)


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
        for s in steps:
            row = {"suite": s.get("suite") or suite, "id": s["id"], "from": s["from"], "to": s["to"], "kind": s["kind"],
                   "expect": s["expect"], "reached": s["reached"], "skipped": s["skipped"]}
            if s.get("video") and s.get("recStart") and os.path.exists(os.path.join(d, s["video"])):
                tap_s = s["tapAt"] - s["recStart"]
                res = analyze_video(os.path.join(d, s["video"]), tap_s)
                if "error" not in res:
                    sheet = f"{suite}/sheet-{s['id']}.png"  # the run's directory
                    contact_sheet(os.path.join(out, sheet), res, tap_s)
                    row.update({k: res[k] for k in ("intermediate", "flash", "shift", "jank_dropped", "settle_ms", "frames")})
                    row["sheet"] = sheet
                else:
                    row["error"] = res["error"]
            else:
                row["error"] = "no video"
            end = s.get("recEnd") or (s["doneAt"] + 4)
            late, probe_settle = probe_shift(events, s["tapAt"], end)
            row["probe_shift"] = [e["raw"] for e in late][:5]
            row["probe_settle_ms"] = probe_settle
            row["probe_seen"] = bool(events)
            row["checks"] = {
                "intermediate": "n/a" if "error" in row or s["kind"] == "load" else ("FAIL" if row["intermediate"] else "PASS"),
                "flash": "n/a" if "error" in row else ("FAIL" if row["flash"] else "PASS"),
                "shift_video": "n/a" if "error" in row or s["kind"] == "scroll" else ("FAIL" if row["shift"] else "PASS"),
                "shift_probe": "n/a" if not events else ("FAIL" if late and s["kind"] != "scroll" else "PASS"),
            }
            rows.append(row)
    json.dump(rows, open(os.path.join(out, "motion-report.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False, default=str)

    def count(check):
        return sum(1 for r in rows if r["checks"][check] == "FAIL")
    lines = ["# Motion audit", "", f"{len(rows)} steps. FAIL: intermediate {count('intermediate')}, flash {count('flash')}, "
             f"shift (video) {count('shift_video')}, shift (probe) {count('shift_probe')}.", "",
             "## Calibration", "", CALIBRATION, "",
             f"Thresholds: STATIC_DIFF={STATIC_DIFF}, DISTINCT={DISTINCT}, FLASH_LUMA={FLASH_LUMA}, QUIET_S={QUIET_S}, "
             f"SHIFT_AREA={SHIFT_AREA}, PROBE_QUIET_S={PROBE_QUIET_S}, PROBE_MIN_PT={PROBE_MIN_PT}.", "",
             "Jank is not judged: the simulator writes ~4 frames a second, so 'dropped' counts every animation.", "",
             "## Steps", "",
             "| suite | step | from → to | kind | reached | intermediate | flash | shift video | shift probe | settle ms | dropped@60 | sheet |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        c = r["checks"]
        lines.append(f"| {r['suite']} | {r['id']} | {r['from']} → {r['to']} | {r['kind']} | {'yes' if r['reached'] else 'NO'} | "
                     f"{c['intermediate']} | {c['flash']} | {c['shift_video']} | {c['shift_probe']} | {r.get('settle_ms', '')} | "
                     f"{r.get('jank_dropped', '')} | {'[png](' + r['sheet'] + ')' if r.get('sheet') else r.get('error', '')} |")
    lines += ["", "## Details of FAIL rows", ""]
    for r in rows:
        if "FAIL" in r["checks"].values():
            lines.append(f"- **{r['suite']}/{r['id']}** ({r['from']} → {r['to']}): "
                         + "; ".join(x for x in [
                             f"intermediate screens {r['intermediate']}" if r.get("intermediate") else "",
                             f"flash {r['flash']}" if r.get("flash") else "",
                             f"late change {r['shift']}" if r.get("shift") and r["kind"] != "scroll" else "",
                             f"probe {r['probe_shift'][:3]}" if r["probe_shift"] and r["kind"] != "scroll" else ""] if x))
    open(os.path.join(out, "motion-report.md"), "w", encoding="utf-8").write("\n".join(lines) + "\n")
    print("\n".join(lines[:3]))


if __name__ == "__main__":
    main()
