# Lisa v0.14.0

The **App-Store-readiness** release. Since v0.13.0, the iOS companion (Lisa Pocket)
went from "connects and chats" to a polished, submission-ready app: it now pairs
reliably off Wi-Fi, never leaves a chat in a dead end, and has a redesigned home /
chat / agents surface. Alongside it: a hardened LISA Cloud M0, and a small,
model-appropriate provider tune-up.

Typecheck green · full test suite green · `swift build` green · no breaking changes.

## ✨ What's new since v0.13.0

### iOS — reachability you can trust
- **Tailscale-first pairing + honest errors** (#202): the pairing QR/flow prefers a
  reachable address, and connection failures now say *what* went wrong instead of
  masking everything behind a `-999 "cancelled"`.
- **Off-Wi-Fi recovery** (#203): a "same Wi-Fi?" banner when a paired LAN IP is
  unreachable on cellular, an "Anywhere (Tailscale)" toggle, and **one-tap switch to
  LISA Cloud** when your Mac isn't reachable.
- The Mac backend now **binds LAN-reachable by default, token-gated** (#169), and the
  menu bar has native **"Pair iPhone…" QR** pairing (#171, #173) — no terminal needed.

### iOS — chat that never dead-ends
- **Retry / Stop / empty-turn handling** (#206): an empty or failed turn becomes a
  tappable **Retry** instead of a silent "(no response)"; **Stop** cancels a
  streaming turn (and aborts the agent server-side); clearer error vs. empty states.
- **Full UI redesign**: card-dashboard Home + 4-tab IA (#196, #198), chat bubbles
  with code blocks / tool chips / typing / history (#194, #200), needs-you-first
  **Agents** action cards (#199), onboarding polish (#195), accessibility pass (#191),
  and haptics + toasts on mutating actions (#190).

### iOS — App Store submission
- **Sign in with Apple gated off for v1** to avoid the 5.1.1(v) in-app-account-deletion
  requirement while the cloud is still single-tenant (re-enable via `LISA_ENABLE_SIWA`).
- **TestFlight pipeline fixes**: build number must be `< 2³²` (`date +%s`, not a 12-digit
  stamp), `MARKETING_VERSION` must be ≥ the ASC version, and `CFBundleVersion` is now
  stamped into the generated Info.plists — so uploads actually appear in TestFlight.
- Privacy policy page (en + zh-CN) for submission (#165).

### LISA Cloud (M0)
- Connect Lisa Pocket to an **HTTPS cloud URL**, not just a LAN Mac (#161).
- **Durable soul** via a GCS volume at `/data` (#162); provider-aware birth/run gates
  with a **GLM-powered demo** (#158); Sign-in-with-Apple env plumbing through
  `deploy.sh` (#177).

### Providers — model-appropriate tuning
- **1-hour prompt caching** on the stable system prefix (soul + skills + memory) so it
  stays warm across think-time gaps instead of a cold re-write every 5 minutes;
  conversational tail stays 5-minute. `LISA_CACHE_TTL=5m` opts back out.
- **Thinking-effort lever** (`output_config.effort`): dispatched subagents default to
  `low` (cheap parallel work); `LISA_EFFORT` overrides globally. See
  `docs/PLAN_MODEL_TUNING_v1.0.md` for the plan + debate (most OpenClaw-style knobs
  were dropped — 1M context is already native on Sonnet 4.6, the rest are Opus/Sonnet-5
  only).

## Install / update

- **Mac**: download `Lisa-Suite-v0.14.0.dmg` below, or let the in-app updater pull it.
- **CLI**: `npm i -g @oratis/lisa@0.14.0` (or the `lisa-*-bundle` tarballs below).
- **iOS**: via TestFlight (build ships separately from this release).
