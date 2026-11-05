// Run with:  node --test web/tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createAnimation, parseAnimation, toJSON, toCSV, getSeries, setSeries, retime } from '../js/format.js';
import { analyze, smoothAnimation, smoothSeries, checkSeries, projectQP, enforcePass, kinematics,
  FLAG_RANGE, FLAG_SPEED, FLAG_ACCEL } from '../js/limits.js';
import { generate, PRESETS, PATTERNS, defaultLayer, layerDemand } from '../js/generators.js';
import { buildBridge, boardFrames, stepsPerMm, heightToSteps, stepsToHeight, parseBridge, bridgeToJSON, frameLine } from '../js/bridge.js';
import { BoardClient, ShowPlayer } from '../js/serial.js';

const L = { min_mm: 0, max_mm: 800, max_speed: 200, max_accel: 600, boundary: 'rest' };
const fps = 30;
const root = fileURLToPath(new URL('../../', import.meta.url));

const worst = (s, limits = L) => checkSeries(s, fps, limits).severity.reduce((a, b) => Math.max(a, b), 0);

test('JSON and CSV round-trip', () => {
  const a = generate({ rows: 3, cols: 4, duration: 2, layers: [defaultLayer('wave')] });
  for (const text of [toJSON(a), toCSV(a)]) {
    const b = parseAnimation(text);
    assert.equal(b.rows, 3); assert.equal(b.cols, 4);
    assert.equal(b.frameCount, a.frameCount); assert.equal(b.fps, 30);
    for (let i = 0; i < a.heights.length; i++) assert.ok(Math.abs(a.heights[i] - b.heights[i]) < 1e-3);
    assert.deepEqual(b.balls[5], { row: 1, col: 1 });
  }
});

test('example exports in the repo parse', () => {
  for (const f of ['examples/ripple_8x8.json', 'examples/ripple_8x8.csv', 'examples/too_fast_8x8.json']) {
    const a = parseAnimation(readFileSync(root + f, 'utf8'), f);
    assert.equal(a.ballCount, 64, f);
    assert.ok(a.frameCount > 10, f);
  }
});

test('CSV with arbitrary column names guesses a grid', () => {
  const csv = '# fps=24\nframe,a,b,c,d,e,f\n1,0,1,2,3,4,5\n2,1,2,3,4,5,6\n';
  const a = parseAnimation(csv);
  assert.equal(a.fps, 24); assert.equal(a.ballCount, 6); assert.equal(a.rows * a.cols, 6);
  assert.equal(a.frameStart, 1);
});

test('kinematics match the constant-speed-per-frame motor model', () => {
  const s = Float64Array.from([0, 1, 3, 6, 6]);
  const { vel, acc } = kinematics(s, 10, 'rest');
  assert.deepEqual(Array.from(vel), [0, 10, 20, 30, 0]);
  assert.deepEqual(Array.from(acc), [100, 100, 100, -300, 0]);
});

test('analyze flags range, speed and acceleration separately', () => {
  const a = createAnimation({ rows: 1, cols: 3, frameCount: 5, fps: 10 });
  // ball 0: out of range; ball 1: too fast; ball 2: fine
  setSeries(a, 0, [100, 100, 900, 900, 900]);
  setSeries(a, 1, [100, 100, 150, 200, 200]);  // 500 mm/s
  setSeries(a, 2, [100, 101, 102, 102, 102]);
  const lim = { ...L, max_speed: 200, max_accel: 100000 };
  const an = analyze(a, lim);
  assert.ok(an.ballFlags[0] & FLAG_RANGE);
  assert.ok(an.ballFlags[1] & FLAG_SPEED);
  assert.equal(an.ballFlags[2], 0);
  assert.equal(an.ok, false);
  assert.equal(an.badBalls, 2);
  assert.ok(an.spans.length >= 1);
});

test('NaN heights are reported, never silently accepted', () => {
  const s = Float64Array.from([100, 100, NaN, 100, 100]);
  const r = checkSeries(s, fps, L);
  assert.ok(r.flags[2] & FLAG_RANGE);
});

test('a feasible animation is left untouched by smoothing', async () => {
  const a = generate({ layers: PRESETS['Calm ocean'] });
  assert.equal(analyze(a, L).ok, true);
  const { anim, report } = await smoothAnimation(a, L);
  assert.equal(report.ballsChanged, 0);
  assert.deepEqual(anim.heights, a.heights);
});

test('smoothing removes every violation (hard cases)', () => {
  const cases = {
    step: Array.from({ length: 300 }, (_, i) => (i < 150 ? 200 : 600)),
    outOfRange: Array.from({ length: 300 }, (_, i) => 400 + 600 * Math.sin(2 * Math.PI * 0.2 * i / fps)),
    noise: Array.from({ length: 600 }, (_, i) => 400 + 300 * Math.sin(i * 1.7) * Math.cos(i * 0.37)),
    spike: Array.from({ length: 200 }, (_, i) => (i === 100 ? 790 : 10)),
    startsMoving: Array.from({ length: 120 }, (_, i) => 100 + i * 5),
    long: Array.from({ length: 5400 }, (_, i) => 400 + 350 * Math.sin(i * 0.05) * Math.cos(i * 0.013)),
  };
  for (const boundary of ['rest', 'free']) {
    const lim = { ...L, boundary };
    for (const [name, y] of Object.entries(cases)) {
      const s = smoothSeries(Float64Array.from(y), fps, lim);
      assert.ok(s.every(Number.isFinite), `${name}/${boundary} finite`);
      assert.ok(worst(s, lim) <= 1, `${name}/${boundary}: worst ratio ${worst(s, lim)}`);
    }
  }
});

test('smoothing is the least-squares fix: local, and symmetric around a step', () => {
  const y = Float64Array.from({ length: 300 }, (_, i) => (i < 150 ? 200 : 600));
  const s = smoothSeries(y, fps, L);
  // Far from the step nothing changes.
  assert.ok(Math.abs(s[10] - 200) < 0.01 && Math.abs(s[290] - 600) < 0.01);
  // The transition is centred on the step (not delayed like a causal filter).
  assert.ok(Math.abs((s[149] + s[150]) / 2 - 400) < 2, `${s[149]} ${s[150]}`);
  // Minimal: a slightly different feasible curve is never closer.
  const dist = v => v.reduce((acc, x, i) => acc + (x - y[i]) ** 2, 0);
  const alt = enforcePass(y, 0, 800, 200 / fps * 0.99, 600 / fps / fps * 0.99, true);
  assert.ok(dist(s) < dist(alt));
});

test('interior-point projection converges quickly', () => {
  const y = Float64Array.from({ length: 600 }, (_, i) => 400 + 300 * Math.sin(i * 0.4));
  const stats = {};
  projectQP(y, 0, 800, 200 / fps, 600 / fps / fps, true, { stats });
  assert.ok(stats.iterations < 60, `iterations ${stats.iterations}`);
});

test('every preset except the stress test is within default limits', () => {
  for (const [name, layers] of Object.entries(PRESETS)) {
    const ok = analyze(generate({ layers }), L).ok;
    assert.equal(ok, !name.startsWith('Too fast'), name);
  }
});

test('generator respects travel and starts/ends at the rest height', () => {
  for (const type of Object.keys(PATTERNS)) {
    const a = generate({ rows: 4, cols: 4, duration: 6, base_mm: 400, layers: [{ ...defaultLayer(type), amplitude: 2000 }] });
    const an = analyze(a, L);
    assert.ok(an.peak.min >= 0 && an.peak.max <= 800, type);
    assert.ok(Math.abs(a.heights[0] - 400) < 1e-3, type);
    assert.ok(Math.abs(a.heights[a.heights.length - 1] - 400) < 1e-3, type);
  }
});

test('analytic demand for periodic layers matches measurement', () => {
  const layer = { ...defaultLayer('wave'), amplitude: 100, period: 4 };
  const d = layerDemand(layer);
  const an = analyze(generate({ duration: 20, ease: 0, layers: [layer], fit: 'none' }), { ...L, boundary: 'free' });
  assert.ok(Math.abs(an.peak.speed - d.speed) / d.speed < 0.02);
  assert.ok(Math.abs(an.peak.accel - d.accel) / d.accel < 0.03);
});

test('retime slows motion by the factor', () => {
  const a = generate({ layers: PRESETS['Too fast (stress test)'] });
  const an = analyze(a, L);
  const b = retime(a, 2);
  assert.equal(b.frameCount, (a.frameCount - 1) * 2 + 1);
  const bn = analyze(b, L);
  assert.ok(bn.peak.speed < an.peak.speed * 0.55);
});

test('Physical Bridge conversion', () => {
  const m = { travel_mm: 800, spool_diameter_mm: 20, steps_per_rev: 200, microsteps: 4, motors_per_board: 8, home: 'top' };
  const spm = stepsPerMm(m);
  assert.ok(Math.abs(spm - 800 / (Math.PI * 20)) < 1e-9);
  assert.equal(heightToSteps(800, m), 0);                 // fully raised = home
  assert.equal(heightToSteps(0, m), Math.round(800 * spm));
  assert.ok(Math.abs(stepsToHeight(heightToSteps(321, m), m) - 321) < 1 / spm);
  const a = generate({ rows: 8, cols: 8, duration: 2, layers: PRESETS['Calm ocean'] });
  const doc = parseBridge(bridgeToJSON(buildBridge(a, m, L)));
  assert.equal(doc.boards.length, 8);
  assert.equal(doc.frames.length, a.frameCount);
  assert.equal(doc.motor_count, 64);
  const b3 = boardFrames(doc, 3);
  assert.equal(b3[0].length, 8);
  assert.equal(b3[5][2], doc.frames[5][3 * 8 + 2]);
  assert.equal(frameLine([1, 2, 3]), 'F 1 2 3\n');
  assert.ok(doc.stats.peak_step_rate > 0);
});

// A fake board that implements the wire protocol closely enough to test the host side.
class FakeBoard {
  constructor(motors = 8, capacity = 4) {
    this.motors = motors; this.capacity = capacity; this.buf = []; this.consumed = 0; this.ended = false;
    this.received = []; this.playing = false;
  }
  attach(client) { this.client = client; }
  reply(l) { setTimeout(() => this.client.handleLine(l), 0); }
  async write(text) {
    for (const line of text.split('\n').filter(Boolean)) {
      const [cmd, ...args] = line.split(' ');
      if (cmd === 'HELLO') this.reply(`PB1 0 ${this.motors} ${this.capacity}`);
      else if (cmd === 'STOP') { this.buf = []; this.consumed = 0; this.playing = false; this.reply('OK STOP'); }
      else if (cmd === 'FPS') this.reply('OK FPS');
      else if (cmd === 'HOME') this.reply('HOMED');
      else if (cmd === 'GOTO') { assert.equal(args.length, this.motors); this.reply('AT'); }
      else if (cmd === 'F') {
        assert.equal(args.length, this.motors);
        if (this.buf.length >= this.capacity) throw new Error('overflow');
        this.buf.push(args.map(Number)); this.received.push(args.map(Number));
      } else if (cmd === 'PLAY') { this.playing = true; this.tick(); }
      else if (cmd === 'END') this.ended = true;
    }
  }
  tick() {
    if (!this.playing) return;
    if (this.buf.length) { this.buf.shift(); this.consumed++; this.reply(`C ${this.consumed}`); }
    else if (this.ended) { this.playing = false; this.reply(`DONE ${this.consumed}`); return; }
    setTimeout(() => this.tick(), 1);
  }
}

test('ShowPlayer streams every frame to every board with flow control', async () => {
  const a = generate({ rows: 2, cols: 8, duration: 1, layers: PRESETS['Calm ocean'] });
  const doc = buildBridge(a, { motors_per_board: 8 }, L);
  const boards = [new FakeBoard(8, 4), new FakeBoard(10, 6)];   // second board has 2 spare motors
  const clients = boards.map((fb, i) => { const c = new BoardClient(fb, { name: `b${i}` }); fb.attach(c); return c; });
  let progress = 0;
  await new ShowPlayer(clients, doc, { onProgress: f => { progress = f; } }).run();
  assert.equal(progress, doc.frame_count);
  boards.forEach((fb, i) => {
    assert.equal(fb.received.length, doc.frame_count);
    const expect = boardFrames(doc, i);
    assert.deepEqual(fb.received[7].slice(0, 8), expect[7]);
    if (fb.motors > 8) assert.deepEqual(fb.received[7].slice(8), [0, 0]);
  });
});
