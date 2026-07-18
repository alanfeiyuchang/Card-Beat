# Card Beat

A browser-based clip editor for a card **rhythm game**. Import raw footage of a sleight-of-hand
move (deal, fan, table fan, spring, false shuffle…), isolate the hands + cards, stylize with a
toon shader, align it to a beat grid, and export a game-ready, alpha-cut PNG sequence + timing JSON.

No build step, no framework. WebGL2 for the shader pipeline, Web Audio for the waveform,
a pure-JS ZIP writer for export.

## Run

### Desktop app (recommended — enables SAM object segmentation)

```bash
cd "Card Beat"
./run.sh           # first run makes a venv + installs torch/ultralytics/pywebview (large)
```

Opens a native window. Use the **SAM segmentation (desktop)** panel: *Open video* → set concepts
(`hand, playing card`) → *Run SAM*. It segments each object across the clip and loads them as
**separate layers** you can shade/tint independently. Works on Apple Silicon (MPS) or CPU.

### Model weights

- **SAM 2.1** (`sam2.1_b.pt`) auto-downloads from ultralytics — but it's *point/box*-promptable,
  not text. (Click-prompt UI is not wired yet, so text concepts won't work with it.)
- **SAM 3.1** (`sam3.pt`) is what enables the `hand` / `playing card` **text** prompts, but its
  weights are **gated**. One-time setup inside the venv:
  ```bash
  # 1. Request access in a browser (click "Agree and access"):
  open https://huggingface.co/facebook/sam3
  # 2. Log in (paste an HF token from huggingface.co/settings/tokens):
  ./.venv/bin/hf auth login
  ```
  After access is granted, *Run SAM* downloads `sam3.pt` automatically and text prompts work.
  Note: `facebook/sam3` is **manually gated**, so access approval may not be instant.

Verified on this machine: torch 2.13 + MPS available; SAM 2.1 downloads & runs; `facebook/sam3`
exists on HF but is gated (needs the login above).

### Browser-only (editor + shader, no SAM)

```bash
npm start          # serves on http://localhost:5173 via `npx serve`
```

Then open http://localhost:5173. (Must be http — ES modules won't load from `file://`.
`python3 -m http.server 5173` also works.) The browser build has the full editor + toon shader +
export, plus the in-browser matting fallback, but not SAM object separation (that needs the app).

## Workflow

1. **Import video** — top-left. Loads the clip, decodes its audio into the timeline waveform.
2. **Frame & Crop** — tick *Show crop tool*, drag the box to isolate the hands. Set output W/H
   (defaults to source aspect capped at 512px; *Square to crop* for a square sprite).
3. **Background removal** — for a clean cut, film on a solid backdrop:
   - *Chroma key* + **Eyedrop** (click the backdrop in the preview) for greenscreen.
   - *Remove dark / light background* for a plain black or white cloth.
   Tune Threshold / Softness; *Spill kill* desaturates leftover key-color fringing.
4. **Toon shader** — color bands, Sobel edge thickness/threshold, edge color, and color grade.
5. **Beats & timing** — set BPM (or **Tap**), place *First beat* at the playhead, choose speed
   (retimes the move to feel on-beat), set export FPS, and trim in/out on the timeline.
6. **Export PNG sequence + JSON** — frame-steps the trimmed range, bakes the shader (straight
   alpha preserved), and downloads `<clip>_cardbeat.zip` containing `frames/frame_0000.png…`
   and `cardbeat.json`. *Quick WebM* is a fast opaque preview only (MediaRecorder drops alpha).

## Output → Unity

`cardbeat.json` schema (all timing already converted to **output-clip time** in seconds):

```jsonc
{
  "output": { "width", "height", "fps", "frameCount", "format": "png-sequence-rgba" },
  "trim": { "inSec", "outSec" }, "playbackRate", "durationOutSec",
  "tempo": { "bpm", "beatsPerBar", "firstBeatSrcSec" },
  "beatsSec": [ /* beat times to schedule input windows against */ ],
  "shader": { /* the exact params used, for reproducibility */ }
}
```

Recommended Unity path:
- Import `frames/` as **Sprites (2D, alpha)**; play as a flipbook at `output.fps`, or assemble into
  a sprite-sheet / `Texture2DArray`.
- Load `cardbeat.json`; drive the rhythm timing from `beatsSec` against `AudioSettings.dspTime`
  (schedule hit-windows on those timestamps — do **not** use frame time).
- On a missed beat, trigger the "card drops" overlay VFX separately; the flipbook keeps playing
  underneath (see the game design notes — fail feedback is decoupled from the base clip).

## Notes / limits

- Background removal is shader keying (chroma / luma), which is why deliberate filming on a solid
  backdrop matters. No ML segmentation yet — that would be the upgrade path for messy backgrounds.
- PNG-sequence export is frame-accurate but heavier than video; keep clips short (a move is 1–3s).
- Alpha video (WebM VP8 alpha) export is a possible future addition; PNG sequence is the reliable
  alpha path into Unity today.
