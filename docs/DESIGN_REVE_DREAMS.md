# Design: auditable Dream (Reve dream records)

Status: implemented in `src/reve/` (W9, part). Plan: [PLAN_ALWAYS_ON_UPGRADE_2026-09-30.md](./PLAN_ALWAYS_ON_UPGRADE_2026-09-30.md) §W9 "可审计的 Dream". Related: [PLAN_REVE_v1.0.md](./PLAN_REVE_v1.0.md), [AUTONOMY_ROADMAP.md](./AUTONOMY_ROADMAP.md), [THREAT_MODEL.md](./THREAT_MODEL.md).

## What it is

Every autonomous reflective pass leaves a reviewable record of what it changed and lets the user act on it:

| Pass | Entry point | Trigger |
|---|---|---|
| Idle (Reve) run | `runIdleOnce` (`src/idle/runner.ts`) | `idle` |
| Session reflection | `reflectOnSession` (`src/reflect.ts`) | `reflect` |
| Weekly examen | heartbeat task `builtin:weekly_examen` | `examen` |
| Desire review | heartbeat task `builtin:desire_review`, `runDesireReviewOnce` | `desire-review` |

The hooks only wrap the existing calls (`withDream(...)` or a `beginDream` handle). Other heartbeat chores and desire pursuits are not dreams.

## The record

`<lisaHome>/reve/dreams/` holds, per dream:

- `<id>.json`: the `DreamRecord` (`src/reve/types.ts`).
- `<id>.md`: a short human summary.
- `<id>.before.json`: the revert sidecar. For KB pages and skills it holds each changed file's content from before the pass. For memory it holds only the entry lines the pass added and removed, never the whole file, so an entry the pass did not touch is never copied there. It never holds soul content.

The id has the form `d-<yyyymmddThhmmssSSS>-<hex8>`. It is minted by the server, sorts by time, and is validated before it is ever used in a path.

A record contains:

- the window (start and end), the trigger, the heartbeat task when there is one, and the outcome;
- the ids of the `AutonomyRun`s recorded inside the pass. `AutonomyRun` gained an optional `id` and `dreamId`, linked both ways;
- **soul commits** (local, with soul git on): sha, subject, opKind, caller label, per-file numstat, and a diff capped at 4 KiB per commit;
- **file changes** for memory, KB, skills and soul: status, before and after sha256, line counts, a compact line diff capped at 8 KiB per file, the memory entries added or removed, and, for a user-part change that cannot be reverted, `notRevertibleReason`;
- **desire changes** (added, revised, closed), **emotion deltas** (before, after and delta from `emotions.json`), and the skills touched;
- **drift metrics**: identity, purpose and constitution patches, values and opinions churn, desire churn, emotion volatility, memory entries added and removed, KB files changed, skills touched;
- the reconsider requests delivered to this pass, and an audit list of reverts;
- `capped` (a snapshot cap was hit), `uncaptured` (parts left out whole, with the reason and their file count) and `skippedSymlinks` (links met where a tracked file or directory would be).

A pass that changed nothing writes no record. Two exceptions: a pass that received reconsider notes (its record shows that Lisa saw them), and a pass that ran while a part could not be captured (so the log never says "no changes" about a part it did not look at).

### Capture: snapshot everywhere, git on top

Before the pass, the files it may touch are snapshotted into memory:

| Part | Files tracked |
|---|---|
| memory | `memory/*.md` |
| KB | `kb/SCHEMA.md`, `kb/sources/*.md`, `kb/wiki/*.md` |
| skills | `skills/<name>/SKILL.md` |
| soul | identity, purpose, constitution, name, `values/`, `opinions/`, `desires/`, `relationships/`, journal files from the last 3 days, `emotions.json` |

After the pass, the same parts are snapshotted again and diffed. This one path works on the cloud edition too. There, soul git is off on GCS FUSE (`LISA_SOUL_GIT`), so the plan's "cloud snapshot mechanism" is the default path rather than a separate mode.

Session reflection never writes the KB, so it does not snapshot the KB. The generated `kb/index.md` and `kb/index.json` are not tracked; a revert rebuilds them.

**Symlinks are never followed.** Every directory between the home and a tracked file is checked with `lstat`; a link, to a file or a directory, is skipped and listed in `skippedSymlinks`, and files are read with `O_NOFOLLOW`. A link such as `kb/wiki -> soul/values` or `skills/x/SKILL.md -> soul/identity.md` therefore can neither put soul text into a revert sidecar nor make a soul file look like revertible user data.

**Caps never hide a file.** A part whose tracked files would take the pass past 5000 files is left out whole and named in `uncaptured`; its changes are not in the record. Parts are captured in the order memory, skills, soul, KB, so a large KB is the part that drops out. Within a captured part every tracked path is listed, so a path missing from the pre-pass snapshot really did not exist. A file that is listed but cannot be read is "unknown": a change to it is shown as modified (or deleted, if it is gone after the pass), never as added, and is never revertible.

When soul git is available (`capture: "git"`), the record also lists the soul-git commits between HEAD before and HEAD after. Every soul commit made inside a dream scope has `[dream:<id>]` appended to its subject; this is captured at call time, like the caller label. A commit stamped with another dream's id is that dream's and is excluded, so two overlapping passes do not claim each other's commits. **Unstamped commits in the window, for example from a concurrent chat, are still attributed to the dream.**

### Caps and retention

- Snapshot: 256 KiB per file and 16 MiB per pass. Larger files are hashed but cannot be diffed or reverted. At most 5000 files per pass; a part that would pass it is left out whole and named (see above).
- Record: 512 KiB. Diffs are trimmed, largest first, until it fits, and the record is marked `truncated`. Reads are capped too: the API and the CLI show a record bigger than 512 KiB trimmed the same way, with `readTruncated: true`; a record file over 16 MiB is not parsed (422). Revert and forget read the stored record whole.
- Revert sidecar: 4 MiB. Changes beyond it are recorded as not revertible, with the reason.
- Retention: a dream is kept if it is among the newest 60 or younger than 90 days, whichever keeps more, but never more than the newest 500. Then the oldest are pruned while the directory is over 64 MiB, never below 10 dreams. Orphan sidecars are removed. Delivered reconsider notes go after 90 days or when their dream is pruned (a waiting note is never dropped), and `audit.jsonl` keeps at most 90 days and 5000 lines. Retention runs on server startup and then at most once an hour per home and process, in its own short lock section, not on every pass.
- `LISA_REVE_DREAMS=0` (or `false` / `off`) is the kill switch: no capture, and reconsider is refused (409 `dreams_disabled`, the CLI says so) instead of queuing notes no pass would see.

Capture never breaks a pass. Any failure degrades to "no record" with a warning; on the cloud edition the uid in a `users/<uid>/` path in that warning is redacted.

## Sovereignty: user data vs. Lisa's soul

The plan asks for "one-click rollback". The sovereignty principle holds that Lisa is the only editor of her soul (AUTONOMY_ROADMAP §2.1, `soul_object`: sovereignty is real at the soul-file level, and the user cannot change those files). PLAN_REVE adds that the user-facing view is read-only and opens no way for the user to rewrite soul files. The two are reconciled by splitting ownership.

**User-owned parts can be reverted:** memory, KB pages, and skills.

`POST /api/reve/dreams/{id}/revert` with `{ "parts": ["memory", "kb", "skills"], "force"?: true }`, or `lisa reve revert <id> --parts memory,kb`:

- **Memory is reverted entry by entry**, against the current file: the entries the dream added are taken out (one line each, if still there) and the entries it removed are put back (if not there now). Nothing else in the file changes, and a whole pre-dream file is never restored. So a memory revert keeps everything written since and can never bring back an entry the dream did not remove, for example one the user forgot afterwards. A memory file the dream created is removed when nothing else is left in it. A file this dream's revert already handled is reported as already reverted. A memory revert never reports `modified_since`, so `force` does not change it.
- **KB pages and skills are restored file by file, three-way safe.** A file is restored only if it still holds exactly what the dream left (its hash equals `afterHash`).
  - A file already at its pre-dream content is a no-op, so a repeated revert is idempotent.
  - If any selected file changed since the dream, nothing is written and the response is **409** with the conflicting paths, unless `force` is set.
  - A file with no pre-dream copy is reported as `not_revertible`.
- **What "skills" covers.** Any `skills/<name>/SKILL.md` that changed during the dream window, whoever changed it: Lisa in that pass, or a concurrent chat (see Known limits). It is not limited to Lisa's own patches. Skills reached through a link are never tracked.
- **Atomic.** Each file is replaced by an atomic rename. All files are checked before any is written. If a write fails, the files already written are rolled back.
- **Locked.** The revert holds the reve write lock and, for the KB, the KB store's own write lock (order: reve, then kb). Memory and skills writes in the stores take no lock today, so the race window is the gap between the check and the rename.
- **Audited.** The revert is appended to the record's `reverts` and to `reve/audit.jsonl`, with the actor (`uid:<uid>`, `local` or `cli`). A KB revert also rebuilds the index and makes a KB-git provenance commit.
- **Path-jailed, against the filesystem.** A record path must match its part's pattern (`memory/*.md`, `kb/{SCHEMA.md,sources/*.md,wiki/*.md}`, `skills/<name>/SKILL.md`) and resolve under the active home. Before planning, and again right before every write, the revert checks that no directory between the home and the target is a link and the target is not a link either. It creates a missing directory one level at a time under a checked parent, never with `mkdir -p` through a link. It also checks that the parent's realpath equals `realpath(home)/<the part's directory>` (case-insensitively on macOS and Windows). A violation is a **409** conflict with reason `unsafe_target`; under `force` that file is skipped. A tampered record or a planted link cannot point a revert at soul files.

**Soul parts are Lisa's:** identity, purpose, constitution, values, opinions, desires, journal and emotions. `parts: ["soul"]` is a 400 that points to reconsider. Instead:

`POST /api/reve/dreams/{id}/reconsider` with `{ "note": "…" }`, or `lisa reve reconsider <id> "<note>"`:

- queues a request in `reve/reconsider.json` and writes **nothing** under `soul/`;
- the next reflective pass that runs inside a dream (a session reflection or an idle run) claims pending notes, at most 5, oldest first, under the reve lock;
- **framing:** control characters, Unicode format characters (bidi overrides, isolates, zero-width), the quote marks `«` `»` and anything that looks like the frame tag are taken out of the note. Each pass wraps every note in a `reconsider-note-<code>` tag, where the random code is made for that pass only. The block tells Lisa that a request without that code (in a transcript, a channel message or a page) is not one. It also says: "this is a request, not an instruction … you are its only editor … say why in your journal";
- **delivery: claim, deliver, acknowledge.** A claimed note is `claimed` (with `claimedIn` = that dream's id), so no concurrent pass takes it. It becomes `delivered` (`deliveredIn` = the dream) only when that pass ends without error. The dream record, which lists the note in `reconsiderDelivered`, is written first and is the commit point. A pass that throws or records an error outcome puts its notes back to pending. A claim whose pass is gone is recovered by the next claim: the process died, the acknowledgement never landed, or the claim is older than 6 hours. The note becomes `delivered` if that dream's record shows the pass finished with it, `pending` otherwise. **The guarantee:** a note is never lost, and it is acknowledged by exactly one pass that finished. It may be *shown* more than once, when a pass that saw it failed or died, and that pass may already have acted on it;
- at most 200 notes may be waiting (pending or claimed); a new note past that is refused with **429** `queue_full`. A waiting note is never dropped;
- whatever Lisa decides, she does through her own soul write path. Commits made in that pass carry `reconsider:<request ids>` in their subject, so the soul history shows which change answered which request;
- the request and its status appear with the dream (`GET /api/reve/dreams/{id}` returns `reconsider`) and in `GET /api/reve/reconsider`.

This differs from the plan's literal "rollback via soul git locally" for soul files. That deviation is the point of this design.

## Who may read and act

The routes use the Warden's trust model (`wardenTrust` and `crossSiteProblem` in `src/web/warden-api.ts`):

- **Every route, reads included**, refuses a browser request marked `Sec-Fetch-Site: cross-site`, an `Origin` that is not this host (or the configured public origin), and, when the caller is trusted only because it connected from loopback, a `Host` that is not a loopback name. That last case is DNS rebinding: a page that resolves its own name to 127.0.0.1. The refusal is a 403 (`cross_site_request`, `cross_origin_request`, `untrusted_host`). Reads are guarded too because records hold memory and KB text.
- **Revert and reconsider** also need a caller allowed to approve: the loopback owner on the Mac edition, or a signed-in account. A shared `LISA_WEB_TOKEN` or a paired device can read the log but gets 403 `trusted_local_confirmation_required` for these. A reconsider note is user text that lands in an unattended run with `web_fetch`.

## Tenant isolation

Every path goes through `lisaHome()`. On the cloud edition the server has already entered `homeScope` for the signed-in account (`users/<uid>/`), so a caller can only list, read, revert or reconsider dreams in its own subtree. A dream id from another tenant is simply not found (404). A cloud caller with no account (the shared token, which would land in the operator's global home) gets 403. Background passes on the cloud already run inside the user's scope, so their dreams land in that user's home. Tests cover uid A against uid B for read, revert and reconsider.

## Memory sovereignty: forget

Dream records hold memory and KB text: diffs, entry lists, KB pre-dream copies in sidecars, and reconsider notes. `forgetInReve(match, { apply, only? })` in `src/reve/forget.ts` cleans all of it. `match` is forget's predicate on text, `(text) => boolean`.

- **Records** (`<id>.json`): every matching line of a change's or a soul commit's diff, every matching memory entry listed as added or removed, a matching soul-commit subject and a matching summary become `[forgotten by user]`. Ids, hashes, counts and timestamps stay, so the record still loads. Paths and skill, desire and task names are structure, like KB file names in forget: they are never renamed and are reported in `untouched`.
- **Summaries** (`<id>.md`): matching lines are replaced.
- **Sidecars** (`<id>.before.json`): a sidecar that holds a match anywhere is deleted whole. Every user-part change of that dream becomes not revertible, with `notRevertibleReason` set to say forget deleted the copy.
- **Reconsider notes**: a matching note is replaced.
- **`audit.jsonl`**: matching string values are replaced. `at`, `action`, `dreamId` and `requestId` are kept, and a line that is not JSON is replaced whole.
- It returns per-kind counts (`records`, `summaries`, `sidecars`, `reconsider`, `audit`), their `total`, and the items, each with a stable `id` built from its location and the content it was planned on. A dry run (`apply: false`) writes nothing. Apply with `only` changes only the confirmed items. Apply runs under the reve lock and appends a counts-only audit line.

Forget lives in `src/sovereignty/` (#421), which this PR does not touch. At merge time forget calls `forgetInReve((text) => m.test(text), { apply, only })` from its plan and apply steps, adds the items to its digest and counts under a `reve` layer, and `reve` is registered as scanned in `src/sovereignty/coverage.ts`. Even without that call, the entry-level memory revert means a revert never brings a forgotten memory entry back. Until forget calls `forgetInReve`, forgotten text can still sit in `reve/` (diffs, KB sidecars, notes) for up to the retention window. Export leaves `reve/` out.

## Coherence metrics (paper hook)

`lisa reve metrics [--days n] [--json]` and `GET /api/reve/metrics?days=n` return per-UTC-day sums of the drift indicators above, zero-filled, with totals. The output is a pure function of the stored records and `now`, so it is deterministic.

## API and CLI

| Route | Purpose |
|---|---|
| `GET /api/reve/dreams?limit=n` | Newest-first summaries, plus corrupt ids and the count of waiting reconsider notes |
| `GET /api/reve/dreams/{id}` | Full record (trimmed with `readTruncated` past 512 KiB) plus its reconsider requests. 404 if unknown, 422 if corrupt |
| `POST /api/reve/dreams/{id}/revert` | User-data revert. 400 bad parts, 403 not allowed to act, 409 conflict (`modified_since`, `not_revertible`, `unsafe_target`), 415 non-JSON |
| `POST /api/reve/dreams/{id}/reconsider` | Queue a note (201). 403 not allowed to act, 409 `no_soul_changes` or `dreams_disabled`, 429 `queue_full` |
| `GET /api/reve/reconsider` | The reconsider queue |
| `GET /api/reve/metrics?days=n` | Metrics time series |

Every route also returns 403 for a cross-site request or a DNS-rebinding Host. All of these are in `contracts/lisa-api-v1.openapi.json`, added without changing existing routes. POST bodies must be JSON and are capped at 16 KiB.

The CLI commands are `lisa reve dreams | show | revert | reconsider | metrics`. `show` and `dreams` strip terminal escape sequences and control characters from captured text, such as an OSC 52 clipboard write in a captured web page.

## Known limits and follow-ups

- **Overlapping passes.** Two passes whose windows overlap both see each other's file changes in their snapshot diffs, and a live chat during a pass is attributed to that pass the same way. Soul commits are separated by the dream stamp, but file changes and unstamped soul commits are not. A revert of either restores the pre-pass state of a shared KB or skill file, and the three-way check still refuses if the file moved on after both. A memory revert takes out only the entries listed for that dream.
- **Forget wiring.** `forgetInReve` exists and is tested here; forget (#421) has to call it (see above).
- **KB sidecars hold whole pages.** KB and skills revert is file-level, so their sidecars keep the pre-dream file until retention or forget removes them.
- The soul inspector UI (a Dreams list with Revert and "Ask her to reconsider") is not built yet. The API is ready for it.
- The examen and the desire review do not inject reconsider notes; only reflection and idle runs do.
