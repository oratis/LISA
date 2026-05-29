## What's new in v0.3.1

A **hardening release**. Following a full product/code review
(`docs/PRODUCT_REVIEW_v0.3.md`), the project went from **zero automated
tests** to a 114-test regression net with a CI gate, and four real
security/correctness holes were closed. No new features — this is about
making the v0.3.0 surface trustworthy.

### Tests + CI (0 → 114)

- New test harness using Node's built-in `node:test` via the existing `tsx`
  loader — **zero new dependencies** (consistent with the project's
  5-runtime/4-dev-dep ethos). Run with `npm test`.
- New `.github/workflows/ci.yml` gates every push and PR on
  typecheck → tests → build. The release workflows were build-only, so the
  net now actually blocks regressions.
- Test files are excluded from `dist/` (don't ship in the npm tarball).

### Security fixes

- **SSRF redirect bypass closed** (`web_fetch`) — the private-IP check ran only
  on the initial URL, so a public URL could `302` → `http://127.0.0.1:8000`
  (or the cloud metadata IP `169.254.169.254`) and be followed into internal
  services. Redirects are now followed manually with **every hop re-validated**,
  capped at 5.
- **AppleScript injection closed** (`iMessage`) — outbound text was interpolated
  into the AppleScript source with only quote-escaping, so a newline or a
  crafted `" & (do shell script "…")` payload could inject script. Inbound
  iMessage text is untrusted (anyone who can text you), so this was real. Text
  now passes as positional `argv` and is never parsed as source.
- **Path traversal blocked** (soul slugs) — value/opinion/desire/journal/
  relationship slugs are validated at the single path chokepoint; `../`,
  separators, control chars, and leading dots are rejected before becoming a
  file path.

### Concurrency & cost

- **Cross-process soul write lock** — LISA runs as several processes against
  the same `~/.lisa/soul/` (web server, CLI, the launchd/cron heartbeat + idle
  runners). Desire-progress appends (read-modify-write) now run under an
  advisory file lock, so a heartbeat can't interleave with a chat turn and lose
  data. Self-heals from a crashed holder via a staleness timeout.
- **Heartbeat token budget + run-lock** — `heartbeat.json` gains `budgetTokens`
  (default 500k): once a run crosses the ceiling, remaining tasks are skipped
  (logged, not dropped), bounding runaway autonomous cost. A run-lock skips
  overlapping ticks instead of double-running.

### Correctness & performance

- **Continuous emotion decay** — decay now applies on write (`soul_feel`) and in
  `soul_read`, not just the system-prompt view, so intensities no longer jump
  discontinuously after an offline gap; and decay no longer silently drops the
  emotion event trail.
- **Memory index cache** — the TF-IDF index is cached and rebuilt only when the
  sessions directory changes (mtime+size fingerprint), instead of on every
  `memory_search` call.

### Mac surface polish

- **Menu-bar face icon** (Lisa.app) — the bare `○` text item is now the Lisa
  face (round-masked, desaturated when the backend is offline). Left-click opens
  a live popover (mood · currently-wanting · Claude Code summary · Open /
  Refresh); right-click / ⌘-click jumps straight to the window.
- **Scrollable island expand panel** — the Dynamic-Island widget's expand panel
  now scrolls instead of clipping its content off the bottom when there's a long
  reflection plus many active Claude sessions.

### Upgrade

```sh
npm install -g @oratis/lisa            # 0.3.1
# or
brew update && brew upgrade lisa
# or grab the signed + notarized Lisa-Suite-v0.3.1.dmg below
```
