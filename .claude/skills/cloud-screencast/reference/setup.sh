#!/usr/bin/env bash
# VM bootstrap for cloud-screencast. Run once on a fresh Ubuntu 24.04 instance.
#   scp setup.sh <vm>:~/ && ssh <vm> 'bash ~/setup.sh'
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

sudo apt-get update -y
sudo apt-get install -y --no-install-recommends \
  xvfb x11-utils x11-xserver-utils xdotool wmctrl ffmpeg xterm \
  git build-essential curl ca-certificates gnupg unzip imagemagick \
  fonts-inter fonts-jetbrains-mono fonts-noto-color-emoji fonts-noto-cjk fonts-dejavu
#   ^^^ fonts are not optional. Web UIs ask for -apple-system / SF Pro / SF Mono,
#   none of which exist here; without Inter + JetBrains Mono you record DejaVu
#   fallback and the app looks subtly wrong. Noto Color Emoji matters more than
#   you expect — UI copy is full of ★ ❤️ 🌙.

# Node (pin to whatever the app needs)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Google Chrome stable — prefer real Chrome over Playwright's bundled chromium so
# the recording matches what users actually see.
curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
  | sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
  | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt-get update -y
sudo apt-get install -y google-chrome-stable

# CDP driver only — no browser download.
mkdir -p ~/drive && cd ~/drive && npm init -y >/dev/null && npm i playwright-core

fc-cache -f
node -v; google-chrome --version; ffmpeg -version | head -1
echo SETUP_DONE
