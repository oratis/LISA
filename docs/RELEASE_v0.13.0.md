# Lisa v0.13.0

A small, mostly-infrastructure release on top of v0.12.0. The headline features —
the **multi-agent control plane** (see every agent; command managed agents;
PTY-spawn and **adopt** real `claude`/`codex` sessions) and the **iOS companion**
— already shipped across v0.11.x–v0.12.0. This release packages the iOS
**TestFlight** delivery pipeline and cuts a clean, current build to install.

824 tests, typecheck green, `swift build` green, no breaking changes.

## ✨ What's new since v0.12.0

### iOS — TestFlight release pipeline
- `packaging/ios-companion/testflight.sh` + `.github/workflows/release-ios-testflight.yml`:
  archive with `xcodebuild`, upload to App Store Connect via an API key — so Lisa
  Pocket can ship to TestFlight from CI.
- `packaging/ios-companion/RELEASE.md` documents the signing/credentials setup.

## 📦 Already in v0.11–v0.12 (recap, for anyone upgrading from an older build)

If you're coming from an older install (e.g. v0.8.x), you also get everything
from the control-plane line:

- **See every agent** — GUI sidebar, island, and Mac menu bar show all agents
  (claude-code / codex / managed / …) with live progress: turns, tokens, last
  tool·file, ⚠ pending-permission, ✗ error.
- **Command managed agents** — delegate a task, then approve/deny each mutating
  step, send follow-ups, cancel.
- **PTY agents (flagged `LISA_PTY_AGENTS=1`)** — spawn real `claude`/`codex`
  under a pseudo-terminal, and **adopt idle sessions you started yourself** via
  `claude --resume` (guarded so a live session is never corrupted).
- **iOS companion (Lisa Pocket)** — pair by QR, watch + steer agents, APNs push,
  widgets, Live Activity.

## Install

- **CLI / backend:** `npm install -g .` from the repo (or the published package)
  → `lisa serve --web`.
- **Mac app:** the notarized `Lisa-Suite-v0.13.0.dmg` is built by CI on the tag;
  drag Lisa.app to /Applications. (The app spawns `lisa serve --web` from your
  PATH.)
