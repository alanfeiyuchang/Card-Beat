# Card Beat

Browser-based clip editor that prepares real footage of card sleight-of-hand moves (deal, fan,
table fan, spring, false shuffle…) for a **card rhythm game**. Import video → crop/frame →
background-key + toon shader → beat-align & retime → export alpha PNG sequence + timing JSON for Unity.

Companion to the game itself. This tool solves the "how do we get stylized, background-free,
beat-aligned move clips into the engine" pipeline. Chosen approach: **pre-processed video + live
toon shader** (not mocap-to-rig), because sleight-of-hand fidelity is the whole appeal and real
footage preserves it; background removal is deliberate-filming + shader keying.

## Stack

Zero build step, no framework. Plain ES modules served over http.
- WebGL2 shader pipeline (crop → color grade → background key → toon quantize + Sobel edge), one pass.
- Web Audio API decodes the clip's audio into the timeline waveform.
- Pure-JS store-only ZIP writer (no deps) bundles the PNG sequence + JSON.

## Run

`npm start` (→ `npx serve` on :5173) or `python3 -m http.server 5173`. Must be http, not file://.

## Files

- `index.html` / `css/styles.css` — UI shell (preview + timeline left, control panels right).
- `js/state.js` — single source of truth + pub/sub; `beatTimes()` derives the beat grid.
- `js/segment.js` — lazy Transformers.js (CDN) ML foreground matting → grayscale mask canvas.
- `js/shaders.js` — GLSL. `js/pipeline.js` — WebGL2 renderer + mask texture + `toBlob()` + eyedropper.
- `js/timeline.js` — waveform/beat-grid/trim/playhead canvas + scrub & drag-trim.
- `js/crop.js` — drag crop overlay, **aspect-locked to output** (no stretching); `fitAspect`/`maxFit`.
- `js/history.js` — undo/redo over the editable state slice; one step per committed change.
- `js/audio.js` — waveform decode + tap-tempo.
- `js/zip.js` — store-only ZIP. `js/exporters.js` — PNG-sequence (alpha) + quick WebM + `buildMeta`.
- `js/main.js` — wiring + render loop.

## Look

Default toon look is **Just Dance**: near-flat color (few bands), thick bold ink outline
(`edgeGain` pushes the Sobel edge toward solid), punchy saturation. Preset buttons in the Toon
panel: Just Dance / Comic ink / Flat 2-tone.

## Beat anchors (rhythm-game retiming — core feature)

`js/beatmap.js`. The user drops anchors (B key / button; red flags on the timeline, draggable,
dbl-click deletes) at move-impact moments. Consecutive anchors are retimed to the NEAREST whole
number of beats (min 1) at `beatLen` s/beat, so every anchor lands exactly on a beat in output
time (e.g. beatLen 2, anchors 2/4.5/8 → seg1 2.5s→2s @1.25×, seg2 3.5s→4s @0.875×). Playback
applies per-segment `video.playbackRate` live; a Web Audio metronome clicks at beat points
(accent = anchors). PNG export frame-steps through `outToSrc(i/fps)` so the retiming is baked
into the frames; `cardbeat.json` v2 ships `beatsSec` (OUTPUT time), accents, anchors, and the
piecewise segment map. With <2 anchors the legacy uniform `playbackRate` applies. Anchors are
clip-specific (reset on import, in undo history, not persisted).

## UI layout

Right panel is 4 workflow tabs: 1·Cut (trim readout, crop) · 2·Objects (SAM) · 3·Style (layers,
toon, background-removal fallback) · 4·Beat (anchors, beatLen+BPM, metronome, preview speed,
export fps). Shortcuts: Space play, B add anchor, ←/→ frame-step (⇧×10), ⌘Z/⌘⇧Z undo/redo.

## Editing UX

- **Undo/redo** — toolbar buttons + ⌘Z / ⌘⇧Z. Steps commit on control release, crop/trim
  drag-end, and button actions (not on every live slider tick).
- **Crop** — aspect-locked to output so exports never stretch; *Reset* = max centered crop,
  *Square output* makes output square + refits, *Apply crop* finalizes & closes the tool.

## Output contract (what Unity consumes)

`<clip>_cardbeat.zip` = `frames/frame_NNNN.png` (RGBA, straight alpha) + `cardbeat.json`.
JSON timing is in **output-clip seconds**; `beatsSec` is the array to schedule input windows
against `AudioSettings.dspTime`. Miss feedback ("card drops") is a separate overlay, not baked in.

## Verified

Headless Chrome load: WebGL2 + both shaders compile/link, all panels render, export gated until a
clip loads. ZIP writer output passes `unzip -t` integrity + extracts correctly.

## Desktop app + SAM object separation (the real reason it's not browser-only)

`app.py` (pywebview) hosts the exact same WebGL editor in a **native window** and exposes a
Python↔JS bridge; `sam_backend.py` runs **SAM via ultralytics** over the whole clip, writing one
PNG mask sequence per object. Two paths (`segment_video` branches on model):
- **SAM 2.1 (default, Apache-2.0, auto-downloads)** — `SAM2VideoPredictor`, one tracked pass per
  object from a **click point** (`_run_sam2_points`). This is the working, verified path: the user
  clicks the hand and the card in the preview ("Set object points"), each is tracked across all
  frames. Verified end-to-end on a real clip (302 tracked masks/object, frame-varying coverage).
- **SAM 3.1 (text prompts, gated)** — `_run_sam3_text`, `text=["hand","playing card"]`; weights
  gated on HF (`facebook/sam3`, manual approval) so it needs `hf auth login` first.
Env note: `huggingface-cli` is deprecated → use `hf auth login`.
The editor loads those as **object layers** (`js/layers.js`) — each with its own toon shader +
`tint` — composited via alpha blending (`pipeline.render(..., clear=false)`), so the card can be
recolored/re-shaded independently of the hand. Run: `./run.sh` (venv + torch/ultralytics/pywebview).

Verified locally: Python compiles; two-layer composite with independent tints renders correctly
(red layer + blue layer) in headless WebGL; SAM panel + tint control present; no errors. **NOT run
in sandbox:** the pywebview GUI launch, WKWebView WebGL2, and actual SAM inference (needs weights +
MPS/CPU). The one version-specific risk is `sam_backend._masks_for_frame` — the ultralytics
SAM3/SAM2 prompt API; it's isolated so it's the only thing to tweak if the model call errors.

Why not Meta SAM in the browser / why not matting: matting gives ONE foreground alpha (can't split
hand vs card); SAM is promptable per-object with tracking but needs Python. Hence the desktop pivot.

## ML segmentation stage (runs first, browser fallback)

Optional pre-shader stage in `segment.js`: a Transformers.js foreground/matting model (default
RMBG-1.4; MODNet alt) produces a per-frame alpha mask that removes everything but the hands+cards,
then the shader toon-shades only the kept region. WebGPU when available, else WASM. Preview
segments the paused/seeked frame (debounced); export re-segments every frame (slow but accurate).
`shader` mask path (mask.r → alpha) is verified with a synthetic mask; **live model inference was
not run in the dev sandbox** (needs a real browser + internet for the first weight download) — the
RMBG tensor-handling glue follows the canonical Transformers.js example and may need a tweak per
model. NOT Meta SAM: SAM/SAM2 are promptable and SAM2-video needs a GPU backend, so a matting model
is the right in-browser tool for automatic per-frame hand+card isolation. Licensing: RMBG-1.4 is
non-commercial; use MODNet/BiRefNet (Apache-2.0) for a commercial game.

## Known limits / upgrade paths

- Chroma/luma keying still available as a lighter alternative to ML segmentation.
- Alpha video (WebM VP8 alpha) export not implemented; PNG sequence is the reliable alpha path.
- Quick WebM export is opaque (MediaRecorder drops alpha) — preview only.
