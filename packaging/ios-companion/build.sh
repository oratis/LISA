#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# build.sh — generate the Xcode project from project.yml and build/verify Lisa
# Pocket for the iOS Simulator. Simulator builds need NO code signing, so this
# runs anywhere Xcode is installed.
#
# Prereqs:  brew install xcodegen   +   Xcode (full, not just CommandLineTools)
#
# Usage:
#   ./build.sh                                    # build for a default simulator
#   ./build.sh 'platform=iOS Simulator,name=iPhone 17 Pro'
#
# Release (App Store) is out of scope here — like the Markup project, production
# builds go through a signing pipeline (EAS / `xcodebuild archive` + a paid Apple
# Developer account). This script is for local compile/verification.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

command -v xcodegen >/dev/null || { echo "✗ need xcodegen — run: brew install xcodegen" >&2; exit 1; }

# Action: `build` (default) or `test` (runs the LisaPocketTests logic tests).
ACTION="build"
if [ "${1:-}" = "test" ]; then ACTION="test"; shift; fi

echo "==> xcodegen generate"
xcodegen generate

DEST="${1:-platform=iOS Simulator,name=iPhone 17 Pro}"
echo "==> xcodebuild $ACTION ($DEST)"
xcodebuild -project LisaPocket.xcodeproj -scheme LisaPocket \
  -sdk iphonesimulator -destination "$DEST" \
  -derivedDataPath .build "$ACTION" CODE_SIGNING_ALLOWED=NO

echo "✓ Lisa Pocket $ACTION succeeded (simulator)."
