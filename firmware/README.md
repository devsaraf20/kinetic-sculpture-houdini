# kinetic_bridge firmware

An Arduino sketch that plays Physical Bridge streams
([docs/PHYSICAL_BRIDGE.md](../docs/PHYSICAL_BRIDGE.md)) on step/dir stepper
drivers using [AccelStepper](https://www.airspayce.com/mikem/arduino/AccelStepper/).

| Board | Motors per board | Limit switches | Sync | Notes |
|---|---|---|---|---|
| **ESP32 DevKit** (recommended) | 8 | one shared NC chain on GPIO34 (external 10 kΩ pull-up) | GPIO2 | fast enough for 8 motors at several kHz each |
| Arduino Mega 2560 | 8 | one per motor, A0–A7 | D2 | keep the total step rate modest (≈ 8 × 1500 steps/s) |
| Arduino Uno/Nano + CNC Shield V3 | 4 (X, Y, Z, A) | X-/Y-/Z- (D9–D11) and A0 | — | good for a 2×2 prototype |

An 8×8 sculpture needs 8 boards with 8 motors each (one row per board) or
another split. Set `motors_per_board` in the web app / `pbridge.py convert`
to match.

## Build and flash

1. Install the **AccelStepper** library (Arduino IDE → Library Manager).
2. Open `kinetic_bridge/kinetic_bridge.ino`.
3. Edit `config.h`:
   * `BOARD_ID`: 0, 1, 2 … The host connects ports in this order.
   * `MAX_POSITION`: full travel in steps (`travel_mm × steps_per_mm`, shown in
     the web app's Output tab and by `pbridge.py info`).
   * `MAX_STEP_RATE`: safety cap in steps/s.
   * Pin tables, `INVERT_DIR`, `LIMIT_MODE`, `SYNC_MODE`.
4. Select the board and upload. Open the serial monitor at 115200 baud,
   type `HELLO`, and the board answers `PB1 <id> <motors> <buffer>`.

The same sketch builds for all three boards. The pin table is chosen from the
board you compile for (`ESP32`, `ARDUINO_AVR_MEGA2560`, otherwise Uno/Nano).

## Wiring (per motor)

```
driver STEP  ← STEP_PINS[i]          driver VMOT ← 12–24 V supply (+ 100 µF cap at the driver)
driver DIR   ← DIR_PINS[i]           driver GND  ← supply GND and board GND (common ground)
driver EN    ← ENABLE_PIN (shared)   driver MS1-3 / CFG ← microstepping to match `microsteps`
limit switch ← LIMIT_PINS[i] to GND (normally open), or all NC switches in series on LIMIT_SHARED_PIN
```

* Set the driver current limit for your motor **before** connecting it.
* The motors stay **enabled** from boot so the balls don't drop. Use a
  self-locking worm gear or a brake if the balls must stay up with power off.
* Direction: positive steps must move **away** from the switch (lower the
  ball when the switches are at the top). If a motor runs the wrong way during
  `HOME`, set `INVERT_DIR` for it.

## Calibration

1. `steps_per_mm = steps_per_rev × microsteps / (π × spool diameter)`. Measure
   the effective diameter with the string wound on. It changes as string winds
   up, so a narrow, deep spool (or a capstan) keeps it constant.
2. `HOME`, then `GOTO` to the step count for 500 mm, and measure. Correct the
   spool diameter in the web app (Output tab) until it matches.
3. Find the real limits: play the *Too fast* demo smoothed at increasing
   speed/acceleration limits until a motor skips (check by homing again and
   seeing whether it hits the switch where expected). Use about 70 % of that.

## Testing without hardware

`tests/test_python_tools.py` compiles this sketch for the PC
(`firmware/test/Arduino.h` + `harness.cpp`) together with the real
AccelStepper sources. The harness models the motors' physical positions from
the step/dir pins and closes the limit switches at the top of travel. The tests
then play shows through `tools/pbridge.py` for the ESP32, Mega and Uno
configurations and check that every motor ends exactly where the show says.
