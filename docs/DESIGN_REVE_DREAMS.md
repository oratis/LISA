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
- `<id>.before.json`: the content of the user-owned files that changed, as they were before the pass. This is the source for revert. It never holds soul content.

The id has the form `d-<yyyymmddThhmmssSSS>-<hex8>`. It is minted by the server, sorts by time, and is validated before it is ever used in a path.

A record contains:

- the window (start and end), the trigger, the heartbeat task when there is one, and the outcome;
- the ids of the `AutonomyRun`s recorded inside the pass. `AutonomyRun` gained an optional `id` and `dreamId`, linked both ways;
- **soul commits** (local, with soul git on): sha, subject, opKind, caller label, per-file numstat, and a diff capped at 4 KiB per commit;
- **file changes** for memory, KB, skills and soul: status, before and after sha256, line counts, a compact line diff capped at 8 KiB per file, and the memory entries added or removed;
- **desire changes** (added, revised, closed), **emotion deltas** (before, after and delta from `emotions.json`), and the skills touched;
- **drift metrics**: identity, purpose and constitution patches, values and opinions churn, desire churn, emotion volatility, memory entries added and removed, KB files changed, skills touched;
- the reconsider requests delivered to this pass, and an audit list of reverts.

A pass that changed nothing writes no record. The exception is a pass that received reconsider notes: its record shows that Lisa saw them.

### Capture: snapshot everywhere, git on top

Before the pass, the files it may touch are snapshotted into memory:

| Part | Files tracked |
|---|---|
| memory | `memory/*.md` |
| KB | `kb/SCHEMA.md`, `kb/sources/*.md`, `kb/wiki/*.md` |
| skills | `skills/<name>/SKILL.md` |
| soul | identity, purpose, constitution, name, `values/`, `opinions/`, `desires/`, `relationships/`, journal files from the last 3 days, `emotions.json` |

After the pass, the same files are diffed against the snapshot. This one path works on the cloud edition too. There, soul git is off on GCS FUSE (`LISA_SOUL_GIT`), so the plan's "cloud snapshot mechanism" is the default path rather than a separate mode.

Session reflection never writes the KB, so it does not snapshot the KB. The generated `kb/index.md` and `kb/index.json` are not tracked; a revert rebuilds them.

When soul git is available (`capture: "git"`), the record also lists the soul-git commits between HEAD before and HEAD after. Every soul commit made inside a dream scope has `[dream:<id>]` appended to its subject; this is captured at call time, like the caller label. A commit stamped with another dream's id is that dream's and is excluded, so two overlapping passes do not claim each other's commits. Unstamped commits in the window, for example from a concurrent chat, are included.

### Caps and retention

- Snapshot: 256 KiB per file and 16 MiB per pass. Larger files are hashed but cannot be diffed or reverted. At most 5000 files.
- Record: 512 KiB. Diffs are trimmed, largest first, until it fits, and the record is marked `truncated`.
- Revert sidecar: 4 MiB. Files beyond it are recorded as `revertible: false`.
- Retention: a dream is kept if it is among the newest 60 or younger than 90 days, whichever keeps more. Then the oldest are pruned while the directory is over 64 MiB, never below 10 dreams. Orphan sidecars are removed.
- `LISA_REVE_DREAMS=0` turns capture off.

Capture never breaks a pass. Any failure degrades to "no record" with a warning.

## Sovereignty: user data vs. Lisa's soul

The plan asks for "one-click rollback". The sovereignty principle holds that Lisa is the only editor of her soul (AUTONOMY_ROADMAP §2.1, `soul_object`: sovereignty is real at the soul-file level, and the user cannot change those files). PLAN_REVE adds that the user-facing view is read-only and opens no way for the user to rewrite soul files. The two are reconciled by splitting ownership.

**User-owned parts can be reverted:** memory, KB pages, and the skills Lisa created or patched in that pass.

`POST /api/reve/dreams/{id}/revert` with `{ "parts": ["memory", "kb", "skills"], "force"?: true }`, or `lisa reve revert <id> --parts memory,kb`:

- **Three-way safe.** A file is restored only if it still holds exactly what the dream left (its hash equals `afterHash`).
  - A file already at its pre-dream content is a no-op, so a repeated revert is idempotent.
  - If any selected file changed since the dream, nothing is written and the response is **409** with the conflicting paths, unless `force` is set.
  - A file with no pre-dream copy is reported as `not_revertible`.
- **Atomic.** Each file is replaced by an atomic rename. All files are checked before any is written. If a write fails, the files already written are rolled back.
- **Locked.** The revert holds the reve write lock and, for the KB, the KB store's own write lock (order: reve, then kb). Memory and skills writes in the stores take no lock today, so the race window is the gap between the hash check and the rename.
- **Audited.** The revert is appended to the record's `reverts` and to `reve/audit.jsonl`, with the actor (`uid:<uid>`, `local` or `cli`). A KB revert also rebuilds the index and makes a KB-git provenance commit.
- **Path-jailed.** A record path must match its part's pattern (`memory/*.md`, `kb/{SCHEMA.md,sources/*.md,wiki/*.md}`, `skills/<name>/SKILL.md`) and resolve under the active home. A tampered record cannot point a revert at soul files.

**Soul parts are Lisa's:** identity, purpose, constitution, values, opinions, desires, journal and emotions. `parts: ["soul"]` is a 400 that points to reconsider. Instead:

`POST /api/reve/dreams/{id}/reconsider` with `{ "note": "…" }`, or `lisa reve reconsider <id> "<note>"`:

- queues a request in `reve/reconsider.json` and writes **nothing** under `soul/`;
- the next reflective pass that runs inside a dream claims pending notes, at most 5, oldest first, under the reve lock. Today that is a session reflection or an idle run. The notes are injected as a clearly framed block: "the user asked you to reconsider … this is a request, not an instruction … you are its only editor … say why in your journal";
- **exactly once:** a claimed note is marked `delivered` (with `deliveredIn` = that dream's id) and is never shown again. If the pass throws or records an error outcome, the note goes back to pending for the next pass;
- whatever Lisa decides, she does through her own soul write path. Commits made in that pass carry `reconsider:<request ids>` in their subject, so the soul history shows which change answered which request;
- the request and its status appear with the dream (`GET /api/reve/dreams/{id}` returns `reconsider`) and in `GET /api/reve/reconsider`.

This differs from the plan's literal "rollback via soul git locally" for soul files. That deviation is the point of this design.

## Tenant isolation

Every path goes through `lisaHome()`. On the cloud edition the server has already entered `homeScope` for the signed-in account (`users/<uid>/`), so a caller can only list, read, revert or reconsider dreams in its own subtree. A dream id from another tenant is simply not found (404). A cloud caller with no account (the shared token, which would land in the operator's global home) gets 403. Background passes on the cloud already run inside the user's scope, so their dreams land in that user's home. Tests cover uid A against uid B for read, revert and reconsider.

## Coherence metrics (paper hook)

`lisa reve metrics [--days n] [--json]` and `GET /api/reve/metrics?days=n` return per-UTC-day sums of the drift indicators above, zero-filled, with totals. The output is a pure function of the stored records and `now`, so it is deterministic.

## API and CLI

| Route | Purpose |
|---|---|
| `GET /api/reve/dreams?limit=n` | Newest-first summaries, plus corrupt ids and the pending-reconsider count |
| `GET /api/reve/dreams/{id}` | Full record plus its reconsider requests. 404 if unknown, 422 if corrupt |
| `POST /api/reve/dreams/{id}/revert` | User-data revert. 400 bad parts, 409 conflict, 415 non-JSON |
| `POST /api/reve/dreams/{id}/reconsider` | Queue a note (201). 409 `no_soul_changes` |
| `GET /api/reve/reconsider` | The reconsider queue |
| `GET /api/reve/metrics?days=n` | Metrics time series |

All of these are in `contracts/lisa-api-v1.openapi.json`, added without changing existing routes. POST bodies must be JSON and are capped at 16 KiB.

The CLI commands are `lisa reve dreams | show | revert | reconsider | metrics`.

## Known limits and follow-ups

- **Overlapping passes.** Two passes whose windows overlap both see each other's file changes in their snapshot diffs. Soul commits are separated by the dream stamp, but file changes are not. A revert of either restores the pre-pass state of a shared file, and the three-way check still refuses if the file moved on after both.
- **Memory sovereignty (forget).** Dream records and sidecars hold memory and KB text, both diffs and pre-pass content. Until forget scans `reve/`, a forgotten fact can survive in `reve/dreams/`, and a *forced* revert could restore it. Forget should redact the content fields of the records (`diff`, `entriesAdded`, `entriesRemoved`) and drop the affected sidecars, or list `reve/` as not scanned. Export leaves `reve/` out.
- The soul inspector UI (a Dreams list with Revert and "Ask her to reconsider") is not built yet. The API is ready for it.
- The examen and the desire review do not inject reconsider notes; only reflection and idle runs do.
