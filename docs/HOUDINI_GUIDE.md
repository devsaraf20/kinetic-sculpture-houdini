# Designing physically possible animations in Houdini

A kinetic sculpture is an animation with a body. Every ball hangs on a
string wound on a spool, and a stepper motor has to *physically* produce the
motion you keyframe. This guide explains what the motors can and cannot do,
how to set up a Houdini scene so you see problems while you animate, and
how to get a clean export into the rest of the pipeline.

The default machine in this project (change the numbers to match yours):

| Limit | Default | Why it exists |
|---|---|---|
| Travel | 0 to 800 mm | length of string between "fully raised" (at the limit switch) and "fully lowered" |
| Max speed | 200 mm/s | above this the motor loses torque and **skips steps**, so the ball's real position no longer matches the animation |
| Max acceleration | 600 mm/s² | the motor has to accelerate the rotor, the spool and the ball. Too much, and it skips steps or the ball bounces and swings on its string |
| Frame rate | 30 fps | the firmware moves at constant speed between frames, so the frame rate is the sampling rate of your motion |

Skipped steps are permanent: the controller thinks the ball is at 400 mm
when it is really at 380, and the error builds up until the next homing.
That is why every tool in this pipeline treats the limits as hard rules.

---

## 1. The physics in four rules

### Rule 1: speed is the slope of the height curve
In the Animation Editor, the steepest part of a ball's `ty` curve is its top
speed. A move of 200 mm in 1 second averages 200 mm/s, so with ease-in/out
the peak is higher, around 300 mm/s, which is too fast.

### Rule 2: acceleration is the curvature, and corners are infinitely sharp
Every *corner* in a curve is an instant change of speed, which is infinite
acceleration. Corners come from:

* **Linear and constant interpolation.** A linear key followed by another
  linear key makes a corner at the key.
* **Hard `clamp()` in VEX.** Where the curve hits the clamp, the speed drops
  to zero in one frame.
* **Starting or stopping the show mid-motion.** The machine is standing still
  before frame 1 and after the last frame (*rest boundary*), so a ball that
  is already moving on frame 1 jumps from 0 to full speed at once.
* **Switching layers on and off** (an `if (@Frame > 100)` block, a switch SOP,
  a blend with a constant weight that jumps).

Use eased keys (Bezier or Ease In/Out) and smooth functions instead.

### Rule 3: sine waves have a speed limit *and* an acceleration limit
For a ball moving as `A·sin(2πt/T)` (amplitude `A` in mm, period `T` in seconds):

* peak speed = `2π·A / T`
* peak acceleration = `(2π/T)²·A`

So the shortest period you can use depends on the amplitude:

| Amplitude | Shortest period (200 mm/s, 600 mm/s²) | Limited by |
|---|---|---|
| 25 mm | 1.28 s | acceleration |
| 50 mm | 1.81 s | acceleration |
| 75 mm | 2.36 s | speed |
| 100 mm | 3.14 s | speed |
| 150 mm | 4.71 s | speed |
| 200 mm | 6.28 s | speed |
| 300 mm | 9.42 s | speed |

Below about 67 mm amplitude (`v²/a`) acceleration is the limit; above it,
speed is. **When you add layers, add their peaks:** two waves of 100 mm at 6 s
can line up and give 200 mm at 6 s for that ball.

### Rule 4: point-to-point moves need time
The fastest possible move from standing still to standing still:

| Distance | Minimum time |
|---|---|
| 50 mm | 0.58 s |
| 100 mm | 0.83 s |
| 200 mm | 1.33 s |
| 400 mm | 2.33 s |
| 800 mm (full travel) | 4.33 s |

(`t = 2·√(d/a)` for short moves; `t = d/v + v/a` once the move is long enough to
reach top speed.) If you want a ball to "drop" fast, it still takes over half a
second to go 50 mm.

---

## 2. Scene setup

### Install the package
1. Copy `houdini/kinetic_sculpture.json` to `$HOUDINI_USER_PREF_DIR/packages/`
   (for example `~/houdini20.5/packages/`).
2. Edit the `KINETIC_SCULPTURE` path in it to point at this repository's
   `houdini` folder.
3. Restart Houdini. You get a **Kinetic Sculpture** shelf with *Build Rig*,
   *Check Limits* and *Export Heights*, and the `kinetic_export` /
   `kinetic_scene` Python modules.

### Build the rig
*Build Rig* (or `kinetic_scene.build(rows=8, cols=8)`) creates
`/obj/kinetic_sculpture`:

```
ball_grid      detail wrangle: one point per ball, i@row / i@col, P.y = 0
  motion       point wrangle: example waves + ripple (replace with your animation)
  OUT_HEIGHTS  null: the exporter reads this
  prev_frame / next_frame   time shifts ($F-1 / $F+1)
  limit_preview             colours every ball by the limits (see section 4)
  balls + strings -> VIS    display geometry
```

### Conventions the exporter relies on
* **One point per ball, and the count never changes.** Points can be the
  template points of a Copy to Points, packed primitives, or the centres of
  your ball geometry. Don't export the sphere geometry itself.
* **Height is `P.y`.** With the default unit scale (1000), 1 Houdini unit is
  1 m, and `P.y = 0` is the lowest allowed position (0 mm). `P.y = 0.8` is 800 mm.
  If your rig uses another zero, pass `zero_y`.
* **Rows run along +Z and columns along +X.** The exporter finds the grid from
  the rest positions, even with a little placement jitter. For irregular
  layouts, add integer point attributes `row` and `col`, which always win.
* **The frame rate is the playback rate.** Set it in *Global Animation
  Options* before you animate. 30 fps is a good default. 60 fps gives smoother
  motion but twice the data, and does **not** raise the limits.

---

## 3. Ways to animate that stay physical

### Procedural (VEX)
`houdini/vex/motion_waves.vfl` is a template that is safe by construction:

```c
// Quintic ease: zero velocity and zero acceleration at both ends.
float smootherstep(float e0; float e1; float x) {
    float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}
// Soft limit instead of clamp(): no acceleration spike at the travel ends.
float softclamp(float x; float lo; float hi; float knee) {
    float a = lo + knee, b = hi - knee;
    if (x > b) return b + knee * tanh((x - b) / knee);
    if (x < a) return a - knee * tanh((a - x) / knee);
    return x;
}
...
h *= smootherstep(0, ease, t) * smootherstep(0, ease, dur - t);   // start and end at rest
@P.y = softclamp(rest + h, min_mm, max_mm, 60) / 1000.0;
```

Guidelines:
* Drive motion with **time in seconds** (`@Time`), never with `@Frame`. Then
  changing the frame rate doesn't change the speed.
* Use the table in Rule 3 to pick amplitude and period, and budget the
  **sum** of the layers.
* **Fade layers in and out with `smootherstep`**, never with `if`.
* Spatial frequency matters too. A wave moving across the grid at speed `c`
  with wavelength `λ` makes each ball oscillate at period `λ/c`.
* Noise: use smooth noise (`noise()`, `onoise()`, `curlnoise()`) with few
  octaves. Every octave doubles the frequency, which means 2× the speed and
  4× the acceleration at the same amplitude. Never use `random()` per frame.

### Keyframes
* Use **Ease In/Out** or **Bezier** interpolation. Avoid *Linear* and
  *Constant*, and check that tangents are continuous (no broken tangents).
* Give every move at least the minimum time from Rule 4.
* Start and end the shot with a few frames of hold on flat tangents.

### CHOPs: filter animation you already have
CHOPs are the best tool to fix existing motion (mocap, simulation, audio-driven):

1. Bring the heights into CHOPs: **Geometry CHOP** (Method: *Animated*,
   Attribute: `P`, keep `ty`) on `OUT_HEIGHTS`.
2. Inspect: **Slope CHOP** once gives speed (units/s), twice gives acceleration.
   Multiply by 1000 for mm and compare with the limits in the graph view.
3. Fix it, in order of preference:
   * **Filter CHOP** (Gaussian, width ≈ 0.2–0.5 s) removes jitter and spikes.
   * **Lag CHOP** limits how fast a channel can follow its input.
   * **Spring CHOP** gives physically smooth following with a little overshoot,
     so leave headroom.
   * **Limit CHOP** keeps the travel range. Follow it with a Filter CHOP,
     because a hard limit is a corner.
4. Back to geometry: **Channel SOP** (or `chop()` in a wrangle) writing `P.y`.

### Simulations (Vellum, RBD, POPs)
Sims are rarely physical *for this machine*. Things bounce, collide and stop
instantly. Simulate, cache, then put the result through the CHOP filter chain
above, or use the web app's Auto-smooth.

### Retiming
If the motion looks right but is too fast, slow it down. Speed falls with the
slow-down factor `k` and acceleration with `k²`. The checker prints the
`k` that would make the shot feasible, the web app has a **Slow down ×k**
button, and in Houdini you can use a Time Warp SOP or retime in CHOPs.

---

## 4. See the limits while you animate

`limit_preview` (from `houdini/vex/limit_preview.vfl`) compares each frame
with the previous and next frames and colours the balls:

| Colour | Meaning |
|---|---|
| blue to gold | OK (gradient = height) |
| **red** | too fast |
| **orange** | too much acceleration |
| **purple** | outside the travel range |

It also writes `f@speed`, `f@accel`, `i@violation` per point and the detail
attributes `worst_speed_ratio`, `worst_accel_ratio` and `violations`. Pin a
Geometry Spreadsheet on the detail attributes while scrubbing. A ratio above
1.0 means over the limit.

**Check Limits** on the shelf (or `kinetic_export.check_scene(...)`) checks
the *whole* frame range at once, including the start and end at rest, and
lists the frames that break a limit:

```
Peak speed     187.2 mm/s   (limit 200)
Peak accel     912.4 mm/s2  (limit 600)
Height          45.0 .. 755.0 mm (allowed 0 .. 800)
14 frame(s) break a limit: 118-124, 301-307
Retiming alone would need the animation x1.23 slower ...
```

The motion model is the same everywhere (Houdini preview, web app, Python
tools and firmware). Between two frames the motor runs at constant speed, so
speed = Δheight × fps and acceleration = Δspeed × fps.

---

## 5. Export

* **Shelf → Export Heights**: pick the SOP (or an object glob such as
  `/obj/ball_*`), the frame range and the limits, then a `.json` or `.csv`
  file. A report is shown after writing.
* **Python Shell**:
  ```python
  import kinetic_export
  kinetic_export.export(sop_path="/obj/kinetic_sculpture/OUT_HEIGHTS",
                        out_path="$HIP/export/wave.json", start=1, end=601)
  ```
* **Batch / farm** with `hython`:
  ```bash
  hython houdini/scripts/python/kinetic_export.py show.hip \
      --sop /obj/kinetic_sculpture/OUT_HEIGHTS --out wave.json --strict
  ```
  `--strict` exits with code 2 if a limit is broken, so a pipeline can refuse it.

Then open `web/index.html`, drop the file in, check it in 3D, auto-smooth
any remaining problem frames, and export the Physical Bridge file for the
motors.

---

## 6. Checklist before you export

- [ ] Frame rate set and motion driven by `@Time` (or keyframes in seconds)
- [ ] Ball count constant; one point per ball on `OUT_HEIGHTS`
- [ ] Heights within travel, with a soft limit and not a hard clamp
- [ ] Every layer's amplitude/period within the Rule 3 table, and the **sum** of the layers too
- [ ] No linear/constant keys, broken tangents or `if`-switched layers
- [ ] Show starts and ends at rest (ease in/out of at least 1–2 s)
- [ ] `limit_preview` shows no red/orange/purple while scrubbing
- [ ] *Check Limits* says OK, or the remaining frames are few and small enough for Auto-smooth
- [ ] For loops: the last frame flows into the first (same position **and** speed)

## Blender
The same rules apply. `blender/export_heights_blender.py` exports either all
objects of a collection (world Z of their origins) or the evaluated vertices of
one mesh (Geometry Nodes output, one vertex per ball). Blender is Z-up, so the
height is `Z`. Use the Graph Editor's *Ease In/Out* and the *Smooth* and
*Butterworth Smooth* operators in the same places you would use CHOP filters.
