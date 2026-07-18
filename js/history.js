// Undo/redo over the editable (serializable) slice of state. Snapshots are taken on
// discrete commits (control `change`, crop/trim drag-end, button actions) — not on every
// live `input` tick — so one drag = one undo step.
import { state, emit } from './state.js';

const FIELDS = ['crop','outputW','outputH','keyMode','keyColor','keyThresh','keySoft','spill',
  'toon','levels','edgeThresh','edgeThick','edgeGain','edgeColor','tint',
  'outline','outlineColor','outlineThick','sat','bright','contrast',
  'trimIn','trimOut','playbackRate','fps','bpm','beatOffset','beatsPerBar'];

function clone(v) { return Array.isArray(v) ? v.slice() : (v && typeof v === 'object' ? { ...v } : v); }
function snap() { const o = {}; for (const k of FIELDS) o[k] = clone(state[k]); return o; }

export class History {
  constructor(onRestore) {
    this.onRestore = onRestore;
    this.limit = 200;
    this.past = [];
    this.future = [];
    this.present = snap();
    this._sync();
  }

  // Re-baseline (e.g. after importing a new clip). Clears history.
  reset() { this.past = []; this.future = []; this.present = snap(); this._sync(); }

  // Record the current state as a new step. Call AFTER state has changed.
  commit() {
    // skip no-op commits (e.g. change event that didn't alter anything)
    if (JSON.stringify(snap()) === JSON.stringify(this.present)) return;
    this.past.push(this.present);
    if (this.past.length > this.limit) this.past.shift();
    this.present = snap();
    this.future.length = 0;
    this._sync();
  }

  undo() {
    if (!this.past.length) return;
    this.future.push(this.present);
    this.present = this.past.pop();
    this._apply(this.present);
  }

  redo() {
    if (!this.future.length) return;
    this.past.push(this.present);
    this.present = this.future.pop();
    this._apply(this.present);
  }

  _apply(sn) {
    for (const k of FIELDS) state[k] = clone(sn[k]);
    this.onRestore();
    emit();
    this._sync();
  }

  _sync() {
    const u = document.getElementById('undoBtn'), r = document.getElementById('redoBtn');
    if (u) u.disabled = !this.past.length;
    if (r) r.disabled = !this.future.length;
  }
}
