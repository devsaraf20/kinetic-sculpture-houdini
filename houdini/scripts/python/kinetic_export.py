"""
Kinetic sculpture height exporter for SideFX Houdini.

Exports the height of every ball, every frame, to the
"kinetic-sculpture-heights" JSON or CSV format (docs/FORMATS.md) that the
web app (web/index.html) and tools/pbridge.py read.

Three ways to run it
--------------------
1. Shelf tool / Python Shell (interactive):
       import kinetic_export; kinetic_export.run_shelf_tool()
   (or paste this whole file into a shelf tool's Script tab; it calls
   run_shelf_tool() when executed inside a Houdini UI session.)

2. Python Shell (scripted):
       import kinetic_export
       kinetic_export.export(sop_path="/obj/kinetic_sculpture/OUT_HEIGHTS",
                             out_path="$HIP/export/heights.json")

3. Command line with hython:
       hython houdini/scripts/python/kinetic_export.py scene.hip --sop /obj/kinetic_sculpture/OUT_HEIGHTS \
              --out heights.json --start 1 --end 600

What it reads
-------------
* SOP mode (recommended): one point per ball in a SOP. The point's P.y is
  the ball height. Packed primitives work too (one point per packed prim).
  Optional integer point attributes `row` and `col` fix the grid position;
  otherwise rows/cols are worked out from the X/Z positions.
* Object mode: object nodes matching a glob, e.g. "/obj/ball_*"; their
  world-space translate Y is the height.

Height convention: height_mm = (y - zero_y) * unit_scale. With the default
unit_scale = 1000 (Houdini metres -> mm) and zero_y = 0, a ball at y = 0 is
fully lowered and a ball at y = 0.8 is 800 mm above that.

The module has no hard dependency on `hou` so its pure functions can be
unit-tested outside Houdini.
"""

from __future__ import annotations

import csv
import io
import json
import math
import os
import sys

try:  # pragma: no cover - only available inside Houdini
    import hou  # type: ignore
except ImportError:  # running outside Houdini (tests, plain python)
    hou = None

FORMAT = "kinetic-sculpture-heights"
VERSION = 1

DEFAULT_LIMITS = {
    "min_mm": 0.0,
    "max_mm": 800.0,
    "max_speed": 200.0,  # mm/s
    "max_accel": 600.0,  # mm/s^2
    "boundary": "rest",
}


# --------------------------------------------------------------------------
# Pure helpers (no Houdini needed)
# --------------------------------------------------------------------------

def _cluster(values, gap):
    """Sorted cluster centres of 1D values: a new cluster starts after a jump > gap."""
    vals = sorted(values)
    groups = [[vals[0]]]
    for v in vals[1:]:
        if v - groups[-1][-1] > gap:
            groups.append([v])
        else:
            groups[-1].append(v)
    return [sum(g) / len(g) for g in groups]


def assign_grid(xz, rows_attr=None, cols_attr=None):
    """
    Work out (row, col) for every ball.

    xz: list of (x, z) rest positions. rows_attr/cols_attr: optional lists of
    ints from point attributes. Returns (rows, cols, [(row, col), ...],
    spacing) where spacing is in scene units (None if unknown).
    Rows run along +Z, columns along +X.
    """
    n = len(xz)
    if n == 0:
        raise ValueError("no balls found")
    if rows_attr is not None and cols_attr is not None:
        rc = list(zip(rows_attr, cols_attr))
        rows = max(r for r, _ in rc) + 1
        cols = max(c for _, c in rc) + 1
        if len(set(rc)) != n:
            raise ValueError("row/col attributes are not unique per ball")
        return rows, cols, rc, _spacing_from_xz(xz)

    xs = [p[0] for p in xz]
    zs = [p[1] for p in xz]
    # Ball spacing ~ the largest jump between neighbouring sorted coordinates;
    # anything well below it (placement jitter) belongs to the same row/column.
    jumps = [b - a for vals in (sorted(xs), sorted(zs)) for a, b in zip(vals, vals[1:])]
    gap = 0.4 * max(jumps) if jumps else 0.0
    cx = _cluster(xs, gap)
    cz = _cluster(zs, gap)
    if len(cx) * len(cz) == n:
        def nearest(c, v):
            return min(range(len(c)), key=lambda i: abs(c[i] - v))
        rc = [(nearest(cz, z), nearest(cx, x)) for x, z in xz]
        if len(set(rc)) == n:
            steps = sorted(b - a for c in (cx, cz) for a, b in zip(c, c[1:]))
            return len(cz), len(cx), rc, (steps[len(steps) // 2] if steps else None)
    # Not a clean grid: keep the incoming order and pick a near-square layout.
    rows = int(math.floor(math.sqrt(n)))
    while rows > 1 and n % rows:
        rows -= 1
    cols = n // rows
    return rows, cols, [(i // cols, i % cols) for i in range(n)], _spacing_from_xz(xz)


def _spacing_from_xz(xz):
    """Typical distance between neighbouring balls (scene units), robust to jitter."""
    xs = [p[0] for p in xz]
    zs = [p[1] for p in xz]
    jumps = [b - a for vals in (sorted(xs), sorted(zs)) for a, b in zip(vals, vals[1:])]
    if not jumps or max(jumps) <= 0:
        return None
    gap = 0.4 * max(jumps)
    steps = sorted(b - a for c in (_cluster(xs, gap), _cluster(zs, gap)) for a, b in zip(c, c[1:]))
    return steps[len(steps) // 2] if steps else None


def build_export(heights_by_frame, ball_rc, rows, cols, fps, frame_start=0,
                 spacing_mm=100.0, source="houdini", range_mm=None, names=None):
    """
    heights_by_frame: list of frames, each a list of heights (mm) in the
    incoming ball order. Balls are re-ordered row-major in the output.
    """
    order = sorted(range(len(ball_rc)), key=lambda i: (ball_rc[i][0], ball_rc[i][1]))
    balls = []
    for k, i in enumerate(order):
        b = {"index": k, "row": int(ball_rc[i][0]), "col": int(ball_rc[i][1])}
        if names:
            b["name"] = names[i]
        balls.append(b)
    frames = [[round(float(fr[i]), 3) for i in order] for fr in heights_by_frame]
    doc = {
        "format": FORMAT,
        "version": VERSION,
        "source": source,
        "units": "mm",
        "fps": float(fps),
        "frame_start": int(frame_start),
        "frame_count": len(frames),
        "grid": {"rows": int(rows), "cols": int(cols), "spacing_mm": round(float(spacing_mm), 3)},
    }
    if range_mm:
        doc["range_mm"] = [float(range_mm[0]), float(range_mm[1])]
    doc["balls"] = balls
    doc["frames"] = frames
    return doc


def dumps_json(doc):
    """JSON with one frame per line (valid JSON, readable diffs)."""
    head = dict(doc)
    head["grid"] = "__GRID__"
    head["balls"] = "__BALLS__"
    head["frames"] = "__FRAMES__"
    text = json.dumps(head, indent=2)

    def lines(items):
        return "[\n" + ",\n".join("    " + json.dumps(it, separators=(",", ":")) for it in items) + "\n  ]"

    text = text.replace('"__GRID__"', json.dumps(doc["grid"], separators=(",", ":")))
    text = text.replace('"__BALLS__"', lines(doc["balls"]))
    text = text.replace('"__FRAMES__"', lines(doc["frames"]))
    return text + "\n"


def dumps_csv(doc):
    out = io.StringIO()
    meta = [("format", FORMAT), ("version", VERSION), ("fps", _num(doc["fps"])),
            ("rows", doc["grid"]["rows"]), ("cols", doc["grid"]["cols"]),
            ("spacing_mm", _num(doc["grid"]["spacing_mm"])), ("units", "mm"), ("source", doc["source"])]
    if doc.get("range_mm"):
        meta.append(("range_mm", ",".join(_num(v) for v in doc["range_mm"])))
    for k, v in meta:
        out.write("# %s=%s\n" % (k, v))
    w = csv.writer(out, lineterminator="\n")
    w.writerow(["frame", "time_s"] + ["r%dc%d" % (b["row"], b["col"]) for b in doc["balls"]])
    for i, fr in enumerate(doc["frames"]):
        w.writerow([doc["frame_start"] + i, "%.4f" % (i / doc["fps"])] + [_num(v) for v in fr])
    return out.getvalue()


def _num(v):
    v = float(v)
    return str(int(v)) if v == int(v) else repr(round(v, 3))


def write_export(doc, path):
    path = os.path.expandvars(os.path.expanduser(path))
    d = os.path.dirname(os.path.abspath(path))
    if not os.path.isdir(d):
        os.makedirs(d)
    text = dumps_csv(doc) if path.lower().endswith(".csv") else dumps_json(doc)
    with open(path, "w", newline="") as f:
        f.write(text)
    return path


def check_limits(doc, limits=None):
    """
    Same motion model as the web app: constant speed between frames.
    Returns a dict with peaks and the list of violating frames.
    """
    lim = dict(DEFAULT_LIMITS)
    lim.update(limits or {})
    fps = float(doc["fps"])
    frames = doc["frames"]
    n = len(frames)
    nb = len(frames[0]) if n else 0
    rest = lim["boundary"] == "rest"
    bad = {}
    peak_v = peak_a = 0.0
    lo, hi = float("inf"), float("-inf")
    for b in range(nb):
        s = [fr[b] for fr in frames]
        vel = [0.0] + [(s[i] - s[i - 1]) * fps for i in range(1, n)]
        for i in range(n):
            v_prev = vel[i] if i >= 1 else (0.0 if rest else None)
            v_next = vel[i + 1] if i + 1 < n else (0.0 if rest else None)
            acc = 0.0 if v_prev is None or v_next is None else (v_next - v_prev) * fps
            why = []
            if s[i] < lim["min_mm"] - 1e-6 or s[i] > lim["max_mm"] + 1e-6 or s[i] != s[i]:
                why.append("range")
            if abs(vel[i]) > lim["max_speed"] * (1 + 1e-4):
                why.append("speed")
            if abs(acc) > lim["max_accel"] * (1 + 1e-4):
                why.append("accel")
            if why:
                bad.setdefault(i, set()).update(why)
            peak_v = max(peak_v, abs(vel[i]))
            peak_a = max(peak_a, abs(acc))
            lo, hi = min(lo, s[i]), max(hi, s[i])
    slowdown = max(1.0, peak_v / lim["max_speed"], math.sqrt(peak_a / lim["max_accel"]))
    return {
        "ok": not bad,
        "bad_frames": sorted(bad),
        "reasons": {f: sorted(r) for f, r in bad.items()},
        "peak_speed": peak_v,
        "peak_accel": peak_a,
        "min_mm": lo,
        "max_mm": hi,
        "slowdown": slowdown,
        "limits": lim,
    }


def format_report(rep):
    lim = rep["limits"]
    lines = [
        "Peak speed  %8.1f mm/s   (limit %g)" % (rep["peak_speed"], lim["max_speed"]),
        "Peak accel  %8.1f mm/s2  (limit %g)" % (rep["peak_accel"], lim["max_accel"]),
        "Height      %8.1f .. %.1f mm (allowed %g .. %g)" % (rep["min_mm"], rep["max_mm"], lim["min_mm"], lim["max_mm"]),
    ]
    if rep["ok"]:
        lines.append("OK: every frame is physically possible.")
    else:
        spans = _spans(rep["bad_frames"])
        shown = ", ".join("%d-%d" % (a, b) if a != b else str(a) for a, b in spans[:12])
        lines.append("%d frame(s) break a limit: %s%s" % (len(rep["bad_frames"]), shown, " ..." if len(spans) > 12 else ""))
        lines.append("Retiming alone would need the animation x%.2f slower (range problems are not fixed by retiming)." % rep["slowdown"])
        lines.append("Fix it in the scene, or load the export in the web app and use Auto-smooth.")
    return "\n".join(lines)


def _spans(frames):
    spans = []
    for f in frames:
        if spans and spans[-1][1] == f - 1:
            spans[-1][1] = f
        else:
            spans.append([f, f])
    return spans


# --------------------------------------------------------------------------
# Houdini side
# --------------------------------------------------------------------------

def _require_hou():
    if hou is None:
        raise RuntimeError("This function must run inside Houdini (hython or the Houdini UI).")


def scene_frame_range():
    _require_hou()
    try:
        r = hou.playbar.frameRange()
        return int(r[0]), int(r[1])
    except Exception:  # hython without a playbar
        return int(float(hou.expandString("$FSTART"))), int(float(hou.expandString("$FEND")))


def _sop_geometry(node, frame):
    if hasattr(node, "geometryAtFrame"):
        return node.geometryAtFrame(frame)
    hou.setFrame(frame)
    return node.geometry()


def collect_from_sop(sop_path, start, end, unit_scale=1000.0, zero_y=0.0):
    """Heights (mm) per frame from one point per ball in a SOP."""
    _require_hou()
    node = hou.node(sop_path)
    if node is None:
        raise ValueError("No node at %s" % sop_path)
    if not isinstance(node, hou.SopNode):
        # Allow pointing at a geo object: use its display SOP.
        node = node.displayNode() if hasattr(node, "displayNode") else None
        if node is None:
            raise ValueError("%s is not a SOP and has no display SOP" % sop_path)
    geo0 = _sop_geometry(node, start)
    n = len(geo0.iterPoints())
    if n == 0:
        raise ValueError("%s has no points at frame %d" % (node.path(), start))
    p0 = geo0.pointFloatAttribValues("P")
    xz = [(p0[3 * i], p0[3 * i + 2]) for i in range(n)]
    rows_attr = cols_attr = None
    if geo0.findPointAttrib("row") is not None and geo0.findPointAttrib("col") is not None:
        rows_attr = [int(v) for v in geo0.pointIntAttribValues("row")]
        cols_attr = [int(v) for v in geo0.pointIntAttribValues("col")]
    frames = []
    for f in range(int(start), int(end) + 1):
        geo = _sop_geometry(node, f)
        p = geo.pointFloatAttribValues("P")
        if len(p) != 3 * n:
            raise ValueError("Point count changed at frame %d (%d -> %d). Ball count must be constant."
                             % (f, n, len(p) // 3))
        frames.append([(p[3 * i + 1] - zero_y) * unit_scale for i in range(n)])
    return frames, xz, rows_attr, cols_attr, None


def collect_from_objects(pattern, start, end, unit_scale=1000.0, zero_y=0.0):
    """Heights (mm) per frame from object nodes matching a glob like /obj/ball_*."""
    _require_hou()
    parent, _, glob = pattern.rpartition("/")
    root = hou.node(parent or "/obj")
    objs = [o for o in root.glob(glob) if isinstance(o, hou.ObjNode)]
    if not objs:
        raise ValueError("No objects match %s" % pattern)
    t0 = hou.frameToTime(start)
    xz = []
    for o in objs:
        t = o.worldTransformAtTime(t0).extractTranslates()
        xz.append((t[0], t[2]))
    frames = []
    for f in range(int(start), int(end) + 1):
        t = hou.frameToTime(f)
        frames.append([(o.worldTransformAtTime(t).extractTranslates()[1] - zero_y) * unit_scale for o in objs])
    return frames, xz, None, None, [o.name() for o in objs]


def export(sop_path=None, objects=None, out_path="$HIP/export/heights.json", start=None, end=None,
           unit_scale=1000.0, zero_y=0.0, fps=None, limits=None, quiet=False):
    """
    Export heights. Give either sop_path (one point per ball) or objects
    (a glob such as "/obj/ball_*"). Returns (written_path, report).
    """
    _require_hou()
    fs, fe = scene_frame_range()
    start = fs if start is None else int(start)
    end = fe if end is None else int(end)
    fps = hou.fps() if fps is None else float(fps)
    if objects:
        frames, xz, ra, ca, names = collect_from_objects(objects, start, end, unit_scale, zero_y)
        src = "houdini:" + objects
    else:
        frames, xz, ra, ca, names = collect_from_sop(sop_path, start, end, unit_scale, zero_y)
        src = "houdini:" + sop_path
    rows, cols, rc, spacing = assign_grid(xz, ra, ca)
    lim = dict(DEFAULT_LIMITS)
    lim.update(limits or {})
    doc = build_export(frames, rc, rows, cols, fps, frame_start=start,
                       spacing_mm=(spacing * unit_scale) if spacing else 100.0,
                       source=src, range_mm=(lim["min_mm"], lim["max_mm"]), names=names)
    path = write_export(doc, hou.expandString(out_path))
    rep = check_limits(doc, lim)
    if not quiet:
        print("Exported %d balls (%dx%d) x %d frames @ %g fps -> %s" % (len(rc), rows, cols, len(frames), fps, path))
        print(format_report(rep))
    return path, rep


def check_scene(sop_path=None, objects=None, start=None, end=None, unit_scale=1000.0, zero_y=0.0,
                limits=None, show=True):
    """Check the scene against the limits without writing a file."""
    _require_hou()
    fs, fe = scene_frame_range()
    start = fs if start is None else int(start)
    end = fe if end is None else int(end)
    collect = collect_from_objects if objects else collect_from_sop
    frames, xz, ra, ca, names = collect(objects or sop_path, start, end, unit_scale, zero_y)
    rows, cols, rc, _ = assign_grid(xz, ra, ca)
    lim = dict(DEFAULT_LIMITS)
    lim.update(limits or {})
    doc = build_export(frames, rc, rows, cols, hou.fps(), frame_start=start)
    rep = check_limits(doc, lim)
    text = format_report(rep)
    if rep["bad_frames"]:
        text += "\n(Frame numbers above are scene frames %d + index.)" % start
    if show and hou.isUIAvailable():
        hou.ui.displayMessage(text, title="Kinetic sculpture limits",
                              severity=hou.severityType.Message if rep["ok"] else hou.severityType.Warning)
    else:
        print(text)
    return rep


def run_shelf_tool():
    """Interactive export with Houdini dialogs."""
    _require_hou()
    sel = hou.selectedNodes()
    default_src = sel[0].path() if sel else "/obj/kinetic_sculpture/OUT_HEIGHTS"
    fs, fe = scene_frame_range()
    labels = ("SOP path (or /obj/ball_* glob)", "Start frame", "End frame", "Unit scale (scene unit -> mm)",
              "Zero height Y (scene units)", "Max speed mm/s", "Max accel mm/s2", "Lowest mm", "Highest mm")
    initial = (default_src, str(fs), str(fe), "1000", "0",
               str(DEFAULT_LIMITS["max_speed"]), str(DEFAULT_LIMITS["max_accel"]),
               str(DEFAULT_LIMITS["min_mm"]), str(DEFAULT_LIMITS["max_mm"]))
    btn, vals = hou.ui.readMultiInput("Export kinetic sculpture heights", labels,
                                      buttons=("Export", "Cancel"), default_choice=0, close_choice=1,
                                      initial_contents=initial)
    if btn != 0:
        return None
    path = hou.ui.selectFile(start_directory="$HIP", title="Save heights", file_type=hou.fileType.Any,
                             pattern="*.json *.csv", default_value="$HIP/export/heights.json",
                             chooser_mode=hou.fileChooserMode.Write)
    if not path:
        return None
    src = vals[0].strip()
    limits = {"max_speed": float(vals[5]), "max_accel": float(vals[6]),
              "min_mm": float(vals[7]), "max_mm": float(vals[8])}
    kw = dict(out_path=path, start=int(vals[1]), end=int(vals[2]), unit_scale=float(vals[3]),
              zero_y=float(vals[4]), limits=limits, quiet=True)
    if "*" in src or "?" in src:
        written, rep = export(objects=src, **kw)
    else:
        written, rep = export(sop_path=src, **kw)
    sev = hou.severityType.Message if rep["ok"] else hou.severityType.Warning
    hou.ui.displayMessage("Wrote %s\n\n%s" % (written, format_report(rep)), severity=sev,
                          title="Kinetic sculpture export")
    return written


def main(argv=None):
    """hython entry point."""
    import argparse
    ap = argparse.ArgumentParser(description="Export kinetic sculpture ball heights from a .hip file")
    ap.add_argument("hip", nargs="?", help=".hip file to load (omit when already in a session)")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--sop", help="SOP with one point per ball, e.g. /obj/kinetic_sculpture/OUT_HEIGHTS")
    src.add_argument("--objects", help="object glob, e.g. '/obj/ball_*'")
    ap.add_argument("--out", required=True, help="output .json or .csv")
    ap.add_argument("--start", type=int)
    ap.add_argument("--end", type=int)
    ap.add_argument("--fps", type=float)
    ap.add_argument("--unit-scale", type=float, default=1000.0, help="scene units to mm (default 1000: metres)")
    ap.add_argument("--zero-y", type=float, default=0.0, help="scene Y that counts as height 0")
    ap.add_argument("--min-mm", type=float, default=DEFAULT_LIMITS["min_mm"])
    ap.add_argument("--max-mm", type=float, default=DEFAULT_LIMITS["max_mm"])
    ap.add_argument("--max-speed", type=float, default=DEFAULT_LIMITS["max_speed"])
    ap.add_argument("--max-accel", type=float, default=DEFAULT_LIMITS["max_accel"])
    ap.add_argument("--strict", action="store_true", help="exit with code 2 if limits are broken")
    a = ap.parse_args(argv)
    _require_hou()
    if a.hip:
        hou.hipFile.load(a.hip, suppress_save_prompt=True, ignore_load_warnings=True)
    limits = {"min_mm": a.min_mm, "max_mm": a.max_mm, "max_speed": a.max_speed, "max_accel": a.max_accel}
    _, rep = export(sop_path=a.sop, objects=a.objects, out_path=a.out, start=a.start, end=a.end,
                    unit_scale=a.unit_scale, zero_y=a.zero_y, fps=a.fps, limits=limits)
    return 2 if (a.strict and not rep["ok"]) else 0


if __name__ == "__main__":  # pragma: no cover
    if hou is not None and getattr(hou, "isUIAvailable", lambda: False)() and len(sys.argv) <= 1:
        run_shelf_tool()      # pasted into a shelf tool / run from the Python Source Editor
    else:
        sys.exit(main())
