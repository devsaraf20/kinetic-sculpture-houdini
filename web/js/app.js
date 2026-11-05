// UI glue: load / generate -> check -> smooth -> play -> export / stream.

import { parseAnimation, toJSON, toCSV, getSeries, retime } from './format.js';
import { analyze, smoothAnimation, kinematics, DEFAULT_LIMITS, describeFlags, FLAG_RANGE, FLAG_SPEED, FLAG_ACCEL } from './limits.js';
import { PATTERNS, PRESETS, defaultLayer, generate, layerDemand } from './generators.js';
import { DEFAULT_MACHINE, buildBridge, bridgeToJSON, stepsPerMm } from './bridge.js';
import { BoardClient, ShowPlayer, WebSerialTransport } from './serial.js';
import { SculptureView } from './sim.js';
import { drawTimeline, drawBallChart } from './charts.js';

const $ = id => document.getElementById(id);
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }) : '–');

const state = {
  loaded: null,       // as loaded / generated (for Revert)
  original: null,     // working animation (may be retimed)
  smoothed: null,
  view: 'original',
  analysis: null,     // of the animation on screen
  origAnalysis: null,
  changedFrames: null,
  limits: { ...DEFAULT_LIMITS },
  machine: { ...DEFAULT_MACHINE },
  frame: 0, frameTime: 0, playing: true, speed: 1,
  selected: -1,
  gen: { rows: 8, cols: 8, duration: 20, fps: 30, base_mm: 400, ease: 2.5, spacing_mm: 100, fit: 'scale', layers: [] },
  boards: [], player: null,
};

const shown = () => (state.view === 'smoothed' && state.smoothed ? state.smoothed : state.original);

// ------------------------------------------------------------------ viewport
const view = new SculptureView($('viewport'));
view.onPick = i => { state.selected = i; view.select(i); renderBall(); };

// ------------------------------------------------------------------ tabs
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === b.dataset.tab));
}));

// ------------------------------------------------------------------ loading
function setAnimation(anim, { keepLoaded = false } = {}) {
  if (!keepLoaded) state.loaded = anim;
  state.original = anim;
  state.smoothed = null;
  state.changedFrames = null;
  state.view = 'original';
  if (anim.meta?.range_mm && !keepLoaded && anim.source !== 'generative') {
    // An export that declares its travel range: adopt it as the limit.
    const [lo, hi] = anim.meta.range_mm;
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) { state.limits.min_mm = lo; state.limits.max_mm = hi; writeLimits(); }
  }
  state.frame = Math.min(state.frame, anim.frameCount - 1);
  state.frameTime = state.frame;
  if (state.selected >= anim.ballCount) state.selected = -1;
  rebuildView();
  reanalyze();
  $('empty').hidden = true;
  $('scrub').max = anim.frameCount - 1;
}

function rebuildView() {
  const a = shown();
  if (!a) return;
  view.build({ rows: a.rows, cols: a.cols, spacing_mm: a.spacing_mm, balls: a.balls,
    minMM: state.limits.min_mm, maxMM: state.limits.max_mm });
  view.select(state.selected);
}

async function loadFile(file) {
  try {
    const anim = parseAnimation(await file.text(), file.name);
    anim.meta.name = file.name;
    setAnimation(anim);
    log(`Loaded ${file.name}`);
  } catch (e) {
    alert(`Could not read ${file.name}:\n${e.message}`);
  }
}

$('file').addEventListener('change', e => e.target.files[0] && loadFile(e.target.files[0]));
const drop = $('drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => e.dataTransfer.files[0] && loadFile(e.dataTransfer.files[0]));
document.body.addEventListener('dragover', e => e.preventDefault());
document.body.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });

function demo(name) {
  const layers = PRESETS[name].map(l => ({ ...l }));
  const anim = generate({ ...state.gen, layers, min_mm: state.limits.min_mm, max_mm: state.limits.max_mm });
  anim.meta.name = name;
  setAnimation(anim);
}
$('demo-ok').addEventListener('click', () => demo('Calm ocean'));
$('demo-bad').addEventListener('click', () => demo('Too fast (stress test)'));

// ------------------------------------------------------------------ analysis
function reanalyze() {
  if (!state.original) return;
  state.origAnalysis = analyze(state.original, state.limits);
  state.analysis = state.view === 'smoothed' && state.smoothed ? analyze(state.smoothed, state.limits) : state.origAnalysis;
  view.colorRange = [state.analysis.peak.min, state.analysis.peak.max];
  renderAnalysis();
  renderFacts();
  renderBridgeFacts();
  renderBoards();
  renderBall();
}

function renderFacts() {
  const a = state.original;
  if (!a) { $('facts').innerHTML = ''; return; }
  const rows = [
    ['Name', a.meta?.name || a.source],
    ['Grid', `${a.rows} × ${a.cols} (${a.ballCount} balls)`],
    ['Frames', `${a.frameCount} @ ${a.fps} fps`],
    ['Duration', `${fmt((a.frameCount - 1) / a.fps, 2)} s`],
    ['Height range', `${fmt(state.origAnalysis.peak.min)} – ${fmt(state.origAnalysis.peak.max)} mm`],
    ['Source', a.source],
  ];
  $('facts').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
}

function meter(label, value, limit, unit) {
  const pct = Math.min(value / limit, 2) / 2 * 100;
  const bad = value > limit * 1.0001;
  return `<div class="meter ${bad ? 'bad' : ''}"><div class="lbl"><span>${label}</span><b>${fmt(value)} / ${fmt(limit)} ${unit}</b></div>
    <div class="bar"><i style="width:${pct}%"></i><s style="left:50%"></s></div></div>`;
}

function renderAnalysis() {
  const an = state.analysis;
  const pill = $('status');
  if (!an) { pill.textContent = 'No animation loaded'; pill.className = 'pill'; return; }
  const L = state.limits;
  const travelExcess = Math.max(0, an.peak.max - L.max_mm, L.min_mm - an.peak.min);
  $('meters').innerHTML =
    meter('Peak speed', an.peak.speed, L.max_speed, 'mm/s') +
    meter('Peak acceleration', an.peak.accel, L.max_accel, 'mm/s²') +
    `<div class="meter ${travelExcess > 0 ? 'bad' : ''}"><div class="lbl"><span>Height range</span><b>${fmt(an.peak.min)} … ${fmt(an.peak.max)} mm</b></div>
      <div class="bar"><i style="left:${clampPct((an.peak.min - L.min_mm) / (L.max_mm - L.min_mm))}%;width:${clampPct((an.peak.max - an.peak.min) / (L.max_mm - L.min_mm))}%"></i></div></div>`;
  const label = state.view === 'smoothed' && state.smoothed ? 'Smoothed' : 'Original';
  if (an.ok) {
    $('summary').innerHTML = `<b>${label}: all ${shown().frameCount} frames are within limits.</b>`;
    pill.textContent = `${label}: within limits`; pill.className = 'pill ok';
  } else {
    const c = an.counts;
    $('summary').innerHTML = `<b>${label}: ${an.badFrames} of ${shown().frameCount} frames</b> break a limit
      (${an.badBalls} balls). Ball-frames: speed ${c.speed}, accel ${c.accel}, range ${c.range}.
      Retiming alone would need ×${fmt(an.slowdown, 2)} slower${c.range ? ' and would not fix the range' : ''}.`;
    pill.textContent = `${label}: ${an.badFrames} frames break limits`; pill.className = 'pill bad';
  }
  const fps = shown().fps;
  $('spans').innerHTML = an.spans.slice(0, 200).map(s => {
    const tags = [FLAG_RANGE, FLAG_SPEED, FLAG_ACCEL].filter(f => s.flags & f).map(f => `<span class="tag ${describeFlags(f)}">${describeFlags(f)}</span>`).join(' ');
    const fr = s.start === s.end ? `frame ${s.start}` : `frames ${s.start}–${s.end}`;
    return `<li data-f="${s.start}"><span>${fr} <span class="hint">${fmt(s.start / fps, 2)} s</span></span><span>${tags} <span class="hint">${fmt(s.worst, 1)}×</span></span></li>`;
  }).join('') + (an.spans.length > 200 ? `<li>… ${an.spans.length - 200} more</li>` : '');
  $('retime').textContent = `Slow down ×${fmt(state.origAnalysis.slowdown, 2)}`;
  $('retime').disabled = state.origAnalysis.slowdown <= 1.0001;
  $('view-smooth').disabled = !state.smoothed;
  $('view-orig').classList.toggle('active', state.view === 'original');
  $('view-smooth').classList.toggle('active', state.view === 'smoothed');
  $('revert').disabled = state.original === state.loaded && !state.smoothed;
}
const clampPct = v => Math.max(0, Math.min(100, v * 100));

$('spans').addEventListener('click', e => {
  const li = e.target.closest('li[data-f]');
  if (li) seek(+li.dataset.f);
});

// ------------------------------------------------------------------ limits
const limitInputs = { 'lim-min': 'min_mm', 'lim-max': 'max_mm', 'lim-speed': 'max_speed', 'lim-accel': 'max_accel' };
function writeLimits() {
  for (const [id, k] of Object.entries(limitInputs)) $(id).value = state.limits[k];
  $('lim-rest').checked = state.limits.boundary === 'rest';
}
for (const [id, k] of Object.entries(limitInputs)) {
  $(id).addEventListener('change', () => {
    const v = parseFloat($(id).value);
    if (Number.isFinite(v)) state.limits[k] = v;
    if (state.limits.max_mm <= state.limits.min_mm) state.limits.max_mm = state.limits.min_mm + 1;
    state.machine.travel_mm = state.limits.max_mm - state.limits.min_mm;
    writeLimits();
    persist();
    if (k === 'min_mm' || k === 'max_mm') rebuildView();
    reanalyze();
    if (state.smoothed) $('smooth-report').textContent = 'Limits changed since smoothing; run Auto-smooth again.';
  });
}
$('lim-rest').addEventListener('change', () => { state.limits.boundary = $('lim-rest').checked ? 'rest' : 'free'; persist(); reanalyze(); });

// ------------------------------------------------------------------ smoothing
$('smooth').addEventListener('click', async () => {
  if (!state.original) return;
  const btn = $('smooth'), bar = $('smooth-progress');
  btn.disabled = true; bar.hidden = false;
  const t0 = performance.now();
  const { anim, report } = await smoothAnimation(state.original, state.limits, {
    yieldMs: 60,
    onProgress: (d, n) => { bar.firstElementChild.style.width = `${(100 * d) / n}%`; },
  });
  btn.disabled = false; bar.hidden = true;
  state.smoothed = anim;
  state.view = 'smoothed';
  const N = anim.frameCount, B = anim.ballCount;
  state.changedFrames = new Uint8Array(N);
  for (let f = 0; f < N; f++) for (let b = 0; b < B; b++) {
    if (Math.abs(anim.heights[f * B + b] - state.original.heights[f * B + b]) > 0.05) { state.changedFrames[f] = 1; break; }
  }
  $('smooth-report').textContent = report.ballsChanged
    ? `Adjusted ${report.ballsChanged} of ${B} balls over ${report.framesChanged} frames; largest change ${fmt(report.maxDeviation, 1)} mm (${fmt((performance.now() - t0) / 1000, 1)} s). Blue ticks under the timeline mark changed frames.`
    : 'Nothing to fix: every ball is already within limits.';
  reanalyze();
});

$('retime').addEventListener('click', () => {
  const k = Math.ceil(state.origAnalysis.slowdown * 1.02 * 100) / 100;
  const r = retime(state.original, k);
  r.source = state.original.source + `+retime${k}`;
  r.meta = { ...state.original.meta, name: (state.original.meta?.name || '') + ` ×${k}` };
  setAnimation(r, { keepLoaded: true });
});
$('revert').addEventListener('click', () => { if (state.loaded) setAnimation(state.loaded, { keepLoaded: true }); });
$('view-orig').addEventListener('click', () => { state.view = 'original'; reanalyze(); });
$('view-smooth').addEventListener('click', () => { if (state.smoothed) { state.view = 'smoothed'; reanalyze(); } });

// ------------------------------------------------------------------ playback
$('play').addEventListener('click', () => { state.playing = !state.playing; $('play').textContent = state.playing ? '❚❚' : '▶'; });
$('play').textContent = '❚❚';
$('scrub').addEventListener('input', e => { seek(+e.target.value); });
$('speed').addEventListener('change', e => { state.speed = +e.target.value; });
$('color-height').addEventListener('change', e => { view.colorMode = e.target.checked ? 'height' : 'plain'; });
function seek(f) { state.frame = f; state.frameTime = f; }

const tl = $('timeline');
let scrubbing = false;
const tlSeek = e => {
  const a = shown(); if (!a) return;
  const r = tl.getBoundingClientRect();
  seek(Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (a.frameCount - 1)));
};
tl.addEventListener('pointerdown', e => { scrubbing = true; tl.setPointerCapture(e.pointerId); tlSeek(e); });
tl.addEventListener('pointermove', e => scrubbing && tlSeek(e));
tl.addEventListener('pointerup', () => { scrubbing = false; });
document.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea')) return;
  const a = shown(); if (!a) return;
  if (e.key === ' ') { e.preventDefault(); $('play').click(); }
  if (e.key === 'ArrowRight') seek(Math.min(a.frameCount - 1, state.frame + (e.shiftKey ? 10 : 1)));
  if (e.key === 'ArrowLeft') seek(Math.max(0, state.frame - (e.shiftKey ? 10 : 1)));
});

$('ball-close').addEventListener('click', () => { state.selected = -1; view.select(-1); renderBall(); });

function renderBall() {
  const a = shown();
  const panel = $('ball-panel');
  if (!a || state.selected < 0) { panel.hidden = true; return; }
  panel.hidden = false;
  const b = state.selected, bl = a.balls[b];
  const series = getSeries(a, b);
  const kin = kinematics(series, a.fps, state.limits.boundary);
  let orig = null, origKin = null;
  if (a === state.smoothed) { orig = getSeries(state.original, b); origKin = kinematics(orig, a.fps, state.limits.boundary); }
  const flags = new Uint8Array(a.frameCount);
  for (let f = 0; f < a.frameCount; f++) flags[f] = state.analysis.flags[f * a.ballCount + b];
  $('ball-title').textContent = `Ball r${bl.row} c${bl.col} · ${fmt(series[state.frame], 1)} mm · ${fmt(kin.vel[state.frame])} mm/s`;
  drawBallChart($('ball-chart'), { series, kin, orig, origKin, limits: state.limits, fps: a.fps, frame: state.frame, flags });
}

let last = performance.now();
let lastDrawnFrame = -1;
function tick(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const a = shown();
  if (a) {
    if (state.playing) {
      state.frameTime += dt * a.fps * state.speed;
      if (state.frameTime > a.frameCount - 1) state.frameTime = 0;
      state.frame = Math.floor(state.frameTime);
    }
    const f = Math.min(state.frame, a.frameCount - 1);
    const u = state.playing ? state.frameTime - f : 0;
    const B = a.ballCount, f2 = Math.min(f + 1, a.frameCount - 1);
    const h = new Float32Array(B);
    for (let i = 0; i < B; i++) h[i] = a.heights[f * B + i] * (1 - u) + a.heights[f2 * B + i] * u;
    const flags = state.analysis.flags.subarray(f * B, (f + 1) * B);
    let ghost = null;
    if (a === state.smoothed && $('ghost').checked) ghost = state.original.heights.subarray(f * B, (f + 1) * B);
    view.update(h, flags, ghost);
    if (f !== lastDrawnFrame) {
      $('scrub').value = f;
      $('time').textContent = `${f} / ${a.frameCount - 1} · ${fmt(f / a.fps, 2)} s`;
      drawTimeline(tl, state.analysis, f, a === state.smoothed ? state.changedFrames : null);
      renderBall();
      lastDrawnFrame = f;
    }
  }
  view.render();
  requestAnimationFrame(tick);
}
new ResizeObserver(() => { lastDrawnFrame = -1; }).observe(tl);

// ------------------------------------------------------------------ export
function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const baseName = () => (shown()?.meta?.name || 'sculpture').replace(/\.(json|csv)$/i, '').replace(/[^\w.-]+/g, '_') + (state.view === 'smoothed' && state.smoothed ? '_smoothed' : '');
$('export-json').addEventListener('click', () => shown() && download(`${baseName()}.json`,
  toJSON(shown(), { range_mm: [state.limits.min_mm, state.limits.max_mm] })));
$('export-csv').addEventListener('click', () => shown() && download(`${baseName()}.csv`, toCSV(shown()), 'text/csv'));

// ------------------------------------------------------------------ machine / bridge
const machineInputs = { 'm-spool': 'spool_diameter_mm', 'm-steps': 'steps_per_rev', 'm-micro': 'microsteps', 'm-per-board': 'motors_per_board', 'm-rate': 'max_step_rate', 'm-home': 'home' };
function writeMachine() { for (const [id, k] of Object.entries(machineInputs)) $(id).value = state.machine[k]; }
for (const [id, k] of Object.entries(machineInputs)) {
  $(id).addEventListener('change', () => {
    const raw = $(id).value;
    state.machine[k] = k === 'home' ? raw : Math.max(1, parseFloat(raw) || state.machine[k]);
    persist(); renderBridgeFacts(); renderBoards();
  });
}

function renderBridgeFacts() {
  const m = { ...state.machine, travel_mm: state.limits.max_mm - state.limits.min_mm };
  const spm = stepsPerMm(m);
  const a = shown();
  const needRate = state.limits.max_speed * spm;
  const rows = [
    ['Steps per mm', fmt(spm, 3)],
    ['Full travel', `${fmt(m.travel_mm * spm)} steps`],
    ['Steps/s at max speed', `<span class="${needRate > m.max_step_rate ? 'bad' : ''}">${fmt(needRate)}</span>`],
    ['Resolution', `${fmt(1000 / spm / 1000, 3)} mm/step`],
  ];
  if (a) {
    const boards = Math.ceil(a.ballCount / m.motors_per_board);
    rows.push(['Boards needed', `${boards} × ${m.motors_per_board} motors`]);
    const peakRate = state.analysis.peak.speed * spm;
    rows.push(['Peak steps/s in show', `<span class="${peakRate > m.max_step_rate ? 'bad' : ''}">${fmt(peakRate)}</span>`]);
  }
  $('bridge-facts').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

function currentBridge() {
  const a = shown();
  const m = { ...state.machine, travel_mm: state.limits.max_mm - state.limits.min_mm };
  return buildBridge(a, m, state.limits);
}

$('export-bridge').addEventListener('click', () => {
  const a = shown(); if (!a) return;
  if (!state.analysis.ok && !confirm(`This animation still breaks limits on ${state.analysis.badFrames} frames. Export anyway?\n(Use Limits → Auto-smooth first.)`)) return;
  download(`${baseName()}.pbridge.json`, bridgeToJSON(currentBridge()));
});

// Web Serial
function hwLog(msg) { const el = $('hw-log'); el.textContent += msg + '\n'; el.scrollTop = el.scrollHeight; }
function log(msg) { hwLog(msg); }
function renderBoards() {
  const a = shown();
  const need = a ? Math.ceil(a.ballCount / state.machine.motors_per_board) : 0;
  $('boards').innerHTML = state.boards.map((b, i) => `<div class="board"><span>Board ${i} ${b.client.info ? `· ${b.client.info.motors} motors` : ''}</span><button data-rm="${i}" class="ghost">Disconnect</button></div>`).join('')
    + `<p class="hint">${state.boards.length} of ${need || '?'} board(s) connected. Board <i>n</i> drives balls ${state.machine.motors_per_board}·n … ${state.machine.motors_per_board}·n+${state.machine.motors_per_board - 1} (row-major).</p>`;
}
$('boards').addEventListener('click', async e => {
  const i = e.target.dataset.rm; if (i === undefined) return;
  const [b] = state.boards.splice(+i, 1);
  await b.transport.close(); renderBoards();
});
$('connect').addEventListener('click', async () => {
  if (!WebSerialTransport.supported()) { hwLog('Web Serial is not available in this browser. Use Chrome/Edge, or tools/pbridge.py stream.'); return; }
  try {
    const transport = await WebSerialTransport.request(115200);
    const client = new BoardClient(transport, { name: `board${state.boards.length}`, log: hwLog });
    transport.onLine = l => client.handleLine(l);
    state.boards.push({ transport, client });
    const info = await client.hello();
    hwLog(`Connected board id ${info.board}: ${info.motors} motors, buffer ${info.capacity} frames`);
  } catch (e) { hwLog(e.message); }
  renderBoards();
});
$('hw-play').addEventListener('click', async () => {
  if (!shown() || !state.boards.length) { hwLog('Load an animation and connect board(s) first.'); return; }
  if (!state.analysis.ok) { hwLog('Refusing to play: the animation breaks limits. Auto-smooth it first.'); return; }
  const doc = currentBridge();
  state.player = new ShowPlayer(state.boards.map(b => b.client), doc, {
    home: $('hw-home').checked, loop: $('hw-loop').checked, log: hwLog,
    onProgress: f => { if (!state.playing) seek(f % doc.frame_count); },
  });
  try { await state.player.run(); } catch (e) { hwLog('Error: ' + e.message); }
});
$('hw-stop').addEventListener('click', () => state.player?.stop());

// ------------------------------------------------------------------ generate
const presetSel = $('gen-preset');
presetSel.innerHTML = '<option value="">— custom —</option>' + Object.keys(PRESETS).map(k => `<option>${k}</option>`).join('');
$('add-layer-type').innerHTML = Object.entries(PATTERNS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
const genInputs = { 'gen-rows': 'rows', 'gen-cols': 'cols', 'gen-duration': 'duration', 'gen-fps': 'fps', 'gen-base': 'base_mm', 'gen-ease': 'ease', 'gen-spacing': 'spacing_mm', 'gen-fit': 'fit' };
for (const [id, k] of Object.entries(genInputs)) {
  $(id).value = state.gen[k];
  $(id).addEventListener('change', () => { state.gen[k] = k === 'fit' ? $(id).value : +$(id).value; liveGenerate(); });
}
presetSel.addEventListener('change', () => {
  if (!presetSel.value) return;
  state.gen.layers = PRESETS[presetSel.value].map(l => ({ ...l }));
  renderLayers(); runGenerate();
});
$('add-layer').addEventListener('click', () => {
  state.gen.layers.push(defaultLayer($('add-layer-type').value));
  presetSel.value = ''; renderLayers(); liveGenerate();
});
$('gen-run').addEventListener('click', runGenerate);

function renderLayers() {
  const host = $('layers');
  host.innerHTML = '';
  state.gen.layers.forEach((layer, li) => {
    const def = PATTERNS[layer.type];
    const el = document.createElement('div');
    el.className = 'layer';
    el.innerHTML = `<div class="layer-head"><input type="checkbox" ${layer.enabled !== false ? 'checked' : ''} aria-label="Enabled"><b>${def.label}</b><button class="icon small ghost" aria-label="Remove">×</button></div>`;
    el.querySelector('input').addEventListener('change', e => { layer.enabled = e.target.checked; liveGenerate(); });
    el.querySelector('button').addEventListener('click', () => { state.gen.layers.splice(li, 1); renderLayers(); liveGenerate(); });
    for (const p of def.params) {
      const s = document.createElement('div');
      s.className = 'slider';
      s.innerHTML = `<label><span>${p.label}</span><span>${p.unit}</span></label><input type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${layer[p.key]}"><input type="number" min="${p.min}" max="${p.max}" step="${p.step}" value="${layer[p.key]}">`;
      const [r, n] = s.querySelectorAll('input');
      const set = v => { layer[p.key] = v; r.value = v; n.value = v; updateDemand(el, layer); liveGenerate(); };
      r.addEventListener('input', () => set(+r.value));
      n.addEventListener('change', () => set(+n.value));
      el.appendChild(s);
    }
    const d = document.createElement('div');
    d.className = 'demand';
    el.appendChild(d);
    updateDemand(el, layer);
    host.appendChild(el);
  });
}
function updateDemand(el, layer) {
  const d = layerDemand(layer);
  const out = el.querySelector('.demand');
  if (!d) { out.textContent = 'Peak speed/accel: measured after generating (see Limits).'; return; }
  const L = state.limits;
  out.innerHTML = `Peak ≈ <span class="${d.speed > L.max_speed ? 'bad' : ''}">${fmt(d.speed)} mm/s</span> · <span class="${d.accel > L.max_accel ? 'bad' : ''}">${fmt(d.accel)} mm/s²</span> (before scaling)`;
}

let genTimer = 0;
function liveGenerate() {
  if (!$('gen-live').checked) return;
  clearTimeout(genTimer);
  genTimer = setTimeout(runGenerate, 180);
}
function runGenerate() {
  if (!state.gen.layers.length) return;
  const g = state.gen;
  const anim = generate({ ...g, rows: Math.max(1, g.rows | 0), cols: Math.max(1, g.cols | 0),
    min_mm: state.limits.min_mm, max_mm: state.limits.max_mm, layers: g.layers.map(l => ({ ...l })) });
  anim.meta.name = presetSel.value || 'generated';
  setAnimation(anim);
  persist();
}

// ------------------------------------------------------------------ persistence (per-viewer convenience only)
function persist() {
  try { localStorage.setItem('kss.settings', JSON.stringify({ limits: state.limits, machine: state.machine, gen: state.gen })); } catch { /* ignore */ }
}
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem('kss.settings') || 'null');
    if (!s) return;
    Object.assign(state.limits, s.limits || {});
    Object.assign(state.machine, s.machine || {});
    if (s.gen) Object.assign(state.gen, s.gen);
  } catch { /* ignore */ }
}

function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ------------------------------------------------------------------ boot
restore();
writeLimits();
writeMachine();
for (const [id, k] of Object.entries(genInputs)) $(id).value = state.gen[k];
if (!state.gen.layers.length) state.gen.layers = PRESETS['Calm ocean'].map(l => ({ ...l }));
renderLayers();
renderBoards();
renderBridgeFacts();
if (new URLSearchParams(location.search).has('empty')) { /* start empty */ } else demo('Calm ocean');
requestAnimationFrame(tick);
