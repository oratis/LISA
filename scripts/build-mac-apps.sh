#!/usr/bin/env bash
#
# Build Lisa.app and package it into a DMG for distribution via GitHub
# Releases. (The island pill is now a feature of Lisa.app — Settings ▸ Show
# Lisa Island — so there's no separate LisaIsland.app to ship.)
#
# Output (in dist-release/):
#   - Lisa-Suite-v<VERSION>.dmg   disk image with Lisa.app + an /Applications
#                                  drag target (name kept for release/link
#                                  back-compat)
#   - Lisa-Suite-v<VERSION>.dmg.sha256
#
# Phases (first positional arg, default "full"):
#   apps   build + (optionally) Developer-ID-sign both .apps, then STOP.
#          Used by CI so the apps can be notarized + stapled BEFORE the DMG
#          is assembled — that's what gives the .apps inside the DMG their
#          own stapled ticket (so `stapler validate Lisa.app` passes offline).
#   dmg    assemble + sign the DMG from the .apps already on disk. Does NOT
#          rebuild or re-sign the apps (re-signing would strip their stapled
#          notarization ticket). Assumes `apps` (and notarization) already ran.
#   full   apps + dmg in one shot (default). Used for local dev — no
#          notarization, so app-level stapling doesn't apply anyway.
#
# Signing behavior:
#   - The app build.sh scripts always ad-hoc sign so local devs can run them.
#   - When APPLE_SIGNING_IDENTITY is set (CI, after the Developer ID cert is
#     imported), `apps`/`full` re-sign each .app with a hardened runtime +
#     timestamp. Notarization itself happens in the workflow (notarytool needs
#     Apple ID creds, deliberately kept out of this script).
#
# Usage:
#   bash scripts/build-mac-apps.sh                 # full, local, ad-hoc
#   bash scripts/build-mac-apps.sh apps            # CI phase 1
#   bash scripts/build-mac-apps.sh dmg             # CI phase 2 (post-notarize)
#   VERSION=0.2.1 bash scripts/build-mac-apps.sh
#   APPLE_SIGNING_IDENTITY="Developer ID Application: …" bash scripts/build-mac-apps.sh apps
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PHASE="${1:-full}"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
# Hand the resolved version to the per-app build so the .app's Info.plist
# version matches the DMG/release version exactly.
export LISA_APP_VERSION="$VERSION"
OUT="${OUT:-dist-release}"
DMG_NAME="Lisa-Suite-v${VERSION}"
APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"

LISA_APP="packaging/mac-client/Lisa.app"
LISA_ENTITLEMENTS="packaging/mac-client/Resources/Entitlements.plist"

case "$PHASE" in
    apps|dmg|full) ;;
    *) echo "✗ unknown phase '$PHASE' (expected: apps | dmg | full)" >&2; exit 2 ;;
esac

echo "=== Lisa.app DMG ==="
echo "    phase:    $PHASE"
echo "    version:  $VERSION"
echo "    output:   $OUT/$DMG_NAME.dmg"
if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
    echo "    signing:  $APPLE_SIGNING_IDENTITY (hardened runtime)"
else
    echo "    signing:  ad-hoc (Gatekeeper-quarantined for downloaded copies)"
fi
echo

# ─── build + (optional) Developer ID sign both .apps ───────────────
build_and_sign_apps() {
    echo "→ Building Lisa.app (universal)…"
    ( cd packaging/mac-client && bash build.sh )

    if [ ! -d "$LISA_APP" ]; then
        echo "✗ $LISA_APP missing — build step failed" >&2
        exit 1
    fi

    # Re-sign with Developer ID + hardened runtime. The app's own
    # Entitlements.plist (network.client + JIT for the embedded WKWebView) is
    # embedded so notarytool knows what privileges the binary requests.
    if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
        sign_one "$LISA_APP" "$LISA_ENTITLEMENTS"
    fi
}

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

# ─── assemble + sign the DMG from the .apps already on disk ─────────
# IMPORTANT: never re-sign the apps here — in CI they've been stapled with
# their notarization ticket by this point, and re-codesigning strips it.
# cp -R preserves the stapled ticket (it lives inside the bundle).
assemble_dmg() {
    if [ ! -d "$LISA_APP" ]; then
        echo "✗ $LISA_APP missing — run the 'apps' phase first" >&2
        exit 1
    fi

    mkdir -p "$OUT"

    local staging
    staging="$(mktemp -d)/Lisa-Suite"
    mkdir -p "$staging"
    cp -R "$LISA_APP" "$staging/Lisa.app"
    ln -s /Applications "$staging/Applications"

    cat > "$staging/README.txt" <<EOF
Lisa — v${VERSION}
==================

Drag Lisa.app onto Applications:

    Lisa.app          — full chat client (window)
    Applications →    — drop it here

The notch pill ("Lisa Island") is built in — turn it on from
Lisa ▸ Settings… ▸ Show Lisa Island.

Before launching the app, install + start the LISA backend:

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

    local dmg_path="$OUT/${DMG_NAME}.dmg"
    rm -f "$dmg_path"

    echo
    echo "→ Creating DMG…"
    hdiutil create \
        -volname "Lisa Suite" \
        -srcfolder "$staging" \
        -ov -format UDZO -fs HFS+ \
        "$dmg_path" >/dev/null

    # Sign the DMG itself if we have an identity (notarytool requires it).
    # This does not touch the stapled tickets already inside the .apps.
    if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
        echo "→ Codesigning DMG…"
        codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$dmg_path"
    fi

    rm -rf "$(dirname "$staging")"

    ( cd "$OUT" && shasum -a 256 "${DMG_NAME}.dmg" > "${DMG_NAME}.dmg.sha256" )

    echo
    echo "✓ $dmg_path  ($(du -h "$dmg_path" | cut -f1))"
    echo "✓ $OUT/${DMG_NAME}.dmg.sha256"
    echo
    echo "To verify locally:  open '$dmg_path'"
}

case "$PHASE" in
    apps) build_and_sign_apps ;;
    dmg)  assemble_dmg ;;
    full) build_and_sign_apps; assemble_dmg ;;
esac
