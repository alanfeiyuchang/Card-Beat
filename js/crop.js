// Drag-to-crop overlay, aspect-ratio-locked to the output resolution so the exported
// frames are never stretched. Maps a DOM box over the displayed canvas into a normalized
// crop rect on state.crop. onCommit fires once per completed drag (for undo history).
import { state, emit } from './state.js';

export class CropTool {
  constructor(overlay, box, canvas, { onCommit } = {}) {
    this.overlay = overlay; this.box = box; this.canvas = canvas;
    this.onCommit = onCommit || (() => {});
    this.drag = null;
    box.addEventListener('pointerdown', e => this._down(e, 'move'));
    for (const h of box.querySelectorAll('.handle'))
      h.addEventListener('pointerdown', e => this._down(e, h.classList[1]));
    window.addEventListener('pointermove', e => this._move(e));
    window.addEventListener('pointerup', () => {
      if (this.drag) { this.drag = null; this.onCommit(); }
    });
  }

  show(v) {
    this.overlay.hidden = !v;
    if (v) { this.fitAspect(); this.layout(); }
  }

  // desired crop.w / crop.h in NORMALIZED coords so the cropped pixel region matches
  // the output pixel aspect (outputW:outputH).
  _ratioN() {
    const vw = state.videoW || 1, vh = state.videoH || 1;
    return (state.outputW * vh) / (state.outputH * vw);
  }

  // Reshape the current crop to the output aspect, keeping it centered and in-bounds.
  fitAspect() {
    if (!state.videoW) return;
    const r = this._ratioN();
    let { x, y, w, h } = state.crop;
    const cx = x + w / 2, cy = y + h / 2;
    let nw = w, nh = w / r;
    if (nh > 1) { nh = 1; nw = nh * r; }
    if (nw > 1) { nw = 1; nh = nw / r; }
    let nx = Math.max(0, Math.min(cx - nw / 2, 1 - nw));
    let ny = Math.max(0, Math.min(cy - nh / 2, 1 - nh));
    state.crop = { x: nx, y: ny, w: nw, h: nh };
    this.layout();
  }

  // Largest centered crop at the output aspect (used by Reset).
  maxFit() {
    state.crop = { x: 0, y: 0, w: 1, h: 1 };
    this.fitAspect();
  }

  _rect() { return this.canvas.getBoundingClientRect(); }

  layout() {
    if (this.overlay.hidden) return;
    const cr = this._rect();
    const sr = this.overlay.getBoundingClientRect();
    const c = state.crop, b = this.box.style;
    b.left   = (c.x * cr.width  + (cr.left - sr.left)) + 'px';
    b.top    = (c.y * cr.height + (cr.top  - sr.top )) + 'px';
    b.width  = (c.w * cr.width)  + 'px';
    b.height = (c.h * cr.height) + 'px';
  }

  _down(e, mode) {
    e.preventDefault(); e.stopPropagation();
    const cr = this._rect();
    this.drag = { mode, sx: e.clientX, sy: e.clientY, crop: { ...state.crop }, cw: cr.width, ch: cr.height };
  }

  _move(e) {
    if (!this.drag) return;
    const d = this.drag;
    const dx = (e.clientX - d.sx) / d.cw;
    const dy = (e.clientY - d.sy) / d.ch;
    let { x, y, w, h } = d.crop;

    if (d.mode === 'move') {
      const clamp = v => Math.max(0, Math.min(1, v));
      x = Math.min(clamp(x + dx), 1 - w);
      y = Math.min(clamp(y + dy), 1 - h);
      state.crop = { x, y, w, h }; this.layout(); emit(); return;
    }

    // corner resize, aspect-locked
    const r = this._ratioN();
    const west = d.mode.includes('w'), north = d.mode.includes('n');
    const anchorX = west ? x + w : x;
    const anchorY = north ? y + h : y;
    const px = (west ? x : x + w) + dx;    // pointer position (may be out of bounds)
    const py = (north ? y : y + h) + dy;
    let nw = Math.max(Math.abs(anchorX - px), Math.abs(anchorY - py) * r, 0.05);
    // clamp to bounds while preserving aspect + anchor
    const maxWh = west ? anchorX : 1 - anchorX;
    const maxWv = (north ? anchorY : 1 - anchorY) * r;
    nw = Math.max(0.05, Math.min(nw, maxWh, maxWv));
    const nh = nw / r;
    state.crop = { x: west ? anchorX - nw : anchorX, y: north ? anchorY - nh : anchorY, w: nw, h: nh };
    this.layout(); emit();
  }
}
