#!/bin/sh
# LISA Cloud container entrypoint (LISA_EDITION=cloud).
#
# 1. Seed a demo soul on first boot so a reviewer (or any first visitor) isn't
#    stuck at the birth ritual — idempotent: skips if already born.
# 2. Start the web server bound to all interfaces ($PORT, default 8080). Auth is
#    the cloud token gate (LISA_WEB_TOKEN required), NOT loopback.
#
# State lives under $LISA_HOME (default /data). On Cloud Run the container FS is
# ephemeral, so run with --min-instances=1 to keep the demo warm + stateful;
# otherwise each cold start re-births a fresh demo soul.
set -e

export LISA_HOME="${LISA_HOME:-/data}"
mkdir -p "$LISA_HOME"

# Born? isBorn() resolves true once the soul seed exists under $LISA_HOME.
if node -e "import('./dist/soul/store.js').then(m=>m.isBorn()).then(b=>process.exit(b?0:1)).catch(e=>{console.error(e);process.exit(1)})"; then
  echo "[cloud] soul already present — skipping birth"
else
  echo "[cloud] birthing the demo soul (model ${LISA_MODEL:-default})…"
  # `lisa birth` validates that a provider key for the model is configured (any of
  # ANTHROPIC_API_KEY / ZHIPU_API_KEY / OPENAI_API_KEY / … per the model). If none
  # is set it exits non-zero and the first web visitor gets the birth ritual.
  node dist/cli.js birth || echo "[cloud] birth skipped/failed — first visitor will see the birth ritual"
fi

exec node dist/cli.js serve --web --port "${PORT:-8080}" --host 0.0.0.0
