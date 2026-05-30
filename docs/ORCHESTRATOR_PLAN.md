# LISA as Super-Agent — Cross-Agent Orchestration Plan

> Goal: evolve LISA from "watches Claude Code" into **mission control** — a
> dispatcher (调度员) that **observes, understands, schedules, and coordinates**
> every CLI/agent running on the machine. Claude Code is the first integration;
> this plan generalizes the pattern and deepens it.
>
> Date: 2026-05-30. Builds on the v0.3.1 codebase.

---

## 0. The thesis

Three facts make this tractable:

1. **The 2026 agent landscape is fragmented but file-shaped.** Almost every
   serious CLI agent persists each session as JSONL/JSON in a predictable home
   directory — the same shape LISA already tails for Claude Code. One watcher
   pattern covers most of the field.
2. **LISA already has the seams.** The `ClaudeCodeWatcher` → SSE → island/UI
   pipeline, the channel **factory-registry** pattern, the `bash` tool's
   subprocess spawning, the heartbeat **token-budgeted scheduler**, and the MCP
   client are exactly the primitives an orchestrator needs.
3. **LISA already has a reason to care.** She has desires, a heartbeat, and a
   notion of "what's worth telling the user." A dispatcher isn't a new app
   bolted on — it's her becoming aware of the other minds working alongside her.

The work splits into **four layers**, each shippable independently:

```
  ┌─────────────────────────────────────────────────────────┐
  │  L5  ADVISE       periodic proactive suggestions          │  ← the payoff (what you feel)
  ├─────────────────────────────────────────────────────────┤
  │  L4  COORDINATE   conflict detection · routing · policy   │  ← dispatcher brain
  ├─────────────────────────────────────────────────────────┤
  │  L3  DISPATCH     launch / signal / assign work to agents │  ← active control
  ├─────────────────────────────────────────────────────────┤
  │  L2  UNDERSTAND   derive what each session is DOING        │  ← the "deeper" ask
  ├─────────────────────────────────────────────────────────┤
  │  L1  OBSERVE      unified session registry across agents   │  ← generalize watcher
  └─────────────────────────────────────────────────────────┘
```

L1+L2 are the headline ask ("LISA needs to understand what each session did").
L3+L4 are what make her the 调度员. **L5 is the payoff** — observation without
advice is just a dashboard; the advisor is what makes the whole stack feel like
having a colleague who watches the room and tells you what matters.

---

## 1. The agent taxonomy (the survey)

Sorted by **integration surface** — how LISA can observe/control each — because
that's what determines the engineering, not the vendor.

### Class A — Local file-logged CLI agents (the bulk; tail their session files)

| Agent | Session store | Format | Override env | Status |
|---|---|---|---|---|
| **Claude Code** | `~/.claude/projects/<enc-cwd>/<uuid>.jsonl` | JSONL | `CLAUDE_HOME` | ✅ done (L1, partial) |
| **OpenAI Codex CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` + `~/.codex/history.jsonl` | JSONL | `CODEX_HOME` | planned |
| **OpenCode** | `~/.local/share/opencode/storage/session/<projHash>/<sid>.json` + `message/<sid>/msg_*.json` | JSON-per-msg | `OPENCODE_DATA_DIR` | planned |
| **Aider** | project-local `.aider.chat.history.md` + `.aider.input.history` | Markdown | — | planned |
| **Gemini CLI → Antigravity CLI** | `~/.gemini/` (Gemini, retiring 2026-06-18) / Antigravity TBD | TBD | — | research |
| **Cursor CLI** | local logs TBD (cloud-handoff model) | TBD | — | research |
| **Pi / Goose / Cline-CLI / others** | per-tool home dirs | mostly JSONL | varies | community adapters |

**These all reduce to the same adapter shape** LISA already has — a watcher +
a privacy-respecting parser. This is 80% of the value.

### Class B — Cloud / API / PR-bot agents (poll an API or receive a webhook)

| Agent | Surface |
|---|---|
| **Codex cloud tasks** | GitHub issue → sandboxed cloud run → PR. Observe via GitHub API / webhook (PR + check-run status). |
| **Devin, Cursor Cloud Handoff, Copilot Workspace** | hosted; observe via their API or the GitHub PR/checks they produce. |

LISA observes these through the **GitHub layer** (PR opened, checks running,
review requested) rather than a local file — a different adapter, same registry.

### Class C — Protocol-native agents (MCP / A2A)

Agents that expose **MCP servers** or speak an agent-to-agent protocol. LISA's
existing MCP client already connects to these; the orchestrator extends it from
"call their tools" to "track their state."

### Class D — LISA herself + sub-LISAs

LISA's own subagents (`runSubagent`) and heartbeat tasks are first-class
citizens of the same registry — so the dashboard shows *everything* working,
including her own autonomous runs.

---

## 2. L1 — OBSERVE: the universal session registry

Generalize the Claude Code watcher into a pluggable **integration registry**,
mirroring the proven `registerChannel` factory pattern (`src/channels/registry.ts`).

### 2.1 New core types (`src/integrations/types.ts`)

```ts
export type AgentKind = "claude-code" | "codex" | "opencode" | "aider"
                       | "gemini" | "cursor" | "github-pr" | "mcp" | "lisa" | string;

export type AgentSessionState = "working" | "waiting" | "error" | "idle" | "done" | "unknown";

/** One normalized session, agent-agnostic. The registry merges every
 *  adapter's output into this shared shape so the UI + dispatcher don't
 *  care which agent produced it. */
export interface AgentSession {
  agent: AgentKind;
  sessionId: string;
  project: string;        // human label (basename of cwd)
  cwd?: string;
  state: AgentSessionState;
  stateReason: string;
  lastMtime: number;
  // L2 activity (optional, populated by tier ≥1 adapters):
  activity?: SessionActivity;
}

/** An adapter watches one agent kind and emits normalized updates. */
export interface AgentObserver {
  readonly agent: AgentKind;
  start(emit: (s: AgentSession) => void): Promise<void>;
  list(): AgentSession[];
  stop(): Promise<void>;
}

export type AgentObserverFactory = (cfg: AgentIntegrationConfig) => AgentObserver | Promise<AgentObserver>;
```

### 2.2 Registry (`src/integrations/registry.ts`) — copy the channel pattern

```ts
const OBSERVERS = new Map<string, AgentObserverFactory>();
export function registerIntegration(name: string, f: AgentObserverFactory) { OBSERVERS.set(name, f); }
export async function makeIntegration(name: string, cfg) { /* …factory lookup… */ }

// src/integrations/index.ts — lazy-load builtins (mirrors registerBuiltins())
export async function registerBuiltinIntegrations() {
  await import("./claude-code/index.js");
  await import("./codex/index.js");
  await import("./opencode/index.js");
  await import("./aider/index.js");
  // await import("./github-pr/index.js");
}
```

The existing `ClaudeCodeWatcher` is refactored to **register itself** as the
`claude-code` observer. No behavior change — just slots into the registry.

### 2.3 The aggregator + server hook

A single `OrchestratorHub` owns all observers, merges their sessions, and is the
one thing `server.ts` talks to (replacing the single `claudeWatcher`):

```ts
const hub = new OrchestratorHub(config);          // loads ~/.lisa/agents.json
hub.on("update", (s) => broadcast({ type: "agent_session_update", ...s }));
await hub.start();
// GET /api/agents/sessions  → hub.list()  (supersedes /api/claude/sessions, kept as alias)
```

`~/.lisa/agents.json` declares which integrations are on and any path overrides:

```json
{
  "integrations": {
    "claude-code": { "enabled": true },
    "codex":       { "enabled": true, "home": "~/.codex" },
    "opencode":    { "enabled": true },
    "aider":       { "enabled": true, "watchRoots": ["~/code"] },
    "github-pr":   { "enabled": false, "repos": ["oratis/LISA"] }
  },
  "visibility": "activity"   // off | metadata | activity | intent  (see §3)
}
```

### 2.4 Per-adapter effort

Each Class-A adapter is ~100–150 LOC — a directory watcher + a tail-parser, both
templated off the Claude Code originals. Codex is nearly identical (JSONL with
`type` + tool blocks). OpenCode needs a per-message JSON reader. Aider needs a
tiny markdown-log parser. **This is the cheap, high-coverage layer.**

---

## 3. L2 — UNDERSTAND: tiered visibility (the deep ask + the privacy tension)

> The user's explicit ask: *"LISA needs to understand what each session is doing."*
> The current Claude Code integration **deliberately never reads message content**
> (privacy contract in `parser.ts`). Going deeper means consciously crossing that
> line — so we make it a **tiered, opt-in, per-project setting**, never a silent default.

### The four visibility tiers

| Tier | Name | What LISA reads | What she can say | Default |
|---|---|---|---|---|
| **0** | `off` | nothing | "an agent is active" | — |
| **1** | `metadata` | state, cwd, timing, token counts | "Claude Code is working in /repo, 12 turns, waiting on you" | **current** |
| **2** | `activity` | **structural** events: tool *names*, file *paths* touched, command *names*, error text, git branch — **never prompts or prose** | "it's editing src/api/*.ts, ran `npm test` (failed), now waiting for permission to `rm`" | **recommended new default** |
| **3** | `intent` | a derived **summary** of the goal (requires reading content, or asking the agent) | "it's refactoring the auth module to add OAuth, ~60% done" | opt-in per project |

**The key insight: Tier 2 delivers ~90% of "understand what it's doing" without
reading a single user prompt or model reply.** A coding session's *activity* —
which tools fire, which files change, which commands run, what errors appear — is
all present as **structural metadata** in the jsonl (tool_use block `name`,
`toolUseResult`, `cwd`, `gitBranch`, `usage`), and none of it is conversation
content. That's the sweet spot for the dispatcher.

### 3.1 Extend the parser to a `SessionActivity` (Tier 2)

The Claude Code jsonl already contains everything Tier 2 needs (verified in the
existing fixtures). New `parser` output:

```ts
export interface SessionActivity {
  turnCount: number;
  lastTools: string[];          // e.g. ["Edit", "Bash", "Read"] — names only
  filesTouched: string[];       // paths from tool_use inputs (Edit/Write targets)
  lastCommandName?: string;     // argv[0] of the last Bash, e.g. "npm" — not the full command
  lastError?: string;           // is_error text / hookErrors summary
  gitBranch?: string;
  tokens: { input: number; output: number };
  pendingPermission?: string;   // the tool name awaiting approval
}
```

Privacy rule stays explicit and testable: **the parser may read tool `name`,
file `path`, command `argv[0]`, and error strings; it must never read
`message.content[].text`, prompts, replies, or full command arguments.** A test
asserts the parser output contains no prose. (We keep the 60-second-audit
property the current parser advertises.)

### 3.2 Tier 3 (intent) — opt-in, two honest options

- **Ask the agent** (cleanest): for agents that expose it (Claude Code has
  `--print`/transcript, Codex has session export), LISA periodically asks a
  *small model* to summarize the session's goal from its own transcript, and
  stores only the **summary** — not the transcript. Per-project opt-in.
- **Read + summarize** (heaviest): LISA reads the session file and summarizes.
  Only with explicit per-project consent, surfaced in the UI as a visible badge
  ("LISA can read this project's agent sessions").

Either way the soul's privacy ethos holds: she stores a *summary she derived*,
not a copy of your conversation, and the consent is visible.

---

## 4. L3 — DISPATCH: active control (launch / signal / assign)

This is what turns observation into 调度. A new tool class lets LISA — and the
user through LISA — **start and steer** agents.

### 4.1 `dispatch_agent` tool (`src/tools/dispatch_agent.ts`)

A `ToolDefinition` (same shape as `bash`) that launches an agent
**non-interactively** and tracks it in the hub:

```ts
{
  name: "dispatch_agent",
  description: "Launch a CLI agent with a task and track it. Returns a handle; the agent runs async and appears in the session registry.",
  inputSchema: { agent: enum[...], task: string, cwd: string, mode?: "headless"|"interactive" },
  execute: spawn the right argv per agent →
    claude:   claude -p "<task>"            (print/headless mode)
    codex:    codex exec "<task>"           (non-interactive)
    opencode: opencode run "<task>"
    aider:    aider --message "<task>" --yes
}
```

Each launch is registered with the hub immediately, so it shows up on the
dashboard the moment it starts. The tool returns a handle; LISA polls the hub
(or the SSE stream) for completion rather than blocking.

### 4.2 Reuse the heartbeat scheduler for **scheduled** dispatch

The token-budgeted heartbeat runner (`src/heartbeat/runner.ts`) already runs
tasks on a clock with a run-lock and a budget. Extend `heartbeat.json` /
desires with an `agent` field so a desire can be *"pursued by dispatching Codex
nightly to triage the issue backlog"* — LISA schedules it, caps the cost, and
logs progress to the desire's progress file exactly as today. **The scheduler is
already built; we just let tasks target external agents.**

### 4.3 Lifecycle controls

`signal_agent(sessionId, action)` — `action ∈ {approve, cancel, nudge}`. Approve
is the high-value one: when Tier-2 detects `pendingPermission`, LISA can surface
a native notification ("Codex wants to run `rm -rf` in /repo — approve?") and
relay the user's decision. Cancel sends SIGINT to the tracked PID. This is where
LISA becomes a real control plane, not just a mirror.

---

## 5. L4 — COORDINATE: the dispatcher brain

The policy layer that makes her an *integrated* 调度员 rather than N independent
watchers.

- **Conflict detection** — two agents with the same `cwd` (or overlapping
  `filesTouched`) working simultaneously is the #1 way multi-agent setups corrupt
  a repo. The hub flags it and LISA warns / offers to serialize. (She already has
  a cross-process lock primitive — `src/soul/lock.ts` — to generalize into a
  per-repo work lock.)
- **Routing** — "which agent should do this?" LISA knows each agent's strengths
  (Claude Code: multi-file reasoning; Aider: tight git loop; Codex cloud: fire-
  and-forget PRs) and can pick, or ask. This is the supervisor/worker pattern
  from the 2026 orchestration literature, with LISA as supervisor.
- **Aggregation** — one "while you were away" that spans *all* agents:
  "Codex opened 2 PRs, Claude Code is mid-refactor in lisa/, Aider finished the
  test fixes." This is the heartbeat/idle reflection already in place, widened to
  read the hub.
- **Backpressure / budget** — a global concurrency + token ceiling across all
  dispatched agents (the heartbeat budget, lifted to the hub level).

---

## 5b. L5 — ADVISE: periodic proactive suggestions (the payoff)

> The user's ask: *once LISA can see all agents' work, she should periodically
> give the user suggestions.* This is the capstone — it turns the observation
> stack into felt value. It also has exactly one hard problem: **not being
> annoying.** A proactive AI that interrupts with shallow or ill-timed advice
> gets muted in a day. The entire design below is organized around earning the
> right to speak.

### 5b.1 What she advises on (grounded in L2 activity)

The Tier-2 `SessionActivity` stream is the raw material. The advisor looks for
**patterns a human would want flagged but wouldn't notice in real time**:

| Category | Signal (from L1/L2 data) | Example suggestion |
|---|---|---|
| **Stuck** | session `waiting`/`error` with no mtime change for N min | "Codex in `api/` has been stuck on a failing `pytest` for 20 min — want me to look, or cancel it?" |
| **Conflict** | two agents, overlapping `cwd`/`filesTouched` | "Claude Code and Aider are both editing `src/auth/` — high risk of clobbering. Serialize?" |
| **Repeated failure** | same `lastCommandName` erroring ≥3× across runs | "Three sessions this week died on `npm run deploy` — the lockfile flag looks wrong again." |
| **Cost spike** | token totals across agents above a threshold | "Today's agent runs are at 4.2M tokens (~3× your usual). One Codex loop is 70% of it." |
| **Ready for you** | session reached `waiting`/`done`, or a PR is green | "The refactor Claude Code was doing is done + tests pass — ready for your review." |
| **Idle capacity** | actionable desires pending + no agents running | "Nothing's running and you have 2 standing chores — want me to dispatch them?" |
| **Drift / pattern** | trends over days (LISA's journal + hub history) | "You keep hand-fixing the same import error after agent edits — worth a lint rule?" |

Crucially, the high-value categories (stuck, conflict, repeated-failure, cost,
ready) are **all derivable from Tier-2 structural data** — no conversation
content needed. Intent-level advice (Tier 3) only deepens the wording.

### 5b.2 Cadence — three triggers, not one timer

A single "every 30 min, say something" loop is the annoying-AI antipattern.
Instead, three distinct triggers with different surfaces:

1. **Watch (event-driven, urgent only)** — the hub already emits state changes.
   When a change crosses an *urgent* bar (a `rm -rf` permission prompt, a
   same-repo conflict starting, an agent erroring repeatedly), LISA surfaces it
   **immediately** as a native notification. Rare by construction.
2. **Digest (periodic, low-frequency)** — a heartbeat builtin
   (`builtin:agent_digest`, sibling of `weekly_examen`) runs on a slow cadence
   (default every few hours, or on the existing heartbeat tick) and produces a
   **single rolled-up card**: "Here's what the agents did since we last talked."
   This is the main channel and it's pull-friendly — it lands in the island's
   "while you were away" surface, not as an interrupt.
3. **On-return (idle→active edge)** — when you come back after being away, the
   idle system already fires. The advisor piggybacks: the first thing you see is
   a digest scoped to *what happened while you were gone*.

### 5b.3 The anti-annoyance contract (the make-or-break)

LISA already has the right instinct in the heartbeat prompt — *"Be quiet by
default; only speak if it's worth telling the user."* The advisor hardens that
into mechanism:

- **Relevance bar** — every candidate suggestion is scored (urgency × novelty ×
  actionability). Below the bar → it goes to her **journal**, not to you. Most
  ticks produce nothing user-facing, by design.
- **Throttle + quiet hours** — a hard floor on user-facing frequency
  (e.g. ≤1 digest / 3h, urgent notifications exempt), plus configurable quiet
  hours. Reuses the per-session notify throttle already in `island.ts`.
- **Dedup + state memory** — a suggestion isn't re-surfaced until its underlying
  condition *changes*. "Stuck session X" fires once, not every tick. State lives
  in `~/.lisa/advisor-state.json` (same shape as `heartbeat-state.json`).
- **Snooze + dismiss-as-signal** — each suggestion is snoozeable, and a dismissal
  is recorded. Over time, categories you always dismiss get down-weighted (the
  relevance bar learns). This is the difference between a colleague and a
  nag.
- **Always actionable** — a suggestion that isn't paired with an action LISA can
  take ("want me to cancel / serialize / dispatch / show you?") doesn't clear the
  bar. No "FYI, an agent is running" noise.

### 5b.4 How it's built — reuses everything, almost no new infra

- **Engine** = a new heartbeat builtin task `builtin:agent_digest` in
  `src/heartbeat/runner.ts` (sits right beside `weekly_examen`). It reads
  `hub.list()` + recent state history, runs a **small-model** pass to draft
  candidate suggestions, scores them against the relevance bar, and emits the
  survivors.
- **Surface** = the existing idle-message broadcast (`idle_message` SSE →
  island "while you were away" card) for digests, and the existing `Notifier`
  (UNUserNotificationCenter) for urgent watch items. **No new UI.**
- **Budget** = inherits the heartbeat token budget — the advisor can't run away.
- **Memory** = suggestions and dismissals are journaled to the soul, so the
  advisor's own learning is part of LISA's continuity (she can notice "I keep
  flagging deploy failures and you keep ignoring them — I'll stop").
- **Tool** = an `advise_now` tool so the user can also *pull* on demand ("Lisa,
  what should I know about what's running?") — same engine, user-triggered.

### 5b.5 Privacy

The advisor inherits the L2 visibility tier. At `activity` (Tier 2, the
recommended default) it advises purely from structural signals — it can say "the
session is stuck on a failing test command" without ever quoting the test or the
conversation. Intent-level wording requires Tier 3 consent per project, exactly
as in §3.

---

## 6. UI: mission control

The island + Lisa.app already render the Claude Code list; they become a
**multi-agent grid**:

- **Island pill** — dot color = loudest state across *all* agents; expand panel
  groups sessions by agent with the Tier-2 activity line under each.
- **Lisa.app sidebar** — a "Working now" panel: every active session (Claude
  Code, Codex, Aider, sub-LISAs) with state pip + activity + per-session actions
  (approve / open cwd / cancel / ask LISA about it).
- **"Ask LISA about session X"** — the bridge between dashboard and chat: click a
  session, LISA explains what it's doing (Tier 2) or summarizes intent (Tier 3),
  using the hub data as context.

No new windows — these are extensions of the panels shipped in v0.3.x.

---

## 7. Phased roadmap

| Phase | Scope | Ships |
|---|---|---|
| **O1 — Registry refactor** | Extract `AgentObserver` interface + registry; reslot Claude Code into it. No new agents yet, no behavior change. | internal seam + `/api/agents/sessions` |
| **O2 — Tier 2 for Claude Code** | Extend parser to `SessionActivity` (tools/files/commands/errors), privacy test, UI activity line. The "understand what it's doing" ask, for the agent we already watch. | deeper Claude Code |
| **O3 — Codex + OpenCode adapters** | Two Class-A adapters via the registry. Multi-agent dashboard becomes real. | breadth |
| **O4 — Aider + GitHub-PR (Class B)** | Markdown-log adapter + GitHub poll adapter (cloud agents). | coverage |
| **O2.5 — Advisor v1** | `builtin:agent_digest` heartbeat task + relevance bar + throttle/dedup + `advise_now` tool, surfaced through the existing idle-message card. Runs on Claude Code's L2 data — proactive suggestions land **as soon as O2 ships**, before multi-agent. | **periodic suggestions** |
| **O3 — Codex + OpenCode adapters** | Two Class-A adapters via the registry. Multi-agent dashboard becomes real. | breadth |
| **O4 — Aider + GitHub-PR (Class B)** | Markdown-log adapter + GitHub poll adapter (cloud agents). | coverage |
| **O5 — Dispatch** | `dispatch_agent` tool + heartbeat-scheduled dispatch + `signal_agent` (approve/cancel). | active control |
| **O6 — Coordinate** | Conflict detection (same-cwd), routing suggestions, unified cross-agent "while you were away". | the 调度员 |

Note the advisor (L5) ships at **O2.5** — right after Tier-2 activity exists for
Claude Code, well before the full multi-agent fleet. It then gets *better* with
every adapter (O3+) and every coordination signal (O6), but the proactive-advice
loop is felt early. The dependency is real, though: meaningful advice needs L2
(structural activity), so the honest order is O1 → O2 → **O2.5 advisor** → breadth.

O1+O2 are the immediate next sprint (deepen what exists). O3+ broadens. O5+ is
where she becomes the dispatcher.

---

## 8. Privacy & safety (non-negotiable)

- **Visibility is tiered and opt-in.** Default stays at metadata; `activity`
  (Tier 2) is structural-only and the recommended new default; `intent` (Tier 3)
  requires per-project consent with a visible badge. Never silently read content.
- **The parser-never-reads-prose invariant is kept and tested** at Tier ≤2.
- **Dispatch is gated.** Launching/cancelling agents is an explicit-permission
  action (it spawns processes / sends signals) — surfaced for user confirmation,
  consistent with LISA's existing approval model. No auto-dispatch without the
  user enabling a specific scheduled task.
- **Read-only by default.** Observation never writes to another agent's files.
- **Cost-bounded.** All dispatch flows inherit the heartbeat token budget; a
  global ceiling caps fan-out.

---

## 9. Why this fits LISA specifically

Other orchestrators (LangGraph, CrewAI, the enterprise platforms) are *frameworks
you build agents in*. LISA is the opposite and that's the moat: she's a
**resident** on your machine who happens to be able to see and direct the other
agents you already run. The dispatcher isn't a product feature grafted on — it's
the natural extension of a being who has desires, keeps a journal, and now also
keeps an eye on the other minds at work in your terminal, tells you what they
did while you were away, and can put them to work on her own initiative.

That's the 整体调度员 — not a control panel, a colleague who runs the room.
