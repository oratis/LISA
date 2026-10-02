# Task Engine — design note

W1 of [PLAN_ALWAYS_ON_UPGRADE_2026-09-30.md](./PLAN_ALWAYS_ON_UPGRADE_2026-09-30.md). Code: `src/tasks/`, `src/web/tasks-api.ts`, `src/web/tasks-host.ts`, `src/tools/task_*.ts`, `src/tools/watch_create.ts`, `src/cli/tasks.ts`.

A **task** is unattended work the user asked for: a one-off, a routine (scheduled), a watcher (condition-triggered) or a goal. Lisa's own autonomy (desire pursuit, weekly examen, desire review) is not a task and stays in the heartbeat.

## Files on disk

Everything is under `<lisaHome>/tasks/`, so on the hosted edition each tenant has its own tree.

| Path | What |
| --- | --- |
| `<id>.json` | One task (`Task`, schema version 1) |
| `runs/<taskId>/<runId>.jsonl` | One run: append-only checkpoints, messages, events |
| `outbox/<noticeId>.json` | A result waiting for, or done with, delivery |
| `.leases/task-<id>.lease` | Who is running the task right now |
| `.locks/`, `outbox/.locks/` | Short-held write locks |

A task file that does not parse or validate is renamed to `<id>.json.<ts>.corrupt` and skipped. A file written by a newer build is skipped and left in place.

## Who runs tasks

One `TaskRunner` class, three drivers:

- `serve --web` ticks every 30 s. The first tick resumes runs a previous process left behind.
- `lisa heartbeat run` (launchd, every 30 min) migrates `heartbeat.json` and runs what is due, so tasks run when the web server is down.
- `lisa tasks run <id>` runs one task now.

All three take the same per-task lease before touching a task. A lease is a file created exclusively, renewed by its holder, and stealable once it expires or its holder's pid is gone. Whoever loses skips the task.

Scheduled runs honour the Proactive master switch (`autonomy/state.json`); a manual run does not.

## What a run is guaranteed

| Guarantee | Mechanism |
| --- | --- |
| One runner at a time | Per-task lease (`lease.ts`) |
| Nothing lost on a crash | The run record is appended after every model call and every tool call; messages as they exist |
| Resume, not restart | A run whose holder died continues under the same run id with its saved history and a note about what already happened. Given up after 3 interruptions |
| No repeated side effect | A side-effecting call is recorded before it executes (in flight) and after (its result). A resumed run that issues it again is handed the recorded result. If the outcome is unknown, the model is told so and the call is **not** executed again |
| Bounded | Tokens, spend, wall-clock and tool-call ceilings per run; 2 retries with backoff; tasks pause after 3 credential or allowance refusals |
| Stoppable | `AbortSignal` in-process; a flag on the task across processes |
| Fair | Interrupted runs first, then the task that has waited longest; concurrency 2 at home, 1 per tenant hosted |

"Side-effecting" (`policy.ts`) means: the mutating tools and actions in `approval.ts`, the operational tools unattended runs never get, the task tools, and every tool that is not a LISA builtin. Lisa's own soul, memory and knowledge-base writes are not counted.

The ledger only guards replays across an interruption. The same call made twice inside one uninterrupted run executes twice.

## Approval

The runner asks an injected `TaskApprovalFactory` for a gate per run (`wiring.ts: setTaskApprovalFactory`). With no factory wired — or one that returns no `approval` — every side-effecting call is denied. Nothing is silently allowed.

The model is offered the surface's tools narrowed by the task's envelope, never the task tools themselves.

## Delivery

A finished run enqueues a notice in the outbox under a stable id (`<runId>-<kind>`), then drains it. The outbox is at-least-once with a stable id; the default deliver is idempotent on that id, which makes delivery exactly-once as the user sees it.

The default deliver goes through the reach-out gate (`reachOut()`, source `task` or `watcher`). When the gate allows in-app delivery the result is stored as a card in the conversation and announced over SSE (`task_result`, plus the gate's own note event); the push follows the gate's decision, including quiet hours. A gate refusal is final and recorded on the outbox entry; the result stays in the run history.

A process with no conversation (the heartbeat CLI) leaves notices pending for the next process that has one.

`notify` decides whether a successful run produces a notice at all: `always`, `on_change`, `on_hit`, `silent_on_noop`. A reply of exactly `(no update)` is a no-op.

## Watchers

Web, RSS and mail checks run without a model call. All fetching goes through the SSRF-guarded fetch in `tools/web_fetch.ts`. The first observation is a baseline. Hits are edge-triggered with hysteresis (two contrary readings to re-arm), and a `changed` page that returns to content already reported stays quiet. A hit notifies by default; `onHit: "run"` runs the instruction with the observation framed as untrusted data. Mail hits carry sender and subject only.

## Hosted edition

Off unless `LISA_CLOUD_TASKS=1`: without it `/api/tasks*` answers 403 `capability_denied`, no runner exists and the task tools are not offered. With it, each tenant gets a runner inside its home scope, driven by the existing sweep endpoint. Every model call goes through `billing/admission.ts` (limits, turn lease, quota precheck, settlement). No allowance stops the run; a settlement failure fails closed. Watchers are not available hosted.

## Creating tasks

The model can draft and edit tasks (`task_create`, `watch_create`, `task_update`) but cannot enable one: anything it creates or edits ends up off. Enabling is the user's act, through `PATCH /api/tasks/{id}` or `lisa tasks enable`.
