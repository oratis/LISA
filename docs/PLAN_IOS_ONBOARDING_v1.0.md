# PLAN — iOS Onboarding: "Get LISA on your Mac & pair" (v1.0)

**Status: design locked; M1 building.** iOS-only UX layer over existing pairing
primitives — the Mac-local path needs **zero new backend protocol**. Builds on the
merged `ConnectionMode` + scheme-aware `parsePairing` (#161, #163 — the iOS half of
*one identity, two data planes*, `docs/PLAN_IDENTITY_v1.0.md`) and extends
`docs/IOS_COMPANION_PLAN.md` §5.3 (the QR-pairing spec).

## Why / the gap

Lisa Pocket is a **companion to a Mac running LISA** (local-first). Today, first
launch drops a brand-new user straight into the `TabView`, where every tab is a
dead-end `ContentUnavailableView("Not paired")`. The user is left to *discover*
that they need a Mac, install LISA, start it **reachably**, run `lisa pair`, and
scan — with no guidance. That's a cliff, and the most common failure (the phone
can't reach the Mac because `lisa serve` binds loopback by default) is invisible.

**This feature** is a first-run guided flow that carries a new user from "app
installed, nothing configured" → "paired and in the app", holding their hand
through the Mac install, the reachability gotcha, and the QR scan.

**Key fact:** every primitive already exists —
- `lisa pair` (`src/cli/pair.ts`) → POSTs loopback-only `/api/pair/start`, which
  `mintDevice`s a per-device token (returned once), builds
  `lisa-pair://v1?host=&port=&token=&name=`, and renders a **terminal QR**.
- iOS `AppState.parsePairing` already accepts that URL **and** literal
  `http(s)://host:port/?token=` (port defaults 5757 / 443).
- `QRScannerView` already scans + degrades honestly (no camera → `onError`).

So this is a **pure iOS-side UX layer**; the only Mac-side code change is a
default-bind tweak (decision ②).

## Decisions (locked)

1. **Ship the My Mac / LISA Cloud fork now** (flow step 1). The Mac path is fully
   functional; the Cloud card routes to the `edition.ts` sign-in if ready, else a
   "Coming soon" state. A single `ConnectionMode` threads through later steps and
   drives `parsePairing`'s `http` (Mac) vs `https` (cloud) scheme.
2. **The menu-bar Mac app binds LAN-reachable by default** (`--host 0.0.0.0`).
   This removes the #1 failure (forgetting the flag) for app users and lets the
   flow's "Start LISA" step branch by install method. LAN-reachable is still
   **token-gated** — someone on your Wi-Fi can attempt to connect but can't
   without the paired device token; the flow says so on-screen.
3. **Skip allowed + "Finish setup" banner.** `needsOnboarding = !isConfigured &&
   !skipped`. Skipping drops into the app's existing empty states plus a
   persistent top banner that re-enters the flow; Settings also gets a
   "Set up / re-pair" row. Never hard-blocked.

## The flow (happy path = 3 copies + 1 scan)

Presented as a `.fullScreenCover` over `RootView` whenever `needsOnboarding`.

| # | Screen | Content | Primary CTA | Escape hatch |
|---|--------|---------|-------------|--------------|
| 0 | **Welcome** | Lisa portrait. "Meet Lisa. She lives on your Mac — this is your window to her." | Get started | *I already have LISA running →* (→ step 4) |
| 1 | **Where Lisa lives** | Two cards: **My Mac** (recommended · private · local) / **LISA Cloud** (no Mac needed) | pick a card | — |
| 2 | **Install on your Mac** | Segmented **Homebrew / npm / Mac app**, each a tap-to-copy command (`brew install oratis/tap/lisa`, `npm i -g @oratis/lisa`) or a download link | It's installed → | Help link |
| 3 | **Start LISA** | Branches by install method: **Mac app** → "Open LISA from your menu bar — already reachable"; **CLI** → copy `lisa serve --web --host 0.0.0.0` + "stay on the same Wi-Fi" | It's running → | — |
| 4 | **Show the pairing QR** | Copy `lisa pair` + "it prints a QR on your Mac" | Scan the QR | *Paste link / enter manually* |
| 5 | **Scan** | Full-screen `QRScannerView` framing the Mac's QR | (auto on scan) | Paste `lisa-pair://` · manual host/port/token |
| 6 | **Connecting → Connected** | Verify reachability + token, then "Connected to Lisa ✓" | Enter | (on failure → targeted help) |

After success the user lands on **Chat** (warmer than Dispatch).

## Connection-mode fork

`enum ConnectionMode { case mac, cloud }`, chosen at step 1, threaded through:
- **mac** → install/serve/pair steps above; scheme `http`, default port 5757.
- **cloud** → sign-in (Firebase / Sign in with Apple per `PLAN_CLOUD`) → server
  hands back an `https://…?token=` config; scheme `https`, default port 443.
  Until the cloud edition lands, the card shows "Coming soon" and is disabled.

## Pairing mechanism — 100% reuse

- Scan/paste → `AppState.applyPairing(raw)` → `parsePairing` writes config +
  `TokenStore`, sets `isConfigured`.
- **Verify before declaring success:** ping a cheap endpoint (island ping /
  `/api/edition`) so a bad token or unreachable host surfaces *now*, not on the
  first dead tab.
- No change to `devices.ts` / `/api/pair/start` / `lisa pair`.

## Error handling (every step recovers, never traps)

| Failure | Detection | Recovery shown |
|---|---|---|
| Phone can't reach Mac | verify times out / refused | "Same Wi-Fi? Did you run `--host 0.0.0.0`?" + Retry + manual entry + Tailscale tip (mirrors `pair.ts`'s printed hint) |
| Token rejected (401) | verify → 401 | "This link expired or was revoked — run `lisa pair` again." → rescan |
| Camera denied / Simulator | `QRScannerView.onError` | auto-fall back to Paste / Manual |
| Not a LISA code | `parsePairing` → nil | "That's not a LISA pairing code." → retry |
| Mac too old | `/api/edition` / version probe absent | soft warning, continue |
| "Not now" | user skips | empty app + persistent "Finish setup" banner |

## State & integration

- **Trigger:** `RootView` gains `.fullScreenCover(isPresented: app.needsOnboarding)`;
  dismiss on success/skip.
- **AppState additions:** `OnboardingStep` enum / presentation flag,
  `verifyConnection() async`, persisted `completedOrSkippedOnboarding`
  (UserDefaults). Everything else reuses `update / applyPairing / config`.
- **Re-entry:** Settings "Set up / re-pair" row re-presents the flow (also for
  switching Macs or to Cloud).
- **New SwiftUI files** (`Sources/Onboarding/`): `OnboardingFlow.swift` (host +
  step machine), `OnboardingScaffold.swift` (shared: progress dots, title/body,
  tap-to-copy command block, primary CTA + secondary link), per-step views, and
  `OnboardingScan.swift` (wraps the existing `QRScannerView`). All styled via
  `Theme.swift` (cyan accent, dark). One test target for the step logic +
  `parsePairing` round-trip (already pure/testable).

## Mac-side change (decision ②)

The menu-bar app (`packaging/mac-client`) starts `lisa serve` bound to
`0.0.0.0` by default (today it relies on the CLI default of loopback). Still
token-gated. The CLI keeps its loopback default; the flow / `lisa pair` instruct
`--host 0.0.0.0` for CLI users.

## Phasing (each shippable)

1. **M1** — Mac-local happy path (steps 0,1-mac,2-6) + fork UI (Cloud stubbed) +
   paste/manual fallbacks + skip-with-banner. Pure iOS + the one-line menu-bar
   default-bind change.
2. **M2** — targeted error screens, "I already have it" shortcut, Settings
   re-entry, copy haptics.
3. **M3** — Mac-side GUI QR ("Pair iPhone…" menu item / window) so non-CLI users
   skip the terminal.
4. **M4** — wire the LISA Cloud fork to the cloud-edition sign-in.

## Open questions (non-blocking)

- After success, land on **Chat** (warm) vs **Dispatch** (utility)? (Proposed: Chat.)
- Install screen: show all three methods, or detect/recommend one? (Proposed: show
  all, default-highlight Homebrew.)
- Do we surface a short link (e.g. `meetlisa.ai/start`) on the install screen so
  the user can open the Mac instructions on the Mac itself?
