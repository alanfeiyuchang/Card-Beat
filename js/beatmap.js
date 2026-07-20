// Beat-anchor retiming map.
//
// The user drops anchors at source times. Consecutive anchors define segments; each
// segment is retimed to the NEAREST whole number of beats (min 1) at `beatLen` seconds
// per beat, so every anchor lands exactly on a beat in output time.
//   e.g. beatLen=2, anchors 2s & 4.5s -> 2.5s of source plays in 2s (1 beat, 1.25x);
//        next anchor 8s -> 3.5s of source plays in 4s (2 beats, 0.875x).
// Outside the anchored region (before the first / after the last anchor) playback is 1x.
// With fewer than 2 anchors there is no retiming; the global playbackRate applies
// (legacy behaviour, still used by export when no anchors are set).
import { state } from './state.js';

export function activeAnchors() {
  return (state.anchors || [])
    .filter(a => a >= state.trimIn - 1e-6 && a <= state.trimOut + 1e-6)
    .sort((a, b) => a - b);
}

export function hasBeatMap() { return activeAnchors().length >= 2; }

// [{srcIn, srcOut, outIn, outOut, beats, rate}] — rate is the playback speed multiplier
export function segments() {
  const A = activeAnchors();
  const segs = [];
  if (A.length < 2) return segs;
  let out = A[0] - state.trimIn;         // output time of the first anchor (1x before it)
  for (let i = 0; i < A.length - 1; i++) {
    const srcIn = A[i], srcOut = A[i + 1];
    const srcDur = srcOut - srcIn;
    const beats = Math.max(1, Math.round(srcDur / state.beatLen));
    const outDur = beats * state.beatLen;
    segs.push({ srcIn, srcOut, outIn: out, outOut: out + outDur, beats, rate: srcDur / outDur });
    out += outDur;
  }
  return segs;
}

// Playback-speed multiplier at a source time (1 outside the anchored region).
export function rateAt(srcT) {
  for (const s of segments())
    if (srcT >= s.srcIn && srcT < s.srcOut) return s.rate;
  return 1;
}

// source time (absolute) -> output time (0 at trimIn)
export function srcToOut(srcT) {
  const segs = segments();
  if (!segs.length) return (srcT - state.trimIn) / state.playbackRate;
  const first = segs[0], last = segs[segs.length - 1];
  if (srcT <= first.srcIn) return srcT - state.trimIn;
  if (srcT >= last.srcOut) return last.outOut + (srcT - last.srcOut);
  for (const s of segs)
    if (srcT <= s.srcOut) return s.outIn + (srcT - s.srcIn) / s.rate;
  return last.outOut;
}

// output time -> source time (absolute)
export function outToSrc(outT) {
  const segs = segments();
  if (!segs.length) return state.trimIn + outT * state.playbackRate;
  const first = segs[0], last = segs[segs.length - 1];
  if (outT <= first.outIn) return state.trimIn + outT;
  if (outT >= last.outOut) return last.srcOut + (outT - last.outOut);
  for (const s of segs)
    if (outT <= s.outOut) return s.srcIn + (outT - s.outIn) * s.rate;
  return last.srcOut;
}

export function outputDuration() { return srcToOut(state.trimOut); }

// All beat points: anchors (accent), intermediate beats inside multi-beat segments, and
// a projected grid after the last anchor. [{src, out, accent, projected}]
export function beatPoints() {
  const A = activeAnchors();
  if (!A.length) return [];
  const pts = [{ src: A[0], out: srcToOut(A[0]), accent: true }];
  for (const s of segments()) {
    for (let k = 1; k < s.beats; k++)
      pts.push({ src: s.srcIn + (s.srcOut - s.srcIn) * k / s.beats,
                 out: s.outIn + k * state.beatLen, accent: false });
    pts.push({ src: s.srcOut, out: s.outOut, accent: true });
  }
  // continue the grid after the last anchor (rate is 1 there, so spacing == beatLen)
  let src = A[A.length - 1] + state.beatLen;
  while (src <= state.trimOut + 1e-6) {
    pts.push({ src, out: srcToOut(src), accent: false, projected: true });
    src += state.beatLen;
  }
  return pts;
}
