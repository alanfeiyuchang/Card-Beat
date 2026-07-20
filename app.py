"""Card Beat — native desktop app.

Hosts the WebGL editor UI in a real window (pywebview) and exposes a Python bridge that
runs SAM segmentation natively. The editor stays exactly as the browser version; the app
just adds `window.pywebview.api.*` so it can pick a video and run SAM locally.

Run:
    python3 -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    python app.py

The SAM step needs model weights (downloaded by ultralytics on first run) and works on
Apple Silicon (MPS) or CPU. NOT executed in the dev sandbox — validate locally.
"""
import os
import shutil
import tempfile
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import webview

ROOT = Path(__file__).parent.resolve()
MEDIA = Path(tempfile.gettempdir()) / "cardbeat_media"
MEDIA.mkdir(exist_ok=True)
PORT = 8777


class Handler(SimpleHTTPRequestHandler):
    """Serve the app from ROOT, and /media/* from the temp media dir (video + masks)."""
    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/media/"):
            return str(MEDIA / clean[len("/media/"):])
        return str(ROOT / clean.lstrip("/"))

    def log_message(self, *a):  # quiet
        pass


def serve():
    ThreadingHTTPServer.allow_reuse_address = True
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


class Api:
    def __init__(self):
        self.video_path = None
        self.status = "idle"
        self.progress = {"frame": 0, "total": 0, "stage": "idle"}
        self.backend = None
        self.sam_thread = None
        self.sam_result = None

    def get_status(self):
        return self.status

    def get_progress(self):
        return self.progress

    def pick_video(self):
        win = webview.windows[0]
        res = win.create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=False,
            file_types=("Video (*.mp4;*.mov;*.m4v;*.webm;*.avi)", "All files (*.*)"),
        )
        if not res:
            return None
        src = res[0]
        self.video_path = src
        name = Path(src).name
        dst = MEDIA / name
        if not dst.exists():
            try:
                os.symlink(src, dst)
            except OSError:
                shutil.copy(src, dst)
        return {"path": src, "url": f"/media/{name}", "name": name}

    def run_sam(self, concepts, fps=30, model="sam3.pt", points=None,
                trim_start=None, trim_end=None, prompt_times=None, max_seconds=None):
        """Runs SAM on a BACKGROUND thread and returns immediately so get_progress()
        polls stay responsive. Frontend polls get_progress until stage 'done'/'error',
        then calls get_result(). points: {concept:[x,y]} source-px; trim_* in seconds;
        prompt_times: {concept: seconds} the frame each object was marked on."""
        if not self.video_path:
            return {"error": "no video selected"}
        if self.sam_thread and self.sam_thread.is_alive():
            return {"error": "a segmentation is already running"}
        self.sam_result = None
        self.status = "starting"
        self.progress = {"frame": 0, "total": 0, "stage": "starting"}
        self.sam_thread = threading.Thread(
            target=self._sam_job,
            args=(list(concepts), fps, model, points, trim_start, trim_end, prompt_times, max_seconds),
            daemon=True,
        )
        self.sam_thread.start()
        return {"started": True}

    def _sam_job(self, concepts, fps, model, points, trim_start, trim_end, prompt_times, max_seconds):
        from sam_backend import SamBackend
        try:
            self.progress = {"frame": 0, "total": 0, "stage": f"loading {model}"}
            self.backend = SamBackend(model=model)
            out = MEDIA / "masks"
            if out.exists():
                shutil.rmtree(out)

            def prog(p):
                self.progress = {"frame": p["frame"], "total": p["total"],
                                 "stage": p.get("stage", "segment")}
                self.status = f"{p.get('stage','segment')} {p['frame']}/{p['total']}"

            manifest = self.backend.segment_video(
                self.video_path, concepts, out, fps=fps, points=points,
                trim_start=trim_start, trim_end=trim_end, prompt_times=prompt_times,
                max_seconds=max_seconds, progress=prog,
            )
            manifest["baseUrl"] = "/media/masks"
            self.sam_result = manifest
            self.status = "done"
            self.progress = {"frame": 1, "total": 1, "stage": "done"}
        except Exception as e:  # surface to the UI instead of dying silently
            self.status = f"error: {e}"
            self.sam_result = {"error": str(e)}
            self.progress = {"frame": 0, "total": 0, "stage": "error"}

    def get_result(self):
        return self.sam_result

    def preview_sam(self, concepts, points, prompt_times=None, model="sam2.1_b.pt", frame_time=0.0):
        """Single-frame preview: SAM2 uses the click points; SAM3 uses text at frame_time."""
        from sam_backend import SamBackend
        if not self.video_path:
            return {"error": "no video selected"}
        try:
            b = SamBackend(model=model)
            out = MEDIA / "preview"
            if out.exists():
                shutil.rmtree(out)
            if "sam3" in model:
                items = b.preview_text(self.video_path, list(concepts), frame_time or 0.0, out)
            else:
                items = b.preview_points(self.video_path, list(concepts), points or {},
                                         prompt_times or {}, out)
            for it in items:
                it["url"] = f"/media/preview/{it['slug']}.png"
            return {"items": items}
        except Exception as e:
            return {"error": str(e)}


if __name__ == "__main__":
    threading.Thread(target=serve, daemon=True).start()
    webview.settings["ALLOW_DOWNLOADS"] = True   # export ZIP/WebM = browser-style download
    api = Api()
    webview.create_window("Card Beat", f"http://127.0.0.1:{PORT}/index.html",
                          js_api=api, width=1440, height=900)
    webview.start()
