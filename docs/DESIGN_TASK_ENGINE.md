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

Each task also has a working folder, `<lisaHome>/task-workspaces/<taskId>/` (see "Approval": the run's workspace).

- A task file that does not parse or validate is renamed to `<id>.json.<ts>.corrupt` and skipped. A file written by a newer build is skipped and left in place.
- A task whose schedule cannot be used (an invalid time zone, an unknown expression) loads switched off with `pausedReason` set. Reading never writes.
- `LISA_TZ` (the zone for schedules that name none) is checked when a runner is built: an invalid value is reported once and the system zone is used.
- Only creating a task creates the tasks directory (recursively). Other writes create only their own subdirectories inside an existing tasks directory, one level at a time and never recursively (`.leases`; `.locks`; `outbox`, then `outbox/.locks`; `runs`, then a run's directory `runs/<taskId>`); lease renewal and release create no directory at all. Every other write fails with `TaskGoneError` when its directory is missing, so a run in flight cannot put a deleted task, or a deleted account's home, back. A run whose lease directory has disappeared stops as removed.
- Run-log records are written as `\n<json>\n`. A torn line left by a crash is skipped by the reader and does not swallow the record after it.

## Who runs tasks

One `TaskRunner` class, three drivers:

- `serve --web` ticks every 30 s. The first tick resumes runs a previous process left behind.
- `lisa heartbeat run` (launchd, every 30 min) runs what is due, so tasks run when the web server is down. A named run, `lisa heartbeat run <name>`, runs heartbeat chores only, never a task (a title is not an identity: the model can draft a task with any title).
- `lisa tasks run <id>` runs one task now, by id. A manual run of a one-off that is still waiting for its time is a test run and does not use the occurrence up — unless the run ends after the scheduled time, in which case the occurrence is used up.

Starting a run and continuing one — a retry after its backoff, or a resume after a crash — pass the same gate.

- **What started a run is part of the run.** Its first record carries `trigger` (`manual`, `scheduled` or `watcher`), written before the task points at the run, and the gate reads it from there — never from the task's transient state, which a failed write or a crash could lose.
- **A run the user did not start by hand** needs the Proactive master switch (`autonomy/state.json`) on and the task enabled, both to start and to continue. That includes the run a watcher hit queues: the poll re-reads the task under the lease, and a watcher switched off while its check was in flight records the hit (its baseline moves on) but queues no run; a run the engine queued is not started while the task is off.
- **A manual run** (`lisa tasks run`, `POST /api/tasks/{id}/run`) needs only that the task still exists.
- **When the gate is closed** at the moment a non-manual run would continue, the run ends as `cancelled` with the reason (`proactive_off` / `task_disabled`, "Not continued: …") in its run history and no notice is sent. A task that is switched off goes back to rest switched off; an enabled routine or watcher held back by the Proactive switch goes back to rest with its next occurrence computed.
- **Except an enabled one-off held back only by the Proactive switch.** It has no next occurrence, so ending its run would lose the user's task, and starting it afresh later would repeat its side effects. Its run stays parked (the task `queued`, the same run, no model or tool call, nothing counted) and continues with its ledger once the switch is back on. A one-off the user switched off is still cancelled.
- A run executing in a process at the moment the switch flips is not stopped by it; cancel stops that one.
- **An answered run is only finished.** A run whose model had already given its final answer before an interruption is finished and its answer delivered, without a model or tool call. That is not a resume: it is not gated and not counted as an interruption, so it holds even at a run's last allowed interruption.

## The lease

All three drivers take the task's lease before touching it. Whoever loses skips the task.

- **Creation is exclusive** (`link()`, `O_EXCL` where hard links are missing).
- **A live holder on this host is never stolen from**, however long its lease has been expired. "Expired" only means "did not renew" — a blocked event loop or a sleeping laptop — and a holder that wakes up must not find a second runner on its run. Liveness is the pid plus the process start time recorded in the lease, so a recycled pid does not keep a dead holder's lease alive.
- **A dead holder is stolen from at once; a holder on another host, on expiry.** On the hosted edition every holder counts as being on another host: Cloud Run instances can share a hostname (and pids), so a pid proves nothing there and only expiry frees a lease.
- **Stealing, renewing, releasing and the orphan sweep are compare-and-swap.** Each runs under a short mutex, but none relies on it alone: the mutex is taken from a holder stalled inside it for over 15 s, and on this host at once from one whose pid is not alive (on the hosted edition by age only — a pid from another instance proves nothing). So each moves the lease file to a private name and compares it there with the body it read before acting: a steal, a release or a sweep removes it only if it is that body; a renewal installs its new body with an exclusive create only if it is that body. A different body — a lease someone took meanwhile — is put back. However late such a call lands, it never removes or overwrites the next holder's lease. An acquisition re-reads the lease after writing it and succeeds only if the file carries its token.
- **The limit.** While a file is moved aside, its path is empty for an instant (a rename, a read and a link — longer on a FUSE volume). A contender whose exclusive create lands in that instant gets the lease. If the file was a renewing holder's own, the renewal fails and that holder stops; if it was someone else's (a late call), it cannot be put back and that holder fails its next check and stops. In both cases fencing stops the one that lost. A holder's own checks wait out its own renewal, so a renewal never makes its holder look lost.
- **Known gaps.** None of these has been seen outside a probe that forces it; each is tracked as a follow-up.
  - *A revived lease (ABA).* A late call moves holder B's lease aside; within that gap a second contender C acquires the lease, runs, and releases it; the late call then puts B's body back, and B passes its checks again. It needs a call stalled past both the 15 s mutex staleness and B's TTL, and then C's whole tenure inside the gap. So "one holder at a time" holds except under two such stalls.
  - *Hosted, more than one instance.* A mutex left by a dead instance blocks lease operations for 15 s, while each operation gives up after 5 s: a renewal in that window fails and the run is aborted and resumed later. On a volume without hard links (GCS FUSE) the mutex itself can be entered by two callers at once. The hosted edition runs as a single instance today; both must be solved before it runs more than one.
  - A process killed in the middle of a swap leaves a `*.judged` file next to the lease. It is inert, and nothing removes it yet.
- **Fencing.** Every acquisition has a token. The runner re-reads the lease and checks the token before every store write and before every side-effecting tool call. A renewal that fails or errors aborts the run through its `AbortSignal`, and a runner that has lost the lease writes nothing more and does not finish the run. The run itself stays resumable: whoever holds the lease next continues it.
- **Release, even after a loss.** A renewal that merely errored (a transient disk error) reports the lease lost while the file on disk is still this runner's. Releasing removes it anyway, compare-and-swap on the token, so the next tick — here or in another process — can continue the run. If that removal fails too, the file names a live process and nobody else on the host may take it; the process therefore keeps the tokens it holds, treats a lease of its own pid and start time with none of them as an orphan, and removes such orphans at every tick (not on the hosted edition, where they simply expire).

## What a run is guaranteed

| Guarantee | Mechanism |
| --- | --- |
| One runner at a time | The lease, with fencing |
| Nothing lost on a crash | The run record is appended after every model call and every tool call; messages as they exist |
| Resume, not restart | A run whose holder died continues under the same run id with its saved history and a note about what already happened — if the start gate is still open (see "Who runs tasks"). Given up after 3 interruptions |
| A retry is a resume | A transient failure does not end the run. It is parked (`task.resumeAt`) and resumed — same run id, same history, same ledger — up to 2 times with backoff, and the model is told the previous attempt failed and why. The resume passes the start gate too |
| No repeated side effect | See "The ledger" |
| Finishing is recoverable | See "Finishing a run" |
| Bounded | Token (cache reads and writes included), spend, wall-clock and tool-call ceilings per run, and a ceiling on approvals asked and time spent waiting for them. See "The spend ceiling" and "Waiting for an approval" |
| Stoppable | `AbortSignal` in-process; a flag on the task across processes |
| Fair | Interrupted runs first, then the task that has waited longest; concurrency 2 at home, 1 per tenant hosted |

### The spend ceiling

A task's `budget.usdMicros` is enforced by the agent loop's per-run cost cap (`costCapMicroUSD`, `src/model/cost.ts`): before every model call the call's worst case — its prompt, estimated, plus the output ceiling handed to the provider, which is clamped to what is left — must fit under what remains, so the run stops *before* the call that would cross the ceiling. A call that fails after it was sent is counted at that worst case too, and a resumed or retried segment starts with what earlier segments counted already off the top (`run.capSpentMicros`). The run then ends `failed` with stop reason `budget_usd` and an error that says so ("spend ceiling reached — …"), and the user is told as for any failed run; it is not retried. After each call the reported cost is also checked against the ceiling, as a backstop. It is an estimate-based circuit breaker; the residual bound is in `docs/PROVIDERS.md`. #407 defines no global cap; a run without `usdMicros` has no spend ceiling (its token, wall-clock and tool-call ceilings still apply).

### The ledger

Every execution of a side-effecting call is one entry in `run.effects`, written **before** the tool runs (`started`) and closed **after** (`done` with its result, or `error`).

- If the `started` entry cannot be written, the call does not run and the attempt fails like any transient error: a scheduled or watcher run is parked and retried; a manual run is not retried — it finishes `failed` and the user is told (`task_failed`).
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

**Unattended runs get more than read-only calls only with Warden on.** Warden mode is `lisa serve --web --approval warden` (or `LISA_APPROVAL=warden` for a backend an app launches). Without it, every run — scheduled, watcher-triggered or started by hand — may make only the verified read-only calls below; nothing else runs, nothing waits for approval.

The runner asks an injected `TaskApprovalFactory` for a gate per run (the runner's `approvalFactory` option, or process-wide `wiring.ts: setTaskApprovalFactory`). In Warden mode the web server passes Warden's (`src/warden/task-approval.ts`) to its runners. Each run then gets its own Warden session:

- **Origin** `task`, `routine` or `watcher`, with the task id. The default matrix's task column applies: a write, sandboxed exec, network write, send, publish or delete is *preapproved* — allowed when the task's envelope covers it and the user confirmed that envelope, asked about otherwise. Purchases and credentials are handed back to the user.
- **Envelope.** Only a confirmed envelope (see "Confirming what a task may do") reaches Warden, with categories Warden does not know (informational labels such as `web`) dropped. An unconfirmed one has done its whole job once it narrowed the toolset. In a tainted run even a confirmed envelope does not cover exec, delete, send, publish, network writes or writes outside the run's workspace: they ask.
- **Taint.** A run a watcher hit started is tainted from its first call: its prompt quotes an outsider's text. A run that became tainted (Warden saw a taint-source call allowed, or the runner saw a call to a builtin taint source go through — with Warden off too) records it on the run (`tainted`), so a resumed or retried segment starts tainted too — the content is still in its history.
- **Taint travels with what a run leaves behind** (#422 review N3). A tainted run's summary is recorded as such (`task.lastSummaryTainted`): the next run's "Last run" section quotes it inside the external-content markers (`<<<EXTERNAL-CONTENT source="task-run">>>`), as data, and that run starts tainted (`run.inheritedTaint`, in its first record). A tainted run that made state-changing calls marks the folder (`task.workspaceTainted`, never cleared): every later run starts tainted. Its result card is fenced and taints the conversation it lands in (see "Delivery"), and `task_list` does not repeat its text.
- **Nested runs.** The `task` subagent is never offered to a task run, whatever the envelope names. A tool that starts a nested agent run anyway gets the run's gate on its tool context (`approval`: the same Warden session and taint, recorded on the run; no ledger shortcut), and the `task` tool runs its subagent in the calling turn's folder, execution world (`caps`), sandbox mode, signal and USD cap.
- **Tenant.** The uid and home of the scope the runner works in (the authenticated tenant; null on the Mac edition) — never the task file's `owner`. A task whose file names a different account is not run at all (no gate, no model call): the run fails with stop reason `owner_mismatch` and the task is switched off saying why. The run's notices carry the same scope uid.
- **Workspace.** Each task works in its own folder, `<lisaHome>/task-workspaces/<taskId>/` (`src/tasks/workspace.ts`) — never the server's working directory, which under Lisa.app or launchd is `/`. It is the tools' working directory and the workspace root Warden judges paths against. Under a bounded sandbox mode the run's profile makes the whole Lisa home read-only except that folder, for the shell (Seatbelt / bubblewrap) and the file tools alike; Warden's own directory and the server's port stay denied as for every bounded profile. The folder persists between runs and is removed with the task; it is never created for a home that no longer exists.

### Waiting for an approval

When Warden answers `ask` during an unattended run, the call waits in the approval inbox; the run does not fail.

- **Visible.** While the item is pending, the task and the run are `awaiting_approval` (the API, `lisa tasks`, and a `task_updated` event over SSE); the run log records `approval` events ("waiting for approval", then "approved" / "not approved").
- **Not on the clock.** The wait does not count against the run's wall-clock budget or its elapsed time. The lease keeps renewing on its own timer. A cancel — from this process or another (`cancelRequestedAt`, checked every 5 s while waiting) — aborts the run, and an aborted run's pending approval is a deny.
- **The user is told** through `reachOut()`, source `approval` (`taskApprovalNotice`). The in-app note says which task, which tool, and how long the approval stays open — never the payload, which only the approval card shows. The push says only "Lisa needs your approval for a task": it goes through a third-party service (ntfy), and the task title is model-written text (`ReachOutNotice.push`). The gate's decision is final: it delivers approvals in-app and by push even in quiet hours (silently); a notice it withholds (no channel, a duplicate) leaves the item pending in the inbox, where the user can still answer it.
- **The answer.** Approve, and the call runs (and enters the ledger like any side effect). Deny or expiry — about 10 minutes, then deny (`docs/THREAT_MODEL.md`) — and the model is told the call did not run, and the run continues.
- **A restart.** The inbox keeps the payload in memory only, so an item pending when the process stopped can never be approved: the next process expires it from `pending.json` and audits it as orphaned. A clean shutdown that cancels a pending approval does not record that refusal in the run's history. The run, left `awaiting_approval`, is resumed like an interrupted one: the model issues the call again and Warden asks again. A call that was approved and had started when the process died is in the ledger, so the resumed run is answered from it ("outcome unknown; not executed again") and nothing is asked twice.
- **Waiting has a ceiling.** A run may ask at most `budget.maxApprovals` times (default 5, at most 20) and wait at most `budget.approvalWaitMs` in all (default 60 minutes; at most 6 hours, 15 minutes hosted), counted across its segments (`run.approvals`, `run.approvalWaitMs`). Past either the run stops `failed` with stop reason `approval_limit` and the user gets one ordinary failure notice; the ask that would go over is not announced. Both are set per task within those maxima. The time waited is saved when the wait ends on every path but a lost lease — a shutdown that cuts it off included (#422 review N5). A crash records nothing at that moment, so there the bound is the ceiling per segment over at most four segments (a run is given up after 3 interruptions).
- An awaiting run holds its concurrency slot (2 at home) for as long as it waits — at most its waiting ceiling. On the hosted edition (tasks off unless `LISA_CLOUD_TASKS=1`) a sweep waits for the runs it started, so a run that waits for an approval holds its sweep request open until the approval is answered or expires.
- **"For this task" means for this run.** An approval given with scope `task` covers the rest of the run. When the run ends — whatever the outcome, and also when a later process completes the ending after a crash — the gate's `runEnded` hook revokes it, before the task update that ends the finish (so a failed revocation leaves the finish to be completed, and the revocation retried, at the next tick). The next run asks again. Deleting the task revokes them as well — through the runner's `taskRemoved` (the factory's hook of the same name), also when the task is deleted mid-run and its run stops with `TaskGoneError` instead of ending, and directly from `lisa tasks rm`.

The CLI drivers (`lisa heartbeat run`, `lisa tasks run`) have no approval inbox anyone could answer, so they install nothing: a run they pick up gets the read-only allow-list even when the server runs in Warden mode. A task that needs approvals runs with the server up.

With no factory wired — or one that returns no `approval` — the default applies, and it is an **allow-list**: a run may make only the calls in `UNATTENDED_READ_ONLY` (`policy.ts`), each verified to change nothing, some only for specific inputs (`github` for its read actions with a numeric id). Everything else is denied: every other builtin, every plugin, skill and MCP tool, and any tool added later. That includes writes to Lisa's own soul, memory and knowledge base — without an approval layer there is no decision record for them.

`policy.test.ts` enumerates the registry and fails when a tool is on neither the allow-list nor the explicit deny-list, so a new tool forces a decision.

The same predicate decides what the ledger records: anything that is not a verified read-only call.

The model is offered the surface's tools narrowed by the task's envelope, never the task tools themselves. A run started by a watcher hit carries text an outsider controls, so it is additionally limited to what a remote channel gets (no `skill_manage`, no knowledge-base writes or ingestion, none of the operational tools).

## Delivery

The outbox is at-least-once with a stable id; the default deliver is idempotent on that id, which makes delivery exactly-once as the user sees it.

The default deliver goes through the reach-out gate (`reachOut()`, source `task` or `watcher`). When the gate allows in-app delivery the result is stored as a card in the conversation and announced over SSE (`task_result`, plus the gate's own note event); the push follows the gate's decision, including quiet hours. A gate refusal is final and recorded on the outbox entry; the result stays in the run history.

A card that carries outside text — a watcher hit, or a notice from a tainted run (`notice.tainted`) — stores that text inside the external-content markers, and the conversation is marked tainted (Warden's `tainted.json`) before the card is appended. If the mark cannot be written the card is not stored (the outbox retries). The next chat turn in that conversation starts tainted, also after a restart.

A process with no conversation (the heartbeat CLI) leaves notices pending for the next process that has one.

`notify` decides whether a successful run produces a notice at all: `always`, `on_change`, `on_hit`, `silent_on_noop`. A reply of exactly `(no update)` is a no-op.

## Watchers

Web, RSS and mail checks run without a model call.

- All fetching goes through the SSRF-guarded fetch in `tools/web_fetch.ts`.
- Turning a fetched page or feed into the text that is compared — tag scanning, HTML-to-text, feed parsing, the user's regex — runs under a hard time limit. Content built to be slow is a failed check, which backs off.
- The first observation is a baseline. Hits are edge-triggered with hysteresis (two contrary readings to re-arm), and a `changed` page that returns to content already reported stays quiet.
- A feed or mailbox watcher remembers every item of the current fetch and forgets oldest-seen first, so an item still in the feed never looks new again. A feed longer than 2,000 items is taken at both ends: its first and last 1,000 items are remembered, and new items are reported at either end (newest-first and oldest-first feeds alike); an old item that slides into one of those windows from the middle, as the feed grows or drops entries, is not reported. An item inserted into the middle of such a feed is not seen.
- A hit notifies by default with a summary line and the items that fired it. Both are text from outside (a feed's title, a page fragment, a mail subject): each is cleaned of one-time codes and sign-in links and bounded, the summary to one line, the items quoted line by line. The card stores that text inside the external-content markers (`<<<EXTERNAL-CONTENT source="watcher">>>` … `<<<END-EXTERNAL-CONTENT>>>`), so a later turn reads it as data, not as Lisa's own words. The text cannot produce either exact marker: it is normalised first (invisible characters — zero-width, joiners, bidi controls — removed; fullwidth and small-form angle brackets folded to plain ones), and then every run of two or more angle brackets is defused to `‹ ›`. What remains is text that resembles the defused form (`‹‹‹END-EXTERNAL-CONTENT›››`), and rarer look-alikes that are not folded (modifier-letter, Canadian-syllabics or mathematical angle brackets, brackets split by combining marks). They leave the card's own markers intact, but a model could still be misled by them. `onHit: "run"` runs the instruction with the observation wrapped in a per-run tag it cannot close.
- Mail hits carry sender and subject only, after the mail inbound hygiene filter.
- Shutdown or cancellation during a check is not a watcher failure.

## heartbeat.json

Nothing is migrated automatically. `lisa heartbeat run` runs the chores in `heartbeat.json` exactly as before, and additionally runs due tasks.

`lisa tasks migrate-heartbeat [--dry-run]` moves chores into routines on request. It says what will move, and that migrated chores can only make read-only calls unless the server runs in Warden mode (where anything else asks).

- `builtin:*` entries are never moved: they are switches on Lisa's own heartbeat work.
- A chore switched off in `heartbeat.json` is left there, untouched.
- A chore is identified by its content — name, prompt and schedule — never by its name or its position in the file. The routine id is derived from that content, and both the heartbeat's skip rule and the command's "already moved" check use it. Two chores with the same name but a different prompt or schedule become two routines; two exact copies are one chore and become one routine.
- A chore without a schedule of its own gets the installed heartbeat's real interval (read from the launchd plist; 30 minutes is assumed, and reported as an assumption, when none is installed).
- `budgetTokens` becomes each routine's per-run token ceiling.
- The heartbeat skips a chore while its routine exists and is switched on, or was switched off by the engine itself (`pausedReason` set; the user has been told why). A routine the user switched off owns nothing: if its chore is (put back) in `heartbeat.json`, the heartbeat runs it the old way. Switching a task off or on explicitly clears the engine's `pausedReason` — the user's own act replaces it — so an engine-paused routine the user then switches off gives its chore back too.
- Order of writes: create the routine switched off; switch it on; rewrite `heartbeat.json` without exactly the chores a routine now owns (after a backup). The second write is the single switch-over point: before it the chore runs the old way, after it the new way. A chore whose routine could not be created or switched on stays in `heartbeat.json`, untouched, and keeps running the old way. At every point each chore runs exactly one way — the one exception being a routine the engine paused, which runs neither way until the user acts on the notice. Running the command again finishes whatever is left.
- The command holds the heartbeat's run lock for its whole duration, so a heartbeat tick never sees a chore half-way. It waits up to 30 s for a tick in progress, then gives up without changing anything.

## Hosted edition

Off unless `LISA_CLOUD_TASKS=1`: without it `/api/tasks*` answers 403 `capability_denied`, no runner exists and the task tools are not offered.

With it, each tenant gets a runner inside its home scope, driven by the existing sweep endpoint (its `maxRuns` is enforced per run). Every model call goes through `billing/admission.ts` (limits, turn lease, quota precheck, settlement). Watchers are not available hosted.

Every hosted run registers as account work, so account deletion stops it and waits for its last write before removing the home.

## Creating tasks

The task tools (`task_create`, `watch_create`, `task_update`) can draft and edit tasks but have no way to enable one: anything they create or edit ends up off. Enabling is the user's act, through `PATCH /api/tasks/{id}` or `lisa tasks enable`.

### Confirming what a task may do

A task's envelope is a restriction until the user confirms it (`src/tasks/confirmation.ts`). The model may draft one (`task_create`'s `tools`); it narrows the tools a run is offered and pre-approves nothing.

- `lisa tasks enable <id>` prints what would be confirmed — the title, the whole instruction, when it runs, where, how it tells the user, its budget and, in plain words, which actions would run without asking — with control and invisible characters shown escaped. On a terminal it pages that to the terminal's height and asks only after the last line; `y` confirms, anything else switches the task on unconfirmed, and `q` while paging changes nothing. Without a terminal it prints all of it and confirms only with `--confirm <digest>`, the digest `lisa tasks show <id>` prints. A digest that does not match the task changes nothing.
- `PATCH /api/tasks/{id}` with `{enabled: true, confirmEnvelope: <digest>}` confirms, from a caller who may answer approvals (the loopback owner on the Mac edition or a signed-in session) in a same-origin request; anyone else gets 403 and a stale digest 409, and nothing changes. `GET /api/tasks/{id}` returns `confirmation: {digest, confirmed, preapproves, summary}` for a client to show. `POST /api/tasks` never confirms: a task created `enabled: true` is on, unconfirmed.
- The confirmation (`task.envelopeConfirmation`) holds the digest (v2) of every field that reaches the run's prompt or bounds what a run may do — the title, the instruction, the kind, the schedule or trigger, the host, the envelope, the notify mode and the budget — and an HMAC of the task id and that digest under the home's Warden key (`<lisaHome>/warden/digest.key`; #422 review N1, N4). It counts only while the digest still matches and the MAC verifies, so a task file written by anything but `lisa tasks enable` or a confirming `PATCH` loads unconfirmed. Every API edit of those fields clears it and leaves the task on, unconfirmed; every `task_update` clears it outright, whatever it changed, and switches the task off; every enable clears it. A manual "run now" of an unconfirmed task gets the envelope as a restriction only.

This holds for the task tools only. In an attended chat on the Mac edition the model also has `bash` and file tools; `lisa tasks enable <id>` from a shell, or an edit to the task file, would switch a task on (unconfirmed: it cannot sign a confirmation without reading Warden's key, which asks). Closing that is the approval layer's job, not the engine's: under Warden a write, edit or delete under `<lisaHome>/tasks/` asks once whatever the rules or grants say, a command that names the task files, `lisa tasks enable` or `/api/tasks` asks for that exact command (a string match that sees through shell quoting — defence in depth, not a boundary), and a confined shell can neither write the Lisa home nor reach the server's port.

`DELETE /api/tasks/{id}` and `lisa tasks rm` cancel a run in flight and wait for it to let go of the lease before deleting. The wait is capped at 10 s; after that the task is deleted anyway. What refuses the run's later writes is the store, not the lease: the task's files are gone, so every write fails with `TaskGoneError` and the run stops at its next write. Every side-effecting call is preceded by a checkpoint write (the ledger's `started` entry), so it cannot act after that point either. Its lease file stays until the run releases it.
