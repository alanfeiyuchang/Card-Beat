// Export paths:
//  - PNG sequence: frame-steps the trimmed range through the beat-anchor retiming map,
//    renders each frame through the shader (straight alpha preserved) and zips them with
//    a Unity-ready metadata JSON whose beatsSec are in OUTPUT time.
//  - Quick WebM: real-time canvas capture for a fast opaque preview (no alpha).
import { state } from './state.js';
import { Zip } from './zip.js';
import { activeAnchors, segments, srcToOut, outToSrc, outputDuration, beatPoints, hasBeatMap } from './beatmap.js';

// Resolves to true if a real seek happened, false if the video was already at `t`.
function seek(video, t) {
  return new Promise(res => {
    // Setting currentTime to the value it's already at does NOT fire 'seeked' in some
    // engines (incl. WKWebView), which would hang this forever waiting for an event that
    // never comes — exactly what happens when export starts on the frame the playhead is
    // already parked on. Short-circuit that case, and add a safety timeout so a slow/failed
    // seek (e.g. a large 4K source) can never wedge the whole export.
    if (Math.abs(video.currentTime - t) < 1e-3) { res(false); return; }
    let done;
    const timeout = setTimeout(() => { video.removeEventListener('seeked', done); res(true); }, 3000);
    done = () => { clearTimeout(timeout); video.removeEventListener('seeked', done); res(true); };
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

// 'seeked' fires when the seek is logically complete, but the browser hasn't necessarily
// PRESENTED the new decoded frame yet — capturing (texImage2D/drawImage) right after
// 'seeked' can read stale pixels (often frame 0's), which is exactly "masks move correctly
// but the picture never changes." requestVideoFrameCallback fires only once the specific
// frame has actually been handed to the compositor. Only call this after a REAL seek —
// if nothing moved, there's nothing new to present and it would wait forever; a short
// safety timeout guards against rVFC not firing for any other reason too.
function waitForFramePresented(video) {
  return new Promise(res => {
    let done = false;
    const finish = () => { if (!done) { done = true; res(); } };
    const timeout = setTimeout(finish, 500);
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => { clearTimeout(timeout); finish(); });
    } else {
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timeout); finish(); }));
    }
  });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// Chunked base64 encode — spreading a whole large Uint8Array into String.fromCharCode
// blows the call stack, so encode in 32KB pieces instead.
export function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
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
//
// Desktop app (pywebview present): writes loose files+folders straight to a chosen
// directory via the Python bridge — no zip. `writeFile(relPath, arrayBuffer)` is supplied
// by the caller (already bound to the chosen base folder) when running on desktop.
// Browser-only fallback (no filesystem access beyond single-file downloads): bundles
// everything into a .zip and triggers a normal browser download, as before.
export async function exportPngSequence(pipeline, { onProgress, shouldCancel, onFrame, drawFrame, extraFrames, extraMeta, writeFile, exportDir }) {
  const v = state.video;
  const wasRate = v.playbackRate;
  const wasLoop = v.loop;
  // Keep the decoder HOT for the whole export. WebKit releases the decode pipeline of an idle,
  // paused, off-screen <video> after a short while; past that point seeks still move
  // currentTime (a plain property) but NO new frame is decoded, so every remaining frame froze
  // on one picture while the time-indexed masks kept advancing (the "content stops updating
  // after ~frame 61" bug). A *playing* element stays actively decoded — we still seek to each
  // target frame and grab the presented frame. loop=true so it can't stall at the clip end.
  v.loop = true;
  v.playbackRate = 1;
  try { await v.play(); } catch {}
  const restore = () => { try { v.pause(); } catch {} v.loop = wasLoop; v.playbackRate = wasRate; };
  const outDur = outputDuration();
  const frameCount = Math.max(1, Math.round(outDur * state.fps));
  const zip = writeFile ? null : new Zip();
  const pad = n => String(n).padStart(4, '0');
  const put = async (name, buf) => { if (writeFile) await writeFile(name, buf); else zip.add(name, buf); };

  // WKWebView quirk: WebGL texImage2D(<video>) on a PAUSED video keeps sampling the last
  // COMPOSITED frame, not the freshly-seeked decoded one — so every exported frame froze on
  // the playhead position the export started from, while the masks (indexed by computed time)
  // advanced normally. That's the "correct mask, wrong/identical content" bug. A 2D-canvas
  // drawImage(video) DOES read the current decoded frame reliably, so we snapshot each seeked
  // frame here and hand the snapshot to the renderer instead of the live <video> element.
  const snap = document.createElement('canvas');
  const snapCtx = snap.getContext('2d');

  for (let i = 0; i < frameCount; i++) {
    if (shouldCancel && shouldCancel()) { restore(); return null; }
    const srcT = outToSrc(i / state.fps);
    const didSeek = await seek(v, Math.max(0, Math.min(srcT, state.duration - 1e-3)));
    if (didSeek) await waitForFramePresented(v);  // let the decode settle before snapshotting
    if (onFrame) await onFrame(v);
    let frameSrc = v;
    if (v.videoWidth) {
      if (snap.width !== v.videoWidth || snap.height !== v.videoHeight) {
        snap.width = v.videoWidth; snap.height = v.videoHeight;
      }
      snapCtx.drawImage(v, 0, 0, snap.width, snap.height);
      frameSrc = snap;   // upload the fresh decoded frame, not the stale composited <video>
    }
    if (drawFrame) drawFrame(frameSrc, srcT); else pipeline.render(frameSrc, state);
    const blob = await pipeline.toBlob();
    const buf = await blob.arrayBuffer();
    await put(`frames/frame_${pad(i)}.png`, buf);
    // per-object mask sequences (hand, card…) for use in the game engine
    if (extraFrames) {
      for (const f of await extraFrames(srcT, i)) await put(f.name, f.buf);
    }
    onProgress(i / frameCount, `frame ${i + 1} / ${frameCount}`);
  }

  const meta = buildMeta(frameCount, extraMeta);
  const metaBuf = new TextEncoder().encode(JSON.stringify(meta, null, 2)).buffer;
  if (writeFile) {
    onProgress(1, 'writing cardbeat.json');
    await put('cardbeat.json', metaBuf);
    meta.exportDir = exportDir;
  } else {
    zip.add('cardbeat.json', metaBuf);
    onProgress(1, 'packaging zip');
    const base = (state.videoName || 'clip').replace(/\.[^.]+$/, '');
    download(zip.blob(), `${base}_cardbeat.zip`);
  }
  restore();
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
