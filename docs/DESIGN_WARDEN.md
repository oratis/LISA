# Warden — design notes (W2a)

Warden is the deterministic layer that decides whether a tool call may run. The model proposes; Warden decides. Nothing in `src/warden/` calls a model, and nothing in it trusts model-supplied text for anything but display.

Plan: [PLAN_ALWAYS_ON_UPGRADE_2026-09-30.md](PLAN_ALWAYS_ON_UPGRADE_2026-09-30.md) §W2. Threat model: [THREAT_MODEL.md](THREAT_MODEL.md). Reach-out charter: [POLICY_REACH_OUT.md](POLICY_REACH_OUT.md).

## Status: opt-in

Warden is off unless asked for. `lisa serve --web` with no flag behaves as before (`auto`). Turn it on with `--approval warden`, or with `LISA_APPROVAL=warden` for a backend an app launches. The default will flip in a later PR, once a native approver exists (see "Known limits").

## Pipeline

One Warden session per agent run (`createWardenSession`). For every tool call:

1. **Classify** (`classify.ts`) — an explicit table maps the tool and its input to a category (`read`, `self`, `draft`, `write`, `exec`, `network`, `send`, `publish`, `purchase`, `delete`, `credential`), its targets, and whether it is confined by the sandbox. Paths are resolved through symlinks first. A tool that is not in the table is a `write` that asks.
2. **Build the request** (`request.ts`, `preview.ts`) — an HMAC digest of the exact payload under a per-home key, a short redacted preview, and detected data classes.
3. **Evaluate** (`policy.ts`) — a pure function, in this order:
   1. system invariants;
   2. a user rule of `handoff`;
   3. grants, narrowed by what the request is (see "Grants");
   4. forced asks (see below);
   5. user rules, then the default matrix, then the context floor.
4. **Audit** (`audit.ts`) — one JSONL line per decision and per resolution.
5. **Act** — `allow` runs, `deny` returns the reason to the model, `ask` waits in the inbox, `handoff` refuses and files an inbox item telling the user to do the step themselves.

## System invariants

These cannot be changed by rules, grants or a task envelope.

- `purchase` and `credential` are always handed back to the user.
- Origin `autonomy` (idle, Reve, desire and examen runs) may only `read` and write Lisa's own home (`self`). Everything else is denied, and it never raises an approval.
- The cloud surface never allows `exec` or a host file write.
- Warden's own state directory cannot be written or deleted by a file tool. The check follows symlinks and ignores case.

## Default matrix

| Category | Chat | Chat after taint | Task / routine / watcher | Channel / MCP / remote device |
|---|---|---|---|---|
| read, self, draft | auto | auto (see forced asks) | auto | auto |
| write inside a sandboxed workspace | auto | ask | preapproved | ask |
| write with no sandbox, or outside the workspace | ask | ask | ask | ask |
| exec, sandboxed | auto | ask | preapproved | ask |
| exec, no sandbox (`danger-full-access`) | ask | ask | ask | ask |
| network (non-read) | auto | ask | preapproved | ask |
| send, publish, delete | ask | ask | preapproved | ask |
| purchase, credential | handoff | handoff | handoff | handoff |

- **Unsandboxed exec asks for every origin**, the local owner included. A full-access shell can do anything every other tool can, so leaving it `auto` would make every other ask advisory. A user who wants the old behaviour sets a rule (`tools.bash = auto`) knowingly; taint and a remote origin still override it, and it applies to the attended chat only unless it names the task origin (see "User rules").
- **preapproved** means allowed only when the task's envelope covers the action **and the user confirmed that envelope**; otherwise it asks. In a tainted run even a confirmed envelope does not cover exec, delete, send, publish, a network write or a write outside the run's workspace (see "Task envelopes").
- A web chat from a caller who could not answer an approval (a LAN device token, a shared web token) is treated as a remote origin, not as the owner.

## Forced asks

These ask whatever the matrix says.

- **New recipient.** A `send`, `publish` or `network` action that carries PII, a secret or a private message. An outbound read whose URL carries a credential asks too.
- **Tainted egress.** In a tainted run, `web_fetch`, `kb_ingest`, `github_link {open}` and MCP calls ask unless the exact URL already appeared verbatim in the conversation — in what the user wrote or in an earlier tool result — so the model cannot have appended data to it. A grant for the host, or a user rule that covers it, also allows it. `web_search` stays `auto`: its destination is the search provider, not a host a page picked.
- **Credential locations.** A read, write or delete under `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.netrc` and similar, under `<lisaHome>/warden`, or of the provider-key file asks in every run.
- **Tainted reads outside the workspace.** In a tainted run, reading a file outside the workspace asks.
- **Skills.** In a tainted run, `skill_manage` asks: a skill can change what Lisa does later.
- **Commands that name Warden.** A command that mentions Warden's state directory, its approval API or its CLI — or the task API and `lisa tasks enable`, which confirm what a task may do without asking — asks for that exact command, every time.

## Taint

A run is tainted once a taint-source call is allowed:

- `web_fetch`, `web_search`, `kb_ingest`, `takoapi`, `task`;
- `github` issue, PR and run views, `pr_status`, `review_diff {pr}`, `npm_info`;
- `dispatch_status`, `inspect_agent`, `agent_recap`, `transcribe`;
- every `mcp__*` call, unless the user listed the server under `trustedMcpServers` in their rules — a server's own annotations never lower taint;
- any tool the table does not know;
- a shell command that looks like it reaches the network;
- a user message with attachments.

On the web surface taint belongs to the conversation. Tainted conversation ids are kept in `<lisaHome>/warden/tainted.json` (ids only, bounded), so taint survives a restart. If that file is corrupt, every conversation that already has history is treated as tainted.

## Grants

`once` (bound to the payload digest, consumed on use), `task`, `target`, `24h`, `always`. Matching is exact on tool, category, method, and the trust column the approval was given in.

- A `task` grant lasts for one run of the task. It is revoked when the run ends, whatever the outcome (succeeded, failed, cancelled — also when that ending is completed by a later process after a crash), and every revocation is audited (`grant_revoked`). Deleting the task revokes them too — also mid-run, when the run never gets to end, and from `lisa tasks rm`. A task grant older than a run's start that is still there when the run starts (an ending recorded while Warden was off) is revoked before the run's first decision. A later run of the same task asks again.

- A `target` grant matches only when every target of the request is covered. If the targets could not be enumerated completely — too many recipients, a nested value, a key the classifier does not know — no `target` scope is offered and no target grant or target rule applies.
- Tool-wide `always` and `24h` grants do not apply in a tainted run to exec, a write outside the workspace, network, send, publish or delete.
- The card never offers `always` or `24h` for exec, or for anything asked in a tainted run. The one exception is tainted egress, where `24h` is offered and is bound to the host.
- A user rule stricter than a grant wins, whichever is newer. Under an explicit `ask` rule only the approval of that exact payload counts.
- A command that names Warden's state gets no scope wider than `once`.

## Task envelopes

A task's envelope (`tools`, `categories`, `targets`) is a **restriction until the user confirms it**.

- The model can draft one: `task_create`'s `tools`. A drafted or edited envelope narrows the tools the run is offered and pre-approves nothing; Warden gets no envelope for that run, so every action the matrix leaves to the envelope asks.
- The user confirms it when they switch the task on. `lisa tasks enable <id>` prints the instruction, when it runs and, in plain words, which actions would run without asking, and asks on a terminal; elsewhere it needs `--confirm <digest>` (printed by `lisa tasks show <id>`). `PATCH /api/tasks/{id}` takes `{enabled: true, confirmEnvelope: <digest>}`, and only from a caller who may answer approvals, in a same-origin request; `GET /api/tasks/{id}` returns the digest and the summary for a client to show. Enabling without confirming is allowed: the envelope then only restricts.
- The confirmation records the digest of exactly what was shown — instruction, kind, schedule or trigger, envelope, notify mode (`src/tasks/confirmation.ts`). It counts only while that digest matches the task; every edit of those fields (`task_update`, an API edit) and every enable clears it. No model tool can set it.
- **Each task run works in its own folder**, `<lisaHome>/task-workspaces/<taskId>/`, never the server's working directory. That folder is the workspace Warden judges paths against, and under a bounded sandbox mode the run's profile denies writes to the whole Lisa home except it (Seatbelt / bubblewrap and the file tools alike), so a pre-approved shell cannot rewrite task files, rules or settings.
- **Taint overrides the envelope for side effects.** In a tainted run — watcher-triggered, or after a taint source — a confirmed envelope still does not pre-approve exec, delete, send, publish, a network write or a write outside the run's workspace: they ask (`system:tainted-envelope`). Reads, and writes inside the run's own workspace, stay as the envelope says.

## User rules

`rules.json` sets one of four behaviours per category, tool or target: `auto`, `preapproved`, `ask`, `handoff`.

- Rules can tighten anything. They cannot loosen a system invariant, and an `auto` rule does not survive taint, a remote origin, or a corrupt rules file.
- **Origin scoping.** A rule that loosens — `auto`, or anything less strict than the default it replaces — applies to the attended chat only, unless `origins` names the task origin for it: `{"tools": {"bash": "auto"}, "origins": {"tools": {"bash": ["chat", "task"]}}}`. So a rule written for chat (`tools.bash = auto`, `categories.send = auto`) never lets an unattended routine run the shell or send. A rule that tightens (`ask`, `handoff`, or `preapproved` where the default is `auto`) applies to every origin, whatever its scope says. `origins` has the same three maps as the rules (`categories`, `tools`, `targets`); each entry is a non-empty list of `chat` / `task` and must name an existing rule, or the whole file is rejected like any invalid rules document. `lisa warden rules show` prints each loosening rule's scope.
- A target rule loosens only when every target of the request has one; otherwise the stricter of the tool and category rules applies.
- Rule maps are read by own property only, and a value that is not one of the four behaviours counts as `ask`.

## MCP tools

An annotation can only make a tool stricter. An MCP tool is a `read` only when it has `readOnlyHint: true`, its name (split on snake_case and camelCase) contains a lookup verb, and contains no side-effect verb. Names that mention paying or credentials are handed back to the user. Everything else is at least a `write` that asks.

## The approval card

- The inbox keeps the full tool input in memory, never in `pending.json`, the audit log or an SSE event.
- `GET /api/approvals/{id}` serves the whole payload to a caller who may approve. Fields come in an order the classifier chose (the command, path, URL, recipients and body first), never the model's key order. Long values scroll; nothing is clipped. Secret-shaped substrings are masked.
- Approving requires the digest of what was displayed. A missing or stale digest is refused.
- After a restart the payload is gone, so an orphaned approval cannot be approved; it expires as a deny.
- A payload larger than 2 MiB cannot be reviewed and is refused.

## Failing closed

| Failure | Result |
|---|---|
| `rules.json` corrupt or unreadable | No user rules; every side effect is floored at `ask` |
| `grants.json` corrupt or unreadable | No grants |
| `pending.json` corrupt or hand-edited | Nothing is restored; it can never approve anything |
| `tainted.json` corrupt | Every conversation with history is tainted |
| Digest key unreadable or malformed | Every call is denied |
| Approval unanswered (default 10 minutes), turn cancelled, server shutdown, restart | Deny |
| Audit line cannot be written | The side effect does not run |
| Any exception while deciding | Deny |
| Unknown tool | A `write` that asks |

## Storage

Per tenant, under `<lisaHome>/warden/`, files mode 0600:

- `rules.json`, `grants.json`, `tainted.json` — atomic writes under a file lock.
- `digest.key` — the per-home HMAC key for payload digests.
- `pending.json` — a mirror of the in-memory inbox, so a restart can expire orphaned approvals and show hand-offs again. It is never a source of approval.
- `audit.jsonl` — rotated on 5 MiB or a UTC day boundary, pruned after about 30 days. It holds the short preview, the digest, category, masked recipients, verdict, latency, and whether the run was tainted. For keys outside a fixed structural list it holds the key name and length, never the value.

Sandboxed commands cannot reach any of it: every bounded sandbox profile denies reads and writes under `<lisaHome>/warden` and connections to the LISA server's own port (`src/sandbox/protect.ts`).

## Integration points

- `createWardenSession(options)` returns `{ approval, observe, decide, tainted }`. Pass `approval` to `runAgent`, feed `observe` from `onEvent`, and put `approval` on the tool context so nested runs (the `task` subagent) stay gated.
- **Task Engine runs.** `createTaskApprovalFactory` (`task-approval.ts`) is the Task Engine's gate in Warden mode: one session per unattended run, origin `task` / `routine` / `watcher` with the task id, the task's envelope only if the user confirmed it (so the matrix's "preapproved" cells apply to what they confirmed, and to nothing else), the run's taint (a watcher-triggered run starts tainted), and the task's uid and home. The web server passes it to its task runners only when the approval mode is `warden`. **Unattended runs get more than read-only calls only with Warden on**: without it the engine allows only the verified read-only calls in `src/tasks/policy.ts`, and nothing waits for approval. The CLI drivers (`lisa heartbeat run`, `lisa tasks run`) have no inbox anyone could answer and stay read-only. An "ask" in a task run waits in the inbox like a chat turn's: the session's `onApprovalPending` / `onApprovalSettled` hooks let the engine show the run as `awaiting_approval` (wall clock paused), and the user is told through `reachOut()` with source `approval` — the notice names the task and the tool, never the payload. Expiry, restart and cancel behave as for chat (deny); after a restart the resumed run asks again (`docs/DESIGN_TASK_ENGINE.md`, "Waiting for an approval").
- `WardenInbox` takes an emitter `(event, uid) => void`. The host must deliver each event only to subscribers of that `uid`.
- HTTP: `/api/approvals`, `/api/approvals/{id}`, `/api/approvals/{id}/approve`, `/api/approvals/{id}/deny`, `/api/warden/rules`, `/api/warden/grants`, `/api/warden/grants/{id}`, `/api/warden/audit`. State-changing routes require the loopback owner or a signed-in per-user session, a JSON content type, and a same-origin request.
- CLI: `lisa approvals [list | show <id> | approve <id> --digest <digest> | deny <id>]`, `lisa warden rules|grants|audit`.

## Known limits

- **There is no native approver yet, and that is why Warden is opt-in.** Over HTTP on loopback there is no way to tell the user's browser from a local process. A process the user runs unsandboxed can read `/api/approvals/{id}`, approve with the digest it finds there, or rewrite the rules — and so can a shell command the user approved. Until approvals are signed by a native approver (the Mac app with a Keychain-bound key, or a paired phone with Face ID), Warden protects against a model that has not been given an unconfined shell, not against one that has. That approver is the follow-up that gates flipping the default.
- **A chat's workspace root is the server's working directory.** Under launchd and Lisa.app that is `/`. A workspace that is `/`, the user's home (or above it) or that contains a Lisa home confines nothing, so Warden treats `bash` and file writes there as unsandboxed on every surface — they ask — and every tainted read outside it asks too. Task runs no longer have this problem (each works in its own folder, below); giving chat turns a narrower workspace must still happen before the default flips.
- **String checks are best effort.** The check for commands that name Warden's state, and the check for shell commands that reach the network, are string matches. `p=approvals; curl …/api/$p` passes the first; an alias or an encoded payload passes the second. They catch the common case and are not a boundary.
- **Linux.** bubblewrap cannot filter one TCP port. With the network allowed, a sandboxed command on Linux can still connect to the LISA port.
- **Memory poisoning.** In a tainted run `memory`, `soul_patch`, `kb_write` and `kb_add` are still `auto`, and what they write loads into later, untainted conversations. The audit log marks those writes as made in a tainted run; undoing them is provenance work that is not in this PR.
- **Reads inside the workspace do not taint.** `read`, `grep` and `kb_read` can return text someone else wrote (a cloned repository, an ingested page). Tainting on them would taint every coding conversation at once, so they are left out, knowingly.
- **Known URLs are kept in memory.** After a restart a tainted conversation asks again for URLs it had already seen.
- **The CLI REPL.** `--approval warden` there falls back to the stdin prompt and leaves the `task` subagent ungated, as `ask-mutating` already did.
- **The inbox is in-process.** A multi-instance deployment needs a shared store before approvals can be answered from another instance.
- **Only web chat turns and the web server's Task Engine runs are wired.** IM channels, heartbeat chores and idle runs, managed agents and tasks run by the CLI drivers do not go through Warden yet.
- **A paired device token cannot approve.** Approving needs loopback or an account session.
