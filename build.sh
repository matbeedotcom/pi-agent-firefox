#!/bin/sh
# Build the Pi Browser add-ons from a clean checkout.
# POSIX sh (no bashisms) so it runs under sh/dash/bash on any OS.
#
# Produces:
#   firefox/dist/       the loadable Firefox add-on (manifest.json at its root)
#   thunderbird/dist/   the loadable Thunderbird add-on
#   packages/*/dist/    built protocol/host/webext libraries (used by the add-ons)
#
# Optional outputs (run separately, see README "Building from source"):
#   amo/pi-browser-<version>.zip   AMO submission zip     (sh amo/make-zip.sh)
#
# Environment requirements:
#   - Any OS with Node.js (developed/tested on Linux; the build itself is
#     cross-platform).
#   - Node.js >= 22 (engines field; Node 21 crashes the Pi SDK import)
#   - npm >= 10 (ships with Node 22)
#   - No compiler toolchain, no system libraries, no network access at
#     build time beyond npm's package registry.
set -eu
cd "$(dirname "$0")"

fail() { echo "ERROR: $*" >&2; exit 1; }

# --- 1. Verify the build environment ---------------------------------------
command -v node >/dev/null 2>&1 || fail "node not found. Install Node.js >= 22 (https://nodejs.org)."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js >= 22 required (found $(node --version)). Node 21 crashes the Pi SDK import."
command -v npm >/dev/null 2>&1 || fail "npm not found (ships with Node.js)."
echo "node $(node --version), npm $(npm --version)"

# --- 2. Install dependencies (exact versions from package-lock.json) -------
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

# --- 3. Build all workspaces in dependency order ---------------------------
# (protocol -> webext -> agent -> firefox -> thunderbird; the root "build"
# script defines the order. esbuild bundles each add-on; tsc --noEmit gates
# every build on a clean type-check.)
npm run build

# --- 4. Verify the add-on outputs -------------------------------------------
for d in firefox/dist thunderbird/dist; do
  [ -f "$d/manifest.json" ] || fail "$d/manifest.json missing — build failed."
  echo "built $d (loadable via about:debugging -> Load Temporary Add-on)"
done
echo "Build complete. Run 'npm test' for the test suite."
