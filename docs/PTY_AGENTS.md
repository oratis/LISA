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

## Adopting sessions LISA didn't start (`--resume`)

The headline of this spike: controlling `claude` sessions **LISA never spawned** —
your own from the app/terminal. You can't tap a *live* session's pipe (the app
owns its stdin/stdout), but every session has a stable `sessionId`, and
`claude --resume <id>` continues that exact transcript in a fresh process. So:

- In the agents card, an **idle** claude session (its owning process is gone)
  shows an **⇲ adopt** button. Click it → LISA spawns `claude --resume <id>`
  under its own PTY → you now drive a *continuation* of that conversation
  (send / answer / cancel / ▤ output). New turns append to the same transcript,
  so they show up in the app's history too.
- **Liveness guard (important):** LISA refuses (`409`) to adopt a session that's
  currently live — two writers to one JSONL transcript interleave and corrupt it.
  `liveClaudeSessionIds()` reads `~/.claude/sessions/<pid>.json` and checks the
  pid; only sessions with no running owner are marked `resumable` / adoptable.
- **Honest limit:** a session **open and running in the app right now** still
  can't be commanded from outside — close it first, then adopt. (Live control
  would require the app's undocumented `peerProtocol`, which we don't touch.)
- Binary: LISA resumes with `LISA_PTY_CLAUDE_CMD` → the newest app-bundled
  `claude` (version-matched to your sessions) → PATH `claude`.

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
3. Either:
   - **GUI** — in the agents card, pick `claude` or `codex` in the delegate
     picker, type a task, hit ▶; or
   - **Terminal** — `lisa agents pty claude "<task>"` (see below).
   (Without the flag the start endpoint returns `503` and both surfaces show the hint.)

Binary resolution is env-overridable: `LISA_PTY_CLAUDE_CMD`, `LISA_PTY_CODEX_CMD`.

## Adopt-at-launch from your terminal (`lisa agents pty`)

The honest way to "control a CLI session LISA didn't start": don't try to attach
to a `claude`/`codex` you already opened (that needs the undocumented
`peerProtocol`) — **start one through LISA** so it's born controllable.

```sh
lisa agents pty claude "refactor the auth gate"   # new agent (or: codex), with --port N
lisa agents pty --resume <session-id> [follow-up…] # adopt an IDLE claude session you started elsewhere
```

`lisa agents pty` is a thin client to the running `lisa serve --web` (loopback, no
token): it `POST`s `/api/agents/pty/start` so the CLI spawns **inside the server**
(thus in the roster, steerable from the island / GUI / phone), then mirrors the
agent's output here (SSE `/stream`) and forwards each line you type (`/send`).
Ctrl-C cancels it. Requires the server to run with `LISA_PTY_AGENTS=1`.

The `--resume <session-id>` form drives the **resume-adopt** path: it passes
`resumeSessionId` so the server runs `claude --resume <id>` (a continuation that
shares the transcript). The server's liveness guard refuses a session that's still
live (HTTP **409**) — close it first; resuming a live session corrupts its transcript.
Grab the id from a `resumable` roster row.

**Limitation (v1):** input is line-oriented (one typed line → one line into the
CLI), not a raw keystroke passthrough — good for task-style runs, not for driving
a full arrow-key TUI. Raw attach is future work.

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
- **Local-dev caveat.** `node-pty`'s native binding throws `posix_spawnp failed`
  under **Node 26**, so the live PTY path (and `lisa agents pty` end-to-end) can't
  be exercised on a Node-26 machine. CI runs Node 24, where it works; the pure
  helpers and lifecycle are unit-tested with an injected fake pty regardless.
- **Privacy.** A PTY agent captures the full terminal, including model replies.
  That content is shown to **you** on demand (`/api/agents/pty/<id>/output`) and
  is **never** folded into the structural cross-agent roster, which stays
  metadata-only like every observer.

## Endpoints (all behind the standard loopback-or-token auth gate)

| Method + path | Body | Effect |
| --- | --- | --- |
| `POST /api/agents/pty/start` | `{ agent, task, cwd? }` | spawn a fresh PTY agent (503 if flag off) |
| `POST /api/agents/pty/start` | `{ agent:"claude", resumeSessionId, cwd? }` | **adopt** an idle session (409 if it's live) |
| `POST /api/agents/pty/<id>/send` | `{ text }` | type a line into the CLI |
| `POST /api/agents/pty/<id>/cancel` | — | kill the CLI |
| `GET /api/agents/pty/<id>/output` | — | ANSI-stripped terminal tail (one-shot) |
| `GET /api/agents/pty/<id>/stream` | — | SSE: current tail (`snapshot`) then each new `chunk` — the live attach feed |

## Code

- `src/agents/pty.ts` — `PtyAgent` + `PtyRegistry` (+ pure `stripAnsi` /
  `derivePtyState` / `resolveCli`), dynamic `node-pty` import with graceful
  fallback, flag gate.
- `src/integrations/pty/observer.ts` — surfaces PTY agents in the hub roster
  (real kind, `controllable: "pty"`).
- `src/integrations/claude-code/liveness.ts` — `liveClaudeSessionIds()` (the
  adopt guard) + `resumable` enrichment in `/api/agents/sessions`.
- `src/cli/agents-pty.ts` — `lisa agents pty` adopt-at-launch client (+ pure
  `parsePtyArgs` / `parseSseEvents`, unit-tested).
- `src/web/server.ts` — the endpoints above (incl. the `/stream` SSE feed).
- GUI: delegate kind picker + `controllable`-family row controls in
  `lisa-html.ts` / `lisa-client.ts` / `lisa-css.ts`.
- Tests: `src/agents/pty.test.ts` (pure helpers + lifecycle via an injected fake
  pty; one real-`node-pty` round-trip that skips when the dep can't spawn).
