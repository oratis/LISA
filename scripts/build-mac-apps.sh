#!/usr/bin/env bash
#
# Build Lisa.app and package it into a DMG for distribution via GitHub
# Releases. (The island pill is now a feature of Lisa.app — Settings ▸ Show
# Lisa Island — so there's no separate LisaIsland.app to ship.)
#
# Output (in dist-release/):
#   - Lisa-Suite-v<VERSION>.dmg   disk image with Lisa.app + an /Applications
#                                  drag target (name kept for release/link
#                                  back-compat). ~156 MB: the app embeds the
#                                  backend and a universal Node runtime so a
#                                  fresh Mac needs nothing installed. Set
#                                  LISA_EMBED_ARCHS=arm64 for an Apple-Silicon-
#                                  only build (~90 MB smaller).
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
    local args=(--force --options runtime --timestamp
                --sign "$APPLE_SIGNING_IDENTITY")
    if [ -f "$entitlements" ]; then
        args+=(--entitlements "$entitlements")
    fi
    # Inside-out, as codesign requires: the embedded Node runtime is a bare
    # Mach-O under Resources/, which --deep does not treat as nested code, so
    # sign it explicitly first. It needs the same entitlements the app already
    # declares — V8 wants the allow-jit / allow-unsigned-executable-memory pair
    # that the embedded WKWebView also wants — so the same file is reused.
    local node="$app/Contents/Resources/node-runtime/bin/node"
    if [ -f "$node" ]; then
        echo "  ↳ embedded node runtime"
        codesign "${args[@]}" "$node"
    fi
    codesign "${args[@]}" --deep "$app"
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

Nothing else to install. Lisa.app carries its own backend and its own
Node runtime, and starts them for you the first time you open it — no
Node, no npm, no terminal. The app then asks for an LLM key in its own
setup screen.

Prefer the command line, or already have the CLI?

    npm install -g @oratis/lisa      # or: brew install oratis/tap/lisa
    lisa serve --web

The app uses an already-running backend on localhost:5757 when it finds
one, so an existing install keeps working exactly as before.

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
