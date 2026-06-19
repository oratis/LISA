# Lisa Pocket — iOS companion

A native SwiftUI app that turns your phone into a **remote telemetry + control
terminal for Dispatch**: see every Claude Code / Codex / managed / PTY agent on
your Mac, steer the controllable ones, adopt idle sessions, chat with Lisa, and
get push when an agent finishes / errors / needs permission.

It's a thin client to your Mac's `lisa serve --web` — the design is in
[docs/IOS_COMPANION_PLAN.md](../../docs/IOS_COMPANION_PLAN.md) and the endpoints it
uses all live in `src/web/server.ts`.

## Status

**Compile-verified MVP.** The app builds clean for the iOS Simulator (Xcode 26,
iOS 17+ target). It covers:

- **Dispatch** — roster from `/api/agents/sessions` + live `/events` SSE; rows keyed
  off `controllable` / `resumable`; per-session control: managed **approve/deny** ·
  send · cancel, PTY send · **output** · cancel, and **adopt (resume)** for idle
  claude sessions (handles the 409/403 the server returns).
- **Chat** — streams `POST /chat`.
- **Settings** — pairing (**scan** the Mac's QR code via the camera, or paste a
  `lisa-pair://…` / `?token=` string → Keychain), ntfy push registration, and a
  read-only view of the remote-control policy.
- **Glance** — a **Live Activity / Dynamic Island** for a pinned agent (Lock Screen +
  compact / expanded / minimal Dynamic Island), via a WidgetKit extension target.

**Not yet** (follow-ups): live Live-Activity updates via APNs (so a pinned agent stays
fresh while backgrounded — needs an Apple push key; ntfy push works today) and a
home-screen Widget.

## Build / verify

```sh
brew install xcodegen     # one-time
./build.sh                # xcodegen generate + xcodebuild for the simulator
```

The Xcode project is generated from `project.yml` (not committed). Simulator builds
need no code signing; App Store release goes through a signing pipeline (out of scope
here, like the Markup project's EAS flow).

## Pair it

1. On the Mac: `LISA_WEB_TOKEN=$(openssl rand -hex 24) lisa serve --web --host 0.0.0.0`
   (and `POST /api/pair/start` from localhost to mint a per-device token).
2. In the app's **Settings → Pair**, tap **Scan QR code** and point it at the code the
   Mac shows — or paste `http://<mac-ip-or-tailnet>:5757/?token=<token>` (or a
   `lisa-pair://v1?host=&port=&token=` string). The token goes to the Keychain.
3. Out of the house? Put both devices on Tailscale and use the tailnet name as the host.
