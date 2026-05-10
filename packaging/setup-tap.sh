#!/usr/bin/env bash
# One-shot bootstrap: turn packaging/homebrew-tap-seed/ into a brand-new
# git repo at ../homebrew-tap (sibling to LISA/), commit it, and print the
# next steps.
#
# Run this ONCE when you're ready to publish the Homebrew tap. After it
# completes, you create a GitHub repo at github.com/oratis/homebrew-tap
# and push.
#
# Idempotent-ish: refuses to overwrite an existing target dir.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LISA_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SEED="$SCRIPT_DIR/homebrew-tap-seed"
TARGET="${TAP_DIR:-$(cd "$LISA_ROOT/.." && pwd)/homebrew-tap}"

if [ ! -d "$SEED" ]; then
  echo "✗ seed dir not found: $SEED" >&2
  exit 1
fi

if [ -e "$TARGET" ]; then
  echo "✗ target already exists: $TARGET"
  echo "  (move/rename it first, or set TAP_DIR=/some/other/path)"
  exit 1
fi

echo "→ Creating $TARGET from seed…"
mkdir -p "$TARGET"
# Copy contents (not the seed dir itself).
cp -R "$SEED"/. "$TARGET"/

echo "→ git init + initial commit…"
cd "$TARGET"
git init -q -b main
git add .
git commit -q -m "init: lisa tap (from oratis/LISA seed)"

echo
echo "✓ done. Next steps:"
echo
echo "  1. Create the GitHub repo:"
echo "     gh repo create oratis/homebrew-tap --public --source=$TARGET --remote=origin --push"
echo "     (or via the web UI: github.com/new → name 'homebrew-tap' → public)"
echo
echo "  2. After the remote is set + pushed, install + test:"
echo "     brew tap oratis/tap"
echo "     brew install lisa  # will fail until v0.2.0 release tarball + sha256 are wired"
echo
echo "  3. Per-release flow lives in:"
echo "     $LISA_ROOT/docs/PUBLISH.md  (section 2)"
echo
echo "  Tap repo path: $TARGET"
