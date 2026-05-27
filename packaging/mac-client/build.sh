#!/usr/bin/env bash
#
# Build Lisa.app — native Mac client hosting the full chat GUI.
#
# Phases:
#   1. swift build -c release  (universal binary, falls back to host arch)
#   2. iconset → .icns from src/web/assets/lisa-mascot.png (1024x1024)
#   3. assemble Lisa.app bundle (Contents/MacOS, Resources, Info.plist)
#   4. ad-hoc codesign so Gatekeeper at least doesn't reject outright
#
# Output: packaging/mac-client/Lisa.app
#
# Usage:
#   bash build.sh           # release (default)
#   bash build.sh --debug   # debug
#
set -euo pipefail

CONFIG="release"
if [ "${1:-}" = "--debug" ]; then
    CONFIG="debug"
fi

cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"
MASCOT="$REPO_ROOT/src/web/assets/lisa-mascot.png"

if [ ! -f "$MASCOT" ]; then
    echo "✗ mascot PNG not found at $MASCOT" >&2
    echo "  (this script expects to be run from packaging/mac-client/ inside the LISA repo)" >&2
    exit 1
fi

# ── 1. compile ──────────────────────────────────────────────────────
echo "▸ swift build -c $CONFIG"
if ! swift build -c "$CONFIG" --arch arm64 --arch x86_64 2>/dev/null; then
    echo "  (universal build failed, falling back to host arch)"
    swift build -c "$CONFIG"
fi

BIN=""
for candidate in \
    ".build/apple/Products/Release/Lisa" \
    ".build/apple/Products/Debug/Lisa" \
    ".build/release/Lisa" \
    ".build/debug/Lisa" ; do
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

# ── 2. icon ─────────────────────────────────────────────────────────
echo "▸ generating .icns from $MASCOT"
ICONSET=".build/AppIcon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"

# Apple's iconutil expects these specific filenames + sizes.
declare -a SIZES=(
    "16:icon_16x16.png"
    "32:icon_16x16@2x.png"
    "32:icon_32x32.png"
    "64:icon_32x32@2x.png"
    "128:icon_128x128.png"
    "256:icon_128x128@2x.png"
    "256:icon_256x256.png"
    "512:icon_256x256@2x.png"
    "512:icon_512x512.png"
    "1024:icon_512x512@2x.png"
)
for entry in "${SIZES[@]}"; do
    SIZE="${entry%%:*}"
    NAME="${entry##*:}"
    sips -z "$SIZE" "$SIZE" "$MASCOT" --out "$ICONSET/$NAME" >/dev/null
done

ICNS=".build/AppIcon.icns"
iconutil -c icns "$ICONSET" -o "$ICNS"
echo "▸ icon: $ICNS"

# ── 3. assemble bundle ──────────────────────────────────────────────
APP="Lisa.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
mkdir -p "$APP/Contents/Resources"

cp "$BIN" "$APP/Contents/MacOS/Lisa"
chmod +x "$APP/Contents/MacOS/Lisa"
cp Resources/Info.plist "$APP/Contents/Info.plist"
cp "$ICNS" "$APP/Contents/Resources/AppIcon.icns"

# ── 4. ad-hoc sign ──────────────────────────────────────────────────
# Proper signing (Developer ID + notarization) is Phase 4.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

# Force Finder/Dock to pick up the new icon (the system caches by bundle path).
touch "$APP" "$APP/Contents/Info.plist"

echo ""
echo "✓ built $(pwd)/$APP"
echo ""
echo "To launch:    open $APP"
echo "To install:   cp -r $APP /Applications/"
