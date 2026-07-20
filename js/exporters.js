// Export paths:
//  - PNG sequence: frame-steps the trimmed range through the beat-anchor retiming map,
//    renders each frame through the shader (straight alpha preserved) and zips them with
//    a Unity-ready metadata JSON whose beatsSec are in OUTPUT time.
//  - Quick WebM: real-time canvas capture for a fast opaque preview (no alpha).
import { state } from './state.js';
import { Zip } from './zip.js';
import { activeAnchors, segments, srcToOut, outToSrc, outputDuration, beatPoints, hasBeatMap } from './beatmap.js';

function seek(video, t) {
  return new Promise(res => {
    const done = () => { video.removeEventListener('seeked', done); res(); };
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function buildMeta(frameCount, extraMeta) {
  const beats = beatPoints();
  const meta = {
    tool: 'Card Beat',
    version: 2,
    source: state.videoName,
    output: { width: state.outputW, height: state.outputH, fps: state.fps, frameCount, format: 'png-sequence-rgba' },
    trim: { inSec: +state.trimIn.toFixed(4), outSec: +state.trimOut.toFixed(4) },
    // legacy uniform rate — only applied when no beat anchors exist
    playbackRate: hasBeatMap() ? 1 : state.playbackRate,
    durationOutSec: +outputDuration().toFixed(4),
    crop: state.crop,
    beat: {
      secondsPerBeat: state.beatLen,
      bpm: +(60 / state.beatLen).toFixed(3),
      anchorsSrcSec: activeAnchors(),
      anchorsOutSec: activeAnchors().map(a => +srcToOut(a).toFixed(4)),
      // the piecewise retime map, for engines that want to re-derive timing
      segments: segments().map(s => ({
        srcIn: +s.srcIn.toFixed(4), srcOut: +s.srcOut.toFixed(4),
        outIn: +s.outIn.toFixed(4), outOut: +s.outOut.toFixed(4),
        beats: s.beats, rate: +s.rate.toFixed(5),
      })),
    },
    // beat times in OUTPUT-clip seconds — schedule input windows against these
    beatsSec: beats.map(b => +b.out.toFixed(4)),
    beatsSourceSec: beats.map(b => +b.src.toFixed(4)),
    beatsAccent: beats.map(b => !!b.accent),
    shader: {
      keyMode: state.keyMode, keyColor: state.keyColor, keyThresh: state.keyThresh,
      keySoft: state.keySoft, spill: state.spill, toon: state.toon, levels: state.levels,
      edgeThresh: state.edgeThresh, edgeThick: state.edgeThick, edgeGain: state.edgeGain,
      edgeColor: state.edgeColor, tint: state.tint,
      outline: state.outline, outlineColor: state.outlineColor, outlineThick: state.outlineThick,
      sat: state.sat, bright: state.bright, contrast: state.contrast,
    },
  };
  return extraMeta ? { ...meta, ...extraMeta } : meta;
}

// Frame-step export following the retiming map: output frame i shows source time
// outToSrc(i/fps), so beat-stretched timing is baked into the frames themselves.
export async function exportPngSequence(pipeline, { onProgress, shouldCancel, onFrame, drawFrame, extraFrames, extraMeta }) {
  const v = state.video;
  const wasRate = v.playbackRate;
  v.pause();
  const outDur = outputDuration();
  const frameCount = Math.max(1, Math.round(outDur * state.fps));
  const zip = new Zip();
  const pad = n => String(n).padStart(4, '0');

  for (let i = 0; i < frameCount; i++) {
    if (shouldCancel && shouldCancel()) { v.playbackRate = wasRate; return null; }
    const srcT = outToSrc(i / state.fps);
    await seek(v, Math.max(0, Math.min(srcT, state.duration - 1e-3)));
    if (onFrame) await onFrame(v);
    if (drawFrame) drawFrame(v, srcT); else pipeline.render(v, state);
    const blob = await pipeline.toBlob();
    const buf = await blob.arrayBuffer();
    zip.add(`frames/frame_${pad(i)}.png`, buf);
    // per-object mask sequences (hand, card…) for use in the game engine
    if (extraFrames) {
      for (const f of await extraFrames(srcT, i)) zip.add(f.name, f.buf);
    }
    onProgress(i / frameCount, `frame ${i + 1} / ${frameCount}`);
  }

  const meta = buildMeta(frameCount, extraMeta);
  zip.add('cardbeat.json', new TextEncoder().encode(JSON.stringify(meta, null, 2)));
  onProgress(1, 'packaging zip');
  const base = (state.videoName || 'clip').replace(/\.[^.]+$/, '');
  download(zip.blob(), `${base}_cardbeat.zip`);
  v.playbackRate = wasRate;
  return meta;
}

// Real-time opaque WebM (quick look; alpha not preserved by MediaRecorder).
// rateFn(srcT) lets the caller apply beat-anchor retiming live while recording.
export async function exportWebm(canvas, renderFrame, { onProgress, shouldCancel, rateFn }) {
  const v = state.video;
  const stream = canvas.captureStream(state.fps);
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const done = new Promise(r => (rec.onstop = r));

  v.playbackRate = rateFn ? rateFn(state.trimIn) : state.playbackRate;
  await seek(v, state.trimIn);
  rec.start();
  await v.play();

  await new Promise(resolve => {
    const tick = () => {
      if ((shouldCancel && shouldCancel()) || v.currentTime >= state.trimOut) return resolve();
      if (rateFn) v.playbackRate = Math.min(8, Math.max(0.1, rateFn(v.currentTime)));
      renderFrame();
      const p = (v.currentTime - state.trimIn) / (state.trimOut - state.trimIn);
      onProgress(Math.max(0, Math.min(1, p)), 'recording');
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  v.pause(); rec.stop(); await done;
  const base = (state.videoName || 'clip').replace(/\.[^.]+$/, '');
  download(new Blob(chunks, { type: mime }), `${base}_preview.webm`);
}
