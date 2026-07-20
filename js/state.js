// Central editor state + tiny pub/sub. One source of truth the render loop reads each frame.
export const state = {
  // source
  video: null,          // HTMLVideoElement
  videoName: '',
  videoW: 0, videoH: 0,
  duration: 0,

  // frame / crop  (normalized 0..1 region of the source shown in output)
  crop: { x: 0, y: 0, w: 1, h: 1 },
  outputW: 512,
  outputH: 512,

  // background removal
  keyMode: 0,                 // 0 none | 1 chroma | 2 remove-dark | 3 remove-light
  keyColor: [0, 1, 0],        // linear-ish rgb 0..1
  keyThresh: 0.35,
  keySoft: 0.10,
  spill: 0,

  // toon — defaults to a "Just Dance" look: near-flat color, thick bold outline, punchy sat
  toon: true,
  levels: 3,
  edgeThresh: 0.10,
  edgeThick: 3.5,
  edgeGain: 3,
  edgeColor: [0, 0, 0],
  tint: [1, 1, 1],
  outline: false,
  outlineColor: [1, 1, 1],
  outlineThick: 3,
  sat: 1.5,

  // show the un-segmented background behind the object layers
  showBackground: false,
  bright: 0.05,
  contrast: 1.3,

  // timing
  trimIn: 0,
  trimOut: 0,
  playbackRate: 1,     // preview speed; baked into export ONLY when no beat anchors exist
  fps: 30,

  // beat anchors (source seconds, clip-specific) — see beatmap.js for the retiming rules
  anchors: [],
  beatLen: 2.0,        // seconds per beat
  metronome: true,     // click at beat points during playback

  // ui
  showCrop: false,
  playing: false,
};

const subs = new Set();
export function onChange(fn) { subs.add(fn); return () => subs.delete(fn); }
export function emit() { for (const fn of subs) fn(state); }
