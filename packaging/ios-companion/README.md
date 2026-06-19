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

- **Dispatch** — roster from `/api/agents/sessions` + live `/events` SSE (auto-reconnect
  with backoff + a full resync on foreground); rows keyed off `controllable` /
  `resumable`; per-session control: managed **approve/deny** · send · cancel, PTY send ·
  **output** · cancel, and **adopt (resume)** for idle claude sessions (handles the
  409/403 the server returns). The toolbar opens the **dispatch ledger** (Lisa's own
  fire-and-forget runs, with a per-entry log tail).
- **Chat** — streams `POST /chat`, with Lisa's live **mood portrait** (the server's own
  art at `/assets/lisa/<slug>.png`, driven by the mood SSE).
- **Reve** — "while you were away" note + current desire, an agent-activity **recap**
  (2h/8h/24h), and dismissable advisor suggestions.
- **Sense** — ambient-signal **consent** (revoke-only from the phone; granting stays a
  Mac action) + recent sense events.
- **Settings** — pairing (**scan** the Mac's QR code, or paste a `lisa-pair://…` /
  `?token=` string → Keychain), **ntfy + APNs** push registration, read-only
  remote-control policy, **paired devices**, an optional **Face ID / passcode** lock, and
  read-only **Inspect Lisa** (Soul / Memory / Skills / Tools).
- **Glance** — a **Live Activity / Dynamic Island** for a pinned agent and a
  **home-screen / lock-screen Widget** (systemSmall/Medium + accessory families) showing
  active / stuck counts, in a WidgetKit extension. The Widget renders a counts-only
  snapshot the app shares through an App Group — the token stays in the Keychain and no
  session content reaches the extension — and tapping it deep-links into the app.
- **Deep-links** — `lisapocket://` opens the app from a Widget tap, an ntfy push, or an
  APNs push tap (the push carries the link to the relevant session).

- **Live-Activity remote refresh** — a pinned activity requests a push token (forwarded
  to the Mac), and the push-bridge refreshes it over APNs (`liveactivity`) as the agent
  updates, ending it on done/error — so it stays fresh while backgrounded.

**Needs an Apple push key** (the only remaining external dependency): APNs alert delivery
*and* the Live-Activity refresh are wired end-to-end (iOS registration + token capture, a
token-auth APNs sender) but **inert until `LISA_APNS_*` is set on the Mac**; ntfy works
today with no Apple infra. Live APNs behavior is therefore unit-/compile-verified here,
not exercised against Apple.

> Like the Live Activity, the home-screen Widget is **compile-verified on the
> Simulator**. Its data only flows on a **signed** build: App Group capabilities aren't
> applied to unsigned Simulator builds, so without signing the Widget shows its "Open
> Lisa Pocket" placeholder rather than live counts.

## Build / verify

```sh
brew install xcodegen     # one-time
./build.sh                # xcodegen generate + xcodebuild for the simulator
./build.sh test           # run the LisaPocketTests logic tests on a simulator
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
