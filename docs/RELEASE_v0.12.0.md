# Lisa v0.12.0

**Lisa Pocket goes real.** The iOS companion stops being a skeleton and becomes a
proper phone app — pair by QR, watch and steer your Mac's agents, get pushed when
something needs you — backed by real **APNs** delivery. Everything builds on the
v0.11 backend control plane; this is the native surface on top of it.

823 tests (804 → 823), typecheck green, no breaking changes.

## ✨ Highlights

### Lisa Pocket — the iOS companion app
- **Pair by QR.** `lisa pair` shows a QR on your Mac; the app scans it with the
  camera and mints a per-device token (revocable, hash-only on disk).
- **Watch & steer.** Live agent roster (SSE, auto-reconnect with backoff +
  foreground resync), chat with a **live mood portrait** (real server art), and a
  **dispatch ledger** view with per-entry log tails.
- **System surfaces.** A **home-screen Widget** (active / stuck agent counts),
  **lock-screen accessories**, and a **Live Activity** for a pinned agent that
  **refreshes remotely over APNs** — progress on your lock screen without opening
  the app.
- **The rest of her, read-only on your phone.** Soul / Memory / Skills / Tools
  inspection, a **Reve** tab (recap · "while you were away" · desires · advisor),
  and a **Sense** tab (consent — revoke-only — + recent events).
- **Private by default.** Optional **Face ID / passcode** lock; `lisapocket://`
  deep-links route notification taps to the right session/tab; paired-devices
  list in Settings.

### Push notifications (APNs)
- **Real APNs delivery** with token auth — `done` / `error` / `permission` agent
  transitions push to your phone. Inert without a push key (no key → no-op, no
  errors), so it ships safely.
- ntfy notifications now **deep-link** to the originating session.

### CLI
- **`lisa pair [--host H]`** — show a QR to pair a phone with a running
  `serve` (localhost), minting a per-device token.

### Fixes
- Codex resume-adopt now **refuses explicitly** instead of silently downgrading.
- Plus the v0.11.1 first-run polish (single title bar, never-silent boot) carried
  forward.

## Notes

- The push path is **opt-in and inert without an Apple push key** — nothing tries
  to reach Apple until you provision one.
- iOS surfaces (Widget / Live Activity / camera / Face ID) build with Xcode from
  `packaging/ios-companion/`; they can't be compile-verified in this repo's CI
  (no Xcode), but the backend halves (pairing, push, dispatch, SSE) are unit-tested.

## Install

```sh
npm install -g @oratis/lisa
lisa serve --web
lisa pair            # then scan the QR with Lisa Pocket
```

Mac app: download `Lisa-Suite-v0.12.0.dmg` from the GitHub Release.
