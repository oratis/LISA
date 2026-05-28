#!/usr/bin/env bash
#
# Build LisaIsland.app from the SwiftPM target.
#
# SwiftPM emits a bare executable; we wrap it in a hand-rolled .app bundle so
# `open LisaIsland.app` works and LSUIElement (no Dock icon) is honored. No
# Xcode project required — anyone with Command Line Tools or Xcode installed
# can build.
#
# Output: packaging/island-mac/LisaIsland.app
#
# Usage:
#   bash build.sh           # release build (default)
#   bash build.sh --debug   # debug build
#
set -euo pipefail

CONFIG="release"
if [ "${1:-}" = "--debug" ]; then
    CONFIG="debug"
fi

cd "$(dirname "$0")"

echo "▸ swift build -c $CONFIG"
# Universal binary: Apple Silicon + Intel. Build script falls back to host
# arch if cross-build fails (e.g. missing Rosetta SDK on a fresh M-series).
if ! swift build -c "$CONFIG" --arch arm64 --arch x86_64 2>/dev/null; then
    echo "  (universal build failed, falling back to host arch)"
    swift build -c "$CONFIG"
fi

# SwiftPM's universal output lives in .build/apple/Products/<Config>/;
# single-arch output in .build/<config>/.
BIN=""
for candidate in \
    ".build/apple/Products/Release/LisaIsland" \
    ".build/apple/Products/Debug/LisaIsland" \
    ".build/release/LisaIsland" \
    ".build/debug/LisaIsland" ; do
    if [ -x "$candidate" ]; then
        BIN="$candidate"
        break
    fi
done
if [ -z "$BIN" ]; then
    echo "✗ couldn't find compiled binary; check 'swift build' output above" >&2
    exit 1
fi
echo "▸ found binary at $BIN"

APP="LisaIsland.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
mkdir -p "$APP/Contents/Resources"

cp "$BIN" "$APP/Contents/MacOS/LisaIsland"
chmod +x "$APP/Contents/MacOS/LisaIsland"
cp Resources/Info.plist "$APP/Contents/Info.plist"

# Ad-hoc sign so Gatekeeper at least doesn't reject the binary outright on
# first launch. Real signing (Developer ID + notarization) is Phase 4.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

echo "✓ built $(pwd)/$APP"
echo ""
echo "To launch:    open $APP"
echo "To install:   cp -r $APP /Applications/"
