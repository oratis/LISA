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

- A task file that does not parse or validate is renamed to `<id>.json.<ts>.corrupt` and skipped. A file written by a newer build is skipped and left in place.
- A task whose schedule cannot be used (an invalid time zone, an unknown expression) loads switched off with `pausedReason` set. Reading never writes.
- Only creating a task creates directories. Every other write fails with `TaskGoneError` when its directory is missing, so a run in flight cannot put a deleted task, or a deleted account's home, back.
- Run-log records are written as `\n<json>\n`. A torn line left by a crash is skipped by the reader and does not swallow the record after it.

## Who runs tasks

One `TaskRunner` class, three drivers:

- `serve --web` ticks every 30 s. The first tick resumes runs a previous process left behind.
- `lisa heartbeat run` (launchd, every 30 min) runs what is due, so tasks run when the web server is down.
- `lisa tasks run <id>` runs one task now.

Starting a run and continuing one — a retry after its backoff, or a resume after a crash — pass the same gate. A run the user did not start by hand needs the Proactive master switch (`autonomy/state.json`) on and the task enabled; a manual run (`lisa tasks run`, `POST /api/tasks/{id}/run`) needs only that the task still exists. When the gate is closed at the moment a run would continue, the run ends as `cancelled` with the reason (`proactive_off` / `task_disabled`, "Not continued: …") in its run history, the task goes back to rest with its next occurrence computed, and no notice is sent. A run executing in a process at the moment the switch flips is not stopped by it; cancel stops that one.

## The lease

All three drivers take the task's lease before touching it. Whoever loses skips the task.

- **Creation is exclusive** (`link()`, `O_EXCL` where hard links are missing).
- **A live holder on this host is never stolen from**, however long its lease has been expired. "Expired" only means "did not renew" — a blocked event loop or a sleeping laptop — and a holder that wakes up must not find a second runner on its run. Liveness is the pid plus the process start time recorded in the lease, so a recycled pid does not keep a dead holder's lease alive.
- **A dead holder is stolen from at once; a holder on another host, on expiry.**
- **Stealing, renewing and releasing are compare-and-swap.** Each runs under a short mutex and acts only on the lease body it just read.
- **Fencing.** Every acquisition has a token. The runner re-reads the lease and checks the token before every store write and before every side-effecting tool call. A renewal that fails or errors aborts the run through its `AbortSignal`. A runner that has lost the lease writes nothing more and does not finish the run: it now belongs to the new holder.

## What a run is guaranteed

| Guarantee | Mechanism |
| --- | --- |
| One runner at a time | The lease, with fencing |
| Nothing lost on a crash | The run record is appended after every model call and every tool call; messages as they exist |
| Resume, not restart | A run whose holder died continues under the same run id with its saved history and a note about what already happened. Given up after 3 interruptions |
| A retry is a resume | A transient failure does not end the run. It is parked (`task.resumeAt`) and resumed — same run id, same history, same ledger — up to 2 times with backoff, and the model is told the previous attempt failed and why |
| No repeated side effect | See "The ledger" |
| Finishing is recoverable | See "Finishing a run" |
| Bounded | Token (cache reads and writes included), spend, wall-clock and tool-call ceilings per run |
| Stoppable | `AbortSignal` in-process; a flag on the task across processes |
| Fair | Interrupted runs first, then the task that has waited longest; concurrency 2 at home, 1 per tenant hosted |

### The ledger

Every execution of a side-effecting call is one entry in `run.effects`, written **before** the tool runs (`started`) and closed **after** (`done` with its result, or `error`).

- If the `started` entry cannot be written, the call does not run (the attempt fails like any transient error and is retried).
- If the call has run but its outcome cannot be written, the model is never told the call failed: the run stops at once as interrupted (through its `AbortSignal`), the entry stays `started`, and the resume treats it as below.

When a run continues — after an interruption or as a retry — the entries recorded so far become a replay queue per call:

- a `done` entry answers one re-issued call with its recorded result, then is consumed;
- a `started` entry (the process died inside the call) answers one re-issued call with "outcome unknown; not executed again", then is consumed;
- an `error` entry is not replayed: the call may be tried again;
- a call issued more often than it was recorded executes normally.

Inside one uninterrupted segment nothing is replayed: the same call made twice executes twice.

### Finishing a run

1. The run's terminal record is written. Everything the bookkeeping needs is in it.
2. The notices are enqueued in the outbox under stable ids (`<runId>-<kind>`).
3. The task is updated: the pointer to the run is cleared and the next occurrence computed.

A crash after step 1 leaves a task pointing at a terminal run. The next tick completes steps 2 and 3 for that run instead of running the task again. Steps 2 and 3 are idempotent, so repeating them enqueues nothing twice.

A schedule that cannot produce a next occurrence switches the task off with a visible reason (`pausedReason`) and tells the user. A task is never left due with no way forward.

### Blocked states

- **Hosted, no allowance or a settlement that could not be recorded:** the run fails and the task is switched off at once, with the reason. Nothing retries on its own.
- **Hosted, busy or rate-limited (429):** transient. The same run is parked and resumed later.
- **Credential-looking provider errors:** not retried within the occurrence; the task is switched off after 3 in a row.

A task the engine switched off comes back when the user enables it.

## Approval

The runner asks an injected `TaskApprovalFactory` for a gate per run (`wiring.ts: setTaskApprovalFactory`).

With no factory wired — or one that returns no `approval` — the default applies, and it is an **allow-list**: a run may make only the calls in `UNATTENDED_READ_ONLY` (`policy.ts`), each verified to change nothing, some only for specific inputs (`github` for its read actions with a numeric id). Everything else is denied: every other builtin, every plugin, skill and MCP tool, and any tool added later. That includes writes to Lisa's own soul, memory and knowledge base — without an approval layer there is no decision record for them.

`policy.test.ts` enumerates the registry and fails when a tool is on neither the allow-list nor the explicit deny-list, so a new tool forces a decision.

The same predicate decides what the ledger records: anything that is not a verified read-only call.

The model is offered the surface's tools narrowed by the task's envelope, never the task tools themselves. A run started by a watcher hit carries text an outsider controls, so it is additionally limited to what a remote channel gets (no `skill_manage`, no knowledge-base writes or ingestion, none of the operational tools).

## Delivery

The outbox is at-least-once with a stable id; the default deliver is idempotent on that id, which makes delivery exactly-once as the user sees it.

The default deliver goes through the reach-out gate (`reachOut()`, source `task` or `watcher`). When the gate allows in-app delivery the result is stored as a card in the conversation and announced over SSE (`task_result`, plus the gate's own note event); the push follows the gate's decision, including quiet hours. A gate refusal is final and recorded on the outbox entry; the result stays in the run history.

A process with no conversation (the heartbeat CLI) leaves notices pending for the next process that has one.

`notify` decides whether a successful run produces a notice at all: `always`, `on_change`, `on_hit`, `silent_on_noop`. A reply of exactly `(no update)` is a no-op.

## Watchers

Web, RSS and mail checks run without a model call.

- All fetching goes through the SSRF-guarded fetch in `tools/web_fetch.ts`.
- Turning a fetched page or feed into the text that is compared — tag scanning, HTML-to-text, feed parsing, the user's regex — runs under a hard time limit. Content built to be slow is a failed check, which backs off.
- The first observation is a baseline. Hits are edge-triggered with hysteresis (two contrary readings to re-arm), and a `changed` page that returns to content already reported stays quiet.
- A feed or mailbox watcher remembers every item of the current fetch (up to 2,000) and forgets oldest-seen first, so an item still in the feed never looks new again.
- A hit notifies by default, naming the items that fired it (cleaned of one-time codes and sign-in links, bounded, quoted). `onHit: "run"` runs the instruction with the observation wrapped in a per-run tag it cannot close.
- Mail hits carry sender and subject only, after the mail inbound hygiene filter.
- Shutdown or cancellation during a check is not a watcher failure.

## heartbeat.json

Nothing is migrated automatically. `lisa heartbeat run` runs the chores in `heartbeat.json` exactly as before, and additionally runs due tasks.

`lisa tasks migrate-heartbeat [--dry-run]` moves chores into routines on request. It says what will move and that migrated chores can only make read-only calls until the approval layer is wired.

- `builtin:*` entries are never moved: they are switches on Lisa's own heartbeat work.
- A chore switched off in `heartbeat.json` is left there, untouched.
- A chore is identified by its content — name, prompt and schedule — never by its name or its position in the file. The routine id is derived from that content, and both the heartbeat's skip rule and the command's "already moved" check use it. Two chores with the same name but a different prompt or schedule become two routines; two exact copies are one chore and become one routine.
- A chore without a schedule of its own gets the installed heartbeat's real interval (read from the launchd plist; 30 minutes is assumed, and reported as an assumption, when none is installed).
- `budgetTokens` becomes each routine's per-run token ceiling.
- The heartbeat skips a chore while its routine exists and is switched on, or was switched off by the engine itself (`pausedReason` set; the user has been told why). A routine the user switched off owns nothing: if its chore is (put back) in `heartbeat.json`, the heartbeat runs it the old way.
- Order of writes: create the routine switched off; switch it on; rewrite `heartbeat.json` without exactly the chores a routine now owns (after a backup). The second write is the single switch-over point: before it the chore runs the old way, after it the new way. A chore whose routine could not be created or switched on stays in `heartbeat.json`, untouched, and keeps running the old way. At every point each chore runs exactly one way — the one exception being a routine the engine paused, which runs neither way until the user acts on the notice. Running the command again finishes whatever is left.
- The command holds the heartbeat's run lock for its whole duration, so a heartbeat tick never sees a chore half-way. It waits up to 30 s for a tick in progress, then gives up without changing anything.

## Hosted edition

Off unless `LISA_CLOUD_TASKS=1`: without it `/api/tasks*` answers 403 `capability_denied`, no runner exists and the task tools are not offered.

With it, each tenant gets a runner inside its home scope, driven by the existing sweep endpoint (its `maxRuns` is enforced per run). Every model call goes through `billing/admission.ts` (limits, turn lease, quota precheck, settlement). Watchers are not available hosted.

Every hosted run registers as account work, so account deletion stops it and waits for its last write before removing the home.

## Creating tasks

The task tools (`task_create`, `watch_create`, `task_update`) can draft and edit tasks but have no way to enable one: anything they create or edit ends up off. Enabling is the user's act, through `PATCH /api/tasks/{id}` or `lisa tasks enable`.

This holds for the task tools only. In an attended chat on the Mac edition the model also has `bash` and file tools; `lisa tasks enable <id>` from a shell, or an edit to the task file, would switch a task on. Closing that is the approval layer's job (exec asks), not the engine's.

`DELETE /api/tasks/{id}` and `lisa tasks rm` cancel a run in flight and wait for it to let go of the lease before deleting.
