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
#   *     error            → supervisor stops
#
# The active web session is persisted to ~/.lisa/active-web-session.txt so
# the same conversation thread is resumed across restarts.
set -u

cd "$(dirname "$0")/.."

export LISA_SUPERVISED=1

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
      echo "[supervise] lisa exited with code $code — stopping"
      exit "$code"
      ;;
  esac
done
