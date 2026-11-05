// 2D canvas charts: violation timeline and the selected-ball motion graph.

import { FLAG_RANGE, FLAG_SPEED, FLAG_ACCEL } from './limits.js';

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

const flagColor = fl => (fl & FLAG_RANGE ? css('--c-range') : fl & FLAG_SPEED ? css('--c-speed') : css('--c-accel'));

/**
 * Timeline strip: one column per frame. Height of the bar = worst ratio to a
 * limit across all balls (capped at 2x); red tint where any ball breaks a limit.
 * Bottom lane marks frames changed by smoothing.
 */
export function drawTimeline(canvas, analysis, frame, changed = null) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!analysis) return;
  const N = analysis.frameFlags.length;
  const lane = changed ? 5 : 0;
  const ch = h - lane - 2;
  const fx = f => (f / Math.max(N - 1, 1)) * (w - 1);
  // Violation background bands.
  for (const s of analysis.spans) {
    ctx.fillStyle = flagColor(s.flags);
    ctx.globalAlpha = 0.18;
    ctx.fillRect(fx(s.start) - 1, 0, Math.max(2, fx(s.end) - fx(s.start) + 2), ch);
  }
  ctx.globalAlpha = 1;
  // Severity curve as columns (aggregate if more frames than pixels).
  const cols = Math.min(N, Math.floor(w));
  const limitY = ch - ch / 2;
  for (let c = 0; c < cols; c++) {
    const f0 = Math.floor((c * N) / cols), f1 = Math.max(f0 + 1, Math.floor(((c + 1) * N) / cols));
    let sev = 0, fl = 0;
    for (let f = f0; f < f1; f++) { sev = Math.max(sev, analysis.frameSeverity[f]); fl |= analysis.frameFlags[f]; }
    const bh = (Math.min(sev, 2) / 2) * ch;
    ctx.fillStyle = fl ? flagColor(fl) : css('--c-ok');
    ctx.globalAlpha = fl ? 0.95 : 0.55;
    const x = (c / cols) * w;
    ctx.fillRect(x, ch - bh, Math.max(1, w / cols - (cols > 200 ? 0 : 1)), bh);
  }
  ctx.globalAlpha = 1;
  // 100% limit line.
  ctx.strokeStyle = css('--muted');
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(0, limitY + 0.5); ctx.lineTo(w, limitY + 0.5); ctx.stroke();
  ctx.setLineDash([]);
  if (changed) {
    ctx.fillStyle = css('--accent');
    for (let f = 0; f < N; f++) if (changed[f]) ctx.fillRect(fx(f), h - lane, Math.max(1, w / N), lane);
  }
  // Playhead.
  ctx.fillStyle = css('--text');
  ctx.fillRect(Math.round(fx(frame)) - 1, 0, 2, h);
}

/**
 * Three stacked plots for one ball: height, velocity, acceleration, with the
 * limits drawn as dashed lines. `orig` (optional) is drawn faintly underneath.
 */
export function drawBallChart(canvas, { series, kin, orig = null, origKin = null, limits, fps, frame, flags }) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!series) return;
  const N = series.length;
  const padL = 46, padR = 8, gap = 6;
  const ph = (h - gap * 2) / 3;
  const fx = f => padL + (f / Math.max(N - 1, 1)) * (w - padL - padR);
  const panels = [
    { name: 'height mm', data: series, od: orig, lo: limits.min_mm, hi: limits.max_mm,
      min: Math.min(limits.min_mm, ...minmax(series, orig)[0]), max: Math.max(limits.max_mm, ...minmax(series, orig)[1]) },
    { name: 'speed mm/s', data: kin.vel, od: origKin?.vel, lo: -limits.max_speed, hi: limits.max_speed, sym: true },
    { name: 'accel mm/s²', data: kin.acc, od: origKin?.acc, lo: -limits.max_accel, hi: limits.max_accel, sym: true },
  ];
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  panels.forEach((p, k) => {
    const top = k * (ph + gap);
    if (p.sym) {
      let m = p.hi * 1.15;
      for (const v of p.data) m = Math.max(m, Math.abs(v));
      if (p.od) for (const v of p.od) m = Math.max(m, Math.abs(v));
      p.min = -m; p.max = m;
    }
    const fy = v => top + ph - ((v - p.min) / (p.max - p.min || 1)) * ph;
    ctx.fillStyle = css('--panel-2');
    ctx.fillRect(padL, top, w - padL - padR, ph);
    // Violation shading.
    if (flags) {
      const bit = k === 0 ? FLAG_RANGE : k === 1 ? FLAG_SPEED : FLAG_ACCEL;
      ctx.fillStyle = k === 0 ? css('--c-range') : k === 1 ? css('--c-speed') : css('--c-accel');
      ctx.globalAlpha = 0.22;
      for (let f = 0; f < N; f++) if (flags[f] & bit) ctx.fillRect(fx(f) - 1, top, Math.max(2, (w - padL) / N), ph);
      ctx.globalAlpha = 1;
    }
    // Limits.
    ctx.strokeStyle = css('--muted');
    ctx.setLineDash([4, 3]);
    for (const v of [p.lo, p.hi]) { ctx.beginPath(); ctx.moveTo(padL, fy(v) + 0.5); ctx.lineTo(w - padR, fy(v) + 0.5); ctx.stroke(); }
    ctx.setLineDash([]);
    const line = (d, color, width, alpha) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha = alpha;
      ctx.beginPath();
      for (let f = 0; f < N; f++) { const x = fx(f), y = fy(d[f]); f ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke(); ctx.globalAlpha = 1; ctx.lineWidth = 1;
    };
    if (p.od) line(p.od, css('--muted'), 1, 0.8);
    line(p.data, css('--accent'), 1.5, 1);
    ctx.fillStyle = css('--muted');
    ctx.textAlign = 'right';
    ctx.fillText(fmt(p.max), padL - 4, top + 9);
    ctx.fillText(fmt(p.min), padL - 4, top + ph - 1);
    ctx.textAlign = 'left';
    ctx.fillText(p.name, padL + 4, top + 11);
  });
  ctx.fillStyle = css('--text');
  ctx.fillRect(Math.round(fx(frame)) - 0.5, 0, 1, h);
}

function minmax(a, b) {
  let lo = Infinity, hi = -Infinity;
  for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (b) for (const v of b) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return [[lo], [hi]];
}

const fmt = v => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v).toString());
