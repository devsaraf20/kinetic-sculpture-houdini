// Minimal Arduino core for compiling the sketch on a PC (tests only).
// Serial = stdin/stdout, time = the real clock, and a tiny physical model:
// every motor's real position follows the step/dir pins, and limit switches
// close when a motor reaches the top of its travel.
#pragma once
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <algorithm>

#ifndef ARDUINO
#define ARDUINO 100
#endif
#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2
#define RISING 3
enum { A0 = 54, A1, A2, A3, A4, A5, A6, A7 };

typedef bool boolean;
typedef uint8_t byte;

using std::max;
using std::min;
template <typename T, typename L, typename H>
auto constrain(T x, L lo, H hi) -> decltype(x + lo + hi) { return x < lo ? lo : (x > hi ? hi : x); }

unsigned long micros();
unsigned long millis();
void delay(unsigned long ms);
void delayMicroseconds(unsigned int us);
void pinMode(uint8_t pin, uint8_t mode);
void digitalWrite(uint8_t pin, uint8_t val);
int digitalRead(uint8_t pin);
inline void yield() {}
inline void noInterrupts() {}
inline void interrupts() {}
inline int digitalPinToInterrupt(int p) { return p; }
inline void attachInterrupt(int, void (*)(), int) {}

class HostSerial {
 public:
  void begin(unsigned long) {}
  int available();
  int read();
  void write(const char* s);
  void print(const char* s) { write(s); }
  void print(char c) { char b[2] = {c, 0}; write(b); }
  void print(long v) { char b[24]; snprintf(b, sizeof b, "%ld", v); write(b); }
  void print(unsigned long v) { char b[24]; snprintf(b, sizeof b, "%lu", v); write(b); }
  void print(int v) { print((long)v); }
  void print(unsigned int v) { print((unsigned long)v); }
  void print(uint8_t v) { print((unsigned long)v); }
  void print(double v) { char b[32]; snprintf(b, sizeof b, "%.2f", v); write(b); }
  template <typename T> void println(T v) { print(v); write("\n"); }
  void println() { write("\n"); }
};
extern HostSerial Serial;
