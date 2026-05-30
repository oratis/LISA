## What's new in v0.4.0 — LISA becomes a cross-agent orchestrator

The headline: LISA evolves from "watches Claude Code" into **mission control for
every AI agent on your machine**. She observes all of them, understands what each
session is doing (without reading your conversations), periodically advises you,
and can dispatch + coordinate work — implementing layers L1–L5 of the
orchestrator plan (`docs/ORCHESTRATOR_PLAN.md`).

### Observe — one registry for all agents

- A pluggable **integration registry** (mirrors the channel adapter pattern) +
  an **OrchestratorHub** that fans out over every enabled agent, merges their
  sessions into one normalized stream, and emits a single update event.
- Claude Code reslotted behind the generic `AgentObserver` interface (its
  watcher is unchanged).
- **Codex CLI adapter** added through the same registry (off by default, enable
  in `~/.lisa/agents.json`) — proving "add an agent ≈ ~100 lines + one import".
- New `GET /api/agents/sessions`; `/api/claude/sessions` kept as a back-compat
  alias derived from the hub.

### Understand — what each session is *doing* (Tier-2, privacy-first)

- New tiered visibility (`off` / `metadata` / `activity` / `intent`), default
  **activity**. At the activity tier LISA extracts **structural** signals only —
  tool names, file paths, the *name* of the last shell command, error flags, git
  branch, token counts — and shows a one-line "what it's doing" per session.
- **Privacy is tested, not just promised**: a unit test plants a secret string
  in every prose-bearing field (prompts, replies, Write/Edit content, full
  commands, Grep patterns, todos) and asserts it never appears in the output,
  while confirming the structural facts still extract.

### Advise — periodic proactive suggestions

- LISA now **tells you what matters** across all your agents: stuck/errored
  sessions, two agents about to clobber the same repo, repeated command
  failures, cost spikes, finished work ready for review, idle capacity.
- Built to **not be annoying**: a relevance bar (below it → her journal, not
  you), a 3-hour digest throttle (urgent items like permission prompts bypass
  it), condition-hash dedup (a condition re-surfaces only when it changes), and
  dismiss-as-signal learning (categories you always dismiss fade).
- Surfaces through the existing "while you were away" card; plus an `advise_now`
  tool so you can pull on demand ("Lisa, what's going on with my agents?").

### Dispatch + Coordinate — she can put agents to work

- **`dispatch_agent`** launches another CLI agent headlessly (`claude -p`,
  `codex exec`, `opencode run`, `aider --message --yes`), detached and tracked
  via the hub. The task is passed as a single argument (no shell-injection
  surface). Spawning an autonomous process requires approval.
- **Same-cwd conflict guard**: dispatch refuses to launch into a directory
  another agent is already working in (override with `force`) — preventing the
  #1 multi-agent failure mode at the source.

### Under the hood

- Test suite grew to **164 passing** (was 130 at v0.3.1): integration registry,
  hub, Tier-2 activity + privacy, advisor detectors/engine, Codex parser,
  dispatch argv safety.
- Still **zero new runtime dependencies**.

### Upgrade

```sh
npm install -g @oratis/lisa            # 0.4.0
# or
brew update && brew upgrade lisa
# or grab the signed + notarized Lisa-Suite-v0.4.0.dmg below
```

Enable extra agents (Codex, etc.) by creating `~/.lisa/agents.json`:

```json
{ "integrations": { "claude-code": { "enabled": true }, "codex": { "enabled": true } },
  "visibility": "activity" }
```
