#!/usr/bin/env bash
# Lisa supervisor — relaunches the web server when she calls the `redeploy`
# tool to ship her own source changes.
#
# Usage:
#   ./scripts/lisa-supervise.sh                # default: serve --web
#   ./scripts/lisa-supervise.sh --port 8080    # forwards args to `lisa serve --web`
#
# Exit codes from the child:
#   0     clean shutdown   → supervisor stops
#   75    redeploy request → supervisor restarts (after `npm run build` already ran)
#   *     error            → supervisor restarts, up to CRASH_LIMIT times per
#                           CRASH_WINDOW seconds, then stops
#
# Why crashes restart at all: the health watchdog (src/web/health.ts) exits 1
# on purpose when the event loop stays wedged, expecting a supervisor to hand
# users a fresh process — launchd KeepAlive and Cloud Run do that, and this
# script has to match or `lisa-supervise.sh` is the one deployment where the
# watchdog just kills Lisa. The cap is what keeps a genuine startup failure
# (bad config, port in use) from becoming a spin loop.
#
# The active web session is persisted to ~/.lisa/active-web-session.txt so
# the same conversation thread is resumed across restarts.
set -u

cd "$(dirname "$0")/.."

export LISA_SUPERVISED=1

CRASH_LIMIT=${LISA_SUPERVISE_CRASH_LIMIT:-5}
CRASH_WINDOW=${LISA_SUPERVISE_CRASH_WINDOW:-60}
crashes=0
window_start=$(date +%s)

while :; do
  echo "[supervise] starting lisa (web)"
  set +e
  node dist/cli.js serve --web "$@"
  code=$?
  set -e

  case "$code" in
    75)
      echo "[supervise] redeploy requested (exit 75) — restarting in 1s"
      sleep 1
      continue
      ;;
    0)
      echo "[supervise] clean exit — stopping"
      exit 0
      ;;
    130)
      # SIGINT / Ctrl-C
      echo "[supervise] interrupted — stopping"
      exit 0
      ;;
    *)
      now=$(date +%s)
      if [ $((now - window_start)) -ge "$CRASH_WINDOW" ]; then
        crashes=0
        window_start=$now
      fi
      crashes=$((crashes + 1))
      if [ "$crashes" -gt "$CRASH_LIMIT" ]; then
        echo "[supervise] lisa exited with code $code — $crashes crashes in ${CRASH_WINDOW}s, giving up"
        exit "$code"
      fi
      echo "[supervise] lisa exited with code $code — restarting in 2s ($crashes/$CRASH_LIMIT)"
      sleep 2
      continue
      ;;
  esac
done
