# Lisa Pocket (iOS) — full layout + functionality review (v1.0)

Static review of all ~3.6k lines of `packaging/ios-companion/` (24 Swift files),
cross-checked against the backend (`src/web/server.ts`, soul/mail/push/agents) and
the plans (`PLAN_IOS_ONBOARDING_v1.0.md`, `IOS_COMPANION_PLAN.md`). Findings are
code-grounded (`file:line`); a few are flagged *uncertain* (need runtime confirm).
Severities: **Blocker** (broken core flow) · **High** · **Medium** · **Low/Nit**.

Scope note: simulator/unsigned builds only exercise empty/placeholder states for
widgets + Live Activity (App Group / ActivityKit are no-ops there); those layouts
are reasoned from code, not observed.

---

## 0. Executive summary

The app is well-architected (clean `Theme`, tolerant Codable, sound SSE
reconnect, Keychain-only token, correct device-revoke gating). The problems
cluster in five places:

1. **Mutation/control actions fail silently** — `LisaClient.fire()` discards the
   HTTP status, so every Approve/Deny/Send/Cancel/Revoke/Dismiss/push-register
   that returns 401/403/404/409 looks like it worked. Highest-impact bug.
2. **Chat is bare** — swallows in-band `error` events (turn hangs), no auto-scroll,
   renders raw text (no markdown/code), shows no tool activity. It's the most-used
   tab and the weakest.
3. **Soul → Values/Opinions render "—"** — `SoulItem` field mismatch vs `/api/soul`.
4. **Live Activity / Widget freshness** — the activity never updates/ends on-device
   (frozen forever, never auto-dismisses); the widget snapshot is only written
   while the Dispatch tab is open.
5. **Security: app-switcher snapshot leaks the token** — the biometric lock arms on
   `.background`, after iOS already snapshotted the `.inactive` frame.

Plus pervasive **accessibility** gaps (no VoiceOver labels, color-only status,
sub-44pt tap targets) and several **incomplete-vs-plan** items (§F).

---

## A. Blockers / High — correctness, fix before a wide release

| # | Sev | Area | File:line | Issue |
|---|-----|------|-----------|-------|
| A1 | **Blocker** | Dispatch/Net | `LisaClient.swift:106-110,155-167` | `fire()` only throws on transport errors; **HTTP 403/404/409 return normally and are discarded**. So `managedApprove/Deny/Send/Cancel`, `ptySend/Cancel`, `managedStart`, `consentRevoke(All)`, `advisorDismiss`, `setAutonomyState` all **fail silently**. A remote phone with `remoteControl:false` gets 403 on every control tap with zero feedback. **Fix:** make `fire()` throw `LisaError.http(code)` on non-2xx (like `decode()` already does). |
| A2 | **Blocker** | Chat | `ChatView.swift:41-46` | `/chat` SSE emits in-band `{type:"error"}` on a 200 stream (`server.ts:2053`); the loop only handles `text`, so an errored/aborted turn leaves the transcript stuck at `"…Lisa: "` with no message and no spinner. **Fix:** handle `error`/`done` events in the loop. |
| A3 | **Blocker** | Glance | `LiveActivityController.swift` (whole) | The app calls `Activity.request` but **never `activity.update`/`.end`** anywhere. Refresh is 100% remote APNs, which the project says has no Apple key yet → a pinned activity is **frozen at its start state forever and never auto-dismisses**. **Fix:** drive `update`/`end` locally from the existing SSE merge in `RosterModel`. |
| A4 | High | Inspect/Net | `Models.swift:194-201` ↔ `src/soul/types.ts:73-88` | `SoulItem.label = statement ?? what ?? text ?? summary ?? name ?? "—"`, but `/api/soul` Values are `{slug,title,body}` and Opinions `{slug,stance,confidence}` → **every Value & Opinion renders "—"** in `InspectViews.SoulView:74`. Only Desires (`what`) work. **Fix:** add `title/body/stance/slug` to the fallback chain. |
| A5 | High | Glance | `RosterView.swift:10-65` | The home-widget App-Group snapshot is written **only from `RosterModel`, which lives only while the Dispatch tab is on screen**. Stay on Chat / force-quit → widget is stale (or "Open Lisa Pocket"); its own 15-min refresh just re-reads the same stale value. **Fix:** publish the snapshot from a tab-independent place + on background. |
| A6 | High | Security | `App.swift:36,46-47` + `AppState.swift:236` | Biometric lock re-arms on `.background`, but iOS snapshots the **`.inactive`** frame for the app switcher first → the multitasking thumbnail shows the last screen (Settings token `SecureField`, chat) unredacted. **Fix:** lock / show a privacy cover on `.inactive` too. |
| A7 | High | Push/Net | `LisaClient.swift:183-186` | `pushRegister` builds prefs **omitting `mail`**; server defaults `mail:true`, so turning "Mail digest + alerts" **off is a silent no-op**. **Fix:** add `"mail": prefs.mail`. |
| A8 | High | Dispatch | `RosterView.swift:374-423` | Control buttons render purely off `session.controllable`, never off `ControlPolicy.remoteControl` (fetched only in Settings, shown read-only). A policy-blocked remote device sees Approve/Deny/Send/Cancel/Adopt that all 403 (silently, per A1). **Fix:** fetch policy in Dispatch; disable/annotate when blocked. |
| A9 | High | Dispatch | `RosterView.swift:385-399` | "done"/"error" managed+PTY sessions still show live Send/Cancel/Adopt; acting → `ok:false` → 404 (invisible per A1). **Fix:** hide/disable controls on terminal states. |
| A10 | High | Onboarding | `QRScannerView.swift:33,111` | `didScan` latches true on the first decode and is never reset; `stop()` halts the session. After **any** scan (incl. a non-LISA QR) the viewfinder freezes permanently. **Fix:** only latch on a successful LISA parse, or expose a reset. |
| A11 | High | Onboarding | `OnboardingFlow.swift:201-207` | Bad scan does `openManual()` **while still on `.scan`** with the camera live under the sheet; a second decode can fire `go(.connect)` behind the sheet (race). Also yanks the user into a form for a momentary mis-aim (plan intends "stay & retry"). **Fix:** leave `.scan`/pause session before presenting; don't force-manual on a parse miss. |
| A12 | High | Chat | `ChatView.swift:64-70` | No `ScrollViewReader`/auto-scroll — a streaming reply grows past the viewport and the view doesn't follow; user must drag continuously. **Fix:** add a bottom anchor + `scrollTo` on transcript change. |
| A13 | High | Chat | `ChatView.swift:65` | Replies render as one concatenated **raw `Text`** — no markdown, **code blocks unreadable** (proportional font, no background), links not tappable. For a coding-assistant client this is a major fidelity gap. **Fix:** per-message markdown/bubbles. |

---

## B. Medium — functional & UX gaps

- **B1** `OnboardingFlow.swift:258` — `connectScreen` verify runs in `.task`; on Back→re-scan→forward the re-fire depends on SwiftUI rebuilding the branch; if identity is kept, user is stuck on a stale error/no spinner. Make deterministic (`.id(step)` / explicit trigger). *(uncertain)*
- **B2** `OnboardingManualEntry:443-449` — Apple-sign-in error mapping lumps 500 / `.decode` into "Couldn't reach that LISA Cloud URL" (server *was* reached). Distinguish reachable-but-erroring.
- **B3** `OnboardingManualEntry:454` — cloud paste path routes through `parsePairing` which defaults bare URLs to `http`, silently downgrading a cloud connection. Default https in cloud mode.
- **B4** `OnboardingFlow.swift:178-182` — pair screen is method-agnostic: a user who chose **Mac app** is still led with the `lisa pair` terminal command as primary. Branch by `method` (lead with menu-bar "Pair iPhone…"). 
- **B5** `RosterView.swift:430-432` — optimistic send clears the field *before* the send resolves; a silent 403/404 loses the typed text. Clear only on success / restore on failure.
- **B6** `RosterView.swift:49-57` — roster merge only upserts; no "removed" SSE event, so `done` rows linger until the next full `load()`. Reconcile against full loads.
- **B7** `RosterView.swift:123-140` — no first-load spinner: opening Dispatch on a populated Mac briefly shows "No agents". (`DispatchLedgerView` does this right with a `loaded` flag.)
- **B8** `RosterView.swift:391` — PTY output is a manual one-shot `ptyOutput` pull; the live `GET /api/agents/pty/<id>/stream` SSE (`server.ts:1386`) is never wired. Monitoring is half-built vs backend.
- **B9** `SettingsView.swift:96-99` + `AppState.swift:96` — "Connect to" segmented switch only persists `lisa.mode`; the live `config` still points at the other plane (cloud https vs mac http) until re-pair → broken mixed state. Reconcile or warn on switch.
- **B10** `SettingsView.swift:104-119` — ntfy push toggles are live `@State` that do nothing until "Register push" is tapped; no "pending/unsaved" hint. Auto-register on change or label it.
- **B11** `SettingsView.swift:107` — `Toggle("Reve notes", isOn: $prefs.idle)` mislabels the `idle` ("while you were away") pref; the separate `advisor` pref is never surfaced (hardcoded). Clarify labels; expose `advisor`.
- **B12** `ReveView.swift:98-113` — every sub-fetch is `try?` then `error = nil` unconditionally → load errors never surface; an unreachable Mac looks like a quiet-but-healthy day. Set an error when the ping throws (SenseView does this right).
- **B13** `SenseView.swift:84-89` — a failed consent **revoke** is swallowed; user believes they revoked a privacy signal when they didn't. Surface failure.
- **B14** `ChatView.swift:75-82` — Send enables on whitespace-only input (`input.isEmpty` vs trimmed); fires a no-op that clears the field. Trim in the disabled check.
- **B15** Chat — tool-call events (`tool_start/tool_end`, `server.ts:1991`) are dropped; a tool-running turn shows a silent pause. Append an inline "· running Bash…" marker.
- **B16** `InspectViews.swift:8-30` — `AsyncContent` loads once on appear with **no retry / no pull-to-refresh**; on failure the user must leave+re-enter. Add a Retry button.
- **B17** `AppState.swift:71-94` / `push.ts:509` — APNs is the **only** push transport wired; without `LISA_APNS_*` on the Mac the app says "Push registered" but **nothing ever arrives**. The server fully supports `ntfy` (no Apple infra) but the client never offers it. Expose ntfy or surface the APNs-needs-config truth.
- **B18** `LisaClient.swift:197-224` — SSE uses `URLSession.shared` (60s default timeout) with no keep-alive from the server on `/events`; a quiet stream can be torn down with no auto-reconnect at the client layer (RosterView reconnects; Chat mood reconnects; raw `/events` consumers should too). Use a dedicated session with large timeouts.
- **B19** `AppState.swift:187` — `verifyConnection`/onboarding can hang up to 60s on an unreachable host (`.shared` default timeout). Use a short (~10s) probe timeout.
- **B20** `RosterView.swift:392-397` — PTY output viewer (vertical scroll, `maxHeight:200`) clips long unbroken lines horizontally inside a Form row; `DispatchDetailView` uses `ScrollView(.horizontal)` — inconsistent. Unify.
- **B21** `RosterView.swift:364-366` — control-action `status` renders at the *bottom* of the form, often off-screen below an expanded PTY section. Once A1 is fixed, errors need to land near the action.
- **B22** Glance — Dynamic Island **expanded** layout drops the turn count (compact + Lock Screen show it); `AgentLiveActivity.swift:23-35`. Add it.
- **B23** Glance — Live Activity uses hardcoded `.yellow/.blue/.red/.green` (`AgentLiveActivity.swift:47`) because `Theme` isn't compiled into the widget target (`project.yml:71`); the pinned dot mismatches the roster and `.yellow` is low-contrast on a white Lock Screen. Move status colors to `Shared/`.
- **B24** Glance — widget time is `style:.time` (absolute, widget-process TZ); for a "café, Mac at home" use case `.relative` is far clearer and conveys staleness (`AgentCountWidget.swift:71`).
- **B25** Glance — no staleness guard: `snap.updatedAt > .distantPast` only checks *configured*, so an hours-old snapshot renders as confidently live. Dim / append "· 2h ago" past N minutes.
- **B26** Glance — pinning the same session twice spawns duplicate activities (no `[sessionId: Activity]` registry, button has no disable-after-pin); `LiveActivityController.swift:10`. Keep a registry.

---

## C. Layout / UX polish — Low/Nit

- **C1** `OnboardingFlow.swift:55-79, 233-257` — Welcome & Connect screens are `Spacer`-based with **no ScrollView**; large Dynamic Type / SE can clip with no scroll escape. Wrap in ScrollView.
- **C2** `OnboardingFlow.swift:141,166,190` — install/start/pair CTAs sit outside the ScrollView with bare `.padding(.bottom,24)`; use `.safeAreaInset(.bottom)` for the home indicator.
- **C3** `OnboardingScaffold.swift:86-91` — `CopyCommandRow` clips the long `serveCommand` (`lineLimit(2)+minimumScaleFactor`); user can't read what they copy. Allow wrap / horizontal scroll.
- **C4** `OnboardingFlow.swift:75` — "I already have LISA running" shortcut back-fills install/start dots as completed (misleading); also assumes Mac (a cloud user lands on Mac pairing).
- **C5** `OnboardingFlow.swift:209-228` — scan-step "Not now" / instructions over the live camera have no scrim → unreadable on bright scenes. Add a material/gradient behind the top bar.
- **C6** `ChatView.swift:65` — empty placeholder "Say hi to Lisa." uses `Theme.text` (looks like a real message); dim it.
- **C7** `ChatView.swift:64-85` — no `.scrollDismissesKeyboard(.interactively)`, no submit-on-return, no focus mgmt.
- **C8** `ReveView.swift:67` / `InspectViews.swift:86` — monospaced recap/memory in List rows can clip long lines; no `textSelection`. Enable selection, verify wrap.
- **C9** `SettingsView.swift:48-89,183` — Save/Apply/Connect confirmation is a single shared `status` far down the form (off-screen). Inline confirmation / toast.
- **C10** `AgentCountWidget.swift:47-50,122` — `accessoryInline` uses flat emoji `▶/⏸` (monochrome system tint kills the "stuck" alarm) and no leading SF Symbol; **no `accessoryCircular`/`systemLarge`** families. `systemSmall` drops `total`+summary (dead space).
- **C11** `AgentLiveActivity.swift:11-21` — Lock Screen banner has no `containerBackground`/`activityBackgroundTint` → risk of low-contrast/unstyled chrome on iOS 18.
- **C12** `LiveActivityController.swift:25` — `staleDate: nil` → a dead activity never visually ages. Set ~30 min.
- **C13** `AgentSnapshot.swift:20` / `RosterView.swift:69` — widget "stuck" merges `error`+`waiting` (very different urgency) and "total" counts `done`/`idle` rows, inflating the headline. Disambiguate / exclude terminal rows.

---

## D. Accessibility — cross-cutting (currently near-zero)

Confirmed: **no `accessibilityLabel/Hint/Value/element` anywhere** in the content
tabs, roster, onboarding scaffold, or widgets. Specific gaps:

- **D1** Status conveyed by **color only**, no labels: `StatusDot` (`Theme.swift:69` / `RosterView.swift:196`), Live Activity dot, mail importance `‼/!` (`ReveView.swift:46`), copied-check green. VoiceOver + color-blind users get nothing.
- **D2** Onboarding progress dots have no VoiceOver representation (`OnboardingScaffold.swift:18`) — add "Step N of M".
- **D3** Icon-only buttons unlabeled: Send (`ChatView.swift:80`), Copy (28×28, `OnboardingScaffold.swift:96`), LockView Unlock hint, shield "permission required" icon (`RosterView.swift:210`).
- **D4** Sub-44pt tap targets: Send button, Copy button, `OnboardingSecondaryButton`.
- **D5** `RosterRow` reads as disjoint fragments — combine into one labeled element; label StatCell counts ("Needs you: 2").
- **D6** `MoodChip`/portrait (`ChatView.swift:129`) and Soul mood `ProgressView(value:)` (`InspectViews.swift:51`) have no a11y label/value.
- **D7** Scanner region (`OnboardingFlow.swift:209`) — no description that a camera is live / where to point.

---

## E. Security / Privacy

- **E1** (=A6) App-switcher snapshot exposes the token — lock on `.inactive`.
- **E2** `LisaClient.swift:70-78` — token rides in `?token=` query on `AsyncImage` asset URLs (logged by proxies/caches); in **cloud** edition that's the shared `LISA_WEB_TOKEN`. Necessary workaround (AsyncImage can't set headers) — ensure the server doesn't log query strings.
- **E3** `TokenStore.swift:20` — `kSecAttrAccessibleAfterFirstUnlock` allows backup/iCloud-Keychain migration of a full-control token; `…WhenUnlockedThisDeviceOnly` is tighter if no background read is needed.
- **E4** `AppState.swift:55,242` — biometric lock **fail-opens** if the device passcode is removed (auto-unlocks, token exposed). Intentional ("don't trap"), but warn in copy or keep locked.
- **E5** `TokenStore.swift:10-22` — `save()` ignores `SecItemAdd` status; a failed write looks like "unpaired" with no error.

---

## F. Incomplete /未完成 (vs `IOS_COMPANION_PLAN.md` / `PLAN_IOS_ONBOARDING`)

- **F1** **Live Activity (M2 headline "agent 进度常驻锁屏")** — only `start` exists; no on-device `update`/`end` (=A3). The pin is a one-shot snapshot, not a living activity.
- **F2** **Widget families** — missing `accessoryCircular` (the prime lock-screen slot) and `systemLarge`; lock-screen coverage is inline+rectangular only. No `AppIntentConfiguration` to choose *which* agent/project to pin (plan's North-Star pins a specific agent).
- **F3** **PTY live monitoring** — backend `/api/agents/pty/<id>/stream` SSE unused; output is manual pull only (=B8).
- **F4** **ntfy push** — server-supported, never exposed in the client; APNs-only path silently no-ops without an Apple key (=B17).
- **F5** **Chat fidelity** — no markdown/code rendering (=A13), no tool-call surfacing (=B15), no history pagination (`/api/history` exists, unused).
- **F6** **Settings "Sign in with Apple (coming soon)"** (`SettingsView.swift:91-94`) is a hard-disabled dead button **despite** the full exchange path being implemented (`AppState.connectCloudWithApple`). Wire it or remove.
- **F7** **Connection-mode switch is cosmetic** (`AppState.swift:31` "UX-only for now") — switching Mac↔Cloud changes nothing about scheme/port/config (=B9).
- **F8** **Onboarding** — `OnboardingScan.swift` named in the plan doesn't exist (scan inlined); install-screen "Help link" escape hatch absent.
- **F9** **`adoptedSessionId`** decoded but never shown (`Models.swift:25`); `DispatchView.startedAt` decoded but never shown. Minor informational gaps.
- **F10** **Release entitlement** — `aps-environment: development` (`project.yml:61`); a TestFlight/App Store build needs `production` (the whole push + Live Activity path is dev-only today). *(testflight.sh flips this for the archive — verify it covers the widget too.)*

---

## G. What's solid (to bound the review)

Endpoint/shape parity is otherwise excellent — ~30 endpoints + their JSON match
the server (verified). Tolerant Codable (`lastMtime` ISO-or-epoch, optional-heavy).
SSE reconnect-with-backoff + foreground resync (RosterView, Chat mood). Token in
Keychain only (never UserDefaults). Device-revoke correctly gated to localhost
(client never offers remote revoke). APNs subscription keyed separately from ntfy
(won't clobber). `@MainActor` discipline is clean (no data races found). Proactive
toggle has optimistic-rollback + availability gating. `verifyConnection` 401/404
mapping is correct. Apple token-exchange path fully wired (404/401/403 handled).
`serveCommand` correctly arms `LISA_WEB_TOKEN`.

---

## Suggested fix order

1. **A1** (`fire()` throws on non-2xx) — one change unlocks honest feedback for ~10 actions.
2. **A2 + A12 + A13** — make Chat usable (error events, auto-scroll, markdown).
3. **A4** — Soul Values/Opinions (`SoulItem` fields).
4. **A6/E1** — lock on `.inactive` (token leak).
5. **A7** — `mail` pref on the wire.
6. **A3 + A5** — local Live Activity lifecycle + tab-independent widget snapshot.
7. **A8/A9** — gate Dispatch controls by policy + terminal state.
8. **A10/A11** — scanner re-arm + scan-sheet race.
9. Accessibility pass (§D) — labels + tap targets, before submission.

---

# Part 2 — Layout, aesthetics & interaction-smoothness review + optimization plan

Part 1 catalogs *bugs*. Part 2 is the **design layer**: navigation/IA, visual
system, motion, feedback, state design, density — and a phased plan to make the
app feel coherent and smooth. (Code-grounded; a screenshot-based visual-QA pass
on a paired device is itself plan item **P5.4** below.)

## H. Navigation & information architecture

- **H1 — 5 tabs, but two are low-frequency.** `App.swift:19-30`: Dispatch · Chat ·
  Reve · Sense · Settings. **Sense** (privacy consent, revoke-only) and **Reve**
  ("while you were away" recap) are *occasional* surfaces sitting in prime
  bottom-bar real estate. Consensus iOS pattern: keep ≤3–4 primary tabs; demote
  the rest. *Proposal:* collapse to **Chat · Dispatch · Lisa · Settings**, where
  "Lisa" is a home/overview (mood, current desire, Reve recap, Soul/Memory peek)
  and Sense moves into Settings (it's a consent control). This also gives the app
  the **home/overview** the web UI has (Dashboard) and the iOS app lacks.
- **H2 — lands on Chat, but there's no glanceable "home".** After pairing
  (`AppState.finishOnboarding` → tab 1) the user is dropped into a bare chat. A
  home/overview that answers "what is Lisa doing / how is she" at a glance would
  orient better and showcase the product's soul (mood portrait, desire, recap).
- **H3 — Inspect (Soul/Memory/Skills/Tools) is buried in Settings.** `SettingsView`
  hosts the most *interesting* content (who Lisa is) under a utilitarian tab.
  Surface it in the proposed home/overview.
- **H4 — tab labels/icons.** "Reve" is an opaque label (French; the feature brand)
  with `moon.stars`; "Sense" with a radiowave sensor icon is also non-obvious.
  If kept as tabs, pair with clearer affordances; if demoted (H1), moot.

## I. Visual system & consistency

- **I1 — Theme is good but not shared with the widget target.** `Theme.swift` is
  centralized and clean, but `project.yml:71` excludes `Sources/` from the widget,
  so widgets hardcode `.yellow/.blue/...` (§B23) — status colors visibly mismatch
  the app. *Fix:* move the status palette + a few tokens into `Shared/`.
- **I2 — background helpers used inconsistently.** Most lists use
  `consoleBackground()` (`Theme.swift:63`); `ChatView:86` uses `Theme.bgDeep`
  directly. Cards/sections styling varies (onboarding cards vs Settings `Form`
  vs roster rows). Define one card/section style and apply it everywhere.
- **I3 — no spacing/type scale.** Padding values are ad-hoc (8/12/14/18/22/24/28/32
  sprinkled across views); font sizes mix semantic (`.body`,`.caption`) with fixed
  (`.system(size: 72/52/17/11)`). A small spacing scale (`Theme.space.s/m/l`) and a
  type ramp would remove visual jitter between screens and harden Dynamic Type.
- **I4 — monospace content handled three ways.** Horizontal scroll
  (`DispatchDetailView`), clip-in-form (PTY output, recap, memory), and plain wrap.
  Pick one "code/log block" component (mono + selectable + horizontal scroll +
  copy) and reuse.
- **I5 — dark-only, contrast risks.** The app forces `.dark` (fine, on-brand), but
  some tokens are low-contrast (e.g. `Theme.tertiary` captions; widget `.yellow`
  on white Lock Screen). Audit contrast ratios for WCAG AA on the key labels.

## J. Motion, feedback & state design (the "smoothness" core)

- **J1 — feedback is buried, not surfaced.** Across Settings/Roster, action results
  render as a shared `status` string at the *bottom* of a form, often off-screen
  (§B21, §C9). There is **no toast/snackbar** and **no consistent haptics** (only
  onboarding uses `Haptics`). *Fix:* a lightweight top/bottom **toast** + success/
  error **haptics** on every mutating action — the single biggest "feels
  responsive" upgrade once §A1 surfaces real outcomes.
- **J2 — inconsistent loading/empty/error states.** `DispatchLedger` shows a
  spinner before first load; `Roster` flashes "No agents" (§B7); `Reve` swallows
  errors (§B12); `Inspect` has no retry (§B16). *Fix:* one `AsyncStateView`
  (loading → content → empty → error+retry) used by every data screen.
- **J3 — no list/content animation.** The roster upserts rows with no
  insert/remove/move animation (§B6) — agents pop in/out abruptly. Add
  `.animation`/transitions keyed on the session id set.
- **J4 — no skeletons; abrupt content swaps.** First loads jump from blank → full.
  Lightweight skeleton/shimmer placeholders (roster rows, chat, inspect) smooth
  perceived performance.
- **J5 — transitions.** Onboarding uses a tasteful `easeInOut(0.2)`; the rest is
  default. Tab/state changes and modal presents could use subtle, consistent
  motion. Keep it restrained (this is a utility app, not a toy).

## K. Per-screen aesthetic notes

- **K1 — Chat is the #1 visual+interaction upgrade.** Today a single concatenated
  `Text` (§A13). Redesign: **message bubbles** (user right / Lisa left), **markdown
  + code blocks** (mono, bg, copy), **auto-scroll** (§A12), a **typing indicator**
  + inline **tool chips** ("· running Bash") (§B15), and the mood portrait as a
  small persistent header. This alone transforms the app's feel.
- **K2 — Roster rows are information-dense but flat.** `RosterRow` packs project /
  agent / pill / subtitle / counts / shield; good data, weak hierarchy. Strengthen
  the primary line (agent + state color), demote metadata, give the "needs you"
  shield a clear treatment (it's the call-to-action).
- **K3 — Onboarding is the most polished area** (cards, dots, haptics) but: Welcome/
  Connect don't scroll under large type (§C1), the scan step has no scrim (§C5),
  the pair step isn't method-aware (§B4), dots back-fill on the shortcut (§C4).
- **K4 — Settings is a dense `Form`** with unclear labels ("Reve notes" → `idle`,
  §B11), buried confirmations (§C9), and a dead "Sign in with Apple (coming soon)"
  button (§F6). Tighten IA, fix labels, wire or cut the dead button.
- **K5 — Glance surfaces** (§B22–B26, §C10–C13): expanded Island drops turns,
  hardcoded colors, absolute time, missing `accessoryCircular`, no staleness dim.

## L. Phased optimization plan

Each phase is independently shippable; ordered by value-per-effort. (Phase 0 =
Part 1's correctness fixes, which several design items depend on.)

- **P0 — Correctness (Part 1).** `fire()` non-2xx (A1) · chat error events (A2) ·
  Soul fields (A4) · lock on `.inactive` (A6) · mail pref (A7) · Live Activity
  local lifecycle (A3) · widget snapshot off-tab (A5) · Dispatch control gating
  (A8/A9) · scanner re-arm + scan race (A10/A11).
- **P1 — Interaction smoothness.** `AsyncStateView` (loading/empty/error+retry)
  everywhere (J2) · toast + haptics feedback system (J1) · chat auto-scroll (A12) ·
  roster list animations (J3) · short request timeouts (B19).
- **P2 — Chat redesign (K1).** Bubbles · markdown/code · tool chips · typing
  indicator · mood header · history pagination (`/api/history`).
- **P3 — Visual consistency & polish.** Share status palette to `Shared/` (I1) ·
  one card/section style (I2) · spacing scale + type ramp (I3) · one code/log block
  (I4) · onboarding scroll/scrim/method-aware (K3) · widget polish: relative time,
  staleness, `accessoryCircular`, Theme colors, expanded turns (K5).
- **P4 — IA / navigation.** Collapse to 4 tabs + a home/overview (H1/H2) · surface
  Inspect (H3) · clearer labels (H4) · Settings IA + wire/cut Apple button (K4).
- **P5 — Accessibility & QA.** VoiceOver labels + values (§D) · ≥44pt tap targets ·
  Dynamic Type audit (I3) · contrast audit (I5) · **P5.4: screenshot-based visual
  QA** on a paired device across tabs/states (the populated screens this static
  review couldn't observe).

**Effort (rough):** P0 ≈ 2–3 days · P1 ≈ 2 days · P2 ≈ 2–3 days · P3 ≈ 2–3 days ·
P4 ≈ 2 days · P5 ≈ 2 days. Total ≈ 2–3 weeks of focused work; P0+P1+P5 (≈1 week)
is the realistic "ready for a credible TestFlight/submission" bar.

---

# Part 3 — 正反方辩论 (how much to do before launch) + verdict

Two independent positions, each grounded in Parts 1–2.

## 正方 — "do it properly before the public sees the product's face"

- The UI **is** the product claim. The pitch is a "self-evolving AI with a soul,"
  yet the soul (Soul/Memory) is "buried in Settings" (H3) and first run drops into
  a bare chat with no home (H2). Shipping that under-delivers on the central promise.
- **Chat is the core loop and it's broken for a *coding* client** (A13): code
  blocks are unreadable, no auto-scroll (A12), no tool feedback (B15). Plain is
  forgivable; illegible code on every turn is "this can't do its one job."
- **Foundations are cheap now, expensive later**: one `AsyncStateView` (J2), one
  toast/haptics (J1), shared palette (I1), spacing/type ramp (I3) are horizontal
  primitives — 1 edit now vs N call-sites after the code grows and users anchor on
  the 5-tab model (H1).
- **A11y + unpolished states are App-Review + first-impression risk** (D1–D5, B7,
  B12, B16). The plan itself gates a11y "before submission."
- *Concedes:* P0 is strictly first; for a *closed* TestFlight, P0+P1+P5 is a fair
  minimum; P4 (re-tab) shouldn't precede usage data.

## 反方 — "ship P0 + minimal a11y; let real usage drive P2–P4"

- **~0 users, no signal.** P0 fixes things "broken regardless of who shows up"
  (A1, A2, A4, A6, A7, A8–A11, F10 + a cheap a11y pass) — that's the credible bar,
  ~1 week per the doc's own estimate. P2–P4 are bets on guesses about nonexistent
  users.
- **The IA re-tab (P4) is the riskiest, least-justified work.** Its whole basis —
  "Sense and Reve are low-frequency" (H1) — is an assertion with **no usage data**.
  Re-tabbing around an untested guess introduces nav bugs, forces relearning, and
  gets thrown away if testers actually live in Reve/Sense. Textbook premature
  architecture.
- **TestFlight *is* the signal mechanism.** Ship functional, watch which tabs get
  used and what testers complain about, *then* invest. Each phase is "independently
  shippable," so deferring costs nothing structurally.
- *Concedes:* the genuine must-dos (A1 silent-failure, A6 token leak, A2 hung chat,
  A4 Soul "—", scanner freeze, `aps-environment` F10) are non-negotiable; and a
  *thin* chat fix + a *thin* feedback path are worth pulling forward.

## Verdict (what we'll actually build, and order)

The two sides converge on the floor and disagree only on Chat's launch-tier and on
P3/P4 timing. Synthesis:

**🚩 Launch gate (do now — ~1–1.5 weeks):**
1. **P0 correctness** — A1 (`fire()` non-2xx) · A2 (chat error events) · A4 (Soul
   fields) · A6 (lock on `.inactive`) · A7 (mail pref) · A8/A9 (Dispatch gating) ·
   A10/A11 (scanner) · A3/A5 (Live Activity local lifecycle + off-tab snapshot) ·
   F10 (`aps-environment` production — verify the archive).
2. **Thin chat** — A2 + **A12 auto-scroll** + render replies via `Text(.init(markdown:))`
   (gets bold/links/inline code for ~nothing). *Defer* the full K1 redesign.
3. **Thin feedback** — a toast + success/error **haptics** on mutating actions (so
   A1's now-surfaced failures land visibly). *Defer* the full `AsyncStateView`
   rollout, but adopt it for the 2–3 screens touched anyway.
4. **Minimal a11y** — VoiceOver labels + values, color+label status, ≥44pt targets
   (D1–D5).
5. **One cheap P3 pull-forward** — move the status palette to `Shared/` (fixes the
   widget/app color mismatch, I1/B23) since it's a small horizontal change.

**⏳ Fast-follow (after TestFlight signal):**
- **P2** full Chat redesign (bubbles, tool chips, typing indicator, history).
- **P3** visual-system overhaul (spacing scale, type ramp, one card/log component).
- **P4** IA / re-tab + home/overview — **gated on actual usage data**, not H1's
  assumption. (反方's strongest point; 正方 concedes.)

**Always:** P5.4 on-device screenshot QA once a paired build exists.

Rationale: 反方 wins on **P4** (don't re-architect IA pre-signal) and on not
gold-plating P3; 正方 wins on **Chat** (a coding client that can't render code is
the product not working) and on a11y/feedback being correctness-of-experience, not
taste — so the launch gate pulls a *thin* slice of P1/P2 forward and defers the
heavy/ speculative phases to data.

---

# Implementation log

Tracking execution against the verdict's launch gate (newest first).

- _(in progress)_ **P0-A1** — `LisaClient.fire()` throws `LisaError.http` on non-2xx
  so the ~10 control/mutation actions stop failing silently.


</content>
