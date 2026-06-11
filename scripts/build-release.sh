#!/usr/bin/env bash
# Build release artifacts for a new Lisa version.
#
# Produces (in dist-release/):
#   1. lisa-source-vX.Y.Z.tar.gz  — the npm-style tarball (clean source).
#                                   Same as what `npm publish` ships.
#                                   ~30 MB with bundled mood assets.
#   2. lisa-mac-bundle-vX.Y.Z.zip — self-contained "drop and go":
#                                     bin/lisa            (CLI shim)
#                                     bin/lisa-gui.command (GUI double-click)
#                                     dist/               (compiled JS + assets)
#                                     node_modules/       (runtime deps)
#                                     README + LICENSE
#                                   User still needs Node 20+ system-wide.
#                                   ~80-100 MB.
#   3. lisa-linux-bundle-vX.Y.Z.tar.gz — same as Mac minus the .command launcher.
#
# Run from repo root:
#   ./scripts/build-release.sh
#
# Reads version from package.json. Optional override:
#   VERSION=0.2.0 ./scripts/build-release.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
NAME="${NAME:-lisa}"
OUT="dist-release"

# ─── 0. cleanup + prep ─────────────────────────────────────────────
rm -rf "$OUT"
mkdir -p "$OUT"

echo "=== Lisa release build ==="
echo "    version: $VERSION"
echo "    output:  $OUT/"
echo

# ─── 1. clean install + build (production-only deps) ───────────────
echo "→ npm ci --omit=dev (production deps only)…"
npm ci --omit=dev > /dev/null

echo "→ Re-installing TypeScript locally to build (won't ship in the bundle)…"
npm install --no-save --no-package-lock typescript@^5.7.0 > /dev/null

echo "→ npm run build…"
# `copy-assets` makes a symlink; we need a REAL copy in the release bundle
# so users who unpack the tarball don't have a broken symlink.
npx tsc -p tsconfig.json
mkdir -p dist/web
rm -rf dist/web/assets
cp -R src/web/assets dist/web/assets

# TypeScript was only needed for the compile above — prune it back out so the
# bundles' node_modules/ ships runtime deps only (dist/cli.js needs nothing
# else; keeping the compiler would add ~22 MB per bundle).
echo "→ npm prune --omit=dev (drop the build-only TypeScript)…"
npm prune --omit=dev > /dev/null

# ─── 2. source tarball (matches npm publish) ───────────────────────
echo
echo "→ Source tarball (npm-style)…"
npm pack --pack-destination "$OUT" > /dev/null
# Rename from oratis-lisa-X.Y.Z.tgz → lisa-source-vX.Y.Z.tar.gz for clarity.
NPM_TGZ="$(ls "$OUT"/*.tgz | head -1)"
mv "$NPM_TGZ" "$OUT/lisa-source-v${VERSION}.tar.gz"
echo "  ✓ $OUT/lisa-source-v${VERSION}.tar.gz  ($(du -h "$OUT/lisa-source-v${VERSION}.tar.gz" | cut -f1))"

# ─── 3. self-contained Mac bundle ──────────────────────────────────
echo
echo "→ Mac bundle…"
MAC_DIR="$OUT/lisa-mac-bundle-v${VERSION}"
mkdir -p "$MAC_DIR/bin"

# Launchers
cp packaging/launcher/lisa "$MAC_DIR/bin/lisa"
cp packaging/launcher/lisa-gui.command "$MAC_DIR/bin/lisa-gui.command"
chmod +x "$MAC_DIR/bin/lisa" "$MAC_DIR/bin/lisa-gui.command"

# Compiled JS + assets
cp -R dist "$MAC_DIR/dist"

# Runtime deps (npm ci --omit=dev + the post-build prune above)
cp -R node_modules "$MAC_DIR/node_modules"
cp package.json "$MAC_DIR/package.json"

# Docs
cp README.md README.zh-CN.md LICENSE "$MAC_DIR/" 2>/dev/null || true
cp channels.example.json "$MAC_DIR/" 2>/dev/null || true

# Bundle-specific quickstart
cat > "$MAC_DIR/QUICKSTART.txt" <<EOF
Lisa $VERSION — Mac bundle
==========================

Quick start:

  1. Set up an LLM API key:
       mkdir -p ~/.lisa
       echo 'ANTHROPIC_API_KEY=sk-ant-...' > ~/.lisa/config.env

     Other providers (DeepSeek, Gemini, Ollama, ...) work too — see
     https://github.com/oratis/LISA/blob/main/docs/PROVIDERS.md

  2. Launch:
       a. Web UI (recommended): double-click bin/lisa-gui.command
       b. CLI REPL:             ./bin/lisa
       c. One-shot:             ./bin/lisa "say hi"

  3. First launch triggers the birth ritual (~30s, one-time).

Diagnostics if something doesn't work:
  ./bin/lisa doctor

Source: https://github.com/oratis/LISA
License: MIT
EOF

# Zip it up
( cd "$OUT" && zip -qr "lisa-mac-bundle-v${VERSION}.zip" "lisa-mac-bundle-v${VERSION}" )
rm -rf "$MAC_DIR"
echo "  ✓ $OUT/lisa-mac-bundle-v${VERSION}.zip  ($(du -h "$OUT/lisa-mac-bundle-v${VERSION}.zip" | cut -f1))"

# ─── 4. self-contained Linux bundle ────────────────────────────────
echo
echo "→ Linux bundle…"
LIN_DIR="$OUT/lisa-linux-bundle-v${VERSION}"
mkdir -p "$LIN_DIR/bin"
cp packaging/launcher/lisa "$LIN_DIR/bin/lisa"
chmod +x "$LIN_DIR/bin/lisa"
cp -R dist "$LIN_DIR/dist"
cp -R node_modules "$LIN_DIR/node_modules"
cp package.json "$LIN_DIR/package.json"
cp README.md README.zh-CN.md LICENSE "$LIN_DIR/" 2>/dev/null || true
cp channels.example.json "$LIN_DIR/" 2>/dev/null || true

cat > "$LIN_DIR/QUICKSTART.txt" <<EOF
Lisa $VERSION — Linux bundle
============================

Quick start:

  1. Set up an LLM API key:
       mkdir -p ~/.lisa
       echo 'ANTHROPIC_API_KEY=sk-ant-...' > ~/.lisa/config.env

  2. Launch:
       ./bin/lisa                  # CLI REPL
       ./bin/lisa serve --web      # Web UI on http://localhost:5757
       ./bin/lisa "say hi"         # One-shot

  3. First launch triggers the birth ritual (~30s, one-time).

Source: https://github.com/oratis/LISA
License: MIT
EOF

( cd "$OUT" && tar -czf "lisa-linux-bundle-v${VERSION}.tar.gz" "lisa-linux-bundle-v${VERSION}" )
rm -rf "$LIN_DIR"
echo "  ✓ $OUT/lisa-linux-bundle-v${VERSION}.tar.gz  ($(du -h "$OUT/lisa-linux-bundle-v${VERSION}.tar.gz" | cut -f1))"

# ─── 5. restore dev environment ────────────────────────────────────
echo
echo "→ Restoring dev environment (re-installing all deps + dev symlink)…"
npm install > /dev/null
npm run copy-assets > /dev/null

# ─── 6. summary + checksums ────────────────────────────────────────
echo
echo "=== Done ==="
echo
ls -lh "$OUT" | awk 'NR>1 {printf "  %s  %s\n", $5, $NF}'
echo
echo "→ SHA-256 checksums:"
( cd "$OUT" && shasum -a 256 *.tar.gz *.zip 2>/dev/null )
echo
echo "Next steps:"
echo "  1. Test one of the bundles locally."
echo "  2. git tag v${VERSION} && git push --tags"
echo "  3. GitHub → Releases → Draft new release → choose v${VERSION} tag → upload these files."
echo "     (Or: gh release create v${VERSION} ${OUT}/*.tar.gz ${OUT}/*.zip --notes-file docs/RELEASE_v${VERSION}.md)"
