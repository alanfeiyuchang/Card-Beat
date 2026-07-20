// Timeline: waveform + beat anchors/grid + playhead, with draggable trim handles like a
// normal video editor — drag either trim edge, drag the top bar to move the whole trim
// window, drag a beat anchor to move it, click the track to scrub, double-click an anchor
// to delete it (double-click elsewhere resets the trim).
import { state, emit } from './state.js';
import { activeAnchors, beatPoints } from './beatmap.js';

const HANDLE_HIT = 10;   // px grab tolerance around a trim edge
const ANCHOR_HIT = 7;    // px grab tolerance around a beat anchor
const TOP_BAR = 16;      // px height of the draggable "move whole trim" strip

export class Timeline {
  constructor(canvas, { onSeek, onCommit, onAnchorsChanged }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSeek = onSeek;
    this.onCommit = onCommit || (() => {});
    this.onAnchorsChanged = onAnchorsChanged || (() => {});
    this.peaks = null;
    this.playhead = 0;
    this.dragging = null;   // 'in' | 'out' | 'region' | 'scrub' | {anchor: index}
    this.regionStart = null;
    canvas.addEventListener('pointerdown', e => this._down(e));
    canvas.addEventListener('pointermove', e => this._hover(e));
    canvas.addEventListener('dblclick', e => this._dblclick(e));
    window.addEventListener('pointermove', e => this._move(e));
    window.addEventListener('pointerup', () => {
      const d = this.dragging;
      this.dragging = null; this.regionStart = null;
      if (d && d.anchor !== undefined) {
        state.anchors.sort((a, b) => a - b);
        this.onAnchorsChanged(); this.onCommit();
      } else if (d && d !== 'scrub') {
        this.onCommit();
      }
    });
  }

  setWaveform(peaks) { this.peaks = peaks; }
  setPlayhead(t) { this.playhead = t; this.draw(); }

  _x(t) { return (t / (state.duration || 1)) * this.canvas.width; }
  _t(x) { return (x / this.canvas.width) * (state.duration || 1); }
  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return Math.max(0, Math.min(this.canvas.width, (e.clientX - r.left) * (this.canvas.width / r.width)));
  }
  _posY(e) {
    const r = this.canvas.getBoundingClientRect();
    return (e.clientY - r.top) * (this.canvas.height / r.height);
  }

  _anchorAt(x) {
    const A = state.anchors || [];
    let best = -1, bd = ANCHOR_HIT + 1;
    for (let i = 0; i < A.length; i++) {
      const d = Math.abs(x - this._x(A[i]));
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  _hitMode(x, y) {
    if (!state.video) return 'scrub';
    const inX = this._x(state.trimIn), outX = this._x(state.trimOut);
    if (Math.abs(x - inX) <= HANDLE_HIT) return 'in';
    if (Math.abs(x - outX) <= HANDLE_HIT) return 'out';
    const ai = this._anchorAt(x);
    if (ai >= 0) return { anchor: ai };
    if (y <= TOP_BAR && x > inX && x < outX) return 'region';
    return 'scrub';
  }

  _hover(e) {
    if (this.dragging) return;
    const m = this._hitMode(this._pos(e), this._posY(e));
    this.canvas.style.cursor =
      m === 'in' || m === 'out' || (m && m.anchor !== undefined) ? 'ew-resize'
      : m === 'region' ? 'grab' : 'pointer';
  }

  _down(e) {
    const x = this._pos(e), y = this._posY(e);
    this.dragging = this._hitMode(x, y);
    if (this.dragging === 'region') {
      this.regionStart = { x, inT: state.trimIn, outT: state.trimOut };
    } else if (this.dragging === 'scrub') {
      this.onSeek(this._t(x));
    }
  }

  _dblclick(e) {
    if (!state.video) return;
    const ai = this._anchorAt(this._pos(e));
    if (ai >= 0) {
      state.anchors.splice(ai, 1);
      emit(); this.draw(); this.onAnchorsChanged(); this.onCommit();
    } else {
      state.trimIn = 0; state.trimOut = state.duration;
      emit(); this.draw(); this.onCommit();
    }
  }

  _move(e) {
    if (!this.dragging) return;
    const t = Math.max(0, Math.min(state.duration, this._t(this._pos(e))));
    if (this.dragging === 'in') {
      state.trimIn = Math.min(t, state.trimOut - 0.05);
    } else if (this.dragging === 'out') {
      state.trimOut = Math.max(t, state.trimIn + 0.05);
    } else if (this.dragging === 'region') {
      const width = this.regionStart.outT - this.regionStart.inT;
      const dt = this._t(this._pos(e)) - this._t(this.regionStart.x);
      const inT = Math.max(0, Math.min(this.regionStart.inT + dt, state.duration - width));
      state.trimIn = inT; state.trimOut = inT + width;
    } else if (this.dragging.anchor !== undefined) {
      state.anchors[this.dragging.anchor] =
        Math.max(state.trimIn, Math.min(state.trimOut, t));
      this.onAnchorsChanged();
    } else {
      this.onSeek(t);
    }
    emit(); this.draw();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(300, r.width | 0);
    this.canvas.height = r.height | 0;
    this.draw();
  }

  draw() {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height, mid = H / 2;
    const inX = this._x(state.trimIn), outX = this._x(state.trimOut);
    ctx.clearRect(0, 0, W, H);

    // waveform
    if (this.peaks) {
      ctx.fillStyle = '#3a6f6a';
      const n = this.peaks.length;
      for (let i = 0; i < n; i++) {
        const a = this.peaks[i] * (mid - 4);
        ctx.fillRect((i / n) * W, mid - a, Math.max(1, W / n), a * 2);
      }
    } else {
      ctx.fillStyle = '#2a2a34';
      ctx.fillRect(0, mid - 1, W, 2);
    }

    // beat points from the anchor map: intermediate beats as ticks, projected dimmer
    for (const b of beatPoints()) {
      if (b.accent) continue;                       // anchors drawn as flags below
      const x = this._x(b.src);
      ctx.strokeStyle = b.projected ? 'rgba(242,193,78,.25)' : 'rgba(242,193,78,.6)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, H * 0.35); ctx.lineTo(x, H); ctx.stroke();
    }

    // dim the trimmed-out regions
    ctx.fillStyle = 'rgba(10,10,14,.62)';
    ctx.fillRect(0, 0, inX, H);
    ctx.fillRect(outX, 0, W - outX, H);

    // selection outline + draggable top bar
    ctx.strokeStyle = '#6ad0c8'; ctx.lineWidth = 1.5;
    ctx.strokeRect(inX + 0.5, 0.5, Math.max(1, outX - inX) - 1, H - 1);
    ctx.fillStyle = 'rgba(106,208,200,.28)';
    ctx.fillRect(inX, 0, outX - inX, TOP_BAR);

    // trim handles with grips
    for (const x of [inX, outX]) {
      ctx.fillStyle = '#6ad0c8';
      ctx.fillRect(x - 3, 0, 6, H);
      ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1;
      for (const dy of [-4, 0, 4]) {
        ctx.beginPath(); ctx.moveTo(x - 1.5, mid + dy); ctx.lineTo(x + 1.5, mid + dy); ctx.stroke();
      }
    }

    // beat anchors: bright flags (full line + triangle at top)
    for (const a of activeAnchors()) {
      const x = this._x(a);
      ctx.strokeStyle = '#e5695b'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.fillStyle = '#e5695b';
      ctx.beginPath(); ctx.moveTo(x - 6, 0); ctx.lineTo(x + 6, 0); ctx.lineTo(x, 9); ctx.closePath(); ctx.fill();
    }

    // playhead
    const px = this._x(this.playhead);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
  }
}
