# Lisa v0.25.0

**The review-and-optimization release.** Two full-project reviews of v0.24.0 —
one UX, one technical — turned 24 findings into nine merged PRs (#365, #368–#376).
Two P0s are gone: the phone layout that collapsed the main pane to 75px, and the
first-run dead end that trapped anyone who typed a wrong API key. Underneath
that: hosted-edition boundary fixes, a durable billing outbox, a self-watchdog
for the backend, and the engineering gates — lint, formatter, coverage floors,
dependency bot, a real CI matrix, an offline browser smoke — that 60k lines of
TypeScript had been running without. Plans in
[PROJECT_REVIEW_UX_v0.24.0.md](PROJECT_REVIEW_UX_v0.24.0.md) and
[PROJECT_REVIEW_TECH_v0.24.0.md](PROJECT_REVIEW_TECH_v0.24.0.md).

## ⚠️ Node 22.19 is now the minimum

`engines.node` moved from `>=20.0.0` to `>=22.19.0`. This is a real floor, not
housekeeping: undici — a production dependency — calls `worker_threads` APIs
added in Node 22.10, so `>=20` was a promise that installed cleanly and then
failed at runtime. `lisa doctor`, both READMEs, both install pages, the Mac
install wizard and `lisa upgrade` now all check and state the same number,
major *and* minor. On Node 20, upgrade before installing.

## 📱 The phone layout works again (#375)

Since v0.24.0 made the right panel collapse by default, `body.rb-collapsed
.frame` outranked the ≤720px media query, so a 375px viewport got a two-column
`300px 75px` grid: the main pane was **75px wide** and the send button sat off
screen. The collapse rule is now scoped to ≥721px, `#viewChat` pins its column
to `minmax(0,1fr)`, and the function bar became a horizontal scroller instead of
forcing the chat column to its ~680px min-content. Measured at 375×812, both
collapsed and expanded: main pane = viewport width, send button on screen, no
horizontal overflow anywhere. Two Playwright specs now hold that.

## 🔑 First run survives a wrong key (#375)

The birth ritual retried on 401, printed the provider's raw JSON, and made
ENTER reload the page to run again with the same bad key — with no way back to
the key form. Authentication errors are now plain language with a **Change key**
button that returns to the gate, saving a new key restarts the birth without a
reload, and the run is cancellable and deadline-bounded. The gate is also a
provider picker now: 16 providers including DeepSeek, GLM, Moonshot and Qwen, so
the web surface finally matches what the site advertises.

## 🔒 Hosted-edition boundaries (#365, #373)

- `/api/consent/*` and `/api/push/*` reached the cloud deny-list. Both stores are
  machine-wide by design, so any signed-in tenant could read every tenant's
  ntfy topics and APNs tokens, unregister their devices, or switch the mail
  digest off for the whole deployment.
- **Non-canonical paths are rejected before routing.** The deny-list matched the
  normalized pathname while every handler matched the raw `req.url`, so
  `/api/agents/recap/%2e%2e/%2e%2e/%2e%2e` normalized to `/` — not denied — and
  still ran its handler. Failing closed on the path shape covers routes added
  later too.
- **`/health` no longer publishes usage metrics to the public internet.** It is
  pre-gate on purpose (an operator has to tell "slow" from "down" without
  credentials), but in the hosted edition an unauthenticated caller now gets
  health only — not tenant, session and in-flight-turn counts, heap, RSS or
  uptime. Authenticated callers still get the full payload; `/healthz` is
  unchanged.

## ⚙️ The backend notices when it wedges (#373)

Two 5-second stalls on the daily driver during review, and `/health` could only
say `{ok:true}` — enough for launchd to restart a crash, useless against a hang.
`/health` now reports version, uptime, event-loop lag p50/p99/max, heap, RSS and
live counters; a self-watchdog exits after 60s over the lag threshold so the
supervisor can restart it; logs rotate at 10MB × 5. The stall itself was
whole-file reads — session summaries, message pages and the claude-code watcher
are streaming or tail reads now, with an mtime-keyed session index and ETags.

## 💳 Usage settlement is durable (#374)

Billing had an unrecoverable window: the provider had charged, but a failed
balance write or a crash between two writes left neither a debit nor a way to
recover. Every metered turn now appends an immutable usage event **before**
settling; a failed append fails the settlement closed. The balance carries the
applied event ids as its own idempotency key inside the same atomic update, so a
replay cannot double-charge, and a reconciler sweeps pending and failed events
every 15 minutes — escalating to `needs_human` rather than replaying anything old
enough to have aged out of that ring. `lisa billing reconcile` is the operator's
view.

## 🖥 CLI polish (#372)

Persistent REPL history (`~/.lisa/history`, mode 0600, deduped, capped),
one-line tool-call rendering, a spinner that never touches stdout, and thinking
shown as a marker with its content structurally unreachable. New:
`lisa doctor --probe` reads a running backend's `/health` and exits non-zero when
it can't; `lisa upgrade` detects Homebrew / npm-global / source, upgrades, kicks
the LaunchAgent onto the new code, and — when npm fails — hands over the same
no-sudo prefix fix the Mac wizard offers. Proxy logs are quiet unless
`--verbose`, and user-facing paths abbreviate to `~`.

## 🍎 Mac and iOS (#371)

macOS builds with zero warnings and `-warnings-as-errors`, so Swift 6 strict
concurrency can't regress in silently. Lisa.app gained a backend install wizard —
it detects Node and the CLI through a login shell, installs in-panel, and names
the fix when npm hits a permissions error — instead of the README telling you to
go run `npm install -g` yourself. On iOS: accessibility labels throughout (status
never carried by colour alone), a push transport picker that tells the truth
about ntfy vs APNs delivery, live PTY output over SSE, and dispatch rows that
distinguish a clean exit from a crash.

## 📦 Assets and docs (#369, #370)

125 PNGs losslessly re-encoded — 39.05 MB → 32.18 MB, every file verified
pixel-identical — plus real PWA icons (192, 512, a separate maskable variant and
a 180×180 apple-touch-icon) actually wired into the manifest, the page head and
the service worker precache. README dropped from 767 lines to 85 with the install
command inside the first 20; everything else moved to `docs/GUIDE.md`, mirrored
in Chinese, with zero-dependency link and EN/ZH drift checkers in CI.

## 🧰 Engineering gates (#376)

ESLint (flat config, type-aware rules) with the 69 existing violations parked as
a warn baseline and new code gated at error level. Prettier, scoped to files
changed against main. c8 coverage floors on billing, accounts, OTP, session auth,
capabilities and the soul store. Dependabot plus `npm audit` at high. CI now runs
Node 22 and 24 and triggers the website, macOS and iOS builds on their own paths
instead of leaving them to the release pipeline. And a fully offline Playwright
smoke — no model calls, a stubbed provider — whose 27 specs include the two P0s
above, so neither can come back quietly.
