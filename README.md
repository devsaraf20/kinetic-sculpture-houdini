# Kinetic Sculpture: animation → motors

A pipeline that turns a Houdini (or Blender) animation into motion for a
kinetic sculpture of hanging balls (8×8 by default), each raised and lowered
on a string by a stepper motor.

```
 Houdini / Blender                 Web app (Three.js)                         Motors
┌───────────────────┐  heights   ┌──────────────────────────────────┐  Physical  ┌──────────────────────┐
│ A. export script  │──.json────▶│ B. 3D simulation + limit check   │──Bridge───▶│ D. ESP32 / Arduino    │
│   (one point per  │  .csv      │    highlight bad frames          │  .pbridge  │    AccelStepper       │
│    ball, P.y)     │            │    auto-smooth / retime          │  .json or  │    (one board per     │
└───────────────────┘            │ C. generative waves/ripples/noise│  Web Serial│     8 motors)         │
                                 └──────────────────────────────────┘            └──────────────────────┘
```

| Part | What | Where |
|---|---|---|
| A | Houdini exporter (shelf tool, Python Shell, `hython`), rig builder, VEX limit preview | [`houdini/`](houdini) |
| A | Blender exporter (Text Editor or `blender -b … --python`) | [`blender/`](blender) |
| B | Web app: loads exports, 3D playback, checks max speed / acceleration / travel, highlights violating frames, least-squares auto-smoothing, retiming | [`web/`](web) |
| C | Generative mode: travelling waves, ripples, flowing noise, raindrops, breathing dome, spiral, with live feasibility estimates | `web/` → *Generate* tab |
| D | Physical Bridge file + serial protocol, `pbridge.py` (convert / check / stream / simulate), Arduino/ESP32 sketch | [`docs/PHYSICAL_BRIDGE.md`](docs/PHYSICAL_BRIDGE.md), [`tools/`](tools), [`firmware/`](firmware) |
| Guide | **How to design animations in Houdini that are physically possible** | [`docs/HOUDINI_GUIDE.md`](docs/HOUDINI_GUIDE.md) |

## Quick start

```bash
# 1. web app (any static server; ES modules don't load from file://)
python3 -m http.server 8000
# open http://localhost:8000/web/
```

The app opens on a demo. Try **Animation → Demo: too fast**, then **Limits →
Auto-smooth violations** and switch between *Original* and *Smoothed*. Click
a ball to see its height, speed and acceleration curves against the limits.

```bash
# 2. check / convert / play an export from the command line
python3 tools/pbridge.py check examples/ripple_8x8.json
python3 tools/pbridge.py convert examples/ripple_8x8.json -o show.pbridge.json
python3 tools/pbridge.py simulate show.pbridge.json            # no hardware needed
pip install pyserial
python3 tools/pbridge.py stream show.pbridge.json --port /dev/ttyUSB0 --port /dev/ttyUSB1 …
```

In Houdini, install the package (see the guide, section 2) and use the
**Kinetic Sculpture** shelf: *Build Rig → animate → Check Limits → Export
Heights*.

## The machine model

Everything (Houdini preview, web app, Python tools, firmware) uses the same
model. Between two frames a motor runs at **constant speed**, so

```
speed_i = (h_i − h_{i−1}) × fps         acceleration_i = (speed_{i+1} − speed_i) × fps
```

and the show is assumed to start and end at rest. Defaults: travel 0–800 mm,
200 mm/s, 600 mm/s², 30 fps, 20 mm spool, 200 steps/rev at 4× microstepping
(12.73 steps/mm). Everything is configurable in the app's *Limits* and
*Output* tabs, the exporters' arguments, and `firmware/kinetic_bridge/config.h`.

### How auto-smoothing works
For each ball that breaks a limit, the app replaces its curve by the
**closest curve (least squares) that satisfies all limits**: travel range,
speed and acceleration, including starting and ending at rest. This is a
convex quadratic program, solved with a primal-dual interior-point method.
Every step is a pentadiagonal (banded Cholesky) solve, so a 64-ball, 600-frame
show smooths in well under a second. Balls that are already within the limits
are left untouched, and frames far from a problem stay exactly as animated. A
final pass that is guaranteed to stay feasible removes any numerical residue.

## Repository layout

```
houdini/                     Houdini package (copy kinetic_sculpture.json to your packages folder)
  scripts/python/kinetic_export.py   exporter + limit check (shelf / Python Shell / hython)
  scripts/python/kinetic_scene.py    builds a ready-to-animate rig
  toolbar/kinetic_sculpture.shelf    shelf tools
  vex/                               ball grid, example motion, limit preview, strings
blender/export_heights_blender.py
web/                         static web app (index.html, js/, tests/)
tools/pbridge.py             Physical Bridge CLI (stdlib only; pyserial for stream/ports)
firmware/kinetic_bridge/     Arduino/ESP32 sketch (AccelStepper) + config.h
firmware/test/               PC harness used by the tests
docs/                        Houdini design guide, file formats, Physical Bridge spec
examples/                    sample exports (ripple: OK, too_fast: breaks limits) + generator
tests/                       Python tests (exporters, pbridge, firmware on the PC)
```

## Tests

```bash
npm test                                   # web core: parsing, checks, smoothing, generators, bridge, streaming
python3 -m unittest discover -s tests -v   # exporters, pbridge, and the firmware compiled with g++
```

The firmware tests download the AccelStepper sources once (or use
`ACCELSTEPPER_SRC=/path/to/AccelStepper/src`) and are skipped without `g++`.

The web app loads Three.js 0.160 from jsDelivr. To run offline, download
`three.module.js` and `examples/jsm/controls/OrbitControls.js` and point the
import map in `web/index.html` at the local copies.
