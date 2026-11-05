#!/usr/bin/env python3
"""
pbridge -- Physical Bridge command-line tool.

    pbridge.py check   heights.json            # limit report (exit 1 if broken)
    pbridge.py convert heights.json -o show.pbridge.json
    pbridge.py info    show.pbridge.json
    pbridge.py ports                           # list serial ports
    pbridge.py stream  show.pbridge.json --port /dev/ttyUSB0 [--port /dev/ttyUSB1 ...]
    pbridge.py simulate show.pbridge.json      # stream to simulated boards (no hardware)

Heights files are the JSON/CSV written by the Houdini/Blender exporters or
the web app. Physical Bridge files and the wire protocol are described in
docs/PHYSICAL_BRIDGE.md. Only `stream` and `ports` need pyserial
(pip install pyserial); everything else is standard library.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import threading
import time

BRIDGE_FORMAT = "physical-bridge"
BRIDGE_VERSION = 1
HEIGHTS_FORMAT = "kinetic-sculpture-heights"

DEFAULT_LIMITS = {"min_mm": 0.0, "max_mm": 800.0, "max_speed": 200.0, "max_accel": 600.0, "boundary": "rest"}
DEFAULT_MACHINE = {"travel_mm": 800.0, "spool_diameter_mm": 20.0, "steps_per_rev": 200, "microsteps": 4,
                   "motors_per_board": 8, "home": "top", "max_step_rate": 4000}


# ---------------------------------------------------------------- heights I/O

class Heights:
    def __init__(self, fps, rows, cols, balls, frames, spacing_mm=100.0, range_mm=None, source=""):
        self.fps, self.rows, self.cols = float(fps), int(rows), int(cols)
        self.balls, self.frames = balls, frames
        self.spacing_mm, self.range_mm, self.source = spacing_mm, range_mm, source

    @property
    def frame_count(self):
        return len(self.frames)

    @property
    def ball_count(self):
        return len(self.balls)


def _guess_grid(n):
    r = int(math.floor(math.sqrt(n)))
    while r > 1 and n % r:
        r -= 1
    return r, n // r


def load_heights(path):
    with open(path, newline="") as f:
        text = f.read()
    if path.lower().endswith(".json") or text.lstrip().startswith("{"):
        doc = json.loads(text)
        if doc.get("format") == BRIDGE_FORMAT:
            raise SystemExit("%s is a Physical Bridge file, not a heights export" % path)
        frames = [[float(v) for v in fr] for fr in doc["frames"]]
        n = len(frames[0])
        grid = doc.get("grid") or {}
        rows, cols = grid.get("rows"), grid.get("cols")
        if not rows or not cols:
            rows, cols = _guess_grid(n)
        balls = [{"row": b.get("row", i // cols), "col": b.get("col", i % cols)} for i, b in enumerate(doc["balls"])] \
            if doc.get("balls") else [{"row": i // cols, "col": i % cols} for i in range(n)]
        return Heights(doc.get("fps", 30), rows, cols, balls, frames, grid.get("spacing_mm", 100.0),
                       doc.get("range_mm"), doc.get("source", ""))
    meta, header, rows_out = {}, None, []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            body = line[1:].strip()
            for sep in ("=", ":"):
                if sep in body:
                    k, v = body.split(sep, 1)
                    meta[k.strip()] = v.strip()
                    break
            continue
        cells = [c.strip() for c in line.split(",")]
        if header is None:
            header = cells
        else:
            rows_out.append(cells)
    if header is None:
        raise SystemExit("%s: no CSV header" % path)
    skip = {"frame", "time", "time_s", "t"}
    idx = [i for i, h in enumerate(header) if h.lower() not in skip]
    balls = []
    for i in idx:
        h = header[i].lower()
        if h.startswith("r") and "c" in h:
            try:
                r, c = h[1:].split("c", 1)
                balls.append({"row": int(r), "col": int(c)})
                continue
            except ValueError:
                pass
        balls = None
        break
    if balls:
        rows, cols = max(b["row"] for b in balls) + 1, max(b["col"] for b in balls) + 1
    else:
        rows, cols = int(meta.get("rows", 0)), int(meta.get("cols", 0))
        if not rows or not cols:
            rows, cols = _guess_grid(len(idx))
        balls = [{"row": k // cols, "col": k % cols} for k in range(len(idx))]
    frames = [[float(r[i]) for i in idx] for r in rows_out]
    rng = [float(v) for v in meta["range_mm"].replace(";", ",").split(",")] if "range_mm" in meta else None
    return Heights(meta.get("fps", 30), rows, cols, balls, frames, float(meta.get("spacing_mm", 100)), rng,
                   meta.get("source", "csv"))


# ---------------------------------------------------------------- limit check

def check(h, limits):
    """Same model as the web app: constant speed between frames."""
    fps, n = h.fps, h.frame_count
    rest = limits["boundary"] == "rest"
    bad, reasons = set(), {}
    pv = pa = 0.0
    lo, hi = float("inf"), float("-inf")
    for b in range(h.ball_count):
        s = [fr[b] for fr in h.frames]
        vel = [0.0] + [(s[i] - s[i - 1]) * fps for i in range(1, n)]
        for i in range(n):
            vp = vel[i] if i else (0.0 if rest else None)
            vn = vel[i + 1] if i + 1 < n else (0.0 if rest else None)
            acc = 0.0 if vp is None or vn is None else (vn - vp) * fps
            why = []
            if not (limits["min_mm"] - 1e-6 <= s[i] <= limits["max_mm"] + 1e-6):
                why.append("range")
            if abs(vel[i]) > limits["max_speed"] * (1 + 1e-4):
                why.append("speed")
            if abs(acc) > limits["max_accel"] * (1 + 1e-4):
                why.append("accel")
            if why:
                bad.add(i)
                reasons.setdefault(i, set()).update(why)
            pv, pa = max(pv, abs(vel[i])), max(pa, abs(acc))
            lo, hi = min(lo, s[i]), max(hi, s[i])
    return {"ok": not bad, "bad_frames": sorted(bad), "reasons": reasons, "peak_speed": pv, "peak_accel": pa,
            "min_mm": lo, "max_mm": hi,
            "slowdown": max(1.0, pv / limits["max_speed"], math.sqrt(pa / limits["max_accel"]))}


def print_report(rep, limits, out=None):
    out = out or sys.stdout
    out.write("Peak speed  %9.1f mm/s   (limit %g)\n" % (rep["peak_speed"], limits["max_speed"]))
    out.write("Peak accel  %9.1f mm/s^2 (limit %g)\n" % (rep["peak_accel"], limits["max_accel"]))
    out.write("Height      %9.1f .. %.1f mm (allowed %g .. %g)\n" % (rep["min_mm"], rep["max_mm"],
                                                                     limits["min_mm"], limits["max_mm"]))
    if rep["ok"]:
        out.write("OK: every frame is within the limits.\n")
        return
    spans = []
    for f in rep["bad_frames"]:
        if spans and spans[-1][1] == f - 1:
            spans[-1][1] = f
        else:
            spans.append([f, f])
    out.write("%d frame(s) break a limit:\n" % len(rep["bad_frames"]))
    for a, b in spans[:20]:
        why = sorted(set().union(*(rep["reasons"][f] for f in range(a, b + 1))))
        out.write("  frames %5d-%-5d %s\n" % (a, b, ", ".join(why)))
    if len(spans) > 20:
        out.write("  ... and %d more spans\n" % (len(spans) - 20))
    out.write("Retiming alone would need x%.2f slower. Use the web app's Auto-smooth to fix it.\n" % rep["slowdown"])


# ---------------------------------------------------------------- bridge

def steps_per_mm(m):
    return (m["steps_per_rev"] * m["microsteps"]) / (math.pi * m["spool_diameter_mm"])


def _round_half_up(x):  # matches JavaScript Math.round
    return int(math.floor(x + 0.5))


def height_to_steps(h, m, spm):
    hc = min(m["travel_mm"], max(0.0, h))
    return _round_half_up((hc if m["home"] == "bottom" else m["travel_mm"] - hc) * spm)


def build_bridge(h, machine, limits):
    m = dict(DEFAULT_MACHINE, **machine)
    spm = steps_per_mm(m)
    base = limits["min_mm"]
    frames, clipped = [], 0
    for fr in h.frames:
        row = []
        for v in fr:
            hh = v - base
            if hh < -1e-6 or hh > m["travel_mm"] + 1e-6:
                clipped += 1
            row.append(height_to_steps(hh, m, spm))
        frames.append(row)
    peak = 0.0
    for a, b in zip(frames, frames[1:]):
        for x, y in zip(a, b):
            peak = max(peak, abs(y - x) * h.fps)
    mpb = int(m["motors_per_board"])
    boards = [{"board": k, "motors": list(range(s, min(s + mpb, h.ball_count)))}
              for k, s in enumerate(range(0, h.ball_count, mpb))]
    return {
        "format": BRIDGE_FORMAT, "version": BRIDGE_VERSION, "fps": h.fps,
        "frame_count": h.frame_count, "motor_count": h.ball_count,
        "machine": {"travel_mm": m["travel_mm"], "steps_per_mm": round(spm, 6), "home": m["home"],
                    "spool_diameter_mm": m["spool_diameter_mm"], "steps_per_rev": m["steps_per_rev"],
                    "microsteps": m["microsteps"],
                    "max_steps": height_to_steps(m["travel_mm"] if m["home"] == "bottom" else 0, m, spm)},
        "limits": dict(limits),
        "stats": {"peak_step_rate": peak, "clipped_samples": clipped},
        "grid": {"rows": h.rows, "cols": h.cols, "spacing_mm": h.spacing_mm},
        "balls": [{"index": i, "row": b["row"], "col": b["col"]} for i, b in enumerate(h.balls)],
        "boards": boards,
        "frames": frames,
    }


def dumps_bridge(doc):
    head = dict(doc, boards="__BOARDS__", frames="__FRAMES__")
    text = json.dumps(head, indent=2)

    def lines(items):
        return "[\n" + ",\n".join("    " + json.dumps(it, separators=(",", ":")) for it in items) + "\n  ]"

    return text.replace('"__BOARDS__"', lines(doc["boards"])).replace('"__FRAMES__"', lines(doc["frames"])) + "\n"


def load_bridge(path):
    with open(path) as f:
        doc = json.load(f)
    if doc.get("format") != BRIDGE_FORMAT:
        raise SystemExit("%s is not a Physical Bridge file" % path)
    if doc.get("version", 1) > BRIDGE_VERSION:
        raise SystemExit("%s uses Physical Bridge v%s; this tool reads v%d" % (path, doc["version"], BRIDGE_VERSION))
    return doc


def board_frames(doc, board):
    motors = doc["boards"][board]["motors"]
    return [[fr[i] for i in motors] for fr in doc["frames"]]


# ---------------------------------------------------------------- streaming

class Link:
    """Line-based connection to one board (wraps a pyserial port or a simulator)."""

    def __init__(self, port, name, log):
        self.port, self.name, self.log = port, name, log
        self.lines = []
        self.cond = threading.Condition()
        self.consumed = 0
        self.done = False
        self.alive = True
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        buf = b""
        while self.alive:
            try:
                chunk = self.port.read(256)
            except Exception as e:  # port closed / unplugged
                self.log("%s: read failed: %s" % (self.name, e))
                break
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                line = raw.decode("ascii", "replace").strip()
                if line:
                    self._handle(line)

    def _handle(self, line):
        with self.cond:
            if line.startswith("C "):
                self.consumed = int(line.split()[1])
            elif line.startswith("DONE"):
                self.done = True
            elif line.startswith("U "):
                self.log("%s: buffer underrun at frame %s (host too slow?)" % (self.name, line[2:]))
            elif line.startswith("E "):
                self.log("%s: error: %s" % (self.name, line[2:]))
                self.lines.append(line)
            else:
                self.lines.append(line)
            self.cond.notify_all()

    def send(self, line):
        self.port.write((line + "\n").encode("ascii"))

    def expect(self, prefix, timeout):
        """Wait for a line equal to prefix or starting with prefix + ' '."""
        end = time.time() + timeout
        with self.cond:
            while True:
                for i, line in enumerate(self.lines):
                    if line == prefix or line.startswith(prefix + " "):
                        del self.lines[:i + 1]
                        return line
                    if line.startswith("E "):
                        del self.lines[:i + 1]
                        raise RuntimeError("%s: %s" % (self.name, line[2:]))
                left = end - time.time()
                if left <= 0:
                    raise TimeoutError("%s: no %r within %.0f s" % (self.name, prefix, timeout))
                self.cond.wait(left)

    def command(self, line, expect, timeout=5.0):
        self.send(line)
        return self.expect(expect, timeout)

    def close(self):
        self.alive = False


def play(doc, links, home=True, loop=False, log=print, progress=None):
    """Drive one board per link through the whole show (see docs/PHYSICAL_BRIDGE.md)."""
    if len(links) != len(doc["boards"]):
        raise SystemExit("show needs %d board(s), %d given" % (len(doc["boards"]), len(links)))
    n = doc["frame_count"]
    states = []
    for i, link in enumerate(links):
        reply = link.command("HELLO", "PB1", 5)
        _, board_id, motors, cap = reply.split()[:4]
        need = len(doc["boards"][i]["motors"])
        if int(motors) < need:
            raise SystemExit("%s drives %s motors but board %d of the show needs %d" % (link.name, motors, i, need))
        link.command("STOP", "OK", 5)
        link.command("FPS %g" % doc["fps"], "OK", 5)
        frames = board_frames(doc, i)
        pad = [0] * (int(motors) - need)
        states.append({"link": link, "frames": frames, "pad": pad, "cap": int(cap), "sent": 0, "ended": False})
        log("%s: board id %s, %s motors, buffer %s frames" % (link.name, board_id, motors, cap))

    def line(st, f):
        return "F " + " ".join(str(v) for v in st["frames"][f % n] + st["pad"])

    if home:
        log("Homing...")
        for st in states:
            st["link"].send("HOME")
        for st in states:
            st["link"].expect("HOMED", 180)
    log("Moving to the first frame...")
    for st in states:
        st["link"].send(line(st, 0).replace("F", "GOTO", 1))
    for st in states:
        st["link"].expect("AT", 120)

    def pump(st):
        link = st["link"]
        while (loop or st["sent"] < n) and st["sent"] - link.consumed < st["cap"]:
            link.send(line(st, st["sent"]))
            st["sent"] += 1
        if not loop and st["sent"] >= n and not st["ended"]:
            link.send("END")
            st["ended"] = True

    for st in states:
        pump(st)
    # Board 0 is the sync master (if wired): start the others first.
    for st in reversed(states):
        st["link"].send("PLAY")
    log("Playing %d frames at %g fps on %d board(s)..." % (n, doc["fps"], len(states)))
    last = -1
    try:
        while True:
            for st in states:
                pump(st)
            done = all(st["link"].done for st in states)
            low = min(st["link"].consumed for st in states)
            if progress and low != last:
                progress(low, n)
                last = low
            if done:
                break
            with states[0]["link"].cond:
                states[0]["link"].cond.wait(0.005)
    except KeyboardInterrupt:
        log("Stopping...")
        for st in states:
            st["link"].send("STOP")
        raise
    log("Show finished.")


# ---------------------------------------------------------------- simulator

class SimBoard:
    """A software board that speaks the protocol (used by `simulate` and the tests)."""

    def __init__(self, motors=8, capacity=32, fps_scale=1.0, board_id=0):
        self.motors, self.capacity, self.board_id = motors, capacity, board_id
        self.fps, self.fps_scale = 30.0, fps_scale
        self.out = b""
        self.buf, self.consumed, self.playing, self.ended = [], 0, False, False
        self.pos = [0] * motors
        self.received = []
        self.max_jump = 0
        self.lock = threading.Condition()
        self.next_tick = None
        self.partial = b""

    # pyserial-like API
    def write(self, data):
        with self.lock:
            self.partial += data
            while b"\n" in self.partial:
                raw, self.partial = self.partial.split(b"\n", 1)
                self._cmd(raw.decode().strip())
            self.lock.notify_all()

    def read(self, size=1):
        with self.lock:
            self._tick()
            if not self.out:
                self.lock.wait(0.002)
                self._tick()
            data, self.out = self.out[:size], self.out[size:]
            return data

    def _say(self, s):
        self.out += (s + "\n").encode()

    def _cmd(self, line):
        parts = line.split()
        if not parts:
            return
        c, args = parts[0], parts[1:]
        if c == "HELLO":
            self._say("PB1 %d %d %d" % (self.board_id, self.motors, self.capacity))
        elif c == "FPS":
            self.fps = float(args[0])
            self._say("OK FPS")
        elif c == "STOP":
            self.buf, self.consumed, self.playing, self.ended = [], 0, False, False
            self._say("OK STOP")
        elif c in ("HOME", "ZERO"):
            self.pos = [0] * self.motors
            self._say("HOMED" if c == "HOME" else "OK ZERO")
        elif c == "GOTO":
            self.pos = [int(v) for v in args]
            self._say("AT")
        elif c == "F":
            if len(args) != self.motors:
                self._say("E BAD_FRAME")
            elif len(self.buf) >= self.capacity:
                self._say("E OVERFLOW")
            else:
                self.buf.append([int(v) for v in args])
        elif c == "PLAY":
            self.playing = True
            self.next_tick = time.time()
            self._say("OK PLAY")
        elif c == "END":
            self.ended = True
        else:
            self._say("E UNKNOWN %s" % c)

    def _tick(self):
        if not self.playing:
            return
        now = time.time()
        period = 1.0 / (self.fps * self.fps_scale)
        while self.playing and now >= self.next_tick:
            self.next_tick += period
            if self.buf:
                fr = self.buf.pop(0)
                self.max_jump = max(self.max_jump, max(abs(a - b) for a, b in zip(fr, self.pos)))
                self.pos = fr
                self.received.append(fr)
                self.consumed += 1
                self._say("C %d" % self.consumed)
            elif self.ended:
                self.playing = False
                self._say("DONE %d" % self.consumed)
            else:
                self._say("U %d" % self.consumed)


# ---------------------------------------------------------------- CLI

def _limits_from(a, h=None):
    lim = dict(DEFAULT_LIMITS)
    if h is not None and h.range_mm:
        lim["min_mm"], lim["max_mm"] = h.range_mm
    for k in ("min_mm", "max_mm", "max_speed", "max_accel"):
        v = getattr(a, k, None)
        if v is not None:
            lim[k] = v
    if getattr(a, "free", False):
        lim["boundary"] = "free"
    return lim


def _add_limit_args(p):
    p.add_argument("--min-mm", dest="min_mm", type=float, help="lowest allowed height (default 0 or file range)")
    p.add_argument("--max-mm", dest="max_mm", type=float, help="highest allowed height (default 800 or file range)")
    p.add_argument("--max-speed", dest="max_speed", type=float, help="mm/s (default 200)")
    p.add_argument("--max-accel", dest="max_accel", type=float, help="mm/s^2 (default 600)")
    p.add_argument("--free", action="store_true", help="do not assume the show starts/ends at rest")


def cmd_check(a):
    h = load_heights(a.input)
    lim = _limits_from(a, h)
    print("%s: %d balls (%dx%d), %d frames @ %g fps" % (a.input, h.ball_count, h.rows, h.cols, h.frame_count, h.fps))
    rep = check(h, lim)
    print_report(rep, lim)
    return 0 if rep["ok"] else 1


def cmd_convert(a):
    h = load_heights(a.input)
    lim = _limits_from(a, h)
    rep = check(h, lim)
    if not rep["ok"]:
        print_report(rep, lim, sys.stderr)
        if not a.force:
            sys.stderr.write("Refusing to convert an animation that breaks the limits (use --force to override).\n")
            return 1
    m = dict(DEFAULT_MACHINE, travel_mm=lim["max_mm"] - lim["min_mm"], spool_diameter_mm=a.spool,
             steps_per_rev=a.steps_per_rev, microsteps=a.microsteps, motors_per_board=a.motors_per_board, home=a.home)
    doc = build_bridge(h, m, lim)
    out = a.output or a.input.rsplit(".", 1)[0] + ".pbridge.json"
    with open(out, "w") as f:
        f.write(dumps_bridge(doc))
    print("Wrote %s: %d motors on %d board(s), %d frames, %.3f steps/mm, peak %.0f steps/s" % (
        out, doc["motor_count"], len(doc["boards"]), doc["frame_count"], doc["machine"]["steps_per_mm"],
        doc["stats"]["peak_step_rate"]))
    if doc["stats"]["peak_step_rate"] > a.max_step_rate:
        print("WARNING: peak step rate exceeds --max-step-rate %g; lower microstepping or the speed limit."
              % a.max_step_rate)
    return 0


def cmd_info(a):
    doc = load_bridge(a.input)
    m = doc["machine"]
    print("Physical Bridge v%d: %d motors, %d frames @ %g fps (%.1f s)" % (
        doc["version"], doc["motor_count"], doc["frame_count"], doc["fps"], (doc["frame_count"] - 1) / doc["fps"]))
    print("Machine: travel %g mm, %.4f steps/mm, home at %s, max %d steps" % (m["travel_mm"], m["steps_per_mm"],
                                                                         m["home"], m["max_steps"]))
    print("Peak step rate: %.0f steps/s" % doc["stats"]["peak_step_rate"])
    for b in doc["boards"]:
        print("  board %d: balls %s" % (b["board"], b["motors"]))
    return 0


def _progress(done, total):
    if not sys.stdout.isatty():
        step = max(1, total // 10)
        if done % step == 0 or done >= total:
            print("%d/%d frames" % (done, total))
        return
    w = 40
    k = int(w * done / max(total, 1))
    sys.stdout.write("\r[%s%s] %d/%d" % ("#" * k, "." * (w - k), done, total))
    sys.stdout.flush()
    if done >= total:
        sys.stdout.write("\n")


def cmd_ports(a):
    try:
        from serial.tools import list_ports
    except ImportError:
        print("pyserial is not installed: pip install pyserial")
        return 1
    for p in list_ports.comports():
        print("%-20s %s" % (p.device, p.description))
    return 0


def cmd_stream(a):
    try:
        import serial
    except ImportError:
        print("pyserial is not installed: pip install pyserial")
        return 1
    doc = load_bridge(a.input)
    links = []
    for i, dev in enumerate(a.port):
        sp = serial.Serial(dev, a.baud, timeout=0.05)
        links.append(Link(sp, "board%d(%s)" % (i, dev), print))
    time.sleep(2.0)  # most boards reset when the port opens
    try:
        play(doc, links, home=not a.no_home, loop=a.loop, progress=_progress)
    finally:
        for l in links:
            l.close()
    return 0


def cmd_simulate(a):
    doc = load_bridge(a.input)
    boards = [SimBoard(motors=len(b["motors"]), capacity=a.buffer, fps_scale=a.speed, board_id=i)
              for i, b in enumerate(doc["boards"])]
    links = [Link(b, "sim%d" % i, print) for i, b in enumerate(boards)]
    t0 = time.time()
    play(doc, links, home=True, progress=_progress)
    for l in links:
        l.close()
    ok = all(b.received == board_frames(doc, i) for i, b in enumerate(boards))
    jumps = max(b.max_jump for b in boards)
    print("Simulated %d board(s) in %.1f s: %s; largest per-frame move %d steps (%.0f steps/s)" % (
        len(boards), time.time() - t0, "all frames delivered in order" if ok else "FRAME MISMATCH",
        jumps, jumps * doc["fps"]))
    return 0 if ok else 1


def main(argv=None):
    ap = argparse.ArgumentParser(prog="pbridge", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("check", help="check a heights export against the machine limits")
    p.add_argument("input")
    _add_limit_args(p)
    p.set_defaults(fn=cmd_check)

    p = sub.add_parser("convert", help="heights export -> Physical Bridge (.pbridge.json)")
    p.add_argument("input")
    p.add_argument("-o", "--output")
    _add_limit_args(p)
    p.add_argument("--spool", type=float, default=DEFAULT_MACHINE["spool_diameter_mm"], help="spool diameter mm")
    p.add_argument("--steps-per-rev", type=int, default=DEFAULT_MACHINE["steps_per_rev"])
    p.add_argument("--microsteps", type=int, default=DEFAULT_MACHINE["microsteps"])
    p.add_argument("--motors-per-board", type=int, default=DEFAULT_MACHINE["motors_per_board"])
    p.add_argument("--home", choices=("top", "bottom"), default="top")
    p.add_argument("--max-step-rate", type=float, default=DEFAULT_MACHINE["max_step_rate"])
    p.add_argument("--force", action="store_true", help="convert even if limits are broken")
    p.set_defaults(fn=cmd_convert)

    p = sub.add_parser("info", help="summarise a Physical Bridge file")
    p.add_argument("input")
    p.set_defaults(fn=cmd_info)

    p = sub.add_parser("ports", help="list serial ports")
    p.set_defaults(fn=cmd_ports)

    p = sub.add_parser("stream", help="play a Physical Bridge file on the hardware")
    p.add_argument("input")
    p.add_argument("--port", action="append", required=True, help="serial port of board 0, then board 1, ...")
    p.add_argument("--baud", type=int, default=115200)
    p.add_argument("--no-home", action="store_true", help="skip homing (positions must already be known)")
    p.add_argument("--loop", action="store_true", help="repeat forever (Ctrl+C to stop)")
    p.set_defaults(fn=cmd_stream)

    p = sub.add_parser("simulate", help="stream to simulated boards to test a file without hardware")
    p.add_argument("input")
    p.add_argument("--buffer", type=int, default=32)
    p.add_argument("--speed", type=float, default=4.0, help="play faster than real time (default x4)")
    p.set_defaults(fn=cmd_simulate)

    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
