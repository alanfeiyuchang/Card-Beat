import { state, emit, onChange } from './state.js';
import { Pipeline } from './pipeline.js';
import { Timeline } from './timeline.js';
import { CropTool } from './crop.js';
import { History } from './history.js';
import { loadWaveform, TapTempo } from './audio.js';
import { exportPngSequence, exportWebm } from './exporters.js';
import { Layers, STYLE_FIELDS } from './layers.js';
import { loadSettings, saveSettings, saveSettingsDebounced, loadPresets, savePreset, deletePreset } from './persist.js';

const $ = id => document.getElementById(id);
const hexToRgb = h => [parseInt(h.slice(1,3),16)/255, parseInt(h.slice(3,5),16)/255, parseInt(h.slice(5,7),16)/255];
const rgbToHex = c => '#' + c.map(v => Math.round(v*255).toString(16).padStart(2,'0')).join('');

const canvas = $('glcanvas');
let pipeline;
try { pipeline = new Pipeline(canvas); }
catch (e) { alert(e.message); throw e; }

const timeline = new Timeline($('tlcanvas'), {
  onSeek: t => { if (state.video) state.video.currentTime = t; },
  onCommit: () => history.commit(),
});
const crop = new CropTool($('cropOverlay'), $('cropBox'), canvas, { onCommit: () => history.commit() });
const tap = new TapTempo();
const layers = new Layers();
let samPoints = {};       // concept -> [{u, v, px, py}]  (u/v output-uv for dots, px/py source-pixel for SAM)
let samPromptTime = {};   // concept -> source time (s) of the frame its points were marked on
let pickQueue = [];
let pickIdx = 0;
let picking = false;
let samPoll = null;

// Mirror the full state into every control (used after undo/redo).
function syncUI() {
  $('outW').value = state.outputW; $('outH').value = state.outputH;
  $('keyMode').value = String(state.keyMode);
  $('keyColor').value = rgbToHex(state.keyColor);
  $('keyThresh').value = state.keyThresh; $('keySoft').value = state.keySoft; $('spill').value = state.spill;
  $('toon').checked = state.toon; $('levels').value = state.levels;
  $('edgeThresh').value = state.edgeThresh; $('edgeThick').value = state.edgeThick;
  $('edgeGain').value = state.edgeGain;
  $('edgeColor').value = rgbToHex(state.edgeColor);
  $('tint').value = rgbToHex(state.tint);
  $('outline').checked = state.outline;
  $('outlineThick').value = state.outlineThick;
  $('outlineColor').value = rgbToHex(state.outlineColor);
  $('sat').value = state.sat; $('bright').value = state.bright; $('contrast').value = state.contrast;
  $('bpm').value = state.bpm; $('beatOffset').value = state.beatOffset; $('beatsPerBar').value = state.beatsPerBar;
  $('rate').value = state.playbackRate; $('rateLabel').textContent = state.playbackRate.toFixed(2) + '×';
  $('fps').value = state.fps;
  crop.layout(); timeline.draw(); updateTrimLabel();
}
// restore persisted settings into state before the first UI sync, then reflect them
loadSettings();
syncUI();
const history = new History(syncUI);

// save look/behaviour settings whenever they change (debounced)
onChange(saveSettingsDebounced);

// ---------- render loop ----------
// Composite each object layer with its own style; falls back to the single-pass path.
function saveActiveStyle() {
  if (!layers.has() || !layers.active) return;
  const L = layers.get(layers.active);
  for (const k of STYLE_FIELDS) L.style[k] = Array.isArray(state[k]) ? state[k].slice() : state[k];
}
function renderComposited(t) {
  saveActiveStyle();
  let first = true;
  if (state.showBackground) {
    pipeline.clearMask();
    pipeline.render(state.video, { ...state, tint: [1, 1, 1], outline: false }, true);
    first = false;
  }
  for (const L of layers.layers) {
    if (L.visible === false) continue;
    const mask = layers.maskAt(L.slug, t);
    if (!mask) continue;
    pipeline.setMask(mask);
    pipeline.render(state.video, { ...state, ...L.style }, first);
    first = false;
  }
  if (first) pipeline.clearCanvas();
}
function frame() {
  if (state.video && state.video.readyState >= 2) {
    if (layers.has()) renderComposited(state.video.currentTime);
    else pipeline.render(state.video, state);
    timeline.setPlayhead(state.video.currentTime);
    updateTimeLabel();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function updateTimeLabel() {
  if (!state.video) { $('timeLabel').textContent = '0.00 / 0.00'; return; }
  const rel = Math.max(0, state.video.currentTime - state.trimIn);
  const dur = Math.max(0.001, state.trimOut - state.trimIn);
  $('timeLabel').textContent = `${rel.toFixed(2)} / ${dur.toFixed(2)}`;
  $('scrub').value = Math.round(Math.max(0, Math.min(1, rel / dur)) * 1000);
}

// ---------- import ----------
async function openVideo(url, name, audioBlob) {
  const v = document.createElement('video');
  v.src = url;
  v.muted = true; v.playsInline = true; v.loop = false; v.crossOrigin = 'anonymous';
  await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true }));
  await v.play().catch(()=>{}); v.pause(); v.currentTime = 0;

  layers.clear(); $('layerPanel').hidden = true; pipeline.clearMask();
  samPoints = {}; samPromptTime = {}; drawPoints();
  state.video = v;
  state.videoName = name;
  state.videoW = v.videoWidth; state.videoH = v.videoHeight;
  state.duration = v.duration;
  state.trimIn = 0; state.trimOut = v.duration;
  state.crop = { x: 0, y: 0, w: 1, h: 1 };
  // default output keeps source aspect, capped to 512 on the long edge
  const long = Math.max(v.videoWidth, v.videoHeight);
  const scale = Math.min(1, 512 / long);
  state.outputW = Math.round(v.videoWidth * scale);
  state.outputH = Math.round(v.videoHeight * scale);
  $('outW').value = state.outputW; $('outH').value = state.outputH;

  $('fileName').textContent = `${name}  (${v.videoWidth}×${v.videoHeight}, ${v.duration.toFixed(1)}s)`;
  ['playBtn','scrub','exportPngBtn','exportWebmBtn'].forEach(id => $(id).disabled = false);

  v.addEventListener('timeupdate', () => {
    // loop within the trimmed range so playback previews just the trimmed segment
    if (state.playing && state.video.currentTime >= state.trimOut) state.video.currentTime = state.trimIn;
  });

  timeline.resize();
  if (audioBlob) { const { peaks } = await loadWaveform(audioBlob); timeline.setWaveform(peaks); }
  crop.show(state.showCrop);
  emit();
  history.reset();
}

$('videoInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  await openVideo(URL.createObjectURL(file), file.name, file);
});

// ---------- transport ----------
$('playBtn').addEventListener('click', () => {
  const v = state.video; if (!v) return;
  if (state.playing) { v.pause(); state.playing = false; $('playBtn').textContent = '▶'; }
  else {
    if (v.currentTime < state.trimIn || v.currentTime >= state.trimOut) v.currentTime = state.trimIn;
    v.playbackRate = state.playbackRate; v.play(); state.playing = true; $('playBtn').textContent = '❚❚';
  }
});
$('scrub').addEventListener('input', e => {
  if (!state.video) return;
  state.video.currentTime = state.trimIn + (e.target.value / 1000) * (state.trimOut - state.trimIn);
});

// ---------- generic control binding ----------
function bindRange(id, key, tf = v => +v) {
  $(id).addEventListener('input', e => { state[key] = tf(e.target.value); emit(); });
}
bindRange('keyThresh','keyThresh'); bindRange('keySoft','keySoft'); bindRange('spill','spill');
bindRange('levels','levels'); bindRange('edgeThresh','edgeThresh'); bindRange('edgeThick','edgeThick');
bindRange('edgeGain','edgeGain'); bindRange('outlineThick','outlineThick');
bindRange('sat','sat'); bindRange('bright','bright'); bindRange('contrast','contrast');

// commit a history step when a control's value is committed (change fires on release/blur)
const commit = () => history.commit();
['keyThresh','keySoft','spill','levels','edgeThresh','edgeThick','edgeGain','outlineThick',
 'sat','bright','contrast','rate',
 'keyMode','keyColor','edgeColor','tint','outline','outlineColor','toon','outW','outH','bpm','beatOffset','beatsPerBar','fps']
  .forEach(id => $(id).addEventListener('change', commit));

// toon look presets
const PRESETS = {
  justdance: { toon:true, levels:3, edgeThresh:0.10, edgeThick:3.5, edgeGain:3.0, edgeColor:[0,0,0], sat:1.5, bright:0.05, contrast:1.3 },
  ink:       { toon:true, levels:4, edgeThresh:0.14, edgeThick:2.0, edgeGain:2.2, edgeColor:[0,0,0], sat:1.1, bright:0.0,  contrast:1.2 },
  flat:      { toon:true, levels:2, edgeThresh:0.09, edgeThick:4.0, edgeGain:3.5, edgeColor:[0,0,0], sat:1.8, bright:0.05, contrast:1.4 },
};
for (const btn of document.querySelectorAll('[data-preset]')) {
  btn.addEventListener('click', () => {
    Object.assign(state, PRESETS[btn.dataset.preset]);
    syncUI(); emit(); history.commit();
  });
}

// custom saved looks
function renderCustomPresets() {
  const box = $('customPresets'); box.innerHTML = '';
  const all = loadPresets();
  for (const name of Object.keys(all)) {
    const b = document.createElement('button'); b.className = 'btn small'; b.textContent = name;
    b.addEventListener('click', () => { Object.assign(state, all[name]); syncUI(); emit(); history.commit(); });
    const del = document.createElement('span'); del.textContent = ' ✕'; del.title = 'delete'; del.style.opacity = '.6';
    del.addEventListener('click', e => { e.stopPropagation(); deletePreset(name); renderCustomPresets(); });
    b.appendChild(del); box.appendChild(b);
  }
}
$('savePreset').addEventListener('click', () => {
  const name = ($('presetName').value || '').trim();
  if (!name) { $('presetName').focus(); return; }
  savePreset(name); $('presetName').value = ''; renderCustomPresets();
});
renderCustomPresets();

$('keyMode').addEventListener('change', e => { state.keyMode = +e.target.value; emit(); });
$('keyColor').addEventListener('input', e => { state.keyColor = hexToRgb(e.target.value); emit(); });
$('edgeColor').addEventListener('input', e => { state.edgeColor = hexToRgb(e.target.value); emit(); });
$('tint').addEventListener('input', e => { state.tint = hexToRgb(e.target.value); emit(); });
$('tintReset').addEventListener('click', () => { state.tint = [1,1,1]; $('tint').value = '#ffffff'; emit(); history.commit(); });
$('outline').addEventListener('change', e => { state.outline = e.target.checked; emit(); });
$('outlineColor').addEventListener('input', e => { state.outlineColor = hexToRgb(e.target.value); emit(); });
$('toon').addEventListener('change', e => { state.toon = e.target.checked; emit(); });

$('outW').addEventListener('change', e => { state.outputW = Math.max(16, +e.target.value|0); crop.fitAspect(); emit(); });
$('outH').addEventListener('change', e => { state.outputH = Math.max(16, +e.target.value|0); crop.fitAspect(); emit(); });

// undo / redo
$('undoBtn').addEventListener('click', () => history.undo());
$('redoBtn').addEventListener('click', () => history.redo());
window.addEventListener('keydown', e => {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return;
  const k = e.key.toLowerCase();
  if (k === 'z') { e.preventDefault(); e.shiftKey ? history.redo() : history.undo(); }
  else if (k === 'y') { e.preventDefault(); history.redo(); }
});

// crop tool
$('cropToggle').addEventListener('change', e => { state.showCrop = e.target.checked; crop.show(e.target.checked); });
$('cropReset').addEventListener('click', () => { crop.maxFit(); emit(); history.commit(); });
$('cropSquare').addEventListener('click', () => {
  // make output square, then refit the crop to keep aspect (no stretching)
  const s = Math.max(16, state.outputW | 0);
  state.outputW = state.outputH = s; $('outW').value = s; $('outH').value = s;
  crop.fitAspect(); emit(); history.commit();
});
$('cropApply').addEventListener('click', () => {
  // crop applies live; this finalizes it, closes the tool, and records one undo step
  state.showCrop = false; $('cropToggle').checked = false; crop.show(false);
  emit(); history.commit();
});

// eyedropper: next click on stage samples key color
let eyedrop = false;
$('pickKey').addEventListener('click', () => { eyedrop = true; canvas.style.cursor = 'crosshair'; });
canvas.addEventListener('click', e => {
  if (!eyedrop || !state.video) return;
  const r = canvas.getBoundingClientRect();
  const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
  state.keyColor = pipeline.sampleColorAt(u, v, state);
  $('keyColor').value = rgbToHex(state.keyColor);
  if (state.keyMode === 0) { state.keyMode = 1; $('keyMode').value = '1'; }
  eyedrop = false; canvas.style.cursor = 'default'; emit(); history.commit();
});

// ---------- beats & timing ----------
$('bpm').addEventListener('change', e => { state.bpm = +e.target.value; emit(); timeline.draw(); });
$('beatOffset').addEventListener('change', e => { state.beatOffset = +e.target.value; emit(); timeline.draw(); });
$('beatsPerBar').addEventListener('change', e => { state.beatsPerBar = +e.target.value|0; timeline.draw(); });
$('setOffsetHere').addEventListener('click', () => {
  if (!state.video) return;
  state.beatOffset = +state.video.currentTime.toFixed(3);
  $('beatOffset').value = state.beatOffset; timeline.draw(); history.commit();
});
$('tapTempo').addEventListener('click', () => {
  const bpm = tap.tap(performance.now());
  if (bpm) { state.bpm = bpm; $('bpm').value = bpm; timeline.draw(); history.commit(); }
});
$('rate').addEventListener('input', e => {
  state.playbackRate = +e.target.value;
  $('rateLabel').textContent = state.playbackRate.toFixed(2) + '×';
  if (state.video && state.playing) state.video.playbackRate = state.playbackRate;
});
$('fps').addEventListener('change', e => { state.fps = Math.max(10, +e.target.value|0); });
// trim is edited directly on the timeline (drag the handles); no buttons.
function updateTrimLabel() {
  const el = $('trimLabel'); if (!el) return;
  const full = state.trimIn <= 0.001 && Math.abs(state.trimOut - state.duration) < 0.01;
  el.textContent = full ? 'trim: full clip'
    : `trim: ${state.trimIn.toFixed(2)}s → ${state.trimOut.toFixed(2)}s`;
}

// keep crop box glued to the canvas as it resizes / state changes
onChange(() => { crop.layout(); updateTrimLabel(); });
window.addEventListener('resize', () => { timeline.resize(); crop.layout(); });

// ---------- export ----------
let cancelExport = false;
function openModal(title) {
  cancelExport = false;
  $('exportTitle').textContent = title;
  $('exportBar').style.width = '0%';
  $('exportStatus').textContent = 'preparing';
  $('exportModal').hidden = false;
}
const closeModal = () => ($('exportModal').hidden = true);
$('exportCancel').addEventListener('click', () => { cancelExport = true; closeModal(); });
const prog = (p, msg) => { $('exportBar').style.width = (p*100).toFixed(1)+'%'; $('exportStatus').textContent = msg; };

$('exportPngBtn').addEventListener('click', async () => {
  if (!state.video) return;
  const wasPlaying = state.playing; state.video.pause(); state.playing = false; $('playBtn').textContent='▶';
  openModal('Exporting PNG sequence…');
  const drawFrame = layers.has() ? (v, srcT) => renderComposited(srcT) : null;
  try {
    const meta = await exportPngSequence(pipeline, { onProgress: prog, shouldCancel: () => cancelExport, drawFrame });
    if (meta) { prog(1, `done — ${meta.output.frameCount} frames`); setTimeout(closeModal, 700); }
  } catch (e) { $('exportStatus').textContent = 'error: ' + e.message; }
});

$('exportWebmBtn').addEventListener('click', async () => {
  if (!state.video) return;
  openModal('Recording WebM preview…');
  try {
    await exportWebm(canvas, () => pipeline.render(state.video, state),
      { onProgress: prog, shouldCancel: () => cancelExport });
    prog(1, 'done'); setTimeout(closeModal, 700);
  } catch (e) { $('exportStatus').textContent = 'error: ' + e.message; }
});

// ---------- object layers (SAM) ----------
function highlightLayerButtons() {
  for (const b of $('layerButtons').querySelectorAll('button[data-slug]'))
    b.classList.toggle('primary', b.dataset.slug === layers.active);
}
function loadLayerStyle(slug) {
  const L = layers.get(slug); if (!L) return;
  for (const k of STYLE_FIELDS) state[k] = Array.isArray(L.style[k]) ? L.style[k].slice() : L.style[k];
  syncUI();
}
function selectLayer(slug) {
  saveActiveStyle();
  layers.active = slug;
  loadLayerStyle(slug);
  highlightLayerButtons();
}
function buildLayerButtons() {
  const box = $('layerButtons'); box.innerHTML = '';
  // background show/hide
  const bgRow = document.createElement('div'); bgRow.className = 'layer-row';
  const bgEye = document.createElement('button'); bgEye.className = 'btn small eye';
  bgEye.textContent = state.showBackground ? '👁' : '🚫'; bgEye.title = 'show/hide background';
  bgEye.addEventListener('click', () => {
    state.showBackground = !state.showBackground; bgEye.textContent = state.showBackground ? '👁' : '🚫';
  });
  const bgLabel = document.createElement('span'); bgLabel.className = 'muted'; bgLabel.textContent = 'Background';
  bgRow.appendChild(bgEye); bgRow.appendChild(bgLabel); box.appendChild(bgRow);
  // object layers
  for (const L of layers.layers) {
    const row = document.createElement('div'); row.className = 'layer-row';
    const eye = document.createElement('button'); eye.className = 'btn small eye';
    eye.textContent = L.visible === false ? '🚫' : '👁'; eye.title = 'show/hide';
    eye.addEventListener('click', () => {
      L.visible = L.visible === false; eye.textContent = L.visible === false ? '🚫' : '👁';
    });
    const sel = document.createElement('button'); sel.className = 'btn small';
    sel.textContent = L.name; sel.dataset.slug = L.slug;
    sel.addEventListener('click', () => selectLayer(L.slug));
    row.appendChild(eye); row.appendChild(sel); box.appendChild(row);
  }
  highlightLayerButtons();
}

// ---------- desktop bridge (pywebview) ----------
const IS_DESKTOP = () => !!window.pywebview;
async function pickVideoDesktop() {
  const r = await window.pywebview.api.pick_video();
  if (!r) return;
  let audioBlob = null;
  try { audioBlob = await (await fetch(r.url)).blob(); } catch {}
  await openVideo(r.url, r.name, audioBlob);
}
const parseConcepts = () => $('samConcepts').value.split(',').map(s => s.trim()).filter(Boolean);
const PT_COLORS = ['#f2c14e', '#6ad0c8', '#e5695b', '#9b8cf2'];

function drawPoints() {
  const ov = $('pointOverlay'); if (!ov) return;
  ov.innerHTML = '';
  parseConcepts().forEach((c, ci) => {
    for (const p of (samPoints[c] || [])) {
      const d = document.createElement('div'); d.className = 'point-dot';
      d.style.left = (p.u * 100) + '%'; d.style.top = (p.v * 100) + '%';
      d.style.background = PT_COLORS[ci % PT_COLORS.length];
      const s = document.createElement('span'); s.textContent = c; d.appendChild(s);
      ov.appendChild(d);
    }
  });
}
function promptCurrent() {
  const c = pickQueue[pickIdx];
  const n = (samPoints[c] || []).length;
  const last = pickIdx >= pickQueue.length - 1;
  $('samNextObj').textContent = last ? 'Finish ✓' : 'Next object ▸';
  const at = samPromptTime[c] != null ? ` @ ${(samPromptTime[c]).toFixed(2)}s` : '';
  $('samPointsStatus').textContent =
    `scrub to a clear frame, then click every “${c}” (${n} placed${at}) — then ${last ? 'Finish' : 'Next'}`;
}
function startPickPoints() {
  if (!state.video) { $('samPointsStatus').textContent = 'open a video first'; return; }
  const concepts = parseConcepts();
  if (!concepts.length) { $('samPointsStatus').textContent = 'enter concepts first'; return; }
  // marks on whatever frame is shown; SAM tracks both forward AND backward from it
  state.video.pause(); state.playing = false; $('playBtn').textContent = '▶';
  samPoints = {}; samPromptTime = {}; for (const c of concepts) samPoints[c] = [];
  drawPoints();
  pickQueue = concepts.slice(); pickIdx = 0; picking = true;
  $('stage').classList.add('picking');
  $('samNextObj').hidden = false; $('samClearPoints').hidden = false;
  promptCurrent();
}
function finishPicking() {
  picking = false; $('stage').classList.remove('picking'); $('samNextObj').hidden = true;
  const summary = parseConcepts().map(c => `${c}:${(samPoints[c] || []).length}`).join('  ');
  $('samPointsStatus').textContent = `points set — ${summary}`;
}
canvas.addEventListener('click', e => {
  if (!picking || !state.video) return;
  const c = pickQueue[pickIdx];
  // lock this object's prompt frame to the current frame on its first point
  if (!(samPoints[c] && samPoints[c].length)) samPromptTime[c] = state.video.currentTime;
  const r = canvas.getBoundingClientRect();
  const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
  const srcU = state.crop.x + u * state.crop.w, srcV = state.crop.y + v * state.crop.h;
  (samPoints[c] ||= []).push({ u, v, px: srcU * state.videoW, py: srcV * state.videoH });
  drawPoints(); promptCurrent();
});
$('samSetPoints').addEventListener('click', startPickPoints);
$('samNextObj').addEventListener('click', () => {
  if (!picking) return;
  if (pickIdx >= pickQueue.length - 1) finishPicking();
  else { pickIdx++; promptCurrent(); }
});
$('samClearPoints').addEventListener('click', () => {
  samPoints = {}; drawPoints();
  $('samClearPoints').hidden = true; $('samNextObj').hidden = true;
  picking = false; $('stage').classList.remove('picking');
  $('samPointsStatus').textContent = 'no points';
});
$('samModel').addEventListener('change', e => {
  $('samPointsRow').style.display = e.target.value.includes('sam2') ? '' : 'none';
  saveSettings();
});
$('samConcepts').addEventListener('change', saveSettings);
$('samFps').addEventListener('change', saveSettings);

async function runSam() {
  if (!state.video) { $('samStatus').textContent = 'open a video first'; return; }
  const concepts = parseConcepts();
  if (!concepts.length) { $('samStatus').textContent = 'enter at least one concept'; return; }
  const model = $('samModel').value, fps = +$('samFps').value || 30;
  let points = null;
  if (model.includes('sam2')) {
    const missing = concepts.filter(c => !(samPoints[c] && samPoints[c].length));
    if (missing.length) { $('samStatus').textContent = 'set points first for: ' + missing.join(', '); return; }
    points = {}; for (const c of concepts) points[c] = samPoints[c].map(p => [p.px, p.py]);
  }
  const promptTimes = {};
  for (const c of concepts) if (samPromptTime[c] != null) promptTimes[c] = samPromptTime[c];
  const trimStart = state.trimIn > 0.05 ? state.trimIn : null;
  const trimEnd = state.trimOut < state.duration - 0.05 ? state.trimOut : null;
  $('samRun').disabled = true; $('samBar').style.width = '0%'; $('samStatus').textContent = 'starting…';
  let started;
  try { started = await window.pywebview.api.run_sam(concepts, fps, model, points, trimStart, trimEnd, promptTimes); }
  catch (e) { $('samStatus').textContent = 'bridge error: ' + e.message; $('samRun').disabled = false; return; }
  if (started && started.error) { $('samStatus').textContent = 'error: ' + started.error; $('samRun').disabled = false; return; }
  // background job runs in Python; poll progress until done/error
  samPoll = setInterval(async () => {
    let p; try { p = await window.pywebview.api.get_progress(); } catch { return; }
    if (!p) return;
    if (p.total) $('samBar').style.width = Math.round((p.frame / p.total) * 100) + '%';
    $('samStatus').textContent = `${p.stage} ${p.frame}/${p.total}`;
    if (p.stage !== 'done' && p.stage !== 'error') return;
    clearInterval(samPoll); samPoll = null;
    const manifest = await window.pywebview.api.get_result();
    $('samRun').disabled = false;
    if (!manifest || manifest.error) {
      $('samStatus').textContent = 'error: ' + (manifest ? manifest.error : 'no result');
      $('samBar').style.width = '0%'; return;
    }
    $('samBar').style.width = '100%';
    const n = await layers.loadFromManifest(manifest, manifest.baseUrl);
    state.keyMode = 0; $('keyMode').value = '0';
    buildLayerButtons(); $('layerPanel').hidden = false;
    if (n) selectLayer(layers.layers[0].slug);
    $('samStatus').textContent = `done — ${n} object layer(s)`;
  }, 300);
}
function resetSam() {
  if (samPoll) { clearInterval(samPoll); samPoll = null; }
  layers.clear(); $('layerPanel').hidden = true; $('layerButtons').innerHTML = '';
  pipeline.clearMask();
  samPoints = {}; samPromptTime = {}; drawPoints();
  picking = false; $('stage').classList.remove('picking');
  $('samNextObj').hidden = true; $('samClearPoints').hidden = true;
  $('samPointsStatus').textContent = 'no points';
  $('samBar').style.width = '0%'; $('samStatus').textContent = '—';
  $('samRun').disabled = false;
}
// quick single-frame preview so you can confirm the points before the slow full track
async function previewSam() {
  if (!state.video) { $('samStatus').textContent = 'open a video first'; return; }
  const concepts = parseConcepts();
  if (!concepts.length) { $('samStatus').textContent = 'enter at least one concept'; return; }
  const model = $('samModel').value;
  const isSam2 = model.includes('sam2');
  const points = {}, promptTimes = {};
  if (isSam2) {
    const missing = concepts.filter(c => !(samPoints[c] && samPoints[c].length));
    if (missing.length) { $('samStatus').textContent = 'set points first for: ' + missing.join(', '); return; }
    for (const c of concepts) points[c] = samPoints[c].map(p => [p.px, p.py]);
    for (const c of concepts) if (samPromptTime[c] != null) promptTimes[c] = samPromptTime[c];
  }
  const frameTime = state.video.currentTime;   // SAM3 (text) previews the shown frame
  $('samPreview').disabled = true;
  $('samStatus').textContent = isSam2 ? 'previewing marked frame…'
    : 'previewing with SAM 3 text (slow — first run downloads/loads the model)…';
  let res;
  try { res = await window.pywebview.api.preview_sam(concepts, points, promptTimes, model, frameTime); }
  catch (e) { $('samStatus').textContent = 'bridge error: ' + e.message; $('samPreview').disabled = false; return; }
  $('samPreview').disabled = false;
  if (!res || res.error) { $('samStatus').textContent = 'error: ' + (res ? res.error : 'no result'); return; }
  const n = await layers.loadPreview(res.items);
  state.keyMode = 0; $('keyMode').value = '0';
  buildLayerButtons(); $('layerPanel').hidden = false;
  if (n) {
    selectLayer(layers.layers[0].slug);
    const t0 = res.items[0] ? res.items[0].time : frameTime;
    if (state.video) state.video.currentTime = t0;
  }
  $('samStatus').textContent = `preview — check each object mask, then “Track whole clip”`;
}
$('samPick').addEventListener('click', () => pickVideoDesktop().catch(e => $('samStatus').textContent = e.message));
$('samPreview').addEventListener('click', previewSam);
$('samRun').addEventListener('click', runSam);
$('samReset').addEventListener('click', resetSam);

// reveal desktop-only controls once the bridge is ready
function enableDesktop() {
  $('samPanel').hidden = false; document.body.dataset.desktop = '1';
  $('samPointsRow').style.display = $('samModel').value.includes('sam2') ? '' : 'none';
}
if (IS_DESKTOP()) enableDesktop();
window.addEventListener('pywebviewready', enableDesktop);

// initial timeline sizing after layout settles
setTimeout(() => timeline.resize(), 50);
