// Height-export format: parsing, construction and serialisation.
// Heights are kept as float64 so every tool (JS and Python) rounds identically.
//
// One "animation" is a block of heights in millimetres, frame-major:
//   heights[frame * ballCount + ball]
// Height 0 = ball fully lowered, height = travel_mm = ball fully raised.
// See docs/FORMATS.md for the on-disk JSON and CSV layouts.

export const HEIGHTS_FORMAT = 'kinetic-sculpture-heights';
export const HEIGHTS_VERSION = 1;

/**
 * Create an empty animation.
 * @param {object} o
 * @param {number} o.rows
 * @param {number} o.cols
 * @param {number} o.frameCount
 * @param {number} [o.fps=30]
 */
export function createAnimation({ rows, cols, frameCount, fps = 30, spacing_mm = 100,
  frameStart = 0, source = 'web', balls = null, heights = null, meta = {} }) {
  const ballCount = balls ? balls.length : rows * cols;
  const list = balls || gridBalls(rows, cols);
  const data = heights || new Float64Array(frameCount * ballCount);
  if (data.length !== frameCount * ballCount) {
    throw new Error(`heights length ${data.length} != frames ${frameCount} x balls ${ballCount}`);
  }
  return { fps, rows, cols, frameCount, ballCount, frameStart, spacing_mm, source,
    balls: list, heights: data, meta };
}

export function gridBalls(rows, cols) {
  const out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ row: r, col: c });
  return out;
}

export function cloneAnimation(anim) {
  return { ...anim, balls: anim.balls.map(b => ({ ...b })), heights: new Float64Array(anim.heights),
    meta: { ...anim.meta } };
}

export function getSeries(anim, ball, out = null) {
  const { frameCount, ballCount, heights } = anim;
  const s = out || new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) s[f] = heights[f * ballCount + ball];
  return s;
}

export function setSeries(anim, ball, series) {
  const { frameCount, ballCount, heights } = anim;
  for (let f = 0; f < frameCount; f++) heights[f * ballCount + ball] = series[f];
}

export function heightAt(anim, frame, ball) {
  return anim.heights[frame * anim.ballCount + ball];
}

/** Parse a JSON or CSV export. `name` is only used to guess the format. */
export function parseAnimation(text, name = '') {
  const trimmed = text.trimStart();
  if (name.toLowerCase().endsWith('.json') || trimmed.startsWith('{')) {
    return parseJSON(JSON.parse(text));
  }
  return parseCSV(text);
}

export function parseJSON(doc) {
  if (doc.format === 'physical-bridge') {
    throw new Error('This is a Physical Bridge (motor steps) file, not a height export.');
  }
  if (doc.format && doc.format !== HEIGHTS_FORMAT) {
    throw new Error(`Unknown format "${doc.format}"`);
  }
  if (!Array.isArray(doc.frames) || doc.frames.length === 0) throw new Error('JSON has no "frames" array');
  const grid = doc.grid || {};
  const ballsIn = Array.isArray(doc.balls) ? doc.balls : null;
  const ballCount = ballsIn ? ballsIn.length : doc.frames[0].length;
  let rows = grid.rows, cols = grid.cols;
  if (!rows || !cols) ({ rows, cols } = guessGrid(ballCount));
  const balls = ballsIn
    ? ballsIn.map((b, i) => ({ row: b.row ?? Math.floor(i / cols), col: b.col ?? i % cols,
      ...(b.name ? { name: b.name } : {}) }))
    : gridBalls(rows, cols);
  const frameCount = doc.frames.length;
  const heights = new Float64Array(frameCount * ballCount);
  doc.frames.forEach((fr, f) => {
    if (fr.length !== ballCount) throw new Error(`frame ${f} has ${fr.length} values, expected ${ballCount}`);
    for (let b = 0; b < ballCount; b++) heights[f * ballCount + b] = +fr[b];
  });
  return createAnimation({
    rows, cols, frameCount, balls, heights,
    fps: +doc.fps || 30,
    spacing_mm: +(grid.spacing_mm ?? 100),
    frameStart: +(doc.frame_start ?? 0),
    source: doc.source || 'json',
    meta: { range_mm: doc.range_mm || null, units: doc.units || 'mm' },
  });
}

/**
 * Wide CSV: optional "# key=value" comment lines, a header
 * "frame,time_s,r0c0,r0c1,..." then one row per frame.
 */
export function parseCSV(text) {
  const meta = {};
  const lines = text.split(/\r?\n/);
  const rowsOut = [];
  let header = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const m = line.slice(1).trim().match(/^([\w.]+)\s*[=:]\s*(.*)$/);
      if (m) meta[m[1]] = m[2].trim();
      continue;
    }
    const cells = line.split(',').map(s => s.trim());
    if (!header) { header = cells; continue; }
    rowsOut.push(cells);
  }
  if (!header) throw new Error('CSV has no header row');
  // Find ball columns: everything except frame/time columns.
  const skip = new Set(['frame', 'time', 'time_s', 't']);
  const ballCols = [];
  header.forEach((h, i) => { if (!skip.has(h.toLowerCase())) ballCols.push(i); });
  const ballCount = ballCols.length;
  if (ballCount === 0) throw new Error('CSV has no ball columns');
  const balls = ballCols.map((i, k) => {
    const m = header[i].match(/^r(\d+)c(\d+)$/i);
    return m ? { row: +m[1], col: +m[2] } : { row: -1, col: -1, name: header[i], _k: k };
  });
  let rows = +meta.rows || 0, cols = +meta.cols || 0;
  if (balls.every(b => b.row >= 0)) {
    rows = rows || Math.max(...balls.map(b => b.row)) + 1;
    cols = cols || Math.max(...balls.map(b => b.col)) + 1;
  } else {
    if (!rows || !cols) ({ rows, cols } = guessGrid(ballCount));
    balls.forEach((b, k) => { b.row = Math.floor(k / cols); b.col = k % cols; delete b._k; });
  }
  const frameCount = rowsOut.length;
  const heights = new Float64Array(frameCount * ballCount);
  const frameIdx = header.findIndex(h => h.toLowerCase() === 'frame');
  rowsOut.forEach((cells, f) => {
    ballCols.forEach((ci, b) => {
      const v = parseFloat(cells[ci]);
      if (!Number.isFinite(v)) throw new Error(`CSV row ${f + 1}, column "${header[ci]}" is not a number`);
      heights[f * ballCount + b] = v;
    });
  });
  const frameStart = frameIdx >= 0 && rowsOut.length ? +rowsOut[0][frameIdx] || 0 : 0;
  return createAnimation({
    rows, cols, frameCount, balls, heights, frameStart,
    fps: +meta.fps || 30,
    spacing_mm: +(meta.spacing_mm ?? 100),
    source: meta.source || 'csv',
    meta: { range_mm: meta.range_mm ? meta.range_mm.split(/[ ,;]+/).map(Number) : null, units: meta.units || 'mm' },
  });
}

export function guessGrid(n) {
  let r = Math.floor(Math.sqrt(n));
  while (r > 1 && n % r !== 0) r--;
  return { rows: r, cols: n / r };
}

const round3 = v => Math.round(v * 1000) / 1000;

export function toJSON(anim, extra = {}) {
  const frames = [];
  for (let f = 0; f < anim.frameCount; f++) {
    const row = new Array(anim.ballCount);
    for (let b = 0; b < anim.ballCount; b++) row[b] = round3(anim.heights[f * anim.ballCount + b]);
    frames.push(row);
  }
  const doc = {
    format: HEIGHTS_FORMAT,
    version: HEIGHTS_VERSION,
    source: anim.source,
    units: 'mm',
    fps: anim.fps,
    frame_start: anim.frameStart,
    frame_count: anim.frameCount,
    grid: { rows: anim.rows, cols: anim.cols, spacing_mm: anim.spacing_mm },
    ...(anim.meta?.range_mm ? { range_mm: anim.meta.range_mm } : {}),
    ...extra,
    balls: anim.balls.map((b, i) => ({ index: i, row: b.row, col: b.col, ...(b.name ? { name: b.name } : {}) })),
    frames,
  };
  // Keep one frame per line: readable diffs, still valid JSON.
  const head = JSON.stringify({ ...doc, grid: '__GRID__', balls: '__BALLS__', frames: '__FRAMES__' }, null, 2);
  const lines = arr => '[\n' + arr.map(r => '    ' + JSON.stringify(r)).join(',\n') + '\n  ]';
  return head.replace('"__GRID__"', JSON.stringify(doc.grid))
    .replace('"__BALLS__"', lines(doc.balls))
    .replace('"__FRAMES__"', lines(frames)) + '\n';
}

export function toCSV(anim) {
  const out = [
    `# format=${HEIGHTS_FORMAT}`,
    `# version=${HEIGHTS_VERSION}`,
    `# fps=${anim.fps}`,
    `# rows=${anim.rows}`,
    `# cols=${anim.cols}`,
    `# spacing_mm=${anim.spacing_mm}`,
    `# units=mm`,
    `# source=${anim.source}`,
  ];
  if (anim.meta?.range_mm) out.push(`# range_mm=${anim.meta.range_mm.join(',')}`);
  out.push(['frame', 'time_s', ...anim.balls.map(b => `r${b.row}c${b.col}`)].join(','));
  for (let f = 0; f < anim.frameCount; f++) {
    const cells = [anim.frameStart + f, (f / anim.fps).toFixed(4)];
    for (let b = 0; b < anim.ballCount; b++) cells.push(round3(anim.heights[f * anim.ballCount + b]));
    out.push(cells.join(','));
  }
  return out.join('\n') + '\n';
}

/** Resample in time by `factor` (>1 = slower / longer). Cubic Hermite (Catmull-Rom). */
export function retime(anim, factor) {
  if (!(factor > 0)) throw new Error('retime factor must be > 0');
  const n = anim.frameCount;
  const m = Math.max(2, Math.round((n - 1) * factor) + 1);
  const out = createAnimation({ ...anim, frameCount: m, heights: new Float64Array(m * anim.ballCount),
    balls: anim.balls.map(b => ({ ...b })), meta: { ...anim.meta } });
  const s = new Float64Array(n);
  for (let b = 0; b < anim.ballCount; b++) {
    getSeries(anim, b, s);
    for (let j = 0; j < m; j++) {
      const t = (j * (n - 1)) / (m - 1);
      const i = Math.min(Math.floor(t), n - 2);
      const u = t - i;
      const p0 = s[Math.max(i - 1, 0)], p1 = s[i], p2 = s[i + 1], p3 = s[Math.min(i + 2, n - 1)];
      const u2 = u * u, u3 = u2 * u;
      out.heights[j * anim.ballCount + b] = 0.5 * ((2 * p1) + (-p0 + p2) * u
        + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
    }
  }
  return out;
}
