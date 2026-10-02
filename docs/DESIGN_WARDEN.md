# Warden — design notes (W2a)

Warden is the deterministic layer that decides whether a tool call may run. The model proposes; Warden decides. Nothing in `src/warden/` calls a model, and nothing in it trusts model-supplied text for anything but display.

Plan: [PLAN_ALWAYS_ON_UPGRADE_2026-09-30.md](PLAN_ALWAYS_ON_UPGRADE_2026-09-30.md) §W2. Threat model: [THREAT_MODEL.md](THREAT_MODEL.md). Reach-out charter: [POLICY_REACH_OUT.md](POLICY_REACH_OUT.md).

## Pipeline

One Warden session per agent run (`createWardenSession`). For every tool call:

1. **Classify** (`classify.ts`) — an explicit table maps the tool and its input to a category (`read`, `self`, `draft`, `write`, `exec`, `network`, `send`, `publish`, `purchase`, `delete`, `credential`), its targets, and whether it is confined by the sandbox. A tool that is not in the table is a `write` that asks. MCP annotations may lower a tool to `read` and nothing safer; a mutating verb in the tool name overrides a `readOnlyHint`.
2. **Build the request** (`request.ts`, `preview.ts`) — a sha256 digest of the exact payload, a redacted preview of at most 240 characters, and detected data classes. The raw input is never stored.
3. **Evaluate** (`policy.ts`) — a pure function, in this order:
   1. system invariants;
   2. a user rule of `handoff` (it outranks any older grant);
   3. grants (exact match);
   4. the new-recipient rule;
   5. the remaining user rules;
   6. the default matrix.
4. **Audit** (`audit.ts`) — one JSONL line per decision and per resolution.
5. **Act** — `allow` runs, `deny` returns the reason to the model, `ask` waits in the inbox, `handoff` refuses and files an inbox item telling the user to do the step themselves.

## System invariants

These cannot be changed by rules, grants or a task envelope.

- `purchase` and `credential` are always handed back to the user.
- Origin `autonomy` (idle, Reve, desire and examen runs) may only `read` and write Lisa's own home (`self`). Everything else is denied, and it never raises an approval.
- The cloud surface never allows `exec` or a host file write.
- Warden's own state directory cannot be written by a file tool. A shell command that names that directory or the approval API always asks for that exact command, whatever grants exist.

## Default matrix

| Category | Chat | Chat after taint | Task / routine / watcher | Channel / MCP |
|---|---|---|---|---|
| read, self, draft | auto | auto | auto | auto |
| write inside a sandboxed workspace | auto | ask | preapproved | ask |
| write inside the workspace, no sandbox | auto for the local owner | ask | ask | ask |
| write outside the workspace | ask | ask | ask | ask |
| exec, sandboxed | auto | ask | preapproved | ask |
| exec, no sandbox | auto for the local owner | ask | ask | ask |
| network (non-read) | auto | ask | preapproved | ask |
| send, publish, delete | ask | ask | preapproved | ask |
| purchase, credential | handoff | handoff | handoff | handoff |

- **preapproved** means allowed only when the task's capability envelope covers the action; otherwise it asks.
- **New-recipient rule.** A `send`, `publish` or `network` action that carries PII, a secret or a private message asks unless a grant bound to that exact payload or to every recipient exists. A blanket grant or an `auto` rule does not cover it. An outbound read whose URL carries a credential asks too.
- **Taint.** A run is tainted once a taint-source tool is allowed (`web_fetch`, `web_search`, `kb_ingest`, `takoapi`, `task`, an open-world MCP tool, a shell command that reaches the network). On the web surface the taint stays with the conversation for the life of the server process, because the fetched text stays in the history.
- **User rules** (`rules.json`) set one of four behaviours per category, tool or target: `auto`, `preapproved`, `ask`, `handoff`. They can tighten anything. They cannot loosen a system invariant, and an `auto` rule does not survive taint, a remote origin, or a corrupt rules file.

## Grants

`once` (bound to the payload digest, consumed on use), `task`, `target`, `24h`, `always`. Matching is exact on tool, category, method, and the trust column the approval was given in — an `always` approved in the owner's chat does not apply to a remote channel or a task.

## Failing closed

| Failure | Result |
|---|---|
| `rules.json` corrupt or unreadable | No user rules; every side effect is floored at `ask` |
| `grants.json` corrupt or unreadable | No grants |
| `pending.json` corrupt or hand-edited | Nothing is restored; it can never approve anything |
| Approval unanswered (default 10 minutes), turn cancelled, server shutdown, restart | Deny |
| Audit line cannot be written | The side effect does not run |
| Any exception while deciding | Deny |
| Unknown tool | A `write` that asks |

## Storage

Per tenant, under `<lisaHome>/warden/`, files mode 0600:

- `rules.json`, `grants.json` — atomic writes under a file lock.
- `pending.json` — a mirror of the in-memory inbox, so a restart can expire orphaned approvals and show hand-offs again. It is never a source of approval: approving needs a live waiter in the server process.
- `audit.jsonl` — rotated on 5 MiB or a UTC day boundary, pruned after about 30 days. It holds the redacted preview, digest, category, masked recipients, verdict and latency. It never holds raw inputs, tokens, OTPs or message bodies.

## Integration points

- `createWardenSession(options)` returns `{ approval, observe, decide, tainted }`. Pass `approval` to `runAgent`, feed `observe` from `onEvent`, and put `approval` on the tool context so nested runs (the `task` subagent) stay gated.
- `WardenInbox` takes an emitter `(event, uid) => void`. The host must deliver each event only to subscribers of that `uid`.
- HTTP: `/api/approvals`, `/api/approvals/{id}/approve`, `/api/approvals/{id}/deny`, `/api/warden/rules`, `/api/warden/grants`, `/api/warden/grants/{id}`, `/api/warden/audit`. State-changing routes require the loopback owner or a signed-in per-user session, a JSON content type, and a same-origin request.
- Approval mode `warden` is the default for `lisa serve --web`. `--approval auto` restores the previous behaviour.

## Known limits

- Under `danger-full-access`, an untainted local-owner chat runs shell commands without asking, and a shell can edit any file. The string guard on Warden's state is best effort; the sandbox is the real boundary.
- The inbox is in-process. A multi-instance deployment needs a shared store before approvals can be answered from another instance.
- A paired device token cannot approve yet; approving needs loopback or an account session.
- Only web chat turns are wired. IM channels, heartbeat and idle runs, managed agents and the CLI REPL do not go through Warden yet.
