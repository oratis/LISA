#!/usr/bin/env bash
#
# Embed a self-contained LISA backend into Lisa.app.
#
# Why this exists: the app spawns `lisa serve --web`, which until now had to
# come from the login shell's PATH — i.e. the user had to run
# `npm i -g @oratis/lisa` (and have Node) BEFORE the app was any use. Someone
# who only downloaded the DMG got the "backend offline" splash and a list of
# terminal commands. After this step Lisa.app carries its own backend AND its
# own Node, so a Mac with nothing installed answers on localhost:5757 the
# first time the app is opened.
#
# Layout produced inside the bundle:
#   Contents/Resources/backend/dist/          compiled JS + web assets
#   Contents/Resources/backend/node_modules/  runtime deps
#   Contents/Resources/backend/package.json   required — carries "type":"module"
#   Contents/Resources/node-runtime/bin/node  official nodejs.org build
#
# `--omit=optional` drops node-pty, the only native module in the tree, which
# keeps the embedded backend pure JS: nothing is compiled against a specific
# Node ABI and nothing needs `disable-library-validation` under the hardened
# runtime. The PTY agent surface degrades to the 503 it already returns when
# node-pty is absent.
#
# The embedded `node` is ad-hoc signed here because lipo strips the signature
# nodejs.org shipped, and an unsigned Mach-O will not execute on Apple
# Silicon. scripts/build-mac-apps.sh re-signs it with the Developer ID (see
# sign_one) before the outer bundle, inside-out as codesign requires.
#
# Usage:
#   bash embed-runtime.sh <path-to-Lisa.app>
#
# Env:
#   LISA_SKIP_EMBED=1   skip entirely — Swift-only iteration. The app then
#                       falls back to `lisa` on PATH exactly as it used to.
#   LISA_NODE_VERSION   Node to embed (default: the LTS pinned below).
#   LISA_EMBED_ARCHS    space-separated, default "arm64 x64"; two archs are
#                       lipo'd into one universal binary.
set -euo pipefail

APP="${1:-}"
if [ -z "$APP" ]; then
    echo "usage: embed-runtime.sh <path-to-Lisa.app>" >&2
    exit 2
fi
if [ ! -d "$APP/Contents" ]; then
    echo "✗ $APP doesn't look like an .app bundle" >&2
    exit 1
fi

if [ "${LISA_SKIP_EMBED:-}" = "1" ]; then
    echo "▸ LISA_SKIP_EMBED=1 — no embedded backend (app will use \`lisa\` on PATH)"
    exit 0
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
CACHE="$HERE/.build/embed"
RES="$APP/Contents/Resources"
NODE_VERSION="${LISA_NODE_VERSION:-v22.23.2}"
ARCHS="${LISA_EMBED_ARCHS:-arm64 x64}"

# Checksums for PINNED_NODE_VERSION, committed to the repo.
#
# The script already verifies each tarball against nodejs.org's SHASUMS256.txt,
# but that file comes from the same host over the same connection as the
# tarball: anything able to serve a tampered binary can serve a sums file that
# matches it. Node publishes a detached GPG signature for SHASUMS256.txt, and
# checking it would mean carrying (and rotating) their release keyring in the
# build. Pinning the hash here gets the same property more cheaply — the
# expected value lives in version control, so changing it is a reviewed commit,
# and this binary is signed into a notarized DMG and handed to users.
#
# Bumping Node: set both, from `curl https://nodejs.org/dist/<v>/SHASUMS256.txt`.
PINNED_NODE_VERSION="v22.23.2"
PINNED_SHA256_arm64="61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6"
PINNED_SHA256_x64="58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026"

# ── 1. backend: dist/ + production node_modules ─────────────────────
if [ ! -f "$REPO_ROOT/dist/cli.js" ]; then
    echo "✗ $REPO_ROOT/dist/cli.js missing — run 'npm run build' first" >&2
    exit 1
fi

# Install the runtime deps in a staging dir rather than in the repo: a dev
# running build.sh must not have their devDependencies pruned out from under
# them. Keyed on the lockfile so repeat builds skip the install.
STAGE="$CACHE/backend"
LOCK_HASH="$(shasum -a 256 "$REPO_ROOT/package-lock.json" | cut -d' ' -f1)"
if [ "$(cat "$STAGE/.lockhash" 2>/dev/null || true)" != "$LOCK_HASH" ]; then
    echo "▸ installing production deps for the embedded backend…"
    rm -rf "$STAGE"
    mkdir -p "$STAGE"
    cp "$REPO_ROOT/package.json" "$REPO_ROOT/package-lock.json" "$STAGE/"
    ( cd "$STAGE" && npm ci --omit=dev --omit=optional --ignore-scripts \
                             --no-audit --no-fund >/dev/null )
    echo "$LOCK_HASH" > "$STAGE/.lockhash"
else
    echo "▸ reusing cached production deps"
fi

echo "▸ staging backend into the bundle…"
rm -rf "$RES/backend"
mkdir -p "$RES/backend"
cp "$REPO_ROOT/package.json" "$RES/backend/package.json"
# -L dereferences: `npm run copy-assets` leaves dist/web/assets as a symlink
# into src/, and a symlink pointing outside the bundle is dead on the user's
# machine (and would break the code signature seal).
cp -RL "$REPO_ROOT/dist" "$RES/backend/dist"
cp -R "$STAGE/node_modules" "$RES/backend/node_modules"

# ── 2. Node runtime ─────────────────────────────────────────────────
mkdir -p "$CACHE/node"
SUMS="$CACHE/node/SHASUMS256-$NODE_VERSION.txt"
if [ ! -s "$SUMS" ]; then
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$SUMS"
fi

NODE_BINS=()
for arch in $ARCHS; do
    tarball="node-$NODE_VERSION-darwin-$arch.tar.gz"
    tgz="$CACHE/node/$tarball"
    if [ ! -s "$tgz" ]; then
        echo "▸ downloading $tarball…"
        curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$tarball" -o "$tgz"
    fi
    # We are about to ship this binary to users — never skip the checksum.
    #
    # Prefer the value pinned in this file over the one fetched alongside the
    # tarball. Only fall back to SHASUMS256.txt when NODE_VERSION was overridden
    # away from the pin (a deliberate local experiment), and say so loudly:
    # a release build must never take its expected hash from the same place as
    # the artefact it is checking.
    pinned_var="PINNED_SHA256_$arch"
    expected="${!pinned_var:-}"
    if [ "$NODE_VERSION" != "$PINNED_NODE_VERSION" ] || [ -z "$expected" ]; then
        echo "⚠ $NODE_VERSION is not the pinned $PINNED_NODE_VERSION — falling back to" >&2
        echo "  nodejs.org's own SHASUMS256.txt. Do NOT ship a release built this way;" >&2
        echo "  update PINNED_NODE_VERSION / PINNED_SHA256_* instead." >&2
        expected="$(awk -v f="$tarball" '$2 == f { print $1 }' "$SUMS")"
    fi
    if [ -z "$expected" ]; then
        echo "✗ $tarball is not listed in SHASUMS256.txt for $NODE_VERSION" >&2
        exit 1
    fi
    actual="$(shasum -a 256 "$tgz" | cut -d' ' -f1)"
    if [ "$actual" != "$expected" ]; then
        echo "✗ checksum mismatch for $tarball (expected $expected, got $actual)" >&2
        rm -f "$tgz"
        exit 1
    fi
    extracted="$CACHE/node/node-$NODE_VERSION-$arch"
    if [ ! -x "$extracted" ]; then
        tmp="$(mktemp -d)"
        tar -xzf "$tgz" -C "$tmp" "node-$NODE_VERSION-darwin-$arch/bin/node"
        mv "$tmp/node-$NODE_VERSION-darwin-$arch/bin/node" "$extracted"
        rm -rf "$tmp"
        # ~19% off (113 MB → 91 MB per arch) by dropping the symbol table we
        # will never read. Invalidates nodejs.org's signature, which lipo would
        # drop anyway — we re-sign below.
        strip -x "$extracted" 2>/dev/null || true
    fi
    NODE_BINS+=("$extracted")
done

mkdir -p "$RES/node-runtime/bin"
NODE_OUT="$RES/node-runtime/bin/node"
if [ "${#NODE_BINS[@]}" -gt 1 ]; then
    echo "▸ lipo → universal node ($ARCHS)"
    lipo -create -output "$NODE_OUT" "${NODE_BINS[@]}"
else
    cp "${NODE_BINS[0]}" "$NODE_OUT"
fi
chmod +x "$NODE_OUT"
# lipo/cp dropped nodejs.org's signature; re-sign so it can execute at all.
codesign --force --sign - "$NODE_OUT"

# ── 3. smoke test ───────────────────────────────────────────────────
# Prove the embedded pair actually runs before we ship it — a bundle whose
# node can't load its own dist is the exact failure this script exists to
# prevent, and it is invisible until a user double-clicks the app.
EMBEDDED_VERSION="$("$NODE_OUT" -v)"
if ! "$NODE_OUT" "$RES/backend/dist/cli.js" --version >/dev/null 2>&1; then
    echo "✗ embedded backend failed to run:" >&2
    "$NODE_OUT" "$RES/backend/dist/cli.js" --version >&2 || true
    exit 1
fi

echo "✓ embedded backend  $(du -sh "$RES/backend" | cut -f1)"
echo "✓ embedded node     $EMBEDDED_VERSION  ($(du -sh "$NODE_OUT" | cut -f1))"
