/*
  kinetic_bridge -- Physical Bridge receiver for a hanging-ball kinetic sculpture.

  Runs on an ESP32, Arduino Mega or Arduino Uno/Nano (CNC Shield). Each board
  drives MOTOR_COUNT step/dir stepper drivers with AccelStepper. The host
  (web app over Web Serial, or tools/pbridge.py) streams absolute step
  positions, one line per frame; the board plays them on its own frame clock
  so USB timing jitter never reaches the motors.

  Wire protocol (ASCII lines, '\n' terminated) -- docs/PHYSICAL_BRIDGE.md
    host -> board                     board -> host
    HELLO                             PB1 <board_id> <motors> <buffer_frames>
    FPS <fps>                         OK FPS
    HOME                              HOMED            | E HOME_FAILED <motor>
    ZERO                              OK ZERO          (declare current position = 0)
    GOTO <s0> ... <sN-1>              AT               (accelerated move, then idle)
    F <s0> ... <sN-1>                 (queued; E OVERFLOW / E BAD_FRAME on error)
    PLAY                              OK PLAY, then C <frames_consumed> per frame
    END                               OK END, later DONE <frames_consumed> when the queue is empty
    STOP                              OK STOP          (ramp down at MOVE_ACCEL, clear queue, reset counters)
    ENABLE <0|1>                      OK ENABLE
    ?                                 S <state> <buffered> <consumed> <pos0> ... <posN-1>
    (buffer ran dry while playing)    U <frames_consumed>

  Motion model: for every frame the motor runs at the constant speed that
  reaches the frame's target exactly when the next frame starts. The host
  side (web app) guarantees speed and acceleration limits between frames.

  Library: AccelStepper by Mike McCauley (Library Manager: "AccelStepper").
*/

#include <AccelStepper.h>
#include "config.h"

#ifndef IRAM_ATTR
#define IRAM_ATTR
#endif

enum State : uint8_t { IDLE = 0, MOVING = 1, PLAYING = 2, STOPPING = 3 };
static const char* const STATE_NAMES[] = {"IDLE", "MOVING", "PLAYING", "STOPPING"};

AccelStepper* motors[MOTOR_COUNT];
static long frameBuf[BUFFER_FRAMES][MOTOR_COUNT];
static uint16_t bufHead = 0, bufCount = 0;
static uint32_t consumed = 0;
static bool endRequested = false;
static bool underrunReported = false;
static bool announceArrival = false;
static float vel[MOTOR_COUNT];       // speed of the segment each motor is running (steps/s)
static float rampPos[MOTOR_COUNT];   // fractional position while ramping down after STOP

static float fps = 30.0f;
static uint32_t frameUs = 33333UL;
static uint32_t nextFrameUs = 0;
static State state = IDLE;

static char line[LINE_MAX];
static uint8_t lineLen = 0;
static bool lineOverflow = false;

#if SYNC_MODE == SYNC_SLAVE
static volatile uint16_t syncPulses = 0;
void IRAM_ATTR onSyncPulse() { syncPulses++; }
#elif SYNC_MODE == SYNC_MASTER
static bool syncHigh = false;
static uint32_t syncAt = 0;
#endif

// ------------------------------------------------------------------ helpers

static void reply(const char* msg) { Serial.println(msg); }

static void replyError(const char* code) {
  Serial.print("E ");
  Serial.println(code);
}

static void replyCount(const char* prefix, uint32_t n) {
  Serial.print(prefix);
  Serial.println(n);
}

static long clampPosition(long s) {
  if (s < 0) return 0;
  if (s > MAX_POSITION) return MAX_POSITION;
  return s;
}

static void setEnabled(bool on) {
#ifdef ENABLE_PIN
  digitalWrite(ENABLE_PIN, on ? LOW : HIGH);
#else
  (void)on;
#endif
}

// Reads MOTOR_COUNT integers from the strtok stream; false on any error.
static bool parseValues(long* out) {
  for (uint8_t i = 0; i < MOTOR_COUNT; i++) {
    char* tok = strtok(NULL, " ");
    if (!tok) return false;
    char* end;
    out[i] = strtol(tok, &end, 10);
    if (*end) return false;
  }
  return strtok(NULL, " ") == NULL;
}

static void clearQueue() {
  bufHead = bufCount = 0;
  consumed = 0;
  endRequested = false;
  underrunReported = false;
}

// ------------------------------------------------------------------ limit switches

#if LIMIT_MODE == LIMIT_PER_MOTOR
static bool limitHit(uint8_t i) {
  // Three agreeing reads to ignore electrical noise on long switch wires.
  for (uint8_t k = 0; k < 3; k++)
    if (digitalRead(LIMIT_PINS[i]) != LIMIT_TRIGGERED_LEVEL) return false;
  return true;
}
#elif LIMIT_MODE == LIMIT_SHARED
static bool sharedHit() {
  for (uint8_t k = 0; k < 3; k++)
    if (digitalRead(LIMIT_SHARED_PIN) != LIMIT_TRIGGERED_LEVEL) return false;
  return true;
}
#endif

// Blocking accelerated move of every motor to its target.
static void runAllToTargets() {
  bool any = true;
  while (any) {
    any = false;
    for (uint8_t i = 0; i < MOTOR_COUNT; i++) any |= motors[i]->run();
  }
}

// Before an accelerated (run()) move. setCurrentPosition() also clears
// AccelStepper's acceleration state, which the per-frame moveTo() calls of
// playback leave in an arbitrary state. Only call this while stationary.
static void prepareMove() {
  for (uint8_t i = 0; i < MOTOR_COUNT; i++) {
    motors[i]->setCurrentPosition(motors[i]->currentPosition());
    motors[i]->setMaxSpeed(MOVE_SPEED);
    motors[i]->setAcceleration(MOVE_ACCEL);
  }
}

#if LIMIT_MODE == LIMIT_SHARED
// Runs motor i towards the switch until hit(); returns false if it never triggers.
static bool seekSwitch(uint8_t i, bool (*hit)()) {
  motors[i]->setCurrentPosition(0);
  motors[i]->setMaxSpeed(HOMING_SPEED);
  motors[i]->setSpeed(-HOMING_SPEED);
  while (!hit()) {
    motors[i]->runSpeed();
    if (labs(motors[i]->currentPosition()) > HOMING_MAX_STEPS) return false;
  }
  motors[i]->setCurrentPosition(-HOMING_BACKOFF);
  return true;
}
#endif

static bool homeAll() {
  setEnabled(true);
#if LIMIT_MODE == LIMIT_NONE
  for (uint8_t i = 0; i < MOTOR_COUNT; i++) motors[i]->setCurrentPosition(0);
  return true;
#elif LIMIT_MODE == LIMIT_PER_MOTOR
  // All motors seek their own switch at the same time.
  bool done[MOTOR_COUNT];
  for (uint8_t i = 0; i < MOTOR_COUNT; i++) {
    done[i] = false;
    motors[i]->setCurrentPosition(0);
    motors[i]->setMaxSpeed(HOMING_SPEED);
    motors[i]->setSpeed(-HOMING_SPEED);
  }
  uint8_t remaining = MOTOR_COUNT;
  while (remaining) {
    for (uint8_t i = 0; i < MOTOR_COUNT; i++) {
      if (done[i]) continue;
      if (limitHit(i)) {
        motors[i]->setCurrentPosition(-HOMING_BACKOFF);
        done[i] = true;
        remaining--;
      } else {
        motors[i]->runSpeed();
        if (labs(motors[i]->currentPosition()) > HOMING_MAX_STEPS) {
          replyCount("E HOME_FAILED ", i);
          return false;
        }
      }
    }
  }
  prepareMove();
  for (uint8_t i = 0; i < MOTOR_COUNT; i++) motors[i]->moveTo(0);
  runAllToTargets();
  return true;
#elif LIMIT_MODE == LIMIT_SHARED
  // A pressed switch cannot be attributed to a motor: first lower everything a little.
  if (sharedHit()) {
    prepareMove();
    for (uint8_t i = 0; i < MOTOR_COUNT; i++) {
      motors[i]->setCurrentPosition(0);
      motors[i]->moveTo(HOMING_BACKOFF * 2);
    }
    runAllToTargets();
    if (sharedHit()) {
      replyError("HOME_FAILED SWITCH_STUCK");
      return false;
    }
  }
  for (uint8_t i = 0; i < MOTOR_COUNT; i++) {
    if (!seekSwitch(i, sharedHit)) {
      replyCount("E HOME_FAILED ", i);
      return false;
    }
    prepareMove();
    motors[i]->moveTo(0);
    while (motors[i]->run()) {}
    if (sharedHit()) {
      replyCount("E HOME_FAILED ", i);
      return false;
    }
  }
  return true;
#endif
}

// ------------------------------------------------------------------ playback

static void startFrame() {
  if (bufCount == 0) {
    if (endRequested) {
      endRequested = false;
      state = IDLE;
      replyCount("DONE ", consumed);
    } else if (!underrunReported) {
      underrunReported = true;
      replyCount("U ", consumed);
    }
    return;
  }
  underrunReported = false;
  const long* fr = frameBuf[bufHead];
  bufHead = (bufHead + 1) % BUFFER_FRAMES;
  bufCount--;
  for (uint8_t i = 0; i < MOTOR_COUNT; i++) {
    long target = clampPosition(fr[i]);
    float speed = (float)(target - motors[i]->currentPosition()) * fps;
    if (speed > MAX_STEP_RATE) speed = MAX_STEP_RATE;
    if (speed < -MAX_STEP_RATE) speed = -MAX_STEP_RATE;
    motors[i]->moveTo(target);    // must come before setSpeed: moveTo recomputes the speed
    motors[i]->setSpeed(speed);
    vel[i] = speed;
  }
  consumed++;
  replyCount("C ", consumed);
}

// One frame of the STOP ramp: every motor sheds MOVE_ACCEL/fps of speed.
static void rampFrame() {
  const float dv = MOVE_ACCEL / fps;
  bool moving = false;
  for (uint8_t i = 0; i < MOTOR_COUNT; i++) {
    float v = vel[i];
    v = v > dv ? v - dv : (v < -dv ? v + dv : 0.0f);
    vel[i] = v;
    if (v == 0.0f) continue;
    moving = true;
    rampPos[i] += v / fps;
    long target = clampPosition((long)floor(rampPos[i] + 0.5f));
    float speed = (float)(target - motors[i]->currentPosition()) * fps;
    if (speed > MAX_STEP_RATE) speed = MAX_STEP_RATE;
    if (speed < -MAX_STEP_RATE) speed = -MAX_STEP_RATE;
    motors[i]->moveTo(target);
    motors[i]->setSpeed(speed);
  }
  if (!moving) state = IDLE;
}

// Frame clock. While playing a slave follows the master's pulses; the STOP
// ramp always uses the local clock (the master may already have stopped).
static void tickClock() {
#if SYNC_MODE == SYNC_SLAVE
  if (state == PLAYING) {
  noInterrupts();
  uint16_t pulses = syncPulses;
  syncPulses = 0;
  interrupts();
  while (pulses--) startFrame();
  return;
  }
#endif
  uint32_t now = micros();
  if ((int32_t)(now - nextFrameUs) >= 0) {
    nextFrameUs += frameUs;
    // Far behind (e.g. after a long serial burst): resynchronise instead of rushing.
    if ((int32_t)(now - nextFrameUs) > (int32_t)(4 * frameUs)) nextFrameUs = now + frameUs;
    if (state == STOPPING) { rampFrame(); return; }
#if SYNC_MODE == SYNC_MASTER
    digitalWrite(SYNC_PIN, HIGH);
    syncHigh = true;
    syncAt = now;
#endif
    startFrame();
  }
}

// ------------------------------------------------------------------ commands

static void handleLine(char* text) {
  char* cmd = strtok(text, " ");
  if (!cmd) return;

  if (!strcmp(cmd, "F")) {
    if (bufCount >= BUFFER_FRAMES) { replyError("OVERFLOW"); return; }
    long* slot = frameBuf[(bufHead + bufCount) % BUFFER_FRAMES];
    if (!parseValues(slot)) { replyError("BAD_FRAME"); return; }
    bufCount++;
  } else if (!strcmp(cmd, "HELLO")) {
    Serial.print("PB1 ");
    Serial.print(BOARD_ID);
    Serial.print(' ');
    Serial.print(MOTOR_COUNT);
    Serial.print(' ');
    Serial.println(BUFFER_FRAMES);
  } else if (!strcmp(cmd, "FPS")) {
    char* arg = strtok(NULL, " ");
    float f = arg ? (float)atof(arg) : 0.0f;
    if (f < 1.0f || f > 240.0f) { replyError("BAD_FPS"); return; }
    fps = f;
    frameUs = (uint32_t)(1000000.0f / f + 0.5f);
    reply("OK FPS");
  } else if (!strcmp(cmd, "PLAY")) {
    if (state == MOVING || state == STOPPING) { replyError("BUSY"); return; }
    for (uint8_t i = 0; i < MOTOR_COUNT; i++) motors[i]->setMaxSpeed(MAX_STEP_RATE);
    setEnabled(true);
    nextFrameUs = micros();
    underrunReported = false;
#if SYNC_MODE == SYNC_SLAVE
    syncPulses = 0;
#endif
    state = PLAYING;
    reply("OK PLAY");
  } else if (!strcmp(cmd, "END")) {
    endRequested = true;
    reply("OK END");
  } else if (!strcmp(cmd, "STOP")) {
    clearQueue();
    if (state == PLAYING) {
      // Ramp down from the current segment's end instead of stopping dead.
      for (uint8_t i = 0; i < MOTOR_COUNT; i++) rampPos[i] = (float)motors[i]->targetPosition();
      state = STOPPING;
    } else if (state == MOVING) {
      for (uint8_t i = 0; i < MOTOR_COUNT; i++) motors[i]->stop();   // AccelStepper's own decel
      announceArrival = false;
    }
    reply("OK STOP");
  } else if (!strcmp(cmd, "GOTO")) {
    if (state != IDLE) { replyError("BUSY"); return; }
    long target[MOTOR_COUNT];
    if (!parseValues(target)) { replyError("BAD_FRAME"); return; }
    setEnabled(true);
    prepareMove();
    for (uint8_t i = 0; i < MOTOR_COUNT; i++) motors[i]->moveTo(clampPosition(target[i]));
    state = MOVING;
    announceArrival = true;
  } else if (!strcmp(cmd, "HOME")) {
    if (state != IDLE) { replyError("BUSY"); return; }
    clearQueue();
    state = IDLE;
    if (homeAll()) reply("HOMED");
  } else if (!strcmp(cmd, "ZERO")) {
    for (uint8_t i = 0; i < MOTOR_COUNT; i++) motors[i]->setCurrentPosition(0);
    reply("OK ZERO");
  } else if (!strcmp(cmd, "ENABLE")) {
    char* arg = strtok(NULL, " ");
    setEnabled(!arg || atoi(arg) != 0);
    reply("OK ENABLE");
  } else if (!strcmp(cmd, "?")) {
    Serial.print("S ");
    Serial.print(STATE_NAMES[state]);
    Serial.print(' ');
    Serial.print(bufCount);
    Serial.print(' ');
    Serial.print(consumed);
    for (uint8_t i = 0; i < MOTOR_COUNT; i++) {
      Serial.print(' ');
      Serial.print(motors[i]->currentPosition());
    }
    Serial.println();
  } else {
    replyError("UNKNOWN");
  }
}

// Handles at most one complete line per call so the motors keep stepping.
static void pollSerial() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      line[lineLen] = '\0';
      bool overflow = lineOverflow;
      lineLen = 0;
      lineOverflow = false;
      if (overflow) replyError("LINE_TOO_LONG");
      else handleLine(line);
      return;
    }
    if (lineLen < LINE_MAX - 1) line[lineLen++] = c;
    else lineOverflow = true;
  }
}

// ------------------------------------------------------------------ Arduino entry points

void setup() {
  Serial.begin(SERIAL_BAUD);
  for (uint8_t i = 0; i < MOTOR_COUNT; i++) {
    motors[i] = new AccelStepper(AccelStepper::DRIVER, STEP_PINS[i], DIR_PINS[i]);
    motors[i]->setPinsInverted(INVERT_DIR[i], false, false);
    motors[i]->setMinPulseWidth(STEP_PULSE_US);
    motors[i]->setMaxSpeed(MAX_STEP_RATE);
    motors[i]->setAcceleration(MOVE_ACCEL);
  }
#ifdef ENABLE_PIN
  pinMode(ENABLE_PIN, OUTPUT);
#endif
  setEnabled(true);   // hold the balls: an unpowered motor lets them drop
#if LIMIT_MODE == LIMIT_PER_MOTOR
  for (uint8_t i = 0; i < MOTOR_COUNT; i++) pinMode(LIMIT_PINS[i], INPUT_PULLUP);
#elif LIMIT_MODE == LIMIT_SHARED
  pinMode(LIMIT_SHARED_PIN, INPUT);   // external pull-up (ESP32 GPIO34-39 have none)
#endif
#if SYNC_MODE == SYNC_MASTER
  pinMode(SYNC_PIN, OUTPUT);
  digitalWrite(SYNC_PIN, LOW);
#elif SYNC_MODE == SYNC_SLAVE
  pinMode(SYNC_PIN, INPUT);
  attachInterrupt(digitalPinToInterrupt(SYNC_PIN), onSyncPulse, RISING);
#endif
  Serial.println("# kinetic_bridge ready (send HELLO)");
}

void loop() {
  pollSerial();
  switch (state) {
    case PLAYING:
    case STOPPING:
      tickClock();
      for (uint8_t i = 0; i < MOTOR_COUNT; i++) motors[i]->runSpeedToPosition();
      break;
    case IDLE:   // finish the last frame / ramp segment, then hold
      for (uint8_t i = 0; i < MOTOR_COUNT; i++) motors[i]->runSpeedToPosition();
      break;
    case MOVING: {
      bool any = false;
      for (uint8_t i = 0; i < MOTOR_COUNT; i++) any |= motors[i]->run();
      if (!any) {
        state = IDLE;
        if (announceArrival) reply("AT");
        announceArrival = false;
      }
      break;
    }
  }
#if SYNC_MODE == SYNC_MASTER
  if (syncHigh && micros() - syncAt > 20) {
    digitalWrite(SYNC_PIN, LOW);
    syncHigh = false;
  }
#endif
}
