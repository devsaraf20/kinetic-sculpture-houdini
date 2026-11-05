// Physical Bridge streaming client (wire protocol in docs/PHYSICAL_BRIDGE.md).
// Transport-agnostic: BoardClient talks to anything with write(text) and
// feeds received lines into handleLine(). WebSerialTransport adapts the
// browser Web Serial API (Chrome / Edge).

import { boardFrames, frameLine } from './bridge.js';

export class BoardClient {
  constructor(transport, { name = 'board', log = () => {} } = {}) {
    this.transport = transport;
    this.name = name;
    this.log = log;
    this.waiters = [];
    this.listeners = [];
    this.info = null;
  }

  handleLine(raw) {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('E ')) this.log(`${this.name}: error: ${line.slice(2)}`);
    else if (line.startsWith('U ')) this.log(`${this.name}: buffer underrun at frame ${line.slice(2)}`);
    else if (!line.startsWith('C ')) this.log(`${this.name} → ${line}`);
    for (const l of this.listeners) l(line);
    for (const w of [...this.waiters]) {
      if (w.test(line)) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(line); }
      else if (line.startsWith('E ') && w.failOnError) {
        this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.timer);
        w.reject(new Error(`${this.name}: ${line.slice(2)}`));
      }
    }
  }

  onLine(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(l => l !== fn); }; }

  waitFor(prefix, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const w = { test: l => l === prefix || l.startsWith(prefix + ' '), resolve, reject, failOnError: true };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`${this.name}: timed out waiting for "${prefix}"`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  send(line) { return this.transport.write(line.endsWith('\n') ? line : line + '\n'); }

  async command(line, expect, timeoutMs) {
    const p = this.waitFor(expect, timeoutMs);
    await this.send(line);
    return p;
  }

  async hello() {
    const reply = await this.command('HELLO', 'PB1', 4000);
    const [, board, motors, capacity] = reply.split(/\s+/).map(Number);
    this.info = { board, motors, capacity };
    return this.info;
  }
}

/**
 * Plays a Physical Bridge document on one or more boards.
 * clients[i] drives doc.boards[i].
 */
export class ShowPlayer {
  constructor(clients, doc, { home = true, loop = false, log = () => {}, onProgress = () => {} } = {}) {
    this.clients = clients;
    this.doc = doc;
    this.home = home;
    this.loop = loop;
    this.log = log;
    this.onProgress = onProgress;
    this.stopped = false;
  }

  async run() {
    const { doc } = this;
    if (this.clients.length !== doc.boards.length) {
      throw new Error(`show needs ${doc.boards.length} board(s), ${this.clients.length} connected`);
    }
    const N = doc.frame_count;
    const states = this.clients.map((client, i) => ({ client, frames: boardFrames(doc, i), sent: 0, consumed: 0, ended: false }));

    for (const [i, st] of states.entries()) {
      const info = await st.client.hello();
      const need = doc.boards[i].motors.length;
      if (info.motors < need) throw new Error(`${st.client.name} drives ${info.motors} motors, show needs ${need}`);
      st.capacity = Math.max(1, info.capacity);
      st.pad = info.motors - need; // extra motors on the board just hold position 0
      await st.client.command('STOP', 'OK', 3000);
      await st.client.command(`FPS ${doc.fps}`, 'OK', 3000);
    }
    const line = (st, f) => {
      const v = st.frames[f % N];
      return frameLine(st.pad ? v.concat(new Array(st.pad).fill(0)) : v);
    };
    if (this.home) {
      this.log('Homing…');
      await Promise.all(states.map(st => st.client.command('HOME', 'HOMED', 180000)));
    }
    this.log('Moving to the first frame…');
    await Promise.all(states.map(st => st.client.command(line(st, 0).replace(/^F/, 'GOTO').trim(), 'AT', 120000)));
    if (this.stopped) return;

    const pump = async st => {
      while (!this.stopped && st.sent - st.consumed < st.capacity && (this.loop || st.sent < N)) {
        const f = st.sent++;
        await st.client.send(line(st, f));
      }
      if (!this.loop && st.sent >= N && !st.ended && !this.stopped) { st.ended = true; await st.client.send('END'); }
    };
    // Prefill every buffer, then start all boards as close together as possible.
    for (const st of states) await pump(st);
    const done = Promise.all(states.map(st => new Promise((resolve, reject) => {
      st.off = st.client.onLine(l => {
        if (l.startsWith('C ')) {
          st.consumed = +l.slice(2);
          this.onProgress(Math.min(...states.map(s => s.consumed)), N);
          pump(st).catch(reject);
        } else if (l.startsWith('DONE')) resolve();
        else if (l === 'OK STOP') resolve();
      });
    })));
    // Board 0 is the sync master when boards are wired together: start it last.
    for (const st of [...states].reverse()) await st.client.send('PLAY');
    this.log('Playing.');
    try { await done; } finally { states.forEach(st => st.off && st.off()); }
    this.log(this.stopped ? 'Stopped.' : 'Show finished.');
  }

  async stop() {
    this.stopped = true;
    await Promise.all(this.clients.map(c => c.send('STOP').catch(() => {})));
  }
}

export class WebSerialTransport {
  static supported() { return typeof navigator !== 'undefined' && 'serial' in navigator; }

  static async request(baudRate = 115200) {
    const port = await navigator.serial.requestPort();
    const t = new WebSerialTransport(port);
    await t.open(baudRate);
    return t;
  }

  constructor(port) { this.port = port; this.onLine = () => {}; this.encoder = new TextEncoder(); }

  async open(baudRate) {
    await this.port.open({ baudRate });
    this.writer = this.port.writable.getWriter();
    this.reading = this.readLoop();
    // Many boards reset when the port opens; give the bootloader time.
    await new Promise(r => setTimeout(r, 1800));
  }

  async readLoop() {
    const decoder = new TextDecoder();
    let buf = '';
    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { this.onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
    } catch { /* port closed */ } finally { this.reader.releaseLock(); }
  }

  write(text) { return this.writer.write(this.encoder.encode(text)); }

  async close() {
    try { await this.reader?.cancel(); } catch { /* ignore */ }
    try { this.writer?.releaseLock(); } catch { /* ignore */ }
    try { await this.port.close(); } catch { /* ignore */ }
  }
}
