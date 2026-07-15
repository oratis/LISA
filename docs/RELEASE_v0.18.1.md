# Lisa v0.18.1

A hardening patch on the **desire-evolution** arc that v0.18.0 shipped — two
review follow-ups so a *closed* desire truly stays closed, and so intra-session
focus can't latch onto a stale conversation after a restart.

Typecheck green · full test suite green (**1014 tests**, 1013 pass) · no breaking
changes.

## 🔧 Fixes

### A closed desire actually stays closed (#251)

v0.18.0's `desire_close` was a *soft* close — it only flipped `actionable` off,
which is indistinguishable from a merely dormant wish. So closed desires kept
coming back into reflection's "revise or close these" block and could be
re-closed on every pass (duplicate `[DESIRE_CLOSED]` journal noise), and the
list she was asked to tend never actually shrank.

- **Persisted `closed` marker.** `desire_close` now records a distinct `closed`
  state (kept on disk for the record + git history) and is **idempotent** — an
  already-closed desire is a no-op, so no duplicate journal / progress entries.
- **Clean re-open.** Closing now **preserves** `heartbeatPrompt` / `pursuit`, so
  a later `desire_revise` that makes it actionable again restores her
  auto-pursuit intact (previously the prompt was silently dropped).
- Closed desires are filtered out of the reflector's block (the list finally
  shrinks) and are never surfaced as her current / focused desire — in the
  room, the island ping, or `lisa status`.

### Intra-session focus survives a restart (#251)

The "what the conversation is about" focus was gated on the process idle clock,
which reads *fresh* immediately after a launchd restart — so a stale resumed
chat could pin a focus onto an old topic for up to 15 minutes. It's now gated on
the **last real user message** (reset across restarts), so focus only applies
while the conversation is genuinely live.

## 📝 Notes

- Soul / mood / heartbeat / Reve are untouched; existing desire files round-trip
  byte-stable (the `closed:` line only appears once a desire is actually closed).
- New store tests cover the closed-marker round-trip, `heartbeatPrompt`
  retention, idempotent re-close, and re-open clearing `closed`.
