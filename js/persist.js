// Persist the editor's look/behaviour settings across sessions (localStorage).
// Clip-specific things (the loaded video, crop rect, trim range, SAM points/layers) are
// intentionally NOT persisted — only the reusable parameter set.
import { state } from './state.js';

const KEY = 'cardbeat.settings.v1';

// state fields worth carrying over
const STATE_KEYS = [
  'keyMode', 'keyColor', 'keyThresh', 'keySoft', 'spill',
  'toon', 'levels', 'edgeThresh', 'edgeThick', 'edgeGain', 'edgeColor', 'tint',
  'outline', 'outlineColor', 'outlineThick', 'sat', 'bright', 'contrast',
  'bpm', 'beatsPerBar', 'playbackRate', 'fps',
];
// DOM-backed inputs (SAM panel) worth carrying over
const DOM_KEYS = ['samConcepts', 'samModel', 'samFps'];

export function loadSettings() {
  let o;
  try { o = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { o = null; }
  if (!o) return;
  for (const k of STATE_KEYS) if (k in o) state[k] = o[k];
  // DOM values are applied after the elements exist
  for (const id of DOM_KEYS) {
    const el = document.getElementById(id);
    if (el && o._dom && id in o._dom) el.value = o._dom[id];
  }
}

export function saveSettings() {
  const o = {};
  for (const k of STATE_KEYS) o[k] = state[k];
  o._dom = {};
  for (const id of DOM_KEYS) {
    const el = document.getElementById(id);
    if (el) o._dom[id] = el.value;
  }
  try { localStorage.setItem(KEY, JSON.stringify(o)); } catch {}
}

export function clearSettings() {
  try { localStorage.removeItem(KEY); } catch {}
}

// coalesce rapid changes (slider drags) into one write
let t = null;
export function saveSettingsDebounced() {
  clearTimeout(t);
  t = setTimeout(saveSettings, 300);
}

// ---- named custom shader-look presets (persist across sessions) ----
const PRESETS_KEY = 'cardbeat.presets.v1';
const PRESET_FIELDS = ['toon', 'levels', 'edgeThresh', 'edgeThick', 'edgeGain', 'edgeColor',
  'tint', 'outline', 'outlineColor', 'outlineThick', 'sat', 'bright', 'contrast'];

export function loadPresets() {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '{}'); } catch { return {}; }
}
export function savePreset(name) {
  const all = loadPresets();
  const o = {};
  for (const k of PRESET_FIELDS) o[k] = state[k];
  all[name] = o;
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(all)); } catch {}
  return all;
}
export function deletePreset(name) {
  const all = loadPresets();
  delete all[name];
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(all)); } catch {}
  return all;
}
