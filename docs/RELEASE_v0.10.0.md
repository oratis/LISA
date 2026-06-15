# Lisa v0.10.0

**The 1.0-foundations release.** Everything since v0.9.1's security pass goes
*deep before wide*: a real multi-agent **Dispatch** layer, a consent-gated
ambient **Sense** layer, the local-model + reflection groundwork, and — under it
all — a test net around the core loop that was previously running naked.

145 new tests (547 → 692), every PR green through typecheck + build + the full
suite, and the privacy story is now code, not copy: **all sensitive ambient
capture is off by default and gated behind explicit consent.**

> Read **Behavior changes** below if you use `--approval ask-mutating`, the
> screen-advisor, or plan to enable any ambient sensing — a few defaults are new.

## ✨ Highlights

### Dispatch — command and watch every agent
- **Multi-agent monitor.** The island pill + GUI sidebar now show *all* observed
  agents (claude-code / codex / opencode / aider / git / shell / takoapi), not
  just Claude — one roster, live, with a per-agent badge and structural activity.
- **Remote agents are first-class (TakoAPI, D2b).** Agents you *call* via the
  `takoapi` tool appear in the hub as sessions with their A2A TaskState, beside
  your local agents. Discovery stays in `takoapi discover`; the hub only ever
  shows agents you've actually interacted with — never the full registry.
- **`lisa agents`** — one-shot snapshot of every agent session across observers.
- **`/api/agent/signal`** — list / cancel the agents Lisa dispatched, over the
  (auth-gated) web API; it can only ever touch agents Lisa launched herself.

### Sense — ambient context, consent first
- **Unified consent framework.** A single source of truth (`~/.lisa/consent.json`),
  **all sensitive signals OFF by default**, fail-closed. Manage it from
  `lisa consent` or the island's "👁 sense" panel — every signal has a toggle and
  there's a one-tap **Stop all sensing**.
- **S2-screen** — your foreground app, as an ambient signal (app *names* only; no
  screenshots in this path). Blacklisted apps (password managers / banking) are
  skipped whole-frame; window titles are secret-path-dropped + PII-redacted.
- **S2-voice** — push-to-talk transcripts become ambient context when `voice` is
  granted (no audio stored; PII-redacted). Off → dictation works exactly as before.
- **Observer deepening** — `gitBranch` for codex/opencode (derived from cwd),
  wider activity windows, and a `verify-observers` harness to confirm the parse
  against your real agents.
- **`lisa sense`** + an island "recently sensed" feed make all of it legible.

### Model — toward local
- **`lisa model list / install / use / health`** — drive a local Ollama backend
  (pull + switch) from one command.
- **Local embeddings + provider fallback** — semantic recall off-device when
  configured; auto-detect + graceful fallback to TF-IDF / a second provider.

### Reve — reflection you can audit
- **Reflection quality gates** + an **autonomy-run ledger** (`lisa autonomy`) +
  an idle **token-budget breaker** so unattended runs can't run away.
- **Soul-at-a-glance digest** + cross-agent recap folded into reflection;
  desire **"needs-user"** middle-state so Lisa flags work she needs your hand for.

## 🔧 Behavior changes

- **Ambient sensing is opt-in.** A fresh install captures nothing sensitive.
  `screen` / `voice` (and `clipboard` / `selection`, reserved) are off until you
  `lisa consent grant <signal>`.
- **The screen-advisor now also requires `screen` consent** — its own enabled
  flag is no longer enough (a screenshot → model *is* screen capture). It logs a
  hint when enabled but not yet granted.
- **`--approval ask-mutating` now prompts before more tools:** `dispatch_agent`
  and `signal_agent` (local execution / process control), and `github` *write*
  actions (create / comment / merge). github *reads* stay un-gated.
- **New CLI commands:** `lisa consent`, `lisa sense`, `lisa agents`, `lisa model`,
  `lisa autonomy` (shell completions updated for all of them).

## 🔒 Security / hardening

- **Tool input validation** — model-generated tool input is now validated against
  each tool's JSON schema *before* `execute()` (fail-closed, friendly error).
- **LAN auth red-team** — the web RCE gate is extracted into a tested
  `isRequestAuthorized` (no token ⇒ no non-loopback request passes) plus a live
  `scripts/redteam-lan.ts` probe.
- **Core-loop test net (F-core)** — the agent tool-use loop, approval gate,
  session resume, MCP mapping, subagent, and hook runner now have tests; the
  release pipeline already gates on `npm test`.

## 🧰 For operators

- `scripts/footprint.ts` + `docs/FOOTPRINT.md` — measure the resident service's
  CPU/RSS and understand the cost knobs.
- `docs/OBSERVER_FIDELITY.md` — log what you've verified against live agent versions.
- Docs honesty pass: accurate LOC, complete completions, local-model "endpoint vs
  managed lifecycle" clarified.

## Notes

- Fully backward compatible: new config files (`consent.json`, `sense/`) default
  to today's behavior when absent; existing `~/.lisa/*` formats are untouched.
- Deliberately deferred (documented with rationale): always-on voice, local STT
  (whisper.cpp), the optional screenshot→model "local-first judgment", and the
  `clipboard`/`selection` sources. macOS-first for system-level sensing.
