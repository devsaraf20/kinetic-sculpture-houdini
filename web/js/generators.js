// Generative mode: layered procedural patterns -> animation.
//
// Spatial parameters are in grid cells (1 = distance between neighbouring
// balls) so a pattern looks the same on any sculpture size; heights in mm.

import { createAnimation } from './format.js';

// ---------------------------------------------------------------- utilities

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded 3D gradient noise (Perlin "improved noise"), range ~[-1, 1]. */
export function makeNoise3(seed = 1) {
  const rnd = mulberry32(seed);
  const p = new Uint8Array(512);
  const perm = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (t, a, b) => a + t * (b - a);
  const grad = (h, x, y, z) => {
    const k = h & 15;
    const u = k < 8 ? x : y, v = k < 4 ? y : (k === 12 || k === 14 ? x : z);
    return ((k & 1) ? -u : u) + ((k & 2) ? -v : v);
  };
  return (x, y, z) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = fade(x), v = fade(y), w = fade(z);
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z, B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    return lerp(w,
      lerp(v, lerp(u, grad(p[AA], x, y, z), grad(p[BA], x - 1, y, z)),
        lerp(u, grad(p[AB], x, y - 1, z), grad(p[BB], x - 1, y - 1, z))),
      lerp(v, lerp(u, grad(p[AA + 1], x, y, z - 1), grad(p[BA + 1], x - 1, y, z - 1)),
        lerp(u, grad(p[AB + 1], x, y - 1, z - 1), grad(p[BB + 1], x - 1, y - 1, z - 1))));
  };
}

const TAU = Math.PI * 2;
const smootherstep = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (t * 6 - 15) + 10));

// ---------------------------------------------------------------- patterns
// Each pattern: params (UI description + defaults), prepare(params, info) ->
// (x, z, t) => offset in mm. x/z are cell coordinates relative to the centre.
// `demand(params)` optionally gives the analytic peak speed/accel.

const periodic = p => ({ speed: p.amplitude * TAU / p.period, accel: p.amplitude * (TAU / p.period) ** 2 });

export const PATTERNS = {
  wave: {
    label: 'Travelling wave',
    params: [
      { key: 'amplitude', label: 'Amplitude', unit: 'mm', min: 0, max: 500, step: 5, value: 150 },
      { key: 'wavelength', label: 'Wavelength', unit: 'cells', min: 1, max: 32, step: 0.5, value: 8 },
      { key: 'period', label: 'Period', unit: 's', min: 0.5, max: 30, step: 0.1, value: 6 },
      { key: 'direction', label: 'Direction', unit: '°', min: 0, max: 360, step: 5, value: 30 },
    ],
    demand: periodic,
    prepare(p) {
      const th = p.direction * Math.PI / 180, cx = Math.cos(th), cz = Math.sin(th);
      return (x, z, t) => p.amplitude * Math.sin(TAU * ((x * cx + z * cz) / p.wavelength - t / p.period));
    },
  },
  ripple: {
    label: 'Radial ripple',
    params: [
      { key: 'amplitude', label: 'Amplitude', unit: 'mm', min: 0, max: 500, step: 5, value: 150 },
      { key: 'wavelength', label: 'Wavelength', unit: 'cells', min: 1, max: 32, step: 0.5, value: 6 },
      { key: 'period', label: 'Period', unit: 's', min: 0.5, max: 30, step: 0.1, value: 5 },
      { key: 'cx', label: 'Centre X', unit: 'cells', min: -16, max: 16, step: 0.5, value: 0 },
      { key: 'cz', label: 'Centre Z', unit: 'cells', min: -16, max: 16, step: 0.5, value: 0 },
      { key: 'falloff', label: 'Falloff (0 = none)', unit: 'cells', min: 0, max: 32, step: 0.5, value: 0 },
    ],
    demand: periodic,
    prepare(p) {
      return (x, z, t) => {
        const r = Math.hypot(x - p.cx, z - p.cz);
        const fall = p.falloff > 0 ? Math.exp(-r / p.falloff) : 1;
        return p.amplitude * fall * Math.sin(TAU * (r / p.wavelength - t / p.period));
      };
    },
  },
  noise: {
    label: 'Flowing noise',
    params: [
      { key: 'amplitude', label: 'Amplitude', unit: 'mm', min: 0, max: 500, step: 5, value: 180 },
      { key: 'scale', label: 'Feature size', unit: 'cells', min: 0.5, max: 32, step: 0.5, value: 5 },
      { key: 'speed', label: 'Evolution speed', unit: '1/s', min: 0, max: 2, step: 0.01, value: 0.12 },
      { key: 'drift', label: 'Drift', unit: 'cells/s', min: 0, max: 4, step: 0.05, value: 0.3 },
      { key: 'octaves', label: 'Octaves', unit: '', min: 1, max: 4, step: 1, value: 2 },
      { key: 'seed', label: 'Seed', unit: '', min: 1, max: 999, step: 1, value: 7 },
    ],
    prepare(p) {
      const n = makeNoise3(p.seed);
      return (x, z, t) => {
        let sum = 0, amp = 1, freq = 1, norm = 0;
        for (let o = 0; o < p.octaves; o++) {
          sum += amp * n(((x - p.drift * t) / p.scale) * freq, (z / p.scale) * freq, t * p.speed * freq + o * 17.3);
          norm += amp; amp *= 0.5; freq *= 2;
        }
        return p.amplitude * 1.6 * sum / norm;
      };
    },
  },
  rain: {
    label: 'Raindrops',
    params: [
      { key: 'amplitude', label: 'Drop height', unit: 'mm', min: 0, max: 400, step: 5, value: 110 },
      { key: 'rate', label: 'Drops per second', unit: '/s', min: 0.05, max: 3, step: 0.05, value: 0.4 },
      { key: 'ringSpeed', label: 'Ring speed', unit: 'cells/s', min: 0.2, max: 10, step: 0.1, value: 1.2 },
      { key: 'width', label: 'Ring width', unit: 'cells', min: 0.5, max: 6, step: 0.1, value: 2.4 },
      { key: 'life', label: 'Fade time', unit: 's', min: 0.5, max: 10, step: 0.1, value: 3 },
      { key: 'onset', label: 'Drop onset', unit: 's', min: 0.2, max: 4, step: 0.1, value: 1.5 },
      { key: 'seed', label: 'Seed', unit: '', min: 1, max: 999, step: 1, value: 3 },
    ],
    prepare(p, info) {
      const rnd = mulberry32(p.seed);
      const drops = [];
      // Poisson arrivals over the whole duration (plus lead-in so the start is not empty).
      let t = -p.life;
      while (t < info.duration) {
        t += -Math.log(1 - rnd()) / p.rate;
        drops.push({ t, x: (rnd() - 0.5) * info.cols, z: (rnd() - 0.5) * info.rows });
      }
      return (x, z, time) => {
        let h = 0;
        for (const d of drops) {
          const age = time - d.t;
          if (age < 0 || age > p.life * 3) continue;
          const r = Math.hypot(x - d.x, z - d.z);
          const dr = (r - p.ringSpeed * age) / p.width;
          // Smooth onset so a new drop does not jerk the balls.
          const onset = smootherstep(age / p.onset);
          // Fade the tail out smoothly instead of cutting the drop off.
          const tail = 1 - smootherstep((age - 2 * p.life) / p.life);
          h += onset * tail * Math.exp(-age / p.life) * Math.exp(-dr * dr) * Math.cos(Math.PI * dr);
        }
        return p.amplitude * h;
      };
    },
  },
  breathe: {
    label: 'Breathing dome',
    params: [
      { key: 'amplitude', label: 'Amplitude', unit: 'mm', min: 0, max: 500, step: 5, value: 120 },
      { key: 'period', label: 'Period', unit: 's', min: 0.5, max: 30, step: 0.1, value: 8 },
      { key: 'dome', label: 'Dome (−1…1)', unit: '', min: -1, max: 1, step: 0.05, value: 0.6 },
    ],
    demand: periodic,
    prepare(p, info) {
      const rmax = Math.hypot(info.cols / 2, info.rows / 2) || 1;
      return (x, z, t) => {
        const r = Math.hypot(x, z) / rmax;
        return p.amplitude * Math.sin(TAU * t / p.period) * (1 - p.dome * r * r);
      };
    },
  },
  spiral: {
    label: 'Spiral',
    params: [
      { key: 'amplitude', label: 'Amplitude', unit: 'mm', min: 0, max: 500, step: 5, value: 140 },
      { key: 'arms', label: 'Arms', unit: '', min: 1, max: 6, step: 1, value: 2 },
      { key: 'twist', label: 'Twist', unit: 'turns/cell', min: -1, max: 1, step: 0.01, value: 0.12 },
      { key: 'period', label: 'Period', unit: 's', min: 0.5, max: 30, step: 0.1, value: 7 },
    ],
    demand: periodic,
    prepare(p) {
      return (x, z, t) => {
        const a = Math.atan2(z, x), r = Math.hypot(x, z);
        return p.amplitude * Math.sin(p.arms * a + TAU * (p.twist * r - t / p.period));
      };
    },
  },
};

export function defaultLayer(type) {
  const def = PATTERNS[type];
  const layer = { type, enabled: true };
  for (const pr of def.params) layer[pr.key] = pr.value;
  return layer;
}

/** Analytic peak speed/accel of a layer, or null when it has no closed form. */
export function layerDemand(layer) {
  const d = PATTERNS[layer.type]?.demand;
  return d ? d(layer) : null;
}

/**
 * Generate an animation from pattern layers.
 * @param {object} o
 * @param {number} o.rows
 * @param {number} o.cols
 * @param {number} o.fps
 * @param {number} o.duration   seconds
 * @param {number} o.base_mm    rest height the pattern oscillates around
 * @param {number} o.min_mm     travel bottom (used by fit)
 * @param {number} o.max_mm     travel top (used by fit)
 * @param {'clamp'|'scale'|'none'} o.fit
 * @param {number} o.ease       seconds of fade-in/out from/to base height
 * @param {object[]} o.layers
 */
export function generate({ rows = 8, cols = 8, fps = 30, duration = 20, spacing_mm = 100,
  base_mm = 400, min_mm = 0, max_mm = 800, fit = 'scale', ease = 2.5, layers = [] }) {
  const frameCount = Math.max(2, Math.round(duration * fps) + 1);
  const anim = createAnimation({ rows, cols, frameCount, fps, spacing_mm, source: 'generative' });
  const info = { rows, cols, duration, fps };
  const fns = layers.filter(l => l.enabled !== false && PATTERNS[l.type])
    .map(l => PATTERNS[l.type].prepare(l, info));
  const B = rows * cols;
  const off = new Float64Array(frameCount * B);
  let maxUp = 0, maxDown = 0;
  for (let f = 0; f < frameCount; f++) {
    const t = f / fps;
    const env = ease > 0 ? smootherstep(t / ease) * smootherstep((duration - t) / ease) : 1;
    for (let r = 0; r < rows; r++) {
      const z = r - (rows - 1) / 2;
      for (let c = 0; c < cols; c++) {
        const x = c - (cols - 1) / 2;
        let h = 0;
        for (const fn of fns) h += fn(x, z, t);
        h *= env;
        off[f * B + r * cols + c] = h;
        if (h > maxUp) maxUp = h;
        if (-h > maxDown) maxDown = -h;
      }
    }
  }
  let k = 1;
  if (fit === 'scale') {
    const room = Math.min(maxUp > 0 ? (max_mm - base_mm) / maxUp : Infinity,
      maxDown > 0 ? (base_mm - min_mm) / maxDown : Infinity);
    if (room < 1) k = Math.max(room, 0);
  }
  for (let i = 0; i < off.length; i++) {
    let h = base_mm + off[i] * k;
    if (fit !== 'none') h = Math.min(max_mm, Math.max(min_mm, h));
    anim.heights[i] = h;
  }
  anim.meta = { range_mm: [min_mm, max_mm], generator: { layers, base_mm, fit, ease, duration }, fitScale: k };
  return anim;
}

/** A few ready-made recipes for the UI. */
export const PRESETS = {
  'Calm ocean': [
    { ...defaultLayer('wave'), amplitude: 100, wavelength: 10, period: 8, direction: 20 },
    { ...defaultLayer('wave'), amplitude: 40, wavelength: 5, period: 5, direction: 110 },
  ],
  'Pebble in a pond': [{ ...defaultLayer('ripple'), amplitude: 150, wavelength: 6, period: 6, falloff: 9 }],
  'Rain': [{ ...defaultLayer('rain'), amplitude: 90 }],
  'Living noise': [{ ...defaultLayer('noise'), speed: 0.1, drift: 0.25 }],
  'Breathing + spiral': [
    { ...defaultLayer('breathe'), amplitude: 120 },
    { ...defaultLayer('spiral'), amplitude: 50, period: 8 },
  ],
  // Deliberately too fast: useful to see the checker and auto-smoothing at work.
  'Too fast (stress test)': [
    { ...defaultLayer('wave'), amplitude: 260, wavelength: 4, period: 1.2, direction: 45 },
    { ...defaultLayer('noise'), amplitude: 120, speed: 1.2, drift: 2 },
  ],
};
