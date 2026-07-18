// Timeline: waveform + beat grid + playhead, with draggable trim handles like a normal
// video editor — drag either edge to resize the trim, drag the top bar to move the whole
// window, click the track to scrub, double-click to reset trim to the full clip.
import { state, beatTimes, emit } from './state.js';

const HANDLE_HIT = 10;   // px grab tolerance around a trim edge
const TOP_BAR = 16;      // px height of the draggable "move whole trim" strip

export class Timeline {
  constructor(canvas, { onSeek, onCommit }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSeek = onSeek;
    this.onCommit = onCommit || (() => {});
    this.peaks = null;
    this.playhead = 0;
    this.dragging = null;   // 'in' | 'out' | 'region' | 'scrub'
    this.regionStart = null;
    canvas.addEventListener('pointerdown', e => this._down(e));
    canvas.addEventListener('pointermove', e => this._hover(e));
    canvas.addEventListener('dblclick', () => this._resetTrim());
    window.addEventListener('pointermove', e => this._move(e));
    window.addEventListener('pointerup', () => {
      const wasTrim = this.dragging && this.dragging !== 'scrub';
      this.dragging = null; this.regionStart = null;
      if (wasTrim) this.onCommit();
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

  _hitMode(x, y) {
    if (!state.video) return 'scrub';
    const inX = this._x(state.trimIn), outX = this._x(state.trimOut);
    if (Math.abs(x - inX) <= HANDLE_HIT) return 'in';
    if (Math.abs(x - outX) <= HANDLE_HIT) return 'out';
    if (y <= TOP_BAR && x > inX && x < outX) return 'region';
    return 'scrub';
  }

  _hover(e) {
    if (this.dragging) return;
    const m = this._hitMode(this._pos(e), this._posY(e));
    this.canvas.style.cursor =
      m === 'in' || m === 'out' ? 'ew-resize' : m === 'region' ? 'grab' : 'pointer';
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

  _move(e) {
    if (!this.dragging) return;
    const t = Math.max(0, Math.min(state.duration, this._t(this._pos(e))));
    if (this.dragging === 'in') {
      state.trimIn = Math.min(t, state.trimOut - 0.05);
    } else if (this.dragging === 'out') {
      state.trimOut = Math.max(t, state.trimIn + 0.05);
    } else if (this.dragging === 'region') {
      const width = this.regionStart.outT - this.regionStart.inT;
      let dt = this._t(this._pos(e)) - this._t(this.regionStart.x);
      let inT = Math.max(0, Math.min(this.regionStart.inT + dt, state.duration - width));
      state.trimIn = inT; state.trimOut = inT + width;
    } else {
      this.onSeek(t);
    }
    emit(); this.draw();
  }

  _resetTrim() {
    if (!state.video) return;
    state.trimIn = 0; state.trimOut = state.duration;
    emit(); this.draw(); this.onCommit();
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

    // beat grid
    const beats = beatTimes();
    const period = 60 / state.bpm;
    let idx = Math.round((state.trimIn - state.beatOffset) / period);
    for (const t of beats) {
      const x = this._x(t);
      const onBar = ((idx % state.beatsPerBar) + state.beatsPerBar) % state.beatsPerBar === 0;
      ctx.strokeStyle = onBar ? 'rgba(242,193,78,.9)' : 'rgba(242,193,78,.35)';
      ctx.lineWidth = onBar ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      idx++;
    }

    // dim the trimmed-out regions (drawn over waveform/beats)
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

    // playhead
    const px = this._x(this.playhead);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
  }
}
