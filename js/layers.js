// Object layers produced by SAM: one mask sequence per concept (hand, card...), each with
// its own toon-shader style + tint so they can be recolored / re-shaded independently.
import { state } from './state.js';

export const STYLE_FIELDS = ['toon','levels','edgeThresh','edgeThick','edgeGain',
  'edgeColor','tint','outline','outlineColor','outlineThick','sat','bright','contrast'];

// bumped every load so mask URLs are unique — defeats the browser image cache when a
// preview/track is re-run and rewrites the same file paths
let _bust = 0;

function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('mask load failed: ' + url));
    im.src = url;
  });
}

function defaultStyle(idx) {
  const s = {};
  for (const k of STYLE_FIELDS) s[k] = Array.isArray(state[k]) ? state[k].slice() : state[k];
  if (idx === 1) s.tint = [0.55, 0.80, 1.0];   // 2nd object (card) gets a distinct default tint
  if (idx === 2) s.tint = [1.0, 0.7, 0.5];
  return s;
}

export class Layers {
  constructor() { this.layers = []; this.active = null; }
  clear() { this.layers = []; this.active = null; }
  has() { return this.layers.length > 0; }
  get(slug) { return this.layers.find(l => l.slug === slug); }

  async loadFromManifest(m, baseUrl) {
    this.clear();
    const fps = m.fps || 30;
    const v = ++_bust;
    for (const [idx, c] of m.concepts.entries()) {
      const urls = [];
      for (let i = 0; i < c.frameCount; i++)
        urls.push(`${baseUrl}/${c.dir}/frame_${String(i).padStart(4, '0')}.png?v=${v}`);
      const imgs = await Promise.all(urls.map(u => loadImage(u).catch(() => null)));
      // prefer exact per-frame timestamps (fixes fps-report drift / VFR); fall back to index/fps
      const ft = m.frameTimes;
      const times = imgs.map((_, i) =>
        (ft && ft.length) ? ft[Math.min(i, ft.length - 1)] : i / fps);
      this.layers.push({ slug: c.slug, name: c.name, imgs, times, style: defaultStyle(idx), visible: true });
    }
    this.active = this.layers.length ? this.layers[0].slug : null;
    return this.layers.length;
  }

  // single-frame preview: one mask per object at its marked time (shown at any frame)
  async loadPreview(items) {
    this.clear();
    const v = ++_bust;
    for (const [idx, it] of items.entries()) {
      const img = await loadImage(it.url + `?v=${v}`).catch(() => null);
      this.layers.push({ slug: it.slug, name: it.name, imgs: [img], times: [it.time],
        style: defaultStyle(idx), preview: true, visible: true });
    }
    this.active = this.layers.length ? this.layers[0].slug : null;
    return this.layers.length;
  }

  // nearest mask image to source-time t
  maskAt(slug, t) {
    const L = this.get(slug);
    if (!L || !L.imgs.length) return null;
    let best = -1, bd = 1e9;
    for (let i = 0; i < L.times.length; i++) {
      if (!L.imgs[i]) continue;
      const d = Math.abs(L.times[i] - t);
      if (d < bd) { bd = d; best = i; }
    }
    return best >= 0 ? L.imgs[best] : null;
  }
}
