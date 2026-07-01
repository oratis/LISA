# PLAN — iOS reachability: "always reach Lisa" (v1.0)

**Problem (from a real TestFlight device):** Lisa Pocket paired to the Mac shows a
full-screen **"Can't reach Lisa"** dumping a raw `NSError` —
`NSURLErrorDomain Code=-999 "cancelled"`, failing URL
`http://192.168.3.42:5757/api/agents/sessions` — while the phone is on **5G**.

Three distinct defects stack up here; this plan fixes all three, with a 正反方
debate on *how far* to go.

## Root cause (three layers)

1. **LAN-only pairing.** `lisa pair` stores the Mac's **LAN IP** (`192.168.3.42`).
   The Mac-side host pickers (`src/web/pairing.ts` `detectLanHost`,
   `PairController.swift`) rank `en*` (Wi-Fi/Ethernet) high and `utun*` (where
   **Tailscale** lives) low — so a LAN address is chosen, which is **only
   reachable on that same Wi-Fi**. Off Wi-Fi (cellular / other network) it's dead.
2. **Raw error dumped to the user.** `RosterView.swift:16` sets
   `self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"`; a
   plain `NSError` isn't a `LocalizedError`, so `"\(error)"` prints the brutal
   `Error Domain=NSURLErrorDomain Code=-999 …`. The **onboarding** already has a
   friendly, classified message (`VerifyOutcome` → `wifi.exclamationmark`, "Is
   this iPhone on the same Wi-Fi?… A Tailscale tailnet name works too."), but the
   in-tab errors don't reuse it.
3. **`-999` shown as fatal.** `NSURLErrorCancelled(-999)` is thrown by
   `LisaClient.decode` (`session.data(for:)`) when a request is cancelled — by a
   network switch, or by SwiftUI cancelling `RosterView`'s `.task(id: app.config)`
   on re-render, or by a pull-to-refresh superseding an in-flight load. It's a
   **transient/ignorable** signal, not an error worth a full-screen takeover.
   There's also **no request timeout** (uses `.shared`, 60 s default), so an
   unreachable host hangs then fails ambiguously. And the app has **no
   `NWPathMonitor`** — zero awareness of Wi-Fi-vs-cellular or a private-IP host.

## The thesis (unchanged): local-first, reachable everywhere

The fix must not betray "your AI on your machine." Per
[PLAN_IDENTITY_v1.0.md](PLAN_IDENTITY_v1.0.md) Decision 2, the private
always-reachable path is **Tailscale** (E2E, no data in any cloud) — not a
LISA-run relay. So: **guide users onto Tailscale, tell the truth on failure, and
never crash on a cancelled request.**

## The three fixes

### Fix 1 — Tailscale-first pairing (Mac side)
Detect a **Tailscale address** (the `100.64.0.0/10` CGNAT range Tailscale
assigns) and offer it as the **"reachable anywhere"** host, alongside the LAN IP.
- `src/web/pairing.ts`: add `isTailscaleIPv4()` + `detectTailscaleHost()`. Keep
  `detectLanHost` for the same-Wi-Fi case.
- `lisa pair` (`src/cli/pair.ts`): when a Tailscale address is present, print a
  prominent recommendation — *"To use Lisa away from home, pair over Tailscale:
  `<100.x>` (make sure this iPhone is also on Tailscale), then `lisa pair --host
  <100.x>`"* — and still show the LAN QR as the default. **Do not silently switch
  the default to Tailscale** (the Mac can't know the *phone* is on Tailscale;
  forcing it would break plain same-Wi-Fi users — see debate).
- Mirror the detection in `PairController.swift` (Mac app's native QR window) and
  surface a "Reachable anywhere (Tailscale)" toggle.

### Fix 2 — Honest, actionable reachability errors (iOS side)
Stop dumping `NSError`. Add a shared classifier + view reused by every tab.
- New `Sources/ConnectionError.swift`: `classify(_ error:, config:) ->
  ConnectionProblem` mapping `NSURLError` codes → cases:
  `cancelled` (‑999, transient — see Fix 3), `cannotReach` (‑1001/‑1003/‑1004/
  ‑1005/‑1009), `unauthorized` (401/403), `serverError(code)`. Each case carries a
  friendly `title` + `message` + `actions`.
- **Private-IP awareness**: `ServerConfig.isPrivateLAN` (host in `192.168/16`,
  `10/8`, `172.16/12`). When `cannotReach` **and** the host is a private LAN IP,
  the message becomes: *"This looks like a home-Wi-Fi address (192.168.…). If
  you've left that Wi-Fi, reach your Mac with Tailscale, or switch to LISA
  Cloud."* with one-tap **"Use LISA Cloud"** + **"Re-pair"** actions.
- Fix `RosterView.swift:16` (and Home/Chat) to render the classified
  `ConnectionProblem`, not `"\(error)"`. Reuse the same view the onboarding uses.

### Fix 3 — Don't treat a cancelled request as a failure (iOS side)
- In `RosterModel.load` (and the shared classifier), **`NSURLErrorCancelled`
  (‑999) ⇒ do not set an error** — a newer load/task is coming, or the network
  just changed; let the SSE reconnect + `.task` re-run recover silently.
- Give `LisaClient` a `URLSessionConfiguration` with
  `timeoutIntervalForRequest = 10s` so an unreachable host fails **fast + clean**
  (`timedOut`), classifiable by Fix 2 instead of hanging or masking as ‑999.

## 正反方辩论 / Pro–Con debate

### 正方 — FOR (do all three, now)
- **Reachability is the #1 local-edition churn point.** "It worked at home, now it
  says Can't reach Lisa with a scary error" is a trust-killer on a *just-shipped*
  TestFlight build. Table stakes.
- **Tailscale is the honest always-on answer** — private, E2E, no cloud; it *is*
  the local-first reachability story. We already recommend it in help text; we're
  just making the Mac *surface the address* so users don't hand-type a tailnet DNS
  name.
- **Fixes 2 & 3 are unambiguous quality bugs.** Dumping `NSError` and crashing the
  tab on a cancelled request are defects with no downside to fixing.

### 反方 — AGAINST (or: don't over-reach)
- **Tailscale is a third-party dependency on *both* devices.** The Mac can detect
  its *own* Tailscale IP but **cannot know if the phone is on Tailscale** — so a
  Tailscale address could be just as unreachable as the LAN IP, only more
  confusing. Defaulting/forcing it would break plain same-Wi-Fi users.
- **A relay would be more seamless** (zero user setup) — but a *blind E2E* relay is
  ~rebuilding Tailscale (big infra), and a non-blind one puts user data through a
  LISA server, betraying the thesis. Rejected in PLAN_IDENTITY; still rejected.
- **`NWPathMonitor` + live network awareness is scope creep** for v1 — nice for
  "you're on cellular now" banners, but not needed to fix the reported bug.
- **iOS churn risk.** The iOS app is under heavy parallel redesign; broad edits to
  RosterView/LisaClient risk conflicts.

### 裁决 / Synthesis
- **Fix 2 + Fix 3: yes, fully** — pure quality fixes, no thesis tension, directly
  kill the reported screenshot. Highest priority.
- **Fix 1: yes, but *offer* not *force*.** Detect + prominently recommend
  Tailscale on the Mac (CLI now, app window next); keep LAN the default QR. The
  phone-side Tailscale requirement is surfaced in copy, not assumed.
- **Defer**: `NWPathMonitor` live banners, a relay, and any auto-switch to Cloud.

## Phasing

| Phase | What | Risk |
| --- | --- | --- |
| **R1 (this PR)** | Mac `pairing.ts` Tailscale detect + `lisa pair` offer (+ tests); iOS `ConnectionError` classifier + friendly view; RosterView no-raw-dump + ‑999-ignore; `LisaClient` 10s timeout; `ServerConfig.isPrivateLAN` | low–med |
| **R2** | `PairController.swift` Tailscale toggle in the Mac app's Pair window | low |
| **R3** | `NWPathMonitor`: a live "you're off your Mac's Wi-Fi" banner + auto-suggest Cloud/Tailscale | med |
| **R4** | One-tap "Use LISA Cloud" that carries the existing cloud config (needs the cloud account / C3 for a *seamless* switch) | med |

## Security / privacy invariants
- Tailscale path is **E2E, no data in any LISA cloud** — preserves local-first.
- The friendly error's "Use LISA Cloud" is an *explicit* user choice, never
  automatic — the local↔cloud data-plane boundary stays the user's decision.
- No new telemetry; classification is local, from the `NSError` code only.

## What R1 ships
Mac Tailscale detection + `lisa pair` recommendation (tested); iOS honest errors +
‑999 fix + request timeout. R2–R4 sequenced above.
