# Physical Bridge

The Physical Bridge sits between the animation (heights in mm) and the
motors (step positions). It has two parts:

1. **The file** (`.pbridge.json`): a show converted to absolute step
   positions, with the machine geometry and the board layout. It is written by
   the web app (*Output → Download Physical Bridge*) or by
   `tools/pbridge.py convert`. Both produce identical files.
2. **The wire protocol**: the ASCII line protocol a host (web app over Web
   Serial, or `pbridge.py stream`) uses to play the file on one or more
   boards running `firmware/kinetic_bridge`.

```
heights.json ──convert──▶ show.pbridge.json ──stream──▶ board 0 (balls 0-7)
                                                    ├──▶ board 1 (balls 8-15)
                                                    └──▶ …
```

## Heights → steps

```
steps_per_mm = steps_per_rev × microsteps / (π × spool_diameter_mm)
home = "top":    steps = round((travel_mm − h) × steps_per_mm)
home = "bottom": steps = round(h × steps_per_mm)
```

where `h = height − limits.min_mm`, clamped to `[0, travel_mm]`, and `round` is
round-half-up. With the defaults (20 mm spool, 200 steps/rev, 4× microstepping)
that is 12.732 steps/mm, and full travel (800 mm) is 10,186 steps.

Step 0 is the **home position**, which is just below the limit switch. With the
switches at the top, 0 is "fully raised" and positive steps lower the ball.

## File format (`physical-bridge` v1)

```json
{
  "format": "physical-bridge",
  "version": 1,
  "fps": 30,
  "frame_count": 301,
  "motor_count": 64,
  "machine": {
    "travel_mm": 800, "steps_per_mm": 12.732395, "home": "top",
    "spool_diameter_mm": 20, "steps_per_rev": 200, "microsteps": 4, "max_steps": 10186
  },
  "limits": {"min_mm": 0, "max_mm": 800, "max_speed": 200, "max_accel": 600, "boundary": "rest"},
  "stats": {"peak_step_rate": 1860, "clipped_samples": 0},
  "grid": {"rows": 8, "cols": 8, "spacing_mm": 100},
  "balls": [{"index": 0, "row": 0, "col": 0}],
  "boards": [
    {"board":0,"motors":[0,1,2,3,4,5,6,7]},
    {"board":1,"motors":[8,9,10,11,12,13,14,15]}
  ],
  "frames": [
    [5093,5093,5093],
    [5093,5094,5094]
  ]
}
```

* `frames[f][i]` is the absolute step position of ball `i` (row-major) at frame `f`.
* `boards[b].motors[k]` is the ball driven by motor `k` of board `b`. The default
  layout puts consecutive balls on consecutive boards (`motors_per_board`, 8 by
  default, so one row per board on an 8×8 sculpture).
* `limits` records what the show was checked against. `stats.peak_step_rate`
  is the highest steps/s any motor must produce, which you can compare with
  what your board can generate.

## Wire protocol

ASCII, one command per line, `\n`-terminated, 115200 baud by default. Values
are decimal integers.

| Host → board | Board → host | Notes |
|---|---|---|
| `HELLO` | `PB1 <board_id> <motors> <buffer_frames>` | handshake; `buffer_frames` is the queue size for flow control |
| `FPS <fps>` | `OK FPS` | frame rate of the board's clock |
| `HOME` | `HOMED` or `E HOME_FAILED <motor>` | blocking; seeks limit switches and backs off; that point becomes 0 |
| `ZERO` | `OK ZERO` | declare the current position 0 (no switches) |
| `GOTO <s0> … <sN-1>` | `AT` when there | accelerated move (pre-position before playing) |
| `F <s0> … <sN-1>` | nothing; `E OVERFLOW` / `E BAD_FRAME` on error | queue one frame |
| `PLAY` | `OK PLAY`, then `C <n>` per frame | start consuming the queue at `fps` |
| `END` | `OK END`, later `DONE <n>` | no more frames will come; `DONE` when the queue is empty |
| `STOP` | `OK STOP` | clear the queue, ramp the motors down, reset counters |
| `ENABLE 0/1` | `OK ENABLE` | driver enable pin |
| `?` | `S <state> <buffered> <consumed> <pos0> …` | status |
| | `U <n>` | buffer underrun: no frame was ready when the clock ticked (the motors hold) |
| | `E <code>` | error: `UNKNOWN`, `BUSY`, `BAD_FPS`, `LINE_TOO_LONG`, … |
| | `# …` | comment (e.g. the boot banner); ignore |

A frame line must contain exactly as many values as the board has motors.
When a board has more motors than the show needs, the host pads with 0.

### Playing a show

```
HELLO → PB1 0 8 64
STOP  → OK STOP          (reset counters)
FPS 30 → OK FPS
HOME  → HOMED            (optional; required after power-up)
GOTO <frame 0> → AT      (move to the first pose with acceleration)
F <frame 0> … F <frame 63>   (prefill: up to buffer_frames)
PLAY  → OK PLAY
        C 1, C 2, …      every C n frees one slot: send frame (sent) while sent − n < buffer_frames
END   (after the last frame)
        … DONE 301
```

**Flow control** is credit-based. The host counts frames sent, the board
reports frames consumed (`C n`), and the host keeps at most `buffer_frames`
frames in flight. The board plays on its own clock, so USB latency and jitter
never reach the motors as long as the queue doesn't run dry.

**Motion between frames**: when a frame starts, each motor is given the
constant speed `(target − position) × fps`, so it arrives exactly when the
next frame starts (AccelStepper `moveTo` + `setSpeed` + `runSpeedToPosition`).
Acceleration limits are therefore the host's job: the web app's checker and
smoother make sure the speed changes between consecutive frames stay below
`max_accel`. The firmware still clamps every target to `0…MAX_POSITION` and
every speed to `MAX_STEP_RATE` as a last safety net.

### Several boards

Each board gets its own serial port and its slice of the show (`boards[b]`).
The hosts send `PLAY` to the last board first and board 0 last.

* **Without sync wiring** every board runs its own crystal clock. Drift is
  typically 20–50 ppm, about 1.5–3 frames per hour at 30 fps. That is fine for
  shows of a few minutes, since the host restarts every show.
* **With sync wiring** (recommended for long shows) set `SYNC_MODE SYNC_MASTER`
  on board 0 and `SYNC_SLAVE` on the others, and connect every `SYNC_PIN` plus GND.
  The master pulses at every frame and the slaves advance one frame per pulse.

## Tools

```bash
python3 tools/pbridge.py check heights.json        # limit report, exit code 1 if broken
python3 tools/pbridge.py convert heights.json -o show.pbridge.json --spool 20 --microsteps 4
python3 tools/pbridge.py info show.pbridge.json
python3 tools/pbridge.py simulate show.pbridge.json  # play on simulated boards, no hardware
python3 tools/pbridge.py ports                       # needs: pip install pyserial
python3 tools/pbridge.py stream show.pbridge.json --port /dev/ttyUSB0 --port /dev/ttyUSB1
```
