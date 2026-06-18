# PTY agents — steering real CLIs (Stage C spike)

**Status: EXPERIMENTAL. Off by default.** This is the Stage-C spike from the agent
control-plane plan — the path toward commanding *real* `claude` / `codex` CLIs,
not just LISA's own managed agents.

## What it is

A **managed agent** (Phase 3) runs LISA's *own* agent loop — its tools, its
provider. A **PTY agent** instead spawns the **real `claude` / `codex` binary**
inside a pseudo-terminal (`node-pty`), so you get that CLI's full configuration —
its skills, MCP servers, hooks, model — while LISA owns stdin/stdout:

- types your task and any follow-ups into the CLI,
- can answer its prompts (you type into it from the roster),
- reads the terminal stream for a coarse live status + a viewable output tail.

In the GUI agents card these appear under their **real kind** (`claude-code` /
`codex`), marked controllable: a **type-into-the-CLI** box, a **▤ output** button
(shows the captured terminal tail in a modal), and **⏹ cancel**.

## Enabling it

1. Install the optional native dep (it has zero JS deps; if your machine can't
   build it, nothing else in LISA is affected):
   ```sh
   npm i node-pty
   ```
2. Turn the spike on:
   ```sh
   LISA_PTY_AGENTS=1 lisa serve --web
   ```
3. In the agents card, pick `claude` or `codex` in the delegate picker, type a
   task, hit ▶. (Without the flag the start endpoint returns `503` and the GUI
   shows the hint.)

Binary resolution is env-overridable: `LISA_PTY_CLAUDE_CMD`, `LISA_PTY_CODEX_CMD`.

## Honest limits (why it's a flagged spike, not a shipped feature)

- **Only CLIs LISA spawns.** It cannot adopt a `claude`/`codex` session you
  already opened in your own terminal — those have no control channel and stay
  **observe-only**. (Commanding *those* would need Claude Code's undocumented,
  version-locked `peerProtocol` — not attempted here.)
- **Best-effort output parsing.** The CLI's TUI is ANSI / box-drawn and
  version-sensitive, so `state` is inferred from output *quiescence*
  (streaming → working, quiet → waiting), not from parsed intent.
- **Native dep.** `node-pty` is an `optionalDependency`; installs and CI never
  fail if it can't build — PTY agents are simply unavailable then.
- **Privacy.** A PTY agent captures the full terminal, including model replies.
  That content is shown to **you** on demand (`/api/agents/pty/<id>/output`) and
  is **never** folded into the structural cross-agent roster, which stays
  metadata-only like every observer.

## Endpoints (all behind the standard loopback-or-token auth gate)

| Method + path | Body | Effect |
| --- | --- | --- |
| `POST /api/agents/pty/start` | `{ agent, task, cwd? }` | spawn a PTY agent (503 if flag off) |
| `POST /api/agents/pty/<id>/send` | `{ text }` | type a line into the CLI |
| `POST /api/agents/pty/<id>/cancel` | — | kill the CLI |
| `GET /api/agents/pty/<id>/output` | — | ANSI-stripped terminal tail |

## Code

- `src/agents/pty.ts` — `PtyAgent` + `PtyRegistry` (+ pure `stripAnsi` /
  `derivePtyState` / `resolveCli`), dynamic `node-pty` import with graceful
  fallback, flag gate.
- `src/integrations/pty/observer.ts` — surfaces PTY agents in the hub roster
  (real kind, `controllable: "pty"`).
- `src/web/server.ts` — the endpoints above.
- GUI: delegate kind picker + `controllable`-family row controls in
  `lisa-html.ts` / `lisa-client.ts` / `lisa-css.ts`.
- Tests: `src/agents/pty.test.ts` (pure helpers + lifecycle via an injected fake
  pty; one real-`node-pty` round-trip that skips when the dep can't spawn).
