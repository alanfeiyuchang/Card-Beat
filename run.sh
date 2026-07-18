#!/usr/bin/env bash
# Launch Card Beat as a native desktop app (with SAM segmentation).
# First run sets up a venv and installs deps (torch/ultralytics are large).
#
# IMPORTANT: use a NATIVE arm64 Python (Homebrew 3.11/3.12), not the x86_64 python.org
# build — the latter has no pyobjc/torch wheels for recent macOS and fails to compile.
set -e
cd "$(dirname "$0")"

pick_python() {
  for c in /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11 \
           /opt/homebrew/bin/python3 python3.12 python3.11 python3; do
    if command -v "$c" >/dev/null 2>&1; then
      if "$c" -c 'import platform,sys; sys.exit(0 if platform.machine()=="arm64" else 1)' 2>/dev/null; then
        echo "$c"; return 0
      fi
    fi
  done
  echo ""; return 1
}

if [ ! -d .venv ]; then
  PY="$(pick_python)"
  if [ -z "$PY" ]; then
    echo "No native arm64 Python found. Install one with:  brew install python@3.12" >&2
    exit 1
  fi
  echo "Creating virtualenv with $PY ($($PY --version))…"
  "$PY" -m venv .venv
  ./.venv/bin/pip install --upgrade pip
  ./.venv/bin/pip install -r requirements.txt
fi

exec ./.venv/bin/python app.py
