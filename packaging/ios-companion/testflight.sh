#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# testflight.sh — archive Lisa Pocket and upload it to TestFlight.
#
# The native-app analogue of Markup's EAS submit flow: Lisa Pocket is a native
# SwiftUI app (XcodeGen), not Expo, so instead of `eas build`/`eas submit` we
# drive `xcodebuild archive` + `-exportArchive` (destination: upload) with an
# App Store Connect API key, which handles automatic provisioning AND the
# upload in one go. Plain xcrun/xcodebuild, matching the secret-gated style of
# .github/workflows/release-mac-apps.yml (itself lifted from Markup).
#
# ── One-time setup (see RELEASE.md) ───────────────────────────────────────
#   1. Apple Developer account; an "Apple Distribution" cert in the keychain
#      (already present on the dev Mac; CI imports one from a secret).
#   2. Create the app in App Store Connect with bundle id ai.meetlisa.main.
#   3. Create an App Store Connect API key (Users and Access → Integrations →
#      App Store Connect API), role "App Manager". Note the Key ID + Issuer ID
#      and download the AuthKey_<KEYID>.p8 once.
#
# ── Required env ──────────────────────────────────────────────────────────
#   ASC_KEY_ID      App Store Connect API Key ID (e.g. ABC123XYZ9)
#   ASC_ISSUER_ID   API Key Issuer ID (a UUID)
#   ASC_KEY_PATH    path to the downloaded AuthKey_<ASC_KEY_ID>.p8
# ── Optional env ──────────────────────────────────────────────────────────
#   APPLE_TEAM_ID      default 9LH9NBX7P4
#   MARKETING_VERSION  default: whatever project.yml has
#   BUILD_NUMBER       default: date +%s (Unix seconds). MUST be < 2^32 per
#                      CFBundleVersion component — a %Y%m%d%H%M stamp (12 digits,
#                      ~2e11) is 47x over the limit, so Apple accepts the upload
#                      but SILENTLY fails processing (ITMS-90062) and the build
#                      never reaches TestFlight. `date +%s` (~1.8e9) is monotonic,
#                      unique per second, and stays valid until 2106.
#   EXPORT_METHOD      default: app-store-connect (use "app-store" on Xcode<16)
#
# Usage:
#   ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=~/AuthKey_….p8 ./testflight.sh
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

: "${ASC_KEY_ID:?set ASC_KEY_ID (App Store Connect API Key ID)}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID (API Key Issuer ID)}"
: "${ASC_KEY_PATH:?set ASC_KEY_PATH (path to AuthKey_<id>.p8)}"
[ -f "$ASC_KEY_PATH" ] || { echo "✗ ASC_KEY_PATH not found: $ASC_KEY_PATH" >&2; exit 1; }
command -v xcodegen >/dev/null || { echo "✗ need xcodegen — brew install xcodegen" >&2; exit 1; }

TEAM_ID="${APPLE_TEAM_ID:-9LH9NBX7P4}"
# Unix seconds: < 2^32 (valid CFBundleVersion), monotonic, unique per second.
# A %Y%m%d%H%M stamp overflows the 2^32-per-component limit → ITMS-90062, upload
# "succeeds" but never appears in TestFlight.
BUILD_NUMBER="${BUILD_NUMBER:-$(date +%s)}"
EXPORT_METHOD="${EXPORT_METHOD:-app-store-connect}"
# project.yml hard-disables signing for simulator dev builds (CODE_SIGN_IDENTITY="").
# For the archive that empty identity must be overridden, or app-extension targets
# (the widget) silently skip their CodeSign step → ValidateEmbeddedBinary fails.
# Automatic signing re-derives the real identity from the team; this just has to be
# non-empty. Export re-signs for distribution via ExportOptions.
SIGN_IDENTITY="${SIGN_IDENTITY:-Apple Development}"
BUILD_DIR="build"
ARCHIVE="$BUILD_DIR/LisaPocket.xcarchive"

echo "==> xcodegen generate"
xcodegen generate

# TestFlight/App Store builds use the PRODUCTION APNs environment; project.yml
# stays "development" for normal dev builds, so flip the generated entitlement
# here (only for this archive).
if [ -f Sources/LisaPocket.entitlements ]; then
  plutil -replace aps-environment -string production Sources/LisaPocket.entitlements
fi

AUTH=(-allowProvisioningUpdates
  -authenticationKeyPath "$ASC_KEY_PATH"
  -authenticationKeyID "$ASC_KEY_ID"
  -authenticationKeyIssuerID "$ASC_ISSUER_ID")

MV_ARG=()
[ -n "${MARKETING_VERSION:-}" ] && MV_ARG=(MARKETING_VERSION="$MARKETING_VERSION")

echo "==> archive  (build $BUILD_NUMBER · team $TEAM_ID)"
rm -rf "$ARCHIVE"
xcodebuild archive \
  -project LisaPocket.xcodeproj -scheme LisaPocket \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  "${AUTH[@]}" \
  CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=YES \
  CODE_SIGN_IDENTITY="$SIGN_IDENTITY" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" ${MV_ARG[@]+"${MV_ARG[@]}"}

echo "==> write ExportOptions.plist (method=$EXPORT_METHOD, destination=upload)"
cat > "$BUILD_DIR/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>$EXPORT_METHOD</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
</dict></plist>
PLIST

echo "==> export + upload to TestFlight"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$BUILD_DIR/ExportOptions.plist" \
  -exportPath "$BUILD_DIR/export" \
  "${AUTH[@]}"

echo "✓ Uploaded to App Store Connect (build $BUILD_NUMBER)."
echo "  It appears in TestFlight after Apple finishes processing (usually a few minutes)."
