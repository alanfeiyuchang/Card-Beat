# Card Beat — Project Goals

## The bigger picture

The user is building a **card rhythm game**: a PaRappa-the-Rapper-style single-button rhythm
game built around real card sleight-of-hand (dealing, fans, table fans, springs, false
shuffles — not just cardistry flourishes). Core loop: a continuous performance clip plays,
the player hits a button on the beat, and success/failure is shown diegetically — miss a
beat and cards visibly drop; the win condition is "most cards still in hand at the end of
the song." This is the target Unity game. **Card Beat is the asset-prep pipeline for it**,
not the game itself.

Design decision behind the whole approach: real footage of real sleight-of-hand technique
(filmed once, stylized), not 3D-rigged/mocap'd hands. Sleight of hand's whole appeal is
precision and authenticity, which is much easier to get from real footage than from a
retargeted rig — see "Why not mocap / why not ML matting / why not Meta SAM in-browser"
below for the reasoning trail that led here.

## What Card Beat needs to do

Take one video clip of a real performer doing a move, and turn it into a **beat-synced,
stylized, alpha-cut asset** (plus per-object masks) that Unity can drop straight into the
rhythm game as an animated sprite layer, timed against the song.

Concretely, five jobs, in pipeline order:

1. **Frame it** — crop to the hands+cards, at a fixed aspect-locked output resolution.
2. **Cut out the background** — either object segmentation (SAM: separate hand vs. card
   masks, so they can be shaded/recolored independently) or simple chroma/luma keying as a
   lighter fallback.
3. **Stylize it** — a toon/cel shader (the "Just Dance" look: flat color, thick bold
   outline) applied live, not baked per-clip, so the whole move library stays visually
   consistent and is cheap to re-tune.
4. **Beat-sync it** — the hard, game-specific part. The performer's real timing rarely
   matches the song's beat grid, so the user drops **anchors** at each move's impact moment,
   and the segments between anchors are time-stretched to the *nearest whole number of
   beats* so every anchor lands exactly on a beat. This is what makes a real, un-choreographed
   performance playable as a rhythm-game clip.
5. **Export it** — a game-ready package: an alpha PNG sequence (composited + per-object
   masks), and a JSON with beat times **already converted to output-clip seconds** so Unity
   can schedule input judgement windows directly against `AudioSettings.dspTime` without
   redoing any timing math.

## Current status (as of 2026-07-19)

Built and working as a **desktop app** (`./run.sh` — pywebview window + Python backend,
not a browser tab; browser-only mode still works for editing but SAM needs the desktop app):

- Full editor: import, aspect-locked crop, chroma/luma key, live toon shader (with
  presets + user-saveable custom looks), undo/redo, settings persist across sessions.
- **SAM object segmentation**: SAM 2.1 (click points, tiny model default — fast, no
  license gate) is the primary path; SAM 3.1 (text prompts, no clicking) works but is
  ~45s/frame on this hardware and its weights are gated behind a Meta HF license, so it's
  offered as a slower alternative, not the default. Per-point independent tracking (fixes
  "second hand always fails" when two points land on two separate objects). Fast
  single-frame **preview** before committing to a full (slow) clip track. Per-object layers
  with independent tint/outline/show-hide, plus a background show/hide toggle.
- **Beat-anchor retiming**: drag/place anchors on the timeline, nearest-whole-beat
  stretching between them, live Web Audio metronome, export bakes the retiming into the
  frame sequence and ships beat times in output-clip seconds.
- **Export**: composited PNG sequence + separate per-object mask sequences (for further
  in-engine recoloring/effects) + `cardbeat.json` (v2: beats, segments, per-layer styles).
- UI is a 4-tab workflow: Cut → Objects → Style → Beat.
- Tracked on GitHub: `https://github.com/alanfeiyuchang/Card-Beat.git`.

## Decisions already made (don't re-litigate without new information)

- **Real video + live shader, not mocap/rigged 3D hands.** Authenticity of real sleight of
  hand matters more than the interactivity a rig would buy; the "miss = cards drop" feedback
  is a decoupled overlay in-game, not baked into the base clip, so this doesn't cost
  interactivity.
- **SAM, not ML matting, not in-browser SAM.** Matting gives one undifferentiated foreground
  alpha — can't separate hand from card. SAM is promptable per-object with video tracking,
  but needs a Python backend, which is why Card Beat is a desktop app (pywebview + Python),
  not a pure browser tool.
- **SAM 2.1 default over SAM 3.1.** SAM 3's text prompts are more convenient (no clicking,
  auto-multi-instance) but ~90x slower on this hardware and gated behind manual HF approval.
  SAM 2.1 tiny is the practical default; SAM 3.1 stays available for when speed doesn't matter
  or access/hardware improves.
- **Not rebuilding this editor inside Unity.** Considered; the shader logic would port
  cleanly to HLSL, but the custom timeline/crop/beat-anchor UI would need a full rewrite in
  Unity's Editor UI Toolkit (much clunkier for canvas-heavy tools than HTML5 canvas) for
  several days of work, and SAM would still need an external Python process either way.
  Current file-based handoff (export PNG+JSON, import into Unity) is a clean enough boundary
  unless a concrete pain point (workflow friction vs. wanting live preview against real game
  materials) justifies it later — revisit only if that pain point becomes real.

## Known limits / open items

- Background removal without SAM is chroma/luma keying only (needs a deliberately plain
  filming backdrop).
- No alpha video export (WebM VP8 alpha) — PNG sequence is the reliable alpha path today.
- SAM 3.1 speed is a hardware/ops-support ceiling, not something fixable from the app side.

## Unity side (built 2026-07-20)

The companion Unity project (`Card Beat/Card Beat`, Unity 6, URP 2D) now consumes the export
package. All code lives under `Assets/CardBeat/` (namespace `CardBeat`):

- **Importer** (`Card Beat ▸ Import Package (.zip)…` / `Import Extracted Folder…`): extracts
  frames + per-object masks, applies sprite import settings, parses `cardbeat.json` v2 into a
  `CardBeatClipAsset` (frames, beatsSec/beatsAccent, layers).
- **Chart editor** (`Card Beat ▸ Chart Editor`): song waveform + BPM/offset beat grid with
  snap divisions, tap tempo, zoom/pan/scrub, edit-mode playback with metronome, clip events
  placed on the timeline whose **anchors auto-generate notes** (with bake-to-editable-notes),
  manual note editing, judgement-window/card-rule tuning, Unity Undo, Test Play.
- **Runtime**: dspTime `Conductor`, sprite-sequence `ClipSequencePlayer`, single-button
  `JudgementSystem` (Perfect/Good/Miss, combo/score, autoplay), PaRappa-style `NoteLane`,
  programmatic `GameHUD`, and `CardDropEffect` — the diegetic "miss = cards tumble" feedback;
  win condition is cards remaining. `RhythmGameManager` bootstraps the whole scene.
- **Demo content** (`Card Beat ▸ Create Demo Content`): synthesizes a fake cardbeat package
  (also an importer end-to-end test), bakes a procedural WAV, builds a playable demo chart.

Verified in-editor via MCP: clean compile, autoplay full-combo run, miss run with card drops,
importer round-trip (288 frames, 7 anchors, 1 mask layer).
