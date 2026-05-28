#!/usr/bin/env bash
#
# Build Lisa.app + LisaIsland.app and package both into a single DMG for
# distribution via GitHub Releases.
#
# Output (in dist-release/):
#   - Lisa-Suite-v<VERSION>.dmg   one disk image containing both .apps and
#                                  an /Applications drag target
#   - Lisa-Suite-v<VERSION>.dmg.sha256
#
# Behavior:
#   - Always produces an ad-hoc-signed DMG so local devs can run it.
#   - When APPLE_SIGNING_IDENTITY is set (i.e. invoked from the CI workflow
#     after the Developer ID cert is imported), re-signs each .app with a
#     hardened runtime + timestamp before bundling. Notarization happens in
#     the workflow (notarytool requires Apple ID creds, kept out of bash).
#
# Usage:
#   bash scripts/build-mac-apps.sh
#   VERSION=0.2.1 bash scripts/build-mac-apps.sh
#   APPLE_SIGNING_IDENTITY="Developer ID Application: …" bash scripts/build-mac-apps.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
OUT="${OUT:-dist-release}"
DMG_NAME="Lisa-Suite-v${VERSION}"
APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"

echo "=== Lisa.app + LisaIsland.app DMG ==="
echo "    version:  $VERSION"
echo "    output:   $OUT/$DMG_NAME.dmg"
if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
    echo "    signing:  $APPLE_SIGNING_IDENTITY (hardened runtime)"
else
    echo "    signing:  ad-hoc (Gatekeeper-quarantined for downloaded copies)"
fi
echo

mkdir -p "$OUT"

# ─── 1. build both .apps ────────────────────────────────────────────
echo "→ Building Lisa.app (universal)…"
( cd packaging/mac-client && bash build.sh )

echo
echo "→ Building LisaIsland.app (universal)…"
( cd packaging/island-mac && bash build.sh )

LISA_APP="packaging/mac-client/Lisa.app"
ISLAND_APP="packaging/island-mac/LisaIsland.app"

for app in "$LISA_APP" "$ISLAND_APP"; do
    if [ ! -d "$app" ]; then
        echo "✗ $app missing — build step failed" >&2
        exit 1
    fi
done

# ─── 2. (optional) re-sign with Developer ID + hardened runtime ────
# Each app has its own Entitlements.plist next to its Info.plist
# (packaging/<flavor>/Resources/Entitlements.plist). Hardened runtime is
# a notarization prerequisite, and notarytool wants the entitlements
# embedded so it knows what privileges the binary will request.
if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
    sign_one() {
        local app="$1"
        local entitlements="$2"
        echo "→ Codesigning $app with hardened runtime…"
        local args=(--force --deep --options runtime --timestamp
                    --sign "$APPLE_SIGNING_IDENTITY")
        if [ -f "$entitlements" ]; then
            args+=(--entitlements "$entitlements")
        fi
        codesign "${args[@]}" "$app"
        codesign --verify --deep --strict --verbose=1 "$app"
    }
    sign_one "$LISA_APP"   "packaging/mac-client/Resources/Entitlements.plist"
    sign_one "$ISLAND_APP" "packaging/island-mac/Resources/Entitlements.plist"
fi

# ─── 3. assemble DMG staging area ──────────────────────────────────
STAGING="$(mktemp -d)/Lisa-Suite"
mkdir -p "$STAGING"
cp -R "$LISA_APP"  "$STAGING/Lisa.app"
cp -R "$ISLAND_APP" "$STAGING/LisaIsland.app"
ln -s /Applications "$STAGING/Applications"

# README inside the DMG so users see install instructions when they open it
cat > "$STAGING/README.txt" <<EOF
Lisa Suite — v${VERSION}
========================

Drag both apps onto Applications:

    Lisa.app          — full chat client (window)
    LisaIsland.app    — pill widget that lives by the menu bar / notch
    Applications →    — drop both here

Before launching either app, install + start the LISA backend:

    # macOS, with Node 20+:
    npm install -g @oratis/lisa
    mkdir -p ~/.lisa
    echo 'ANTHROPIC_API_KEY=sk-ant-...' > ~/.lisa/config.env
    lisa serve --web

Or download the standalone bundle ("lisa-mac-bundle-*.zip") from the
same release and run:

    bin/lisa serve --web

The apps load http://localhost:5757 — make sure it's running.

Source / docs: https://github.com/oratis/LISA
EOF

# ─── 4. build the DMG ──────────────────────────────────────────────
DMG_PATH="$OUT/${DMG_NAME}.dmg"
rm -f "$DMG_PATH"

echo
echo "→ Creating DMG…"
hdiutil create \
    -volname "Lisa Suite" \
    -srcfolder "$STAGING" \
    -ov -format UDZO -fs HFS+ \
    "$DMG_PATH" >/dev/null

# Sign the DMG itself if we signed the apps (notarytool requires it).
if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
    echo "→ Codesigning DMG…"
    codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$DMG_PATH"
fi

# Cleanup the staging dir
rm -rf "$(dirname "$STAGING")"

# ─── 5. checksums ──────────────────────────────────────────────────
( cd "$OUT" && shasum -a 256 "${DMG_NAME}.dmg" > "${DMG_NAME}.dmg.sha256" )

echo
echo "✓ $DMG_PATH  ($(du -h "$DMG_PATH" | cut -f1))"
echo "✓ $OUT/${DMG_NAME}.dmg.sha256"
echo
echo "To verify locally:  open '$DMG_PATH'"
