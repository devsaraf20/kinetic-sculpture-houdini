// kinetic_bridge configuration. Edit this file for your wiring, then flash one
// board per group of motors (set BOARD_ID 0, 1, 2 ... in the order the host
// connects them; board N drives balls N*MOTOR_COUNT ... in row-major order).
#pragma once

// ------------------------------------------------------------------ identity
#ifndef BOARD_ID
#define BOARD_ID 0
#endif

#ifndef SERIAL_BAUD
#define SERIAL_BAUD 115200
#endif

// ------------------------------------------------------------------ motion
// Step 0 is the home position (next to the limit switch, normally the top:
// ball fully raised). Positive steps move away from the switch. If a motor
// moves the wrong way, flip it in INVERT_DIR below (or swap one coil pair).

// Full travel in steps = travel_mm * steps_per_mm (see the Output tab of the
// web app or `pbridge.py info`). Every target is clamped to 0..MAX_POSITION.
#ifndef MAX_POSITION
#define MAX_POSITION 10186L          // 800 mm on a 20 mm spool, 200 steps/rev x4 microsteps
#endif

// Hard cap on step rate while playing a show (steps/s per motor).
#ifndef MAX_STEP_RATE
#define MAX_STEP_RATE 4000.0f
#endif

// GOTO / STOP moves use AccelStepper's own acceleration profile.
#ifndef MOVE_SPEED
#define MOVE_SPEED 1500.0f           // steps/s
#endif
#ifndef MOVE_ACCEL
#define MOVE_ACCEL 3000.0f           // steps/s^2
#endif

// Step pulse width for the driver (A4988 >= 1 us, DRV8825 >= 2 us, TMC >= 1 us).
#ifndef STEP_PULSE_US
#define STEP_PULSE_US 3
#endif

// ------------------------------------------------------------------ homing
#define LIMIT_NONE 0        // no switches: HOME just declares "here is 0" (raise balls by hand first)
#define LIMIT_PER_MOTOR 1   // one switch per motor (normally open, to GND); all motors home together
#define LIMIT_SHARED 2      // all switches normally closed, in series, one input; motors home one by one

#ifndef HOMING_SPEED
#define HOMING_SPEED 600.0f          // steps/s towards the switch
#endif
#ifndef HOMING_BACKOFF
#define HOMING_BACKOFF 160L          // steps to back off the switch; that point becomes 0
#endif
#ifndef HOMING_MAX_STEPS
#define HOMING_MAX_STEPS (MAX_POSITION + 4000L)   // give up if no switch after this far
#endif

// ------------------------------------------------------------------ multi-board sync
#define SYNC_NONE 0         // every board runs its own frame clock (drift ~ crystal tolerance)
#define SYNC_MASTER 1       // board 0: pulses SYNC_PIN at every frame
#define SYNC_SLAVE 2        // other boards: advance one frame per pulse on SYNC_PIN

#ifndef SYNC_MODE
#define SYNC_MODE SYNC_NONE
#endif

// ------------------------------------------------------------------ boards
#if defined(ESP32)
  // ESP32 DevKit: 8 motors (step/dir drivers such as A4988, DRV8825, TMC2209 in step/dir mode).
  #define MOTOR_COUNT 8
  #ifndef BUFFER_FRAMES
  #define BUFFER_FRAMES 64
  #endif
  static const uint8_t STEP_PINS[MOTOR_COUNT] = {13, 14, 27, 26, 25, 33, 32, 4};
  static const uint8_t DIR_PINS[MOTOR_COUNT]  = {16, 17, 18, 19, 21, 22, 23, 5};
  #define ENABLE_PIN 15                 // shared EN of all drivers, active LOW
  #ifndef LIMIT_MODE
  #define LIMIT_MODE LIMIT_SHARED       // not enough GPIOs for 8 separate switches
  #endif
  #define LIMIT_SHARED_PIN 34           // input-only pin: add an external 10k pull-up to 3V3
  #define SYNC_PIN 2

#elif defined(ARDUINO_AVR_MEGA2560)
  // Arduino Mega 2560: 8 motors, one switch each.
  #define MOTOR_COUNT 8
  #ifndef BUFFER_FRAMES
  #define BUFFER_FRAMES 48
  #endif
  static const uint8_t STEP_PINS[MOTOR_COUNT] = {22, 24, 26, 28, 30, 32, 34, 36};
  static const uint8_t DIR_PINS[MOTOR_COUNT]  = {23, 25, 27, 29, 31, 33, 35, 37};
  #define ENABLE_PIN 8
  #ifndef LIMIT_MODE
  #define LIMIT_MODE LIMIT_PER_MOTOR
  #endif
  static const uint8_t LIMIT_PINS[MOTOR_COUNT] = {A0, A1, A2, A3, A4, A5, A6, A7};
  #define SYNC_PIN 2

#else
  // Arduino Uno / Nano with a CNC Shield V3: X, Y, Z and A (A cloned via D12/D13 jumpers).
  #define MOTOR_COUNT 4
  #ifndef BUFFER_FRAMES
  #define BUFFER_FRAMES 16
  #endif
  static const uint8_t STEP_PINS[MOTOR_COUNT] = {2, 3, 4, 12};
  static const uint8_t DIR_PINS[MOTOR_COUNT]  = {5, 6, 7, 13};
  #define ENABLE_PIN 8
  #ifndef LIMIT_MODE
  #define LIMIT_MODE LIMIT_PER_MOTOR
  #endif
  static const uint8_t LIMIT_PINS[MOTOR_COUNT] = {9, 10, 11, A0};
  // D2/D3 are step pins on the shield, so there is no interrupt pin left for sync.
  #undef SYNC_MODE
  #define SYNC_MODE SYNC_NONE
#endif

// Per-motor direction inversion (true = reverse). Unlisted motors are false.
static const bool INVERT_DIR[MOTOR_COUNT] = {false};

// Switch logic: per-motor switches are normally open to GND (pressed = LOW);
// the shared chain is normally closed to GND (any switch pressed = HIGH).
#ifndef LIMIT_TRIGGERED_LEVEL
  #if LIMIT_MODE == LIMIT_SHARED
    #define LIMIT_TRIGGERED_LEVEL HIGH
  #else
    #define LIMIT_TRIGGERED_LEVEL LOW
  #endif
#endif

#define LINE_MAX (16 + MOTOR_COUNT * 12)
