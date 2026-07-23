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
import re
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
    """Serve the app from ROOT, and /media/* from the temp media dir (video + masks).

    Adds HTTP Range support. This is NOT optional: WKWebView (and browsers generally) treat a
    served <video> as SEEKABLE only if the server honours byte-range requests. Without it,
    setting video.currentTime silently does nothing — so PNG export, which seeks the video to
    each output frame, was capturing frame 0 for the whole clip (masks advanced from computed
    time, but the picture never did). SimpleHTTPRequestHandler has no Range support, hence this.
    """
    protocol_version = "HTTP/1.1"

    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/media/"):
            return str(MEDIA / clean[len("/media/"):])
        return str(ROOT / clean.lstrip("/"))

    def log_message(self, *a):  # quiet
        pass

    def end_headers(self):
        # Never let WKWebView serve stale JS/HTML from cache — otherwise editing js/*.js and
        # relaunching can still run the OLD code, which makes "did my fix take effect?" impossible
        # to reason about. Force a fresh fetch of every asset on each load.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def send_head(self):
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        if not rng or not os.path.isfile(path):
            self._range_remaining = None
            return super().send_head()
        m = re.match(r"bytes=(\d*)-(\d*)\s*$", rng.strip())
        if not m:
            self._range_remaining = None
            return super().send_head()
        try:
            size = os.path.getsize(path)
            start_s, end_s = m.group(1), m.group(2)
            if start_s == "":                       # suffix range: last N bytes
                start, end = max(0, size - int(end_s)), size - 1
            else:
                start = int(start_s)
                end = int(end_s) if end_s else size - 1
            end = min(end, size - 1)
            if start >= size or start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                self._range_remaining = None
                return None
            f = open(path, "rb")
            f.seek(start)
            self.send_response(206)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(end - start + 1))
            self.end_headers()
            self._range_remaining = end - start + 1
            return f
        except OSError:
            self._range_remaining = None
            return super().send_head()

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "_range_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        self._range_remaining = None
        while remaining > 0:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)


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
        self.cancel_requested = False

    def get_status(self):
        return self.status

    def get_progress(self):
        return self.progress

    def cancel_sam(self):
        """Cooperative cancel: the running job checks this between frames and stops there
        (can't force-kill a Python thread mid-inference-call). No-op if nothing is running."""
        self.cancel_requested = True
        return {"ok": True}

    def pick_export_folder(self):
        """Native folder picker for the export destination. Returns the chosen directory,
        or None if cancelled."""
        win = webview.windows[0]
        res = win.create_file_dialog(webview.FileDialog.FOLDER)
        return res[0] if res else None

    def write_export_file(self, base_dir, rel_path, b64data):
        """Write one exported file (frame/mask/json) straight to disk — no zipping.
        rel_path uses forward slashes (e.g. 'frames/frame_0000.png'); parent dirs are
        created as needed. b64data is standard base64 (no data: prefix)."""
        import base64
        try:
            dest = Path(base_dir) / Path(*rel_path.split("/"))
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(base64.b64decode(b64data))
            return {"ok": True}
        except Exception as e:
            return {"error": str(e)}

    def reveal_in_finder(self, path):
        import subprocess
        try:
            subprocess.run(["open", str(path)], check=False)
            return {"ok": True}
        except Exception as e:
            return {"error": str(e)}

    def pick_video(self):
        win = webview.windows[0]
        res = win.create_file_dialog(
            webview.FileDialog.OPEN,
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
        self.cancel_requested = False
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
        from sam_backend import SamBackend, SamCancelled
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
                should_cancel=lambda: self.cancel_requested,
            )
            manifest["baseUrl"] = "/media/masks"
            self.sam_result = manifest
            self.status = "done"
            self.progress = {"frame": 1, "total": 1, "stage": "done"}
        except SamCancelled:
            self.status = "cancelled"
            self.sam_result = {"cancelled": True}
            self.progress = {"frame": 0, "total": 0, "stage": "cancelled"}
        except Exception as e:  # surface to the UI instead of dying silently
            self.status = f"error: {e}"
            self.sam_result = {"error": str(e)}
            self.progress = {"frame": 0, "total": 0, "stage": "error"}

    def get_result(self):
        return self.sam_result

    def preview_sam(self, concepts, points, prompt_times=None, model="sam2.1_b.pt", frame_time=0.0):
        """Single-frame preview: SAM2 uses the click points; SAM3 uses text at frame_time.
        Runs on the same background thread + cancel mechanism as run_sam (SAM3 previews can
        take 45-77s on this hardware — long enough to need the same escape hatch)."""
        if not self.video_path:
            return {"error": "no video selected"}
        if self.sam_thread and self.sam_thread.is_alive():
            return {"error": "a segmentation is already running"}
        self.cancel_requested = False
        self.sam_result = None
        self.status = "starting"
        self.progress = {"frame": 0, "total": 0, "stage": "starting"}
        self.sam_thread = threading.Thread(
            target=self._preview_job,
            args=(list(concepts), points, prompt_times, model, frame_time),
            daemon=True,
        )
        self.sam_thread.start()
        return {"started": True}

    def _preview_job(self, concepts, points, prompt_times, model, frame_time):
        from sam_backend import SamBackend, SamCancelled
        try:
            self.progress = {"frame": 0, "total": 1, "stage": f"loading {model}"}
            b = SamBackend(model=model)
            out = MEDIA / "preview"
            if out.exists():
                shutil.rmtree(out)
            cancel = lambda: self.cancel_requested
            if "sam3" in model:
                items = b.preview_text(self.video_path, concepts, frame_time or 0.0, out, cancel)
            else:
                items = b.preview_points(self.video_path, concepts, points or {},
                                         prompt_times or {}, out, cancel)
            for it in items:
                it["url"] = f"/media/preview/{it['slug']}.png"
            self.sam_result = {"items": items}
            self.status = "done"
            self.progress = {"frame": 1, "total": 1, "stage": "done"}
        except SamCancelled:
            self.status = "cancelled"
            self.sam_result = {"cancelled": True}
            self.progress = {"frame": 0, "total": 0, "stage": "cancelled"}
        except Exception as e:
            self.status = f"error: {e}"
            self.sam_result = {"error": str(e)}
            self.progress = {"frame": 0, "total": 0, "stage": "error"}


if __name__ == "__main__":
    threading.Thread(target=serve, daemon=True).start()
    webview.settings["ALLOW_DOWNLOADS"] = True   # export ZIP/WebM = browser-style download
    api = Api()
    webview.create_window("Card Beat", f"http://127.0.0.1:{PORT}/index.html",
                          js_api=api, width=1440, height=900)
    # pywebview defaults to private_mode=True ("cookies and local storage are not
    # preserved"), which silently wipes localStorage (settings + saved presets) on every
    # launch. Disable it so Card Beat's persisted editor settings actually persist.
    webview.start(private_mode=False)
