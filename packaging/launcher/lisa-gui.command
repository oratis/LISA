#!/usr/bin/env bash
# Mac users: double-click this file to launch Lisa's web UI.
#
# What it does:
#   1. Starts `lisa serve --web --port 5757` in the background
#   2. Opens http://localhost:5757 in your default browser
#   3. Shows server logs in the Terminal window
#   4. Ctrl-C to stop the server (closes the window too)
#
# Lives at: bin/lisa-gui.command in the release tarball.

set -e

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_ROOT="$(dirname "$HERE")"

# Sanity: Node must be on PATH.
if ! command -v node &>/dev/null; then
  cat <<EOF
✗ Node.js not found.

Lisa needs Node.js 20+ to run. Easiest install on macOS:
    brew install node

Or grab the latest from https://nodejs.org/

After installing, double-click this launcher again.
EOF
  read -p "Press Enter to close…"
  exit 1
fi

# Sanity: Node 20+
NODE_MAJOR=$(node --version | sed -E 's/v([0-9]+).*/\1/')
if [ "$NODE_MAJOR" -lt 20 ]; then
  cat <<EOF
✗ Node.js $(node --version) is too old. Lisa needs Node 20+.

    brew upgrade node
EOF
  read -p "Press Enter to close…"
  exit 1
fi

# Banner.
clear
cat <<'EOF'
  ╔══════════════════════════════════════╗
  ║                                      ║
  ║          L I S A   v0.2.0            ║
  ║                                      ║
  ║   web UI: http://localhost:5757      ║
  ║                                      ║
  ║   Ctrl-C to stop and close.          ║
  ║                                      ║
  ╚══════════════════════════════════════╝
EOF
echo

# Open the browser after a short delay so the server has time to bind.
( sleep 2.5 && open "http://localhost:5757" ) &

# Run the server. Stay in foreground so logs are visible and Ctrl-C kills it.
exec "$BUNDLE_ROOT/bin/lisa" serve --web --port 5757
