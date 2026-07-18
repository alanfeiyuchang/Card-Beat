#!/usr/bin/env bash
# Pull the N most-recent videos from a USB-connected Android phone into resources/videos.
#
# Usage:  ./pull_videos.sh [N]        (default N = 5)
# Requires: adb (brew install android-platform-tools) + USB debugging authorized on the phone.
set -euo pipefail

N="${1:-5}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="$SCRIPT_DIR/resources/videos"

# Where to look on the phone, and which extensions count as video.
SEARCH_DIRS="/sdcard/DCIM /sdcard/Movies /sdcard/Pictures /sdcard/Download"
EXTS="mp4 mov mkv 3gp m4v webm"

command -v adb >/dev/null 2>&1 || {
  echo "adb not found. Install it:  brew install android-platform-tools" >&2
  exit 1
}

STATE="$(adb get-state 2>/dev/null || true)"
if [ "$STATE" != "device" ]; then
  echo "Android device not ready (adb state: ${STATE:-none})." >&2
  echo >&2
  adb devices >&2
  echo >&2
  echo "Fix:" >&2
  echo "  1. Plug the phone in over USB." >&2
  echo "  2. Enable Developer options > USB debugging." >&2
  echo "  3. Tap 'Allow' on the 'Allow USB debugging?' prompt (check 'always allow')." >&2
  echo "     If it says 'unauthorized', unplug/replug and watch the phone for the prompt." >&2
  exit 1
fi

mkdir -p "$DEST"

# Build the find name filter:  \( -iname '*.mp4' -o -iname '*.mov' ... \)
NAME_FILTER=""
for e in $EXTS; do
  if [ -z "$NAME_FILTER" ]; then
    NAME_FILTER="-iname '*.$e'"
  else
    NAME_FILTER="$NAME_FILTER -o -iname '*.$e'"
  fi
done

echo "Searching for videos on the phone…"
# One on-device pass: print "<mtime-epoch> <path>" for every video, newest first, keep N.
LIST="$(adb shell "find $SEARCH_DIRS -type f \\( $NAME_FILTER \\) -exec stat -c '%Y %n' {} + 2>/dev/null" \
        | tr -d '\r' | sort -rn | head -n "$N" || true)"

if [ -z "$LIST" ]; then
  echo "No videos found under: $SEARCH_DIRS" >&2
  echo "(Adjust SEARCH_DIRS/EXTS at the top of this script if your videos live elsewhere.)" >&2
  exit 1
fi

NUM="$(printf '%s\n' "$LIST" | grep -c . || true)"
echo "Pulling $NUM latest video(s) → $DEST"

# Paths may contain spaces, so strip the leading "epoch " and keep the rest.
printf '%s\n' "$LIST" | while IFS= read -r line; do
  [ -z "$line" ] && continue
  path="${line#* }"
  [ -z "$path" ] && continue
  echo "  → $(basename "$path")"
  adb pull -a "$path" "$DEST/" >/dev/null
done

echo "Done. Files are in: $DEST"
