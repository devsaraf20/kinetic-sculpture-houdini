// Physical Bridge: heights (mm) -> absolute stepper positions, split per board.
// Spec: docs/PHYSICAL_BRIDGE.md

export const BRIDGE_FORMAT = 'physical-bridge';
export const BRIDGE_VERSION = 1;

export const DEFAULT_MACHINE = Object.freeze({
  travel_mm: 800,          // distance between the fully-raised (home) and fully-lowered positions
  spool_diameter_mm: 20,   // effective diameter of the spool / pulley the string winds on
  steps_per_rev: 200,      // full steps per motor revolution (1.8° motor)
  microsteps: 4,           // driver microstepping
  motors_per_board: 8,     // how many motors each Arduino / ESP32 drives
  home: 'top',             // limit switches at the top: step 0 = fully raised
  max_step_rate: 4000,     // what one board can sustain per motor (steps/s); used for a warning
});

export function stepsPerMm(m) {
  return (m.steps_per_rev * m.microsteps) / (Math.PI * m.spool_diameter_mm);
}

/** Height in mm (0 = lowest, travel = highest) to absolute step position. */
export function heightToSteps(h, m, spm = stepsPerMm(m)) {
  const hc = Math.min(m.travel_mm, Math.max(0, h));
  return Math.round((m.home === 'bottom' ? hc : m.travel_mm - hc) * spm);
}

export function stepsToHeight(s, m, spm = stepsPerMm(m)) {
  const d = s / spm;
  return m.home === 'bottom' ? d : m.travel_mm - d;
}

/** Board layout: consecutive ball indices (row-major) in chunks of motors_per_board. */
export function boardLayout(ballCount, motorsPerBoard) {
  const boards = [];
  for (let start = 0, b = 0; start < ballCount; start += motorsPerBoard, b++) {
    const motors = [];
    for (let i = start; i < Math.min(start + motorsPerBoard, ballCount); i++) motors.push(i);
    boards.push({ board: b, motors });
  }
  return boards;
}

/**
 * Build a Physical Bridge document from an animation.
 * Heights are offset by `limits.min_mm` so the bottom of the allowed range is
 * motor height 0 (heights are expected in [min_mm, min_mm + travel]).
 */
export function buildBridge(anim, machine = DEFAULT_MACHINE, limits = null) {
  const m = { ...DEFAULT_MACHINE, ...machine };
  const spm = stepsPerMm(m);
  const base = limits ? limits.min_mm : 0;
  const B = anim.ballCount;
  const frames = [];
  let clipped = 0;
  for (let f = 0; f < anim.frameCount; f++) {
    const row = new Array(B);
    for (let b = 0; b < B; b++) {
      const h = anim.heights[f * B + b] - base;
      if (h < -1e-6 || h > m.travel_mm + 1e-6) clipped++;
      row[b] = heightToSteps(h, m, spm);
    }
    frames.push(row);
  }
  // Peak step rate (steps/s) any motor must produce.
  let peakRate = 0;
  for (let f = 1; f < frames.length; f++) {
    for (let b = 0; b < B; b++) {
      const r = Math.abs(frames[f][b] - frames[f - 1][b]) * anim.fps;
      if (r > peakRate) peakRate = r;
    }
  }
  return {
    format: BRIDGE_FORMAT,
    version: BRIDGE_VERSION,
    fps: anim.fps,
    frame_count: anim.frameCount,
    motor_count: B,
    machine: {
      travel_mm: m.travel_mm,
      steps_per_mm: +spm.toFixed(6),
      home: m.home,
      spool_diameter_mm: m.spool_diameter_mm,
      steps_per_rev: m.steps_per_rev,
      microsteps: m.microsteps,
      max_steps: heightToSteps(m.home === 'bottom' ? m.travel_mm : 0, m, spm),
    },
    ...(limits ? { limits: { ...limits } } : {}),
    stats: { peak_step_rate: peakRate, clipped_samples: clipped },
    grid: { rows: anim.rows, cols: anim.cols, spacing_mm: anim.spacing_mm },
    balls: anim.balls.map((b, i) => ({ index: i, row: b.row, col: b.col })),
    boards: boardLayout(B, m.motors_per_board),
    frames,
  };
}

export function bridgeToJSON(doc) {
  const head = JSON.stringify({ ...doc, frames: '__FRAMES__', boards: '__BOARDS__' }, null, 2);
  const frames = doc.frames.map(r => '    ' + JSON.stringify(r)).join(',\n');
  const boards = doc.boards.map(b => '    ' + JSON.stringify(b)).join(',\n');
  return head.replace('"__BOARDS__"', '[\n' + boards + '\n  ]')
    .replace('"__FRAMES__"', '[\n' + frames + '\n  ]') + '\n';
}

export function parseBridge(text) {
  const doc = JSON.parse(text);
  if (doc.format !== BRIDGE_FORMAT) throw new Error('not a Physical Bridge file');
  if (doc.version > BRIDGE_VERSION) throw new Error(`Physical Bridge v${doc.version} is newer than this tool`);
  return doc;
}

/** Frames for one board, in that board's motor order. */
export function boardFrames(doc, boardIndex) {
  const motors = doc.boards[boardIndex].motors;
  return doc.frames.map(fr => motors.map(i => fr[i]));
}

/** Wire-protocol line for one frame (see docs/PHYSICAL_BRIDGE.md). */
export function frameLine(values) {
  return 'F ' + values.join(' ') + '\n';
}
