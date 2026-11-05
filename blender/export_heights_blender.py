"""
Kinetic sculpture height exporter for Blender (3.x / 4.x).

Writes the same "kinetic-sculpture-heights" JSON / CSV as the Houdini
exporter (docs/FORMATS.md).

Run it
------
* Text Editor: open this file, edit the CONFIG block, press Run Script.
* Command line:
      blender -b scene.blend --python blender/export_heights_blender.py -- \
          --collection Balls --out heights.json
      blender -b scene.blend --python blender/export_heights_blender.py -- \
          --mesh Sculpture --out heights.csv --start 1 --end 600

Sources
-------
* COLLECTION: every object in a collection (default "Balls"); the world
  Z of each object's origin is the ball height. Works with keyframes,
  drivers, constraints, physics bakes, anything that moves the objects.
* MESH: the evaluated vertices of one object (modifiers and Geometry Nodes
  applied), one vertex per ball. In Geometry Nodes output the ball centres
  as points/vertices (or Realize Instances on the centre points only).

Blender is Z-up: height_mm = (z - zero_z) * unit_scale. unit_scale defaults
to 1000 * scene.unit_settings.scale_length (Blender units -> mm).
"""

import csv
import io
import json
import math
import os
import sys

try:  # pragma: no cover - only inside Blender
    import bpy  # type: ignore
except ImportError:
    bpy = None

FORMAT = "kinetic-sculpture-heights"
VERSION = 1

# ----------------------------------------------------------------- CONFIG
CONFIG = {
    "source": "COLLECTION",       # "COLLECTION" or "MESH"
    "collection": "Balls",
    "mesh_object": "Sculpture",
    "out_path": "//export/heights.json",   # // = next to the .blend; .json or .csv
    "start": None,                # None = scene frame range
    "end": None,
    "unit_scale": None,           # None = 1000 * scene unit scale
    "zero_z": 0.0,
    "min_mm": 0.0, "max_mm": 800.0, "max_speed": 200.0, "max_accel": 600.0,
}
# ------------------------------------------------------------------------


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


def _spacing(cx, cy):
    d = sorted(b - a for c in (cx, cy) for a, b in zip(c, c[1:]))
    return d[len(d) // 2] if d else None


def assign_grid(xy):
    """(rows, cols, [(row, col)], spacing). Rows along +Y, columns along +X."""
    n = len(xy)
    if n == 0:
        raise ValueError("no balls found")
    xs = [p[0] for p in xy]
    ys = [p[1] for p in xy]
    # Ball spacing ~ the largest jump between neighbouring sorted coordinates;
    # anything well below it (placement jitter) belongs to the same row/column.
    jumps = [b - a for vals in (sorted(xs), sorted(ys)) for a, b in zip(vals, vals[1:])]
    gap = 0.4 * max(jumps) if jumps else 0.0
    cx, cy = _cluster(xs, gap), _cluster(ys, gap)
    spacing = _spacing(cx, cy)
    if len(cx) * len(cy) == n:
        def nearest(c, v):
            return min(range(len(c)), key=lambda i: abs(c[i] - v))
        rc = [(nearest(cy, y), nearest(cx, x)) for x, y in xy]
        if len(set(rc)) == n:
            return len(cy), len(cx), rc, spacing
    rows = int(math.floor(math.sqrt(n)))
    while rows > 1 and n % rows:
        rows -= 1
    cols = n // rows
    return rows, cols, [(i // cols, i % cols) for i in range(n)], spacing


def build_export(frames, rc, rows, cols, fps, frame_start, spacing_mm, source, range_mm, names=None):
    order = sorted(range(len(rc)), key=lambda i: rc[i])
    balls = []
    for k, i in enumerate(order):
        b = {"index": k, "row": rc[i][0], "col": rc[i][1]}
        if names:
            b["name"] = names[i]
        balls.append(b)
    return {
        "format": FORMAT, "version": VERSION, "source": source, "units": "mm",
        "fps": float(fps), "frame_start": int(frame_start), "frame_count": len(frames),
        "grid": {"rows": rows, "cols": cols, "spacing_mm": round(float(spacing_mm), 3)},
        "range_mm": [float(range_mm[0]), float(range_mm[1])],
        "balls": balls,
        "frames": [[round(float(fr[i]), 3) for i in order] for fr in frames],
    }


def dumps_json(doc):
    head = dict(doc, grid="__GRID__", balls="__BALLS__", frames="__FRAMES__")
    text = json.dumps(head, indent=2)

    def lines(items):
        return "[\n" + ",\n".join("    " + json.dumps(it, separators=(",", ":")) for it in items) + "\n  ]"

    return (text.replace('"__GRID__"', json.dumps(doc["grid"], separators=(",", ":")))
            .replace('"__BALLS__"', lines(doc["balls"]))
            .replace('"__FRAMES__"', lines(doc["frames"])) + "\n")


def _num(v):
    v = float(v)
    return str(int(v)) if v == int(v) else repr(round(v, 3))


def dumps_csv(doc):
    out = io.StringIO()
    for k, v in (("format", FORMAT), ("version", VERSION), ("fps", _num(doc["fps"])),
                 ("rows", doc["grid"]["rows"]), ("cols", doc["grid"]["cols"]),
                 ("spacing_mm", _num(doc["grid"]["spacing_mm"])), ("units", "mm"), ("source", doc["source"]),
                 ("range_mm", ",".join(_num(v) for v in doc["range_mm"]))):
        out.write("# %s=%s\n" % (k, v))
    w = csv.writer(out, lineterminator="\n")
    w.writerow(["frame", "time_s"] + ["r%dc%d" % (b["row"], b["col"]) for b in doc["balls"]])
    for i, fr in enumerate(doc["frames"]):
        w.writerow([doc["frame_start"] + i, "%.4f" % (i / doc["fps"])] + [_num(v) for v in fr])
    return out.getvalue()


def quick_check(doc, max_speed, max_accel, min_mm, max_mm):
    """Peak speed / accel and a count of violating frames (rest at both ends)."""
    fps = doc["fps"]
    frames = doc["frames"]
    n = len(frames)
    bad = set()
    pv = pa = 0.0
    for b in range(len(frames[0])):
        s = [fr[b] for fr in frames]
        vel = [0.0] + [(s[i] - s[i - 1]) * fps for i in range(1, n)] + [0.0]
        for i in range(n):
            acc = (vel[i + 1] - vel[i]) * fps
            pv, pa = max(pv, abs(vel[i])), max(pa, abs(acc))
            if abs(vel[i]) > max_speed * 1.0001 or abs(acc) > max_accel * 1.0001 or not (min_mm - 1e-6 <= s[i] <= max_mm + 1e-6):
                bad.add(i)
    return {"ok": not bad, "bad_frames": sorted(bad), "peak_speed": pv, "peak_accel": pa}


# ----------------------------------------------------------------- Blender

def _collect(cfg):
    scene = bpy.context.scene
    start = scene.frame_start if cfg["start"] is None else int(cfg["start"])
    end = scene.frame_end if cfg["end"] is None else int(cfg["end"])
    scale = cfg["unit_scale"] or 1000.0 * scene.unit_settings.scale_length
    zero = cfg["zero_z"]
    names = None
    if cfg["source"].upper() == "COLLECTION":
        coll = bpy.data.collections.get(cfg["collection"])
        if coll is None:
            raise ValueError("No collection named %r" % cfg["collection"])
        objs = sorted(coll.all_objects, key=lambda o: o.name)
        if not objs:
            raise ValueError("Collection %r is empty" % cfg["collection"])
        names = [o.name for o in objs]

        def sample():
            return [(o.matrix_world.translation.x, o.matrix_world.translation.y, o.matrix_world.translation.z) for o in objs]
    else:
        obj = bpy.data.objects.get(cfg["mesh_object"])
        if obj is None:
            raise ValueError("No object named %r" % cfg["mesh_object"])

        def sample():
            dg = bpy.context.evaluated_depsgraph_get()
            ev = obj.evaluated_get(dg)
            mesh = ev.to_mesh()
            mw = ev.matrix_world
            pts = [tuple(mw @ v.co) for v in mesh.vertices]
            ev.to_mesh_clear()
            return pts

    frames, xy, count = [], None, None
    current = scene.frame_current
    try:
        for f in range(start, end + 1):
            scene.frame_set(f)
            pts = sample()
            if count is None:
                count = len(pts)
                xy = [(p[0], p[1]) for p in pts]
            elif len(pts) != count:
                raise ValueError("Ball count changed at frame %d (%d -> %d)" % (f, count, len(pts)))
            frames.append([(p[2] - zero) * scale for p in pts])
    finally:
        scene.frame_set(current)
    fps = scene.render.fps / scene.render.fps_base
    return frames, xy, names, start, fps, scale


def export(cfg=None):
    cfg = dict(CONFIG, **(cfg or {}))
    frames, xy, names, start, fps, scale = _collect(cfg)
    rows, cols, rc, spacing = assign_grid(xy)
    src = "blender:" + (cfg["collection"] if cfg["source"].upper() == "COLLECTION" else cfg["mesh_object"])
    doc = build_export(frames, rc, rows, cols, fps, start, (spacing or 0.1) * scale, src,
                       (cfg["min_mm"], cfg["max_mm"]), names)
    path = bpy.path.abspath(cfg["out_path"])
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", newline="") as f:
        f.write(dumps_csv(doc) if path.lower().endswith(".csv") else dumps_json(doc))
    rep = quick_check(doc, cfg["max_speed"], cfg["max_accel"], cfg["min_mm"], cfg["max_mm"])
    print("Exported %d balls (%dx%d) x %d frames @ %g fps -> %s" % (len(rc), rows, cols, len(frames), fps, path))
    print("Peak speed %.1f mm/s (limit %g), peak accel %.1f mm/s2 (limit %g): %s" % (
        rep["peak_speed"], cfg["max_speed"], rep["peak_accel"], cfg["max_accel"],
        "OK" if rep["ok"] else "%d frames break a limit -- smooth them in the web app" % len(rep["bad_frames"])))
    return path, rep


def _parse_cli(argv):
    import argparse
    ap = argparse.ArgumentParser(prog="export_heights_blender.py")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--collection")
    g.add_argument("--mesh")
    ap.add_argument("--out")
    ap.add_argument("--start", type=int)
    ap.add_argument("--end", type=int)
    ap.add_argument("--unit-scale", type=float)
    ap.add_argument("--zero-z", type=float)
    for k in ("min-mm", "max-mm", "max-speed", "max-accel"):
        ap.add_argument("--" + k, type=float)
    a = ap.parse_args(argv)
    cfg = {}
    if a.collection:
        cfg.update(source="COLLECTION", collection=a.collection)
    if a.mesh:
        cfg.update(source="MESH", mesh_object=a.mesh)
    for k_cli, k_cfg in (("out", "out_path"), ("start", "start"), ("end", "end"), ("unit_scale", "unit_scale"),
                         ("zero_z", "zero_z"), ("min_mm", "min_mm"), ("max_mm", "max_mm"),
                         ("max_speed", "max_speed"), ("max_accel", "max_accel")):
        v = getattr(a, k_cli)
        if v is not None:
            cfg[k_cfg] = v
    return cfg


if __name__ == "__main__" and bpy is not None:  # pragma: no cover
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    export(_parse_cli(argv))
