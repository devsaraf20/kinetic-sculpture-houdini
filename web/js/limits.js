// Physical-limit checking and automatic smoothing.
//
// Motion model (matches the firmware): between two frames a motor runs at a
// constant speed, so
//   velocity of segment i (frame i-1 -> i)  v_i = (h_i - h_{i-1}) * fps
//   acceleration at frame i                 a_i = (v_{i+1} - v_i) * fps
// With boundary = 'rest' the sculpture is assumed to be standing still before
// the first frame and after the last one (it is, when playing a show).

import { getSeries, setSeries, cloneAnimation } from './format.js';

export const FLAG_RANGE = 1;
export const FLAG_SPEED = 2;
export const FLAG_ACCEL = 4;

export const DEFAULT_LIMITS = Object.freeze({
  min_mm: 0,          // lowest allowed height
  max_mm: 800,        // highest allowed height (travel)
  max_speed: 200,     // mm/s
  max_accel: 600,     // mm/s^2
  boundary: 'rest',   // 'rest' | 'free'
});

// Relative tolerance so float noise right on the limit is not reported.
const TOL = 1 + 1e-4;
const ABS_TOL = 1e-6;

/** Per-frame velocity (mm/s) and acceleration (mm/s^2) of one series. */
export function kinematics(s, fps, boundary = 'rest') {
  const n = s.length;
  const vel = new Float64Array(n);
  const acc = new Float64Array(n);
  for (let i = 1; i < n; i++) vel[i] = (s[i] - s[i - 1]) * fps;
  const rest = boundary === 'rest';
  for (let i = 0; i < n; i++) {
    const vPrev = i >= 1 ? vel[i] : (rest ? 0 : NaN);
    const vNext = i + 1 < n ? vel[i + 1] : (rest ? 0 : NaN);
    acc[i] = Number.isNaN(vPrev) || Number.isNaN(vNext) ? 0 : (vNext - vPrev) * fps;
  }
  if (rest && n > 0) vel[0] = 0;
  return { vel, acc };
}

/** Flags + severity (ratio to the limit, >1 = violation) for one series. */
export function checkSeries(s, fps, limits) {
  const { vel, acc } = kinematics(s, fps, limits.boundary);
  const n = s.length;
  const flags = new Uint8Array(n);
  const severity = new Float32Array(n);
  const travel = Math.max(limits.max_mm - limits.min_mm, 1e-9);
  for (let i = 0; i < n; i++) {
    let f = 0;
    const rs = Math.abs(vel[i]) / limits.max_speed;
    const ra = Math.abs(acc[i]) / limits.max_accel;
    let rr = 0;
    if (!Number.isFinite(s[i])) rr = Infinity;
    else if (s[i] > limits.max_mm + ABS_TOL) rr = 1 + (s[i] - limits.max_mm) / travel;
    else if (s[i] < limits.min_mm - ABS_TOL) rr = 1 + (limits.min_mm - s[i]) / travel;
    if (rr > 1) f |= FLAG_RANGE;
    if (rs > TOL) f |= FLAG_SPEED;
    if (ra > TOL) f |= FLAG_ACCEL;
    if (Number.isNaN(rs)) f |= FLAG_SPEED;
    if (Number.isNaN(ra)) f |= FLAG_ACCEL;
    flags[i] = f;
    severity[i] = Number.isFinite(s[i]) ? Math.max(rs, ra, rr) : Infinity;
  }
  return { flags, severity, vel, acc };
}

/**
 * Check a whole animation.
 * Returns per ball-frame flags/severity (frame-major), per-frame summaries,
 * peak values and a compact list of violating frame spans.
 */
export function analyze(anim, limits = DEFAULT_LIMITS) {
  const { frameCount: N, ballCount: B, fps } = anim;
  const flags = new Uint8Array(N * B);
  const severity = new Float32Array(N * B);
  const frameFlags = new Uint8Array(N);
  const frameSeverity = new Float32Array(N);
  const frameBallsBad = new Uint16Array(N);
  const ballFlags = new Uint8Array(B);
  const counts = { range: 0, speed: 0, accel: 0 };
  const peak = { speed: 0, accel: 0, min: Infinity, max: -Infinity,
    speedBall: -1, speedFrame: -1, accelBall: -1, accelFrame: -1 };
  const s = new Float64Array(N);
  for (let b = 0; b < B; b++) {
    getSeries(anim, b, s);
    const r = checkSeries(s, fps, limits);
    for (let f = 0; f < N; f++) {
      const k = f * B + b;
      const fl = r.flags[f];
      flags[k] = fl;
      severity[k] = r.severity[f];
      if (fl) {
        frameFlags[f] |= fl;
        ballFlags[b] |= fl;
        frameBallsBad[f]++;
        if (fl & FLAG_RANGE) counts.range++;
        if (fl & FLAG_SPEED) counts.speed++;
        if (fl & FLAG_ACCEL) counts.accel++;
      }
      if (r.severity[f] > frameSeverity[f]) frameSeverity[f] = r.severity[f];
      const av = Math.abs(r.vel[f]), aa = Math.abs(r.acc[f]);
      if (av > peak.speed) { peak.speed = av; peak.speedBall = b; peak.speedFrame = f; }
      if (aa > peak.accel) { peak.accel = aa; peak.accelBall = b; peak.accelFrame = f; }
      if (s[f] < peak.min) peak.min = s[f];
      if (s[f] > peak.max) peak.max = s[f];
    }
  }
  // Contiguous spans of violating frames.
  const spans = [];
  for (let f = 0; f < N; f++) {
    if (!frameFlags[f]) continue;
    const last = spans[spans.length - 1];
    if (last && last.end === f - 1) { last.end = f; last.flags |= frameFlags[f]; last.worst = Math.max(last.worst, frameSeverity[f]); }
    else spans.push({ start: f, end: f, flags: frameFlags[f], worst: frameSeverity[f] });
  }
  let badFrames = 0;
  for (let f = 0; f < N; f++) if (frameFlags[f]) badFrames++;
  let badBalls = 0;
  for (let b = 0; b < B; b++) if (ballFlags[b]) badBalls++;
  // Slow-down factor that would make the animation feasible by retiming alone
  // (speed scales with 1/k, acceleration with 1/k^2). Range is not fixed by retiming.
  const slowdown = Math.max(1, peak.speed / limits.max_speed, Math.sqrt(peak.accel / limits.max_accel));
  return { flags, severity, frameFlags, frameSeverity, frameBallsBad, ballFlags, counts, peak,
    spans, badFrames, badBalls, ok: badFrames === 0, slowdown, limits: { ...limits } };
}

export function describeFlags(fl) {
  const out = [];
  if (fl & FLAG_RANGE) out.push('range');
  if (fl & FLAG_SPEED) out.push('speed');
  if (fl & FLAG_ACCEL) out.push('accel');
  return out.join(' + ');
}

// ---------------------------------------------------------------------------
// Smoothing
// ---------------------------------------------------------------------------

/**
 * Return a copy of `anim` in which every ball obeys the limits. Balls that
 * already comply are untouched. For the others the series is replaced by the
 * closest (least-squares) series that satisfies range, speed and acceleration
 * limits, so frames far away from a violation stay as animated.
 *
 * Async so the UI can show progress: pass onProgress(done, total) and
 * yieldMs (how long to work before letting the browser render a frame).
 */
export async function smoothAnimation(anim, limits = DEFAULT_LIMITS, opts = {}) {
  const out = cloneAnimation(anim);
  const { frameCount: N, ballCount: B, fps } = anim;
  const s = new Float64Array(N);
  const report = { ballsChanged: 0, maxDeviation: 0, framesChanged: 0, perBallDeviation: new Float32Array(B) };
  const changedFrames = new Uint8Array(N);
  let lastYield = performance.now();
  for (let b = 0; b < B; b++) {
    getSeries(anim, b, s);
    const check = checkSeries(s, fps, limits);
    if (check.flags.some(f => f)) {
      const sm = smoothSeries(s, fps, limits, opts);
      let dev = 0;
      for (let f = 0; f < N; f++) {
        const d = Math.abs(sm[f] - s[f]);
        if (d > 0.01) changedFrames[f] = 1;
        if (d > dev) dev = d;
      }
      setSeries(out, b, sm);
      report.ballsChanged++;
      report.perBallDeviation[b] = dev;
      report.maxDeviation = Math.max(report.maxDeviation, dev);
    }
    if (opts.onProgress) opts.onProgress(b + 1, B);
    // Give the UI a frame now and then (time budget, not per ball).
    if (opts.yieldMs && performance.now() - lastYield > opts.yieldMs) {
      await new Promise(r => setTimeout(r, 0));
      lastYield = performance.now();
    }
  }
  for (let f = 0; f < N; f++) report.framesChanged += changedFrames[f];
  out.source = anim.source.endsWith('+smoothed') ? anim.source : anim.source + '+smoothed';
  return { anim: out, report };
}

/** Smooth one series (mm, per frame). Returns a new Float64Array. */
export function smoothSeries(y, fps, limits, opts = {}) {
  const n = y.length;
  if (n < 2) return Float64Array.from(y, v => clamp(v, limits.min_mm, limits.max_mm));
  const margin = opts.margin ?? 0.99;
  const V = limits.max_speed / fps;              // mm per frame
  const A = limits.max_accel / (fps * fps);      // mm per frame^2
  const rest = limits.boundary === 'rest';
  const x = projectQP(y, limits.min_mm, limits.max_mm, V * margin, A * margin, rest, opts);
  // Exact guarantee pass: fixes whatever residual the iterative solver leaves.
  return enforcePass(x, limits.min_mm, limits.max_mm, V * 0.9995, A * 0.9995, rest);
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Least-squares projection onto { lo <= x <= hi, |dx| <= V, |d2x| <= A }
 * (plus "from rest / to rest" rows when `rest`): the series closest to y
 * that obeys the limits. Solved with a Mehrotra predictor-corrector
 * primal-dual interior-point method. Each iteration needs one pentadiagonal
 * factorisation (banded Cholesky, O(n)); 15-40 iterations is typical.
 */
export function projectQP(y, lo, hi, V, A, rest, opts = {}) {
  const n = y.length;
  if (n < 3) return Float64Array.from(y, v => clamp(v, lo, hi));
  // Constraint rows a.x in [bl, bh], at most 3 non-zeros each.
  const rows = [];
  for (let i = 0; i < n; i++) rows.push([i, 1, i, 0, i, 0, lo, hi]);
  for (let i = 1; i < n; i++) rows.push([i, 1, i - 1, -1, i, 0, -V, V]);
  for (let i = 1; i < n - 1; i++) rows.push([i - 1, 1, i, -2, i + 1, 1, -A, A]);
  if (rest) {
    rows.push([1, 1, 0, -1, 0, 0, -A, A]);
    rows.push([n - 2, 1, n - 1, -1, n - 1, 0, -A, A]);
  }
  const m = rows.length;
  const r0 = new Int32Array(m), r1 = new Int32Array(m), r2 = new Int32Array(m);
  const c0 = new Float64Array(m), c1 = new Float64Array(m), c2 = new Float64Array(m);
  const bl = new Float64Array(m), bh = new Float64Array(m);
  rows.forEach((r, k) => { [r0[k], c0[k], r1[k], c1[k], r2[k], c2[k], bl[k], bh[k]] = r; });
  const rowVals = (v, out) => {
    for (let k = 0; k < m; k++) out[k] = c0[k] * v[r0[k]] + c1[k] * v[r1[k]] + c2[k] * v[r2[k]];
  };
  const scatter = (w, out) => {   // out += A^T w
    for (let k = 0; k < m; k++) { const v = w[k]; out[r0[k]] += c0[k] * v; out[r1[k]] += c1[k] * v; out[r2[k]] += c2[k] * v; }
  };

  // Each row gives two inequalities:  a.x + wu = bh,  -a.x + wl = -bl,  wu, wl, lu, ll >= 0.
  // Start strictly inside (the guarantee pass with tighter limits) and perfectly
  // centred (all w*l equal), which keeps the first steps long.
  const d = Math.min(0.5, (hi - lo) / 4);
  const x = enforcePass(y, lo + d, hi - d, V * 0.9, A * 0.9, rest);
  const s = new Float64Array(m);
  rowVals(x, s);
  let mu0 = 0;
  for (let i = 0; i < n; i++) mu0 += (x[i] - y[i]) ** 2;
  mu0 = Math.max(opts.mu0 ?? mu0 / (2 * m), 1e-3);
  const wu = new Float64Array(m), wl = new Float64Array(m), lu = new Float64Array(m), ll = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    wu[k] = Math.max(bh[k] - s[k], 1e-9);
    wl[k] = Math.max(s[k] - bl[k], 1e-9);
    lu[k] = mu0 / wu[k]; ll[k] = mu0 / wl[k];
  }
  const rd = new Float64Array(n), rpu = new Float64Array(m), rpl = new Float64Array(m);
  const du = new Float64Array(m), dl = new Float64Array(m), tmpM = new Float64Array(m);
  const h0 = new Float64Array(n), h1 = new Float64Array(n), h2 = new Float64Array(n);
  const L0 = new Float64Array(n), L1 = new Float64Array(n), L2 = new Float64Array(n);
  const dx = new Float64Array(n), ds = new Float64Array(m), rhs = new Float64Array(n);
  const dwu = new Float64Array(m), dwl = new Float64Array(m), dlu = new Float64Array(m), dll = new Float64Array(m);
  const awu = new Float64Array(m), awl = new Float64Array(m), alu = new Float64Array(m), all = new Float64Array(m);
  const addH = (i, ci, j, cj, w) => {
    if (ci === 0 || cj === 0) return;
    const dd = j - i, v = w * ci * cj;
    if (dd === 0) h0[i] += v;
    else if (dd === 1 || dd === -1) h1[Math.min(i, j)] += v;
    else if (dd === 2 || dd === -2) h2[Math.min(i, j)] += v;
  };

  // Solve the reduced Newton system for a given complementarity rhs (rcu, rcl).
  const direction = (rcu, rcl) => {
    for (let i = 0; i < n; i++) rhs[i] = -rd[i];
    for (let k = 0; k < m; k++) tmpM[k] = -(du[k] * rpu[k] - dl[k] * rpl[k]) + rcu[k] / wu[k] - rcl[k] / wl[k];
    scatter(tmpM, rhs);
    for (let i = 0; i < n; i++) {
      let v = rhs[i];
      if (i >= 1) v -= L1[i] * dx[i - 1];
      if (i >= 2) v -= L2[i] * dx[i - 2];
      dx[i] = v / L0[i];
    }
    for (let i = n - 1; i >= 0; i--) {
      let v = dx[i];
      if (i + 1 < n) v -= L1[i + 1] * dx[i + 1];
      if (i + 2 < n) v -= L2[i + 2] * dx[i + 2];
      dx[i] = v / L0[i];
    }
    rowVals(dx, ds);
    for (let k = 0; k < m; k++) {
      dlu[k] = du[k] * (ds[k] + rpu[k]) - rcu[k] / wu[k];
      dll[k] = dl[k] * (-ds[k] + rpl[k]) - rcl[k] / wl[k];
      dwu[k] = (-rcu[k] - wu[k] * dlu[k]) / lu[k];
      dwl[k] = (-rcl[k] - wl[k] * dll[k]) / ll[k];
    }
  };
  const maxStep = () => {
    let a = 1;
    for (let k = 0; k < m; k++) {
      if (dwu[k] < 0) a = Math.min(a, -wu[k] / dwu[k]);
      if (dwl[k] < 0) a = Math.min(a, -wl[k] / dwl[k]);
      if (dlu[k] < 0) a = Math.min(a, -lu[k] / dlu[k]);
      if (dll[k] < 0) a = Math.min(a, -ll[k] / dll[k]);
    }
    return a;
  };

  const rcu = new Float64Array(m), rcl = new Float64Array(m);
  const maxIter = opts.maxIter ?? 80;
  let it = 0;
  for (; it < maxIter; it++) {
    rowVals(x, s);
    for (let i = 0; i < n; i++) rd[i] = x[i] - y[i];
    for (let k = 0; k < m; k++) tmpM[k] = lu[k] - ll[k];
    scatter(tmpM, rd);
    let mu = 0, rp = 0, rdm = 0;
    for (let k = 0; k < m; k++) {
      rpu[k] = s[k] + wu[k] - bh[k];
      rpl[k] = -s[k] + wl[k] + bl[k];
      rp = Math.max(rp, Math.abs(rpu[k]), Math.abs(rpl[k]));
      mu += wu[k] * lu[k] + wl[k] * ll[k];
    }
    for (let i = 0; i < n; i++) rdm = Math.max(rdm, Math.abs(rd[i]));
    mu /= 2 * m;
    // Converged to well below a micrometre / numerical floor reached.
    if ((mu < 1e-7 && rp < 1e-6 && rdm < 1e-5) || mu < 1e-12) break;

    for (let i = 0; i < n; i++) { h0[i] = 1; h1[i] = 0; h2[i] = 0; }
    for (let k = 0; k < m; k++) {
      du[k] = lu[k] / wu[k]; dl[k] = ll[k] / wl[k];
      const hr = du[k] + dl[k];
      addH(r0[k], c0[k], r0[k], c0[k], hr); addH(r1[k], c1[k], r1[k], c1[k], hr); addH(r2[k], c2[k], r2[k], c2[k], hr);
      addH(r0[k], c0[k], r1[k], c1[k], hr); addH(r0[k], c0[k], r2[k], c2[k], hr); addH(r1[k], c1[k], r2[k], c2[k], hr);
    }
    for (let i = 0; i < n; i++) {
      const l2 = i >= 2 ? h2[i - 2] / L0[i - 2] : 0;
      const l1 = i >= 1 ? (h1[i - 1] - (i >= 2 ? l2 * L1[i - 1] : 0)) / L0[i - 1] : 0;
      L2[i] = l2; L1[i] = l1;
      L0[i] = Math.sqrt(Math.max(h0[i] - l2 * l2 - l1 * l1, 1e-12));
    }
    // Predictor (affine scaling).
    for (let k = 0; k < m; k++) { rcu[k] = wu[k] * lu[k]; rcl[k] = wl[k] * ll[k]; }
    direction(rcu, rcl);
    const aAff = maxStep();
    let muAff = 0;
    for (let k = 0; k < m; k++) {
      muAff += (wu[k] + aAff * dwu[k]) * (lu[k] + aAff * dlu[k]) + (wl[k] + aAff * dwl[k]) * (ll[k] + aAff * dll[k]);
      awu[k] = dwu[k]; awl[k] = dwl[k]; alu[k] = dlu[k]; all[k] = dll[k];
    }
    muAff /= 2 * m;
    const sigma = Math.min(1, (muAff / mu) ** 3);
    // Corrector + centring.
    for (let k = 0; k < m; k++) {
      rcu[k] = wu[k] * lu[k] + awu[k] * alu[k] - sigma * mu;
      rcl[k] = wl[k] * ll[k] + awl[k] * all[k] - sigma * mu;
    }
    direction(rcu, rcl);
    const a = Math.min(1, 0.995 * maxStep());
    let finite = Number.isFinite(a);
    for (let i = 0; i < n && finite; i++) finite = Number.isFinite(dx[i]);
    if (!finite) break;  // keep the last good iterate; the guarantee pass finishes the job
    for (let i = 0; i < n; i++) x[i] += a * dx[i];
    for (let k = 0; k < m; k++) {
      wu[k] += a * dwu[k]; wl[k] += a * dwl[k]; lu[k] += a * dlu[k]; ll[k] += a * dll[k];
    }
  }
  if (opts.stats) opts.stats.iterations = it;
  return x;
}

/**
 * Single forward pass that guarantees every limit. V, A in mm/frame and
 * mm/frame^2. At each frame the next velocity is restricted to the set that
 *   - respects max speed and max acceleration,
 *   - can still brake to a stop before leaving [lo, hi],
 *   - (rest) can still brake to a stop by the last frame.
 * "Brake towards zero velocity" is always inside that set, so it is never
 * empty. Inside it the target is tracked with an acceleration-limited
 * square-root controller, which rejoins the target without overshooting.
 */
export function enforcePass(x, lo, hi, V, A, rest) {
  const n = x.length;
  const p = new Float64Array(n);
  p[0] = clamp(x[0], lo, hi);
  let v = 0;                         // velocity of the previous segment
  const stop = vv => { const a = Math.abs(vv); const k = Math.floor(a / A); return k * a - A * k * (k + 1) / 2; };
  for (let i = 1; i < n; i++) {
    const free = !rest && i === 1;   // free boundary: first segment has no accel limit
    let vmin = free ? -V : Math.max(-V, v - A);
    let vmax = free ? V : Math.min(V, v + A);
    if (rest) { const e = A * (n - i); vmin = Math.max(vmin, -e); vmax = Math.min(vmax, e); }
    const p0 = p[i - 1];
    const upOK = vt => p0 + vt + (vt > 0 ? stop(vt) : 0) <= hi + 1e-9;
    const dnOK = vt => p0 + vt - (vt < 0 ? stop(vt) : 0) >= lo - 1e-9;
    if (!upOK(vmax)) vmax = bisect(upOK, vmin, vmax, true);
    if (!dnOK(vmin)) vmin = bisect(dnOK, vmin, vmax, false);
    if (vmin > vmax) vmin = vmax = (vmin + vmax) / 2;
    // Square-root tracking of the target position and velocity.
    const vr = x[i] - x[i - 1];
    const e = x[i - 1] - p0;
    let g = 0;
    if (e !== 0) {
      const ae = Math.abs(e);
      g = Math.sign(e) * Math.min(ae, -A / 2 + Math.sqrt(A * A / 4 + 2 * A * ae));
    }
    const vt = clamp(vr + g, vmin, vmax);
    p[i] = clamp(p0 + vt, lo, hi);
    v = p[i] - p0;
  }
  return p;
}

// Largest (wantMax) or smallest feasible value in [a, b] for a monotone predicate.
function bisect(ok, a, b, wantMax) {
  let good = wantMax ? a : b, bad = wantMax ? b : a;
  if (!ok(good)) return good;
  for (let k = 0; k < 50; k++) {
    const mid = (good + bad) / 2;
    if (ok(mid)) good = mid; else bad = mid;
  }
  return good;
}

/** Peak speed / acceleration of a pure sine of amplitude amp (mm) and frequency f (Hz). */
export function sineDemand(amp, freq) {
  const w = 2 * Math.PI * freq;
  return { speed: amp * w, accel: amp * w * w };
}
