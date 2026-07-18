// Export paths:
//  - PNG sequence: frame-steps the trimmed range, renders each frame through the shader
//    (straight alpha preserved) and zips them with a Unity-ready metadata JSON.
//  - Quick WebM: real-time canvas capture for a fast opaque preview (no alpha).
import { state, beatTimes } from './state.js';
import { Zip } from './zip.js';

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

export function buildMeta(frameCount) {
  const outStart = state.trimIn;
  const beatsSrc = beatTimes();
  // output time = (sourceTime - trimIn) / playbackRate
  const toOut = t => +((t - outStart) / state.playbackRate).toFixed(4);
  return {
    tool: 'Card Beat',
    version: 1,
    source: state.videoName,
    output: { width: state.outputW, height: state.outputH, fps: state.fps, frameCount, format: 'png-sequence-rgba' },
    trim: { inSec: +state.trimIn.toFixed(4), outSec: +state.trimOut.toFixed(4) },
    segmentation: { enabled: state.segEnable, model: state.segEnable ? state.segModel : null },
    playbackRate: state.playbackRate,
    durationOutSec: +((state.trimOut - state.trimIn) / state.playbackRate).toFixed(4),
    crop: state.crop,
    tempo: { bpm: state.bpm, beatsPerBar: state.beatsPerBar, firstBeatSrcSec: state.beatOffset },
    shader: {
      keyMode: state.keyMode, keyColor: state.keyColor, keyThresh: state.keyThresh,
      keySoft: state.keySoft, spill: state.spill, toon: state.toon, levels: state.levels,
      edgeThresh: state.edgeThresh, edgeThick: state.edgeThick, edgeColor: state.edgeColor,
      sat: state.sat, bright: state.bright, contrast: state.contrast,
    },
    // beats in output-clip time (what Unity schedules against dspTime)
    beatsSec: beatsSrc.map(toOut),
    beatsSourceSec: beatsSrc,
  };
}

// Frame-step export. pipeline renders each frame; onProgress(0..1, msg); returns when done.
export async function exportPngSequence(pipeline, { onProgress, shouldCancel, onFrame, drawFrame }) {
  const v = state.video;
  const wasRate = v.playbackRate;
  v.pause();
  const outDur = (state.trimOut - state.trimIn) / state.playbackRate;
  const frameCount = Math.max(1, Math.round(outDur * state.fps));
  const zip = new Zip();
  const pad = n => String(n).padStart(4, '0');

  for (let i = 0; i < frameCount; i++) {
    if (shouldCancel && shouldCancel()) { v.playbackRate = wasRate; return null; }
    const srcT = state.trimIn + (i / state.fps) * state.playbackRate;
    await seek(v, Math.min(srcT, state.duration - 1e-3));
    if (onFrame) await onFrame(v);
    if (drawFrame) drawFrame(v, srcT); else pipeline.render(v, state);
    const blob = await pipeline.toBlob();
    const buf = await blob.arrayBuffer();
    zip.add(`frames/frame_${pad(i)}.png`, buf);
    onProgress(i / frameCount, `frame ${i + 1} / ${frameCount}`);
  }

  const meta = buildMeta(frameCount);
  zip.add('cardbeat.json', new TextEncoder().encode(JSON.stringify(meta, null, 2)));
  onProgress(1, 'packaging zip');
  const base = (state.videoName || 'clip').replace(/\.[^.]+$/, '');
  download(zip.blob(), `${base}_cardbeat.zip`);
  v.playbackRate = wasRate;
  return meta;
}

// Real-time opaque WebM (quick look; alpha not preserved by MediaRecorder).
export async function exportWebm(canvas, renderFrame, { onProgress, shouldCancel }) {
  const v = state.video;
  const stream = canvas.captureStream(state.fps);
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const done = new Promise(r => (rec.onstop = r));

  v.playbackRate = state.playbackRate;
  await seek(v, state.trimIn);
  rec.start();
  await v.play();

  await new Promise(resolve => {
    const tick = () => {
      if ((shouldCancel && shouldCancel()) || v.currentTime >= state.trimOut) return resolve();
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
