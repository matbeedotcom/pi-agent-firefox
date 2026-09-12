#!/bin/sh
# Build the AMO submission zip from the built add-on (firefox/dist).
# The manifest must sit at the ZIP ROOT (not under a directory).
# Source maps are stripped — they embed absolute local paths and are not
# needed for review.
# Usage: sh amo/make-zip.sh   ->   amo/pi-browser-<version>.zip
set -eu
cd "$(dirname "$0")/.."
DIST=firefox/dist
[ -f "$DIST/manifest.json" ] || { echo "build first: npm run build" >&2; exit 1; }
VER=$(python3 -c "import json;print(json.load(open('$DIST/manifest.json'))['version'])")
OUT="amo/pi-browser-$VER.zip"
rm -f "$OUT"
# $OLDPWD inside the subshell = repo root (where the zip must land).
(cd "$DIST" && zip -qr "$OLDPWD/$OUT" . -x '*.map')
echo "wrote $OUT"
unzip -l "$OUT"
