"""SAM video segmentation backend for Card Beat.

Runs Meta's Segment Anything (SAM 3 / 3.1 preferred, SAM 2 fallback) over a clip and
writes one 8-bit PNG mask sequence per concept ("hand", "playing card") so the editor can
shade each object separately and independently recolor them.

Design:
  segment_video(video, concepts, out_dir, fps) ->
      out_dir/<slug>/frame_0000.png ...        (grayscale masks, 0 or 255, source-sized)
      manifest.json                            (concepts, fps, size, per-concept frame list)

IMPORTANT — the single SAM inference call is isolated in `_masks_for_frame()`.  The exact
ultralytics prompt API differs between SAM2 (point/box prompts) and SAM3 (text/concept
prompts) and across ultralytics versions.  If your version errors there, that one method is
the only thing to adjust.  This file was NOT executed in the dev sandbox — validate on your
machine (Apple Silicon MPS or CPU).
"""
from __future__ import annotations
import os
import json
import re
from pathlib import Path

# SAM3 triggers torch.compile, which needs a full C++ toolchain (missing SDK headers here);
# disable it so it runs in eager mode instead of erroring on JIT compilation.
os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


# SAM3 is heavy to load (~1 min); cache the text predictor so preview + track reuse it.
_SAM3_SEMANTIC = {}


def _get_sam3_semantic(weights):
    if weights not in _SAM3_SEMANTIC:
        from ultralytics.models.sam import SAM3SemanticPredictor
        _SAM3_SEMANTIC[weights] = SAM3SemanticPredictor(overrides=dict(
            model=weights, task="segment", mode="predict", imgsz=1024, save=False, verbose=False))
    return _SAM3_SEMANTIC[weights]


class SamBackend:
    def __init__(self, model: str = "sam3.pt", device: str | None = None):
        self.model_name = model
        self.device = device          # 'mps' | 'cpu' | 'cuda' | None (auto)
        self.model = None

    def _resolve_weights(self):
        """SAM2.x auto-downloads from ultralytics. SAM3 weights are GATED on Hugging Face —
        accept the license at https://huggingface.co/facebook/sam3 and run
        `huggingface-cli login` once; then this pulls sam3.pt for you."""
        if Path(self.model_name).exists():
            return self.model_name
        if "sam3" in self.model_name.lower():
            from huggingface_hub import hf_hub_download
            try:
                return hf_hub_download(repo_id="facebook/sam3", filename="sam3.pt")
            except Exception as e:
                raise RuntimeError(
                    "SAM3 weights are gated. 1) Accept access at "
                    "https://huggingface.co/facebook/sam3 (click 'Agree and access')  "
                    "2) run `./.venv/bin/hf auth login` and paste a token, then retry. "
                    "Note: SAM3 access is manually approved, so it may not be instant. "
                    f"(underlying: {e})"
                )
        return self.model_name  # e.g. sam2.1_b.pt -> ultralytics GitHub assets

    def load(self):
        from ultralytics import SAM
        self.is_sam3 = "sam3" in self.model_name.lower()
        self.model = SAM(self._resolve_weights())
        return {"model": self.model_name}

    def _parse_named_masks(self, r, concepts, slugs, H, W):
        """Route a Results object's masks to concepts by matching detected class names."""
        import numpy as np, cv2
        out = {c: np.zeros((H, W), dtype=bool) for c in concepts}
        masks = getattr(r, "masks", None)
        if masks is None:
            return out
        data = masks.data.cpu().numpy()
        names = getattr(r, "names", {}) or {}
        boxes = getattr(r, "boxes", None)
        cls = boxes.cls.cpu().numpy().astype(int) if boxes is not None else [None] * len(data)
        for i, m in enumerate(data):
            label = names.get(cls[i]) if (isinstance(names, dict) and cls[i] is not None) else None
            target = None
            if label:
                for c in concepts:
                    if _slug(c) in _slug(str(label)) or _slug(str(label)) in _slug(c):
                        target = c
                        break
            if target is None:
                target = concepts[i] if i < len(concepts) else concepts[-1]
            if m.shape != (H, W):
                m = cv2.resize(m.astype("uint8"), (W, H), interpolation=cv2.INTER_NEAREST)
            out[target] |= (m > 0.5)
        return out

    def segment_video(self, video_path, concepts, out_dir, fps=30, points=None,
                      trim_start=None, trim_end=None, prompt_times=None,
                      max_seconds=None, progress=None):
        """points: {concept: [x, y]} in SOURCE-pixel coords (required for SAM2).
        trim_start/trim_end (seconds): only this range is segmented (faster; masks aligned to it).
        prompt_times: {concept: seconds} — the frame each object's points were marked on;
        SAM2 tracks both forward and backward from it."""
        import cv2

        self.is_sam3 = "sam3" in self.model_name.lower()
        out_dir = Path(out_dir)
        slugs = {c: _slug(c) for c in concepts}
        for c in concepts:
            (out_dir / slugs[c]).mkdir(parents=True, exist_ok=True)

        cap = cv2.VideoCapture(str(video_path))
        src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        cap.release()

        if self.is_sam3:
            counts, out_fps, frame_times = self._run_sam3_text(
                video_path, concepts, slugs, out_dir, fps, max_seconds, src_fps, total, W, H,
                trim_start, trim_end, progress)
        else:
            counts, out_fps, frame_times = self._run_sam2_points(
                video_path, concepts, slugs, out_dir, points or {}, src_fps, total, H, W,
                trim_start, trim_end, prompt_times or {}, progress)

        manifest = {
            "tool": "Card Beat SAM",
            "model": self.model_name,
            "video": str(video_path),
            "fps": out_fps,
            "width": W,
            "height": H,
            "sourceFps": src_fps,
            # exact per-frame source timestamps (seconds) — avoids fps-report drift / VFR
            "frameTimes": [round(t, 4) for t in frame_times],
            "concepts": [
                {"name": c, "slug": slugs[c], "frameCount": counts.get(c, 0), "dir": slugs[c]}
                for c in concepts
            ],
        }
        (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
        return manifest

    def _frame_timestamps(self, video_path):
        """Actual per-frame presentation times (seconds) — decoded, so correct for VFR /
        mis-reported fps."""
        import cv2
        cap = cv2.VideoCapture(str(video_path))
        ts = []
        while cap.grab():
            ts.append(cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0)
        cap.release()
        return ts

    def _run_sam3_text(self, video_path, concepts, slugs, out_dir, fps, max_seconds,
                       src_fps, total, W, H, trim_start, trim_end, progress):
        # SAM3 semantic (text) per frame: detects every instance of each concept and merges
        # them per name (so both hands -> one "hand" layer). No points needed. Slow but works.
        import cv2
        from PIL import Image
        weights = self._resolve_weights()
        predictor = _get_sam3_semantic(weights)  # cached, text/concept prompts
        t0 = trim_start or 0.0
        t1 = trim_end if trim_end else ((total / src_fps) if total else (max_seconds or 0))
        if max_seconds:
            t1 = min(t1, t0 + max_seconds)
        n_out = max(1, int(round((t1 - t0) * fps)))
        counts = {c: 0 for c in concepts}
        frame_times = []
        cap = cv2.VideoCapture(str(video_path))
        for i in range(n_out):
            cap.set(cv2.CAP_PROP_POS_MSEC, (t0 + i / fps) * 1000.0)
            ok, frame = cap.read()
            if not ok:
                break
            frame_times.append(cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0)
            predictor.set_prompts({"text": list(concepts)})
            r = predictor(frame)[0]
            masks = self._parse_named_masks(r, concepts, slugs, H, W)
            for c in concepts:
                Image.fromarray((masks[c].astype("uint8")) * 255, "L").save(
                    out_dir / slugs[c] / f"frame_{i:04d}.png")
                counts[c] += 1
            if progress:
                progress({"stage": "segment", "frame": i + 1, "total": n_out})
        cap.release()
        return counts, fps, frame_times

    def preview_text(self, video_path, concepts, frame_time, out_dir):
        """Single-frame SAM3 semantic (text) preview at frame_time — no points."""
        import cv2
        from PIL import Image
        weights = self._resolve_weights()
        predictor = _get_sam3_semantic(weights)
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        cap = cv2.VideoCapture(str(video_path))
        cap.set(cv2.CAP_PROP_POS_MSEC, (frame_time or 0) * 1000.0)
        ok, frame = cap.read()
        cap.release()
        if not ok:
            return []
        H, W = frame.shape[:2]
        slugs = {c: _slug(c) for c in concepts}
        predictor.set_prompts({"text": list(concepts)})
        r = predictor(frame)[0]
        masks = self._parse_named_masks(r, concepts, slugs, H, W)
        items = []
        for c in concepts:
            Image.fromarray((masks[c].astype("uint8")) * 255, "L").save(out_dir / f"{slugs[c]}.png")
            items.append({"name": c, "slug": slugs[c], "time": round(frame_time or 0, 4)})
        return items

    def preview_points(self, video_path, concepts, points, prompt_times, out_dir):
        """Fast single-frame SAM2 image segmentation on each object's marked frame, so the
        user can confirm the points are right before the slow full-video track.
        Returns [{name, slug, time, url-less}] and writes out_dir/<slug>.png masks."""
        import cv2
        import numpy as np
        from PIL import Image
        from ultralytics import SAM

        model = SAM(self._resolve_weights())
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        items = []
        for c in concepts:
            pts = points.get(c) or points.get(_slug(c))
            if not pts:
                continue
            if pts and not isinstance(pts[0], (list, tuple)):
                pts = [pts]
            pt_list = [[float(x), float(y)] for x, y in pts]
            labels = [1] * len(pt_list)
            pt_t = (prompt_times or {}).get(c) or 0.0
            cap = cv2.VideoCapture(str(video_path))
            cap.set(cv2.CAP_PROP_POS_MSEC, pt_t * 1000.0)
            ok, frame = cap.read()
            cap.release()
            if not ok:
                continue
            H, W = frame.shape[:2]
            r = model(frame, points=pt_list, labels=labels, verbose=False)[0]
            m = (r.masks.data[0].cpu().numpy() if getattr(r, "masks", None) is not None
                 and len(r.masks.data) else np.zeros((H, W)))
            if m.shape != (H, W):
                m = cv2.resize(m.astype("uint8"), (W, H), interpolation=cv2.INTER_NEAREST)
            slug = _slug(c)
            Image.fromarray(((m > 0.5).astype("uint8")) * 255, "L").save(out_dir / f"{slug}.png")
            items.append({"name": c, "slug": slug, "time": round(pt_t, 4)})
        return items

    def _extract_segment(self, video_path, t0, t1, src_fps, W, H):
        """Write frames in [t0, t1] to a temp mp4 so SAM tracks only the trimmed range.
        Returns (source_path, frame_times_in_original_timeline, is_temp)."""
        import cv2, tempfile
        if not t0 and not t1:
            return str(video_path), self._frame_timestamps(video_path), False
        tmp = tempfile.NamedTemporaryFile(prefix="cb_seg_", suffix=".mp4", delete=False)
        tmp.close()
        writer = cv2.VideoWriter(tmp.name, cv2.VideoWriter_fourcc(*"mp4v"), src_fps or 30.0, (W, H))
        cap = cv2.VideoCapture(str(video_path))
        if t0:
            cap.set(cv2.CAP_PROP_POS_MSEC, t0 * 1000.0)
        times = []
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            if t1 and t > t1 + 1e-3:
                break
            writer.write(frame)
            times.append(t)
        cap.release(); writer.release()
        return tmp.name, times, True

    def _run_sam2_points(self, video_path, concepts, slugs, out_dir, points,
                         src_fps, total, H, W, trim_start, trim_end, prompt_times, progress):
        """Per object: prompt SAM2 on the marked frame and track BOTH forward and backward
        by running two passes (frames K..end, and K..0 reversed), over the trimmed range."""
        import cv2, os, shutil, tempfile
        import numpy as np
        from PIL import Image
        from ultralytics.models.sam import SAM2VideoPredictor

        weights = self._resolve_weights()
        work = Path(tempfile.mkdtemp(prefix="cb_seg_"))
        frames_dir = work / "frames"; frames_dir.mkdir()

        # extract the trimmed frames once (JPEGs), recording real timestamps
        frame_times = []
        cap = cv2.VideoCapture(str(video_path))
        if trim_start:
            cap.set(cv2.CAP_PROP_POS_MSEC, trim_start * 1000.0)
        idx = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            if trim_end and t > trim_end + 1e-3:
                break
            cv2.imwrite(str(frames_dir / f"{idx:05d}.jpg"), frame)
            frame_times.append(t); idx += 1
        cap.release()
        N = idx

        def write_subvideo(order, path):
            w = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), src_fps or 30.0, (W, H))
            for j in order:
                w.write(cv2.imread(str(frames_dir / f"{j:05d}.jpg")))
            w.release()

        def run_pass(subpath, pt_list, labels):
            ov = dict(conf=0.25, task="segment", mode="predict", imgsz=1024,
                      model=weights, verbose=False, save=False)
            pred = SAM2VideoPredictor(overrides=ov)
            out = []
            for r in pred(source=str(subpath), points=pt_list, labels=labels):
                m = (r.masks.data[0].cpu().numpy() if getattr(r, "masks", None) is not None
                     and len(r.masks.data) else np.zeros((H, W)))
                if m.shape != (H, W):
                    m = cv2.resize(m.astype("uint8"), (W, H), interpolation=cv2.INTER_NEAREST)
                out.append(((m > 0.5).astype("uint8")) * 255)
            return out

        counts = {}
        try:
            for c in concepts:
                pts = points.get(c) or points.get(slugs[c])
                if not pts:
                    raise RuntimeError(f"No point set for '{c}'. Click the object in the preview first.")
                if pts and not isinstance(pts[0], (list, tuple)):
                    pts = [pts]
                pt_list = [[float(x), float(y)] for x, y in pts]
                labels = [1] * len(pt_list)

                # frame index within the trimmed range where this object was marked
                pt_t = prompt_times.get(c) if prompt_times else None
                K = 0 if pt_t is None or not N else min(range(N), key=lambda j: abs(frame_times[j] - pt_t))

                full = [None] * N
                fwd = list(range(K, N))
                write_subvideo(fwd, work / "fwd.mp4")
                for oi, m in enumerate(run_pass(work / "fwd.mp4", pt_list, labels)):
                    if oi < len(fwd):
                        full[fwd[oi]] = m
                if K > 0:
                    bwd = list(range(K, -1, -1))
                    write_subvideo(bwd, work / "bwd.mp4")
                    for oi, m in enumerate(run_pass(work / "bwd.mp4", pt_list, labels)):
                        if oi < len(bwd):
                            full[bwd[oi]] = m

                for j in range(N):
                    m = full[j] if full[j] is not None else np.zeros((H, W), dtype="uint8")
                    Image.fromarray(m, "L").save(out_dir / slugs[c] / f"frame_{j:04d}.png")
                    if progress and j % 5 == 0:
                        progress({"stage": f"track {c}", "frame": j + 1, "total": N})
                counts[c] = N
        finally:
            shutil.rmtree(work, ignore_errors=True)

        n_masks = min(counts.values()) if counts else 0
        return counts, src_fps, frame_times[:n_masks] if n_masks else frame_times
