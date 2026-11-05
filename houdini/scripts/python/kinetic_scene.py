"""
Builds a ready-to-animate kinetic sculpture rig in the current Houdini scene.

    import kinetic_scene
    kinetic_scene.build(rows=8, cols=8)

Network created in /obj/kinetic_sculpture:

    ball_grid (detail wrangle: one point per ball, row/col attributes)
      -> motion (point wrangle: example waves + ripple, eased and soft-clamped)
        -> OUT_HEIGHTS (null)              <- export this with kinetic_export
        -> prev_frame / next_frame (time shifts) -> limit_preview (colours violations)
        -> balls (spheres copied to the preview points) + strings -> VIS (display)

Every parameter of the motion lives on the `motion` node (spare parameters),
so you can keyframe or replace that wrangle with your own animation; anything
that sets P.y on one point per ball works with the exporter.
"""

from __future__ import annotations

import os

import hou  # type: ignore

import kinetic_export

VEX_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "vex"))


def _vex(name):
    with open(os.path.join(VEX_DIR, name)) as f:
        return f.read()


def _add_parms(node, specs):
    """specs: (name, label, default) -- int default -> int parm, float -> float parm."""
    ptg = node.parmTemplateGroup()
    for name, label, default in specs:
        if ptg.find(name):
            continue
        if isinstance(default, bool) or isinstance(default, int):
            t = hou.IntParmTemplate(name, label, 1, default_value=(int(default),))
        else:
            t = hou.FloatParmTemplate(name, label, 1, default_value=(float(default),))
        ptg.append(t)
    node.setParmTemplateGroup(ptg)


def _wrangle(parent, name, snippet, run_over="points"):
    node = parent.createNode("attribwrangle", name)
    node.parm("class").set({"detail": 0, "primitives": 1, "points": 2}[run_over])
    node.parm("snippet").set(snippet)
    return node


def build(rows=8, cols=8, spacing_m=0.1, name="kinetic_sculpture", fps=30, duration_s=20.0,
          limits=None, replace=True):
    lim = dict(kinetic_export.DEFAULT_LIMITS)
    lim.update(limits or {})
    obj = hou.node("/obj")
    geo = obj.node(name)
    if geo is not None and replace:
        geo.destroy()
        geo = None
    if geo is None:
        geo = obj.createNode("geo", name)
    for child in geo.children():
        child.destroy()

    grid = _wrangle(geo, "ball_grid", _vex("ball_grid.vfl"), "detail")
    _add_parms(grid, [("rows", "Rows", int(rows)), ("cols", "Columns", int(cols)),
                      ("spacing_m", "Spacing (m)", float(spacing_m))])

    motion = _wrangle(geo, "motion", _vex("motion_waves.vfl"))
    motion.setInput(0, grid)
    _add_parms(motion, [
        ("rest_height_mm", "Rest Height (mm)", (lim["min_mm"] + lim["max_mm"]) / 2.0),
        ("min_mm", "Lowest (mm)", float(lim["min_mm"])),
        ("max_mm", "Highest (mm)", float(lim["max_mm"])),
        ("soft_knee_mm", "Soft Limit Knee (mm)", 60.0),
        ("wave_amp_mm", "Wave Amplitude (mm)", 100.0),
        ("wave_length_cells", "Wave Length (cells)", 10.0),
        ("wave_period_s", "Wave Period (s)", 8.0),
        ("wave_direction_deg", "Wave Direction (deg)", 20.0),
        ("ripple_amp_mm", "Ripple Amplitude (mm)", 60.0),
        ("ripple_length_cells", "Ripple Length (cells)", 6.0),
        ("ripple_period_s", "Ripple Period (s)", 6.0),
        ("ripple_x", "Ripple Centre X (cells)", 0.0),
        ("ripple_z", "Ripple Centre Z (cells)", 0.0),
        ("ease_s", "Ease In/Out (s)", 2.5),
        ("duration_s", "Duration (s)", float(duration_s)),
    ])

    out = geo.createNode("null", "OUT_HEIGHTS")
    out.setInput(0, motion)

    prev = geo.createNode("timeshift", "prev_frame")
    prev.setInput(0, out)
    prev.parm("frame").setExpression("$F-1")
    nxt = geo.createNode("timeshift", "next_frame")
    nxt.setInput(0, out)
    nxt.parm("frame").setExpression("$F+1")

    check = _wrangle(geo, "limit_preview", _vex("limit_preview.vfl"))
    check.setInput(0, out)
    check.setInput(1, prev)
    check.setInput(2, nxt)
    _add_parms(check, [("unit_scale", "Unit Scale (to mm)", 1000.0), ("zero_y", "Zero Height Y", 0.0),
                       ("min_mm", "Lowest (mm)", float(lim["min_mm"])), ("max_mm", "Highest (mm)", float(lim["max_mm"])),
                       ("max_speed", "Max Speed (mm/s)", float(lim["max_speed"])),
                       ("max_accel", "Max Accel (mm/s2)", float(lim["max_accel"]))])
    # Keep the limit parameters in one place: preview follows the motion node.
    for p in ("min_mm", "max_mm"):
        check.parm(p).setExpression('ch("../motion/%s")' % p)

    sphere = geo.createNode("sphere", "ball_shape")
    sphere.parm("type").set("poly")
    sphere.parmTuple("rad").set((spacing_m * 0.3,) * 3)
    copy = geo.createNode("copytopoints", "balls")
    copy.setInput(0, sphere)
    copy.setInput(1, check)

    strings = _wrangle(geo, "strings", _vex("strings.vfl"))
    strings.setInput(0, out)
    _add_parms(strings, [("ceiling_m", "Ceiling Height (m)", (lim["max_mm"] + 200.0) / 1000.0)])
    merge = geo.createNode("merge", "merge_vis")
    merge.setInput(0, copy)
    merge.setInput(1, strings)
    vis = geo.createNode("null", "VIS")
    vis.setInput(0, merge)
    vis.setDisplayFlag(True)
    vis.setRenderFlag(True)
    geo.layoutChildren()

    frames = int(round(duration_s * fps)) + 1
    hou.setFps(fps)
    hou.playbar.setFrameRange(1, frames)
    hou.playbar.setPlaybackRange(1, frames)
    return geo


def build_interactive():
    btn, vals = hou.ui.readMultiInput(
        "Build a kinetic sculpture rig", ("Rows", "Columns", "Spacing (m)", "FPS", "Duration (s)"),
        buttons=("Build", "Cancel"), default_choice=0, close_choice=1,
        initial_contents=("8", "8", "0.1", "30", "20"))
    if btn != 0:
        return None
    geo = build(rows=int(vals[0]), cols=int(vals[1]), spacing_m=float(vals[2]),
                fps=float(vals[3]), duration_s=float(vals[4]))
    hou.ui.displayMessage(
        "Built %s.\n\nAnimate P.y in the 'motion' wrangle (or replace it).\n"
        "Watch limit_preview: red = too fast, orange = too much acceleration, purple = out of travel.\n"
        "Export with the 'Export Heights' shelf tool (SOP: %s/OUT_HEIGHTS)." % (geo.path(), geo.path()))
    return geo
