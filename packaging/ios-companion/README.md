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
  409/403 the server returns). A running PTY session shows **live output** — the
  server's `/api/agents/pty/<id>/stream` SSE attach (snapshot + chunks) with
  backed-off reconnect, a status line, and horizontal scrolling for long build
  lines; a finished one keeps the one-shot `/output` pull. The toolbar opens the
  **dispatch ledger** (Lisa's own fire-and-forget runs, with a per-entry log tail).
- **Chat** — streams `POST /chat`, with Lisa's live **mood portrait** (the server's own
  art at `/assets/lisa/<slug>.png`, driven by the mood SSE).
- **Reve** — "while you were away" note + current desire, an agent-activity **recap**
  (2h/8h/24h), and dismissable advisor suggestions.
- **Sense** — ambient-signal **consent** (revoke-only from the phone; granting stays a
  Mac action) + recent sense events.
- **Settings** — pairing (**scan** the Mac's QR code, or paste a `lisa-pair://…` /
  `?token=` string → Keychain), a **notification transport picker** (see below),
  read-only remote-control policy, **paired devices**, an optional **Face ID /
  passcode** lock, and read-only **Inspect Lisa** (Soul / Memory / Skills / Tools).
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

## Notifications — pick a transport

The server has always supported two delivery paths (`src/web/push.ts`), but the
app only really offered Apple's, and answered "Push registered" whether or not
anything could ever be delivered. **Settings → Notifications** now picks one:

| | **ntfy topic** | **This iPhone (APNs)** |
|---|---|---|
| Needs | the free ntfy app + a topic you choose | an Apple push key on the Mac (`LISA_APNS_*`) |
| Works today | yes, with no Apple infrastructure | only once that key is set |
| Server field | optional — blank means `ntfy.sh`, or point it at your own | — |

The line under the picker is built from **`GET /api/push/list`** — what your Mac
says it will actually publish to — not from "we sent a register request". So it
can tell you your Mac is sending to a *different* topic than the one on screen,
and the APNs line says plainly that the app cannot see whether the Mac has an
Apple key, so if nothing arrives that is the first thing to check.

**Send a test notification** (ntfy only) posts straight from the phone to the
topic. That is a real end-to-end check of the topic and your ntfy subscription
and works even while the Mac is asleep. There is no APNs equivalent: the server
exposes no test endpoint and a device cannot make Apple push to itself.

The event toggles ("Notify me about") start from what the Mac stored and say
**Unsaved** until you tap *Save preferences*, which calls `/api/push/prefs` on
the existing subscription instead of re-registering. `Daily feeds brief` is now
shown too — the server has always had it.

> The topic is the shared secret: anyone who knows it can read your alerts.
> Pick something hard to guess. Payloads stay low-sensitivity either way (agent /
> project / state), never prompts or terminal output.

## Accessibility

Every status in the app is carried by **text as well as colour** — a pip's colour
is never the only signal. `GlanceColors.phrase(_:)` is the single source of that
wording, shared with the widget extension so a "waiting on you" agent reads the
same in the roster, the Live Activity, the Dynamic Island and the home Widget.

- `StatusDot` takes an optional `label`. Passing one makes it speak; omitting it
  hides the pip from VoiceOver, which is right when the text beside it already
  says the state — so a roster row is one sentence, not "circle, project, circle".
- Roster rows, needs-you cards, dispatch entries, stat cells and onboarding
  choice cards are each **one VoiceOver element** with a full label.
- Icon-only controls (Send, Stop, Copy, Open, Unlock, load-earlier, delegate)
  have labels and hints; Send/Stop/Copy and every secondary button clear the
  **44 pt** minimum target using `minHeight`, so labels still grow with Dynamic
  Type instead of clipping.
- The pairing viewfinder announces "Camera is live" with a value that tracks the
  scan note, and points you at the QR code.
- Onboarding dots announce **"Step N of M"**; mail importance shows the word
  ("‼ Urgent" / "! Important") next to the colour; the allowance bar and the mood
  bars expose a value, not just a fill.

Run `./build.sh test` for the logic tests that pin the wording (state → phrase,
and the pip's colour agreeing with the phrase on a pending permission).

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
