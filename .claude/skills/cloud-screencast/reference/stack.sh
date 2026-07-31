#!/usr/bin/env bash
# Bring up Xvfb -> app -> Chrome(kiosk, CDP). Idempotent: safe to re-run per take.
#
# Geometry: CSS viewport = W/DSF. 2880x1620 @ DSF 2 => 1440x810 CSS, and the 2x
# oversample is what keeps UI text sharp after the downscale to 1080p.
set -uo pipefail

export DISPLAY=:99
W=2880; H=1620; DSF=2
CSS_W=$((W / DSF)); CSS_H=$((H / DSF))

APP_DIR="${APP_DIR:-$HOME/app}"
APP_START="${APP_START:-node dist/cli.js serve --web --port 5757}"
APP_URL="${APP_URL:-http://127.0.0.1:5757/}"
APP_PORT="${APP_PORT:-5757}"
SECRETS="${SECRETS:-$HOME/.app/config.env}"
BG="${BG:-#0b0a1a}"          # match the app background so gaps look deliberate

# Orphaned ffmpeg from a crashed take will hold the output file and silently
# swallow every later recording. Always clear it first.
pkill -f x11grab         2>/dev/null || true
pkill -f "Xvfb :99"      2>/dev/null || true
pkill -f google-chrome   2>/dev/null || true
pkill -f "$APP_START"    2>/dev/null || true
sleep 2

Xvfb :99 -screen 0 ${W}x${H}x24 -nolisten tcp +extension RANDR > ~/xvfb.log 2>&1 &
sleep 2
xsetroot -solid "$BG" 2>/dev/null || true
xset -dpms s off s noblank 2>/dev/null || true

[ -f "$SECRETS" ] && { set -a; . "$SECRETS"; set +a; }
cd "$APP_DIR"
nohup $APP_START > ~/serve.log 2>&1 &

for i in $(seq 1 60); do curl -sf -o /dev/null "http://127.0.0.1:$APP_PORT/" && break; sleep 1; done

rm -rf /tmp/chrome-profile
nohup google-chrome \
  --no-first-run --no-default-browser-check --disable-infobars \
  --disable-features=Translate,TranslateUI,AutofillServerCommunication,MediaRouter \
  --disable-session-crashed-bubble --disable-popup-blocking \
  --force-device-scale-factor=$DSF \
  --kiosk --hide-scrollbars --lang=en-US \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-profile \
  --window-position=0,0 --window-size=${CSS_W},${CSS_H} \
  "$APP_URL" > ~/chrome.log 2>&1 &

for i in $(seq 1 40); do curl -sf -o /dev/null http://127.0.0.1:9222/json/version && break; sleep 1; done
sleep 3

echo "--- geometry ---"; xdpyinfo | grep dimensions
echo "--- css viewport --- ${CSS_W}x${CSS_H} @ ${DSF}x"
echo STACK_UP
