// Runs kinetic_bridge.ino on a PC. Build: see test_firmware.py.
// stdin/stdout carry the serial protocol; on exit (stdin closed or "#QUIT")
// the physical position of every motor is printed to stderr as "PHYS a b c ...".
#include "Arduino.h"
#include <chrono>
#include <cstdio>
#include <fcntl.h>
#include <string>
#include <unistd.h>
#include <vector>

HostSerial Serial;
static std::string rx;
static bool stdinClosed = false;
static const auto t0 = std::chrono::steady_clock::now();

unsigned long micros() {
  return (unsigned long)std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - t0).count();
}
unsigned long millis() { return micros() / 1000; }
void delay(unsigned long ms) { usleep(ms * 1000); }
void delayMicroseconds(unsigned int) {}

// --- physical model ---------------------------------------------------------
static int pinState[128];
static long phys[16];            // real position of each motor (steps; switch closes at <= 0)
static int motorOfStepPin[128], motorOfDirPin[128];
static int nMotors = 0;
static int limitPinMotor[128];

void pinMode(uint8_t, uint8_t) {}
void digitalWrite(uint8_t pin, uint8_t val) {
  int m = motorOfStepPin[pin];
  if (m >= 0 && val == HIGH && pinState[pin] == LOW) {
    int dirPin = -1;
    for (int p = 0; p < 128; p++) if (motorOfDirPin[p] == m) dirPin = p;
    phys[m] += pinState[dirPin] ? 1 : -1;
  }
  pinState[pin] = val;
}
static int sharedLimitPin = -1;
int digitalRead(uint8_t pin) {
  if (limitPinMotor[pin] >= 0) return phys[limitPinMotor[pin]] <= 0 ? LOW : HIGH;   // NO switch to GND
  if (pin == sharedLimitPin) {                                                        // NC chain: opens -> HIGH
    for (int i = 0; i < nMotors; i++) if (phys[i] <= 0) return HIGH;
    return LOW;
  }
  return HIGH;
}

int HostSerial::available() {
  if (!stdinClosed) {
    char buf[4096];
    ssize_t n = ::read(0, buf, sizeof buf);
    if (n > 0) rx.append(buf, n);
    else if (n == 0) stdinClosed = true;
  }
  return (int)rx.size();
}
int HostSerial::read() {
  if (rx.empty()) return -1;
  int c = (unsigned char)rx[0];
  rx.erase(0, 1);
  return c;
}
void HostSerial::write(const char* s) { fputs(s, stdout); fflush(stdout); }

#include "../kinetic_bridge/kinetic_bridge.ino"

int main() {
  fcntl(0, F_SETFL, fcntl(0, F_GETFL) | O_NONBLOCK);
  for (int i = 0; i < 128; i++) motorOfStepPin[i] = motorOfDirPin[i] = limitPinMotor[i] = -1;
  nMotors = MOTOR_COUNT;
  for (int i = 0; i < MOTOR_COUNT; i++) {
    motorOfStepPin[STEP_PINS[i]] = i;
    motorOfDirPin[DIR_PINS[i]] = i;
#if LIMIT_MODE == LIMIT_PER_MOTOR
    limitPinMotor[LIMIT_PINS[i]] = i;
#elif LIMIT_MODE == LIMIT_SHARED
    sharedLimitPin = LIMIT_SHARED_PIN;
#endif
    phys[i] = 3000 + 137 * i;    // balls start somewhere below their switches
  }
  setup();
  for (;;) {
    loop();
    if (stdinClosed && rx.empty()) break;
    if (rx.compare(0, 5, "#QUIT") == 0) break;
  }
  fprintf(stderr, "PHYS");
  for (int i = 0; i < MOTOR_COUNT; i++) fprintf(stderr, " %ld", phys[i]);
  fprintf(stderr, "\n");
  return 0;
}
