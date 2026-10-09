# Memory sovereignty: edit, forget, export, import (W8)

Part of [the always-on upgrade plan](PLAN_ALWAYS_ON_UPGRADE_2026-09-30.md), W8. The person can see and change what Lisa remembers about them, erase a topic from every layer, and take their Lisa with them as a portable archive.

## Surfaces

| What | HTTP | CLI |
| --- | --- | --- |
| List entries | `GET /api/memory/entries` | — |
| Append / replace / delete | `POST /api/memory/entries`, `PUT` / `DELETE /api/memory/entries/{id}` | — |
| Forget a topic | `POST /api/memory/forget` `{ query, dryRun: true }` previews; `{ query, digest }` applies that preview | `lisa forget "<topic>" [--dry-run] [--yes] [--json]` |
| Export | `GET /api/export[?sessions=1]` | `lisa export [--out F] [--include-sessions] [--force]` |
| Import | — (CLI only, see below) | `lisa import <file> [--into <home>] [--replace]` |

The memory panel in the web client lists entries with edit, delete and add, a Forget flow that shows every item it will change (with the text around each match) before you confirm, and export links.

The three CLI commands are subcommands only as the first word and only in exactly the forms above: `export` with no positional, `import` with one positional that is an existing file, `forget` with one positional (quote a multi-word topic), each with only its own flags (or `--help`). Any other command line that starts with one of these words is parsed exactly as it was before they existed: a one-shot prompt, and an unknown flag is an error. `lisa export the report to pdf` is a prompt, and `lisa forget about the meeting --yes` is rejected as an unknown flag. `lisa export` without `--out` asks before writing to the current directory, refuses without a terminal, and always says where the archive went and that it is not encrypted.

Trust is decided on the server:

- **Cloud:** every route needs an account session and runs inside that account's home (`homeForUid(uid)`). A shared web token or device token gets 403.
- **Mac:** reads follow normal auth. Writes, forget and export need the loopback owner or an account session. A paired device is read-only on these routes.
- Every route, the entries read included, refuses cross-site and cross-origin requests, and a loopback-trusted caller must send a loopback `Host` header, because a DNS-rebinding page can read as well as write. The older `GET /api/memory` read in `server.ts` is a separate handler and does not have this guard yet.

## Entries

`src/memory/entries.ts` parses MEMORY.md / USER.md into entries without imposing a schema. An entry is a bullet (with its indented continuation lines), a heading, or a line of prose. Each id is content-addressed: `m_`/`u_` plus a hash of the store, kind, text and the entry's ordinal among identical texts. As a result:

- editing one entry never changes another entry's id;
- an id whose entry was changed concurrently stops resolving and returns 404, instead of overwriting the other change.

Each mutation:

- takes the same lock the `memory` tool now takes (`memory/.write.lock`);
- writes atomically;
- keeps the byte caps (4 KB / 2 KB);
- writes one audit line to `sovereignty/audit.jsonl`, with ids only and no text.

If a file is not clean UTF-8 (it contains NUL bytes or invalid sequences), it is still listed, flagged `corrupt`, but every edit is refused with 409. Rewriting it would silently replace bytes.

## Forget

`src/sovereignty/forget.ts`. A query needs at least 3 characters, or 2 when it contains a Chinese, Japanese or Korean character (two characters are a whole word there).

**Matching.** The topic matches as whole words, ignoring case and tolerating any whitespace between its words: "Ann" matches "Ann", "ann's" and "Ann-Marie", never "annual", "planning" or "announcement". A word edge is a letter, digit, mark or connector (`_`) of a script that puts spaces between words. Chinese, Japanese, Korean, Thai, Lao, Khmer and Myanmar text has no word boundaries, so there the query matches the exact character sequence, also inside longer words, and the preview says so (`report.match`). An existing `[forgotten by user]` placeholder is never matched, so forgetting "user" or "forgotten" cannot nest it and a second forget changes nothing.

**Preview, then apply.** A dry run lists every item it would change: its layer, location (`path`, `path#<entry id>` or `path:<line>`), action, a stable id and a snippet of about 80 characters around the first match, plus `why` where the action needs explaining (a page deleted for its `title` or a `tag`). It also returns a `digest` over the item ids. Apply takes that digest (required over HTTP: `400 preview_required` without it). It re-plans first and refuses with `preview_changed` (HTTP 409, CLI exit 1) unless it finds exactly the previewed set; then every write re-checks its own item's id against the file's current content under that file's lock, so a change that lands after the check is left alone rather than forgotten unseen. Ids are derived from the content they were planned on: a memory entry's id, a KB page's title, tags, provenance and body, a transcript or soul-file line, the matched text of a task spec or notice. An applied report carries no snippets. The audit log keeps counts only, not the query.

| Layer | Action |
| --- | --- |
| memory / user | Drop every entry that mentions the topic. |
| kb | Delete a page only when its title or a tag names the topic. In other pages, replace each matching body line with `[forgotten by user]` and each matching provenance value (url, author…). A page is never deleted for its file name (slug) alone; such pages are listed as `untouched` with `why: "file name"`. |
| memory_kb_links | Strip `[[kb:slug]]` / `[[slug]]` pointers (in memory and in other pages) to the pages deleted above. |
| sessions | Content fields only: matching message text blocks become `[forgotten by user]`, matching thinking blocks are dropped (their signatures would no longer verify), string values in tool inputs and tool results are replaced, and recorded prompts and reflection summaries are redacted line by line. The header line, entry types, ids, timestamps, roles, tool names and ids, and every other entry type are never touched, so every transcript still loads through the session reader. |
| reflections | Replace matching content strings; `kind`, `store`, `slug`, `emotion` and numeric fields are kept. |
| tasks | Content fields only. Task specs: title, instruction, last summary, queued input and the watcher's match text (`contains`, `keywords`, `from`, `subject`), rewritten under the task lock; ids, kind, state, schedule, watcher URL/selector/regex, envelope and budget are kept. Run logs: message text, run input/summary/errors/artifacts/effect results and event summaries. Pending outbox notices: title, summary and artifacts, under the entry's lock. |
| search_index | Delete the persisted embedding cache and drop the in-memory session and KB indexes. |
| relationships, journal | Lisa's soul, so literal matches only, line by line under the soul lock. Each file change is a soul-git commit `user-forget: <path> via user_forget`. |

Lisa's own self (identity, values, opinions, desires) is never edited. Any mentions there are reported as `untouched`.

**What is verified, and what is not.** `src/sovereignty/coverage.ts` classifies every top-level entry the code can create in a home as scanned, not scanned (can hold user text), holding no user text, or other (another account's home, import staging), plus a few unscanned files inside scanned areas (`soul/emotions.json`, `kb/feeds/`, `kb/.ingested.json`, `kb/SCHEMA.md`). Every report carries `scanned` (the areas forget searches) and `notScanned`: the entries present in this home that can hold user text but are not searched, for example `skills/`, `mail/`, `sense/`, `dispatches*`, `history`, `heartbeat*`, the logs, `warden/` pending approvals and `import-backups/`. An entry the registry does not know is listed as not classified. After applying, forget re-scans the scanned areas and returns the result as `remaining`, where each count should be 0; the CLI and the web panel say which areas that re-scan covered and list the not-scanned ones by name, never "nothing matches anywhere". `coverage.test.ts` scans `src/` for entries created under a home and fails on any that the registry does not classify.

**On the hosted edition some text lives outside the account home.** A few modules still resolve their own home instead of `lisaHome()` — among them the mail store, the sense event log and the dispatch ledger — so inside an account scope they write to the process home, which forget (scoped to the account) does not search. Rather than let the not-scanned list come back empty, a forget run inside an account scope always adds `mail`, `sense` and `dispatches` to `notScanned` (and so to `residuals`) with that reason. Routing those modules through `lisaHome()` is a separate tenancy fix; when it lands, these entries come out of this list and into the scanned areas.

After applying, forget writes `sovereignty/forget-notice.json`, a record with counts but no topic. For a week afterwards Lisa's prompt carries a Notice saying the person used Forget and which of her passages now read `[forgotten by user]`.

The response always lists what forget cannot reach (`residuals`):

- provider-side logs;
- backups and earlier exports;
- the soul and KB git history (kept on purpose, so the change can be audited);
- notifications and IM messages already delivered;
- a conversation still in progress;
- images inside past messages;
- KB file names (pages are not renamed);
- each not-scanned entry present in this home, as `Not scanned: <path> — <what>`.

## Export format (v1)

The archive is a gzip'd POSIX tar, written by the minimal writer in `src/sovereignty/tar.ts` (no system `tar`, no shell). Paths are relative to the home. `manifest.json` comes last:

```json
{ "format": "lisa-export", "formatVersion": 1, "lisaVersion": "0.28.1",
  "created": "…", "includesSessions": false, "roots": ["soul", "memory", …],
  "excludes": ["…"], "files": [{ "path": "soul/identity.md", "size": 12, "sha256": "…" }],
  "skipped": 0 }
```

Inclusion is an allowlist: `soul/`, `memory/MEMORY.md`, `memory/USER.md`, `kb/`, `skills/`, `tasks/`, and `sessions/` only when opted in. Allowlisted names must match exactly. Nothing else in a home is ever read. Inside those areas a denylist removes the following, in any spelling a filesystem could treat as the same name: every comparison folds the path segment first (NFKC normalisation, default-ignorable code points such as zero-width joiners and the BOM removed, full case folding, trailing dots and spaces stripped), because APFS and HFS+ are case- and normalisation-insensitive and `.GIT` there is `.git`:

- `.git/` directories;
- `*.lock` and `*.tmp` files;
- `tasks/.leases/`, `tasks/**/.locks/` and `tasks/outbox/`;
- `skills/**/approved.json` (a local trust decision; a carried approval would let a crafted archive's `tool.js` load);
- secret-shaped files (`.env`, `*.env`, `secrets*.json`, `*.key`, `*.pem`, `*.p8`, `*.p12`, `session-secret`, `devices.json`, `accounts.json`, `otp.json`).

Symlinks are never followed (the reader uses `lstat` and `O_NOFOLLOW`). Never exported, because they sit outside the allowlist:

- `config.env`;
- accounts, devices and billing;
- the whole `warden/` directory: secrets, key, grants, rules, digest key, taint, audit and pending approvals;
- mail credentials;
- push, relay, channel and MCP config;
- the sovereignty audit;
- caches and logs.

Each of these is checked by a test that plants a file there and confirms it is absent from the export.

## Import

`src/sovereignty/import.ts` fails closed.

1. **Size:** the compressed size is capped (1 GiB by default). The archive is then decompressed as a stream through a strict reader, which refuses:
   - links, devices, FIFOs and GNU extensions;
   - bad checksums;
   - any file, total size or entry count over its cap (256 MiB per file, 2 GiB in total, 200k entries). These caps are enforced while bytes arrive, so a gzip bomb stops early.
2. **Paths:** every path must be safe (not absolute, no `..`, no backslash, no control characters, no drive letter). It must also be something an honest export could contain, compared after the same folding as on export, so `skills/x/Approved.json`, `kb/.GIT/config`, `kb/.g\u200cit/…` or `tasks/OUTBOX/…` are refused like their lowercase forms. An archive that carries `warden/`, `config.env`, git metadata, a lease, the outbox or a skill approval is rejected as a whole. So is an archive in which two entries, or their parent directories, fold to the same path (`a.md` and `A.md`, NFC and NFD spellings, `note` and `note.`): on a case-insensitive disk they would be one file.
3. **Verification:** files land in a private staging directory inside the target home. The manifest must list exactly those files, with matching sizes and sha256. Then the staged tree is walked again by the names the filesystem reports, and anything that is not a plain file or directory, any reserved name and any git repository layout (a `HEAD` file next to `objects/` or `refs/`, which git treats as a repository whatever the directory is called) rejects the archive. Only then does anything go live. Import therefore never writes a `.git` directory, a git config or a skill approval of any spelling, and an imported executable skill always needs a fresh approval.
4. **Overwrites:** an existing soul (or any other non-empty area) is never overwritten without `--replace`. With `--replace`, the current areas are first moved to `<home>/import-backups/<stamp>/`, and the swap is rolled back if it fails partway.
5. **Tasks:** imported tasks arrive disabled (`paused`, `pausedReason: "imported"`) and are re-owned for the target home.

Only the export areas are touched: the target's `config.env`, accounts and `warden/` stay as they are. Restart Lisa after an import.

**Why import is CLI-only for now.** An archive can be far larger than any reasonable request-body limit. Replacing a tenant's soul over HTTP needs its own design: a staged upload, quota and resumability. Until then, cloud→Mac works with `GET /api/export` followed by `lisa import`. Mac→cloud is an operator step: `lisa import --into <global>/users/<uid>`.

## Deviations / notes

- The `memory` tool had no lock before this change; it now shares one with the API. This is the "same locks the memory tool uses" requirement, met by adding the lock.
- `lisa forget|export|import` are new subcommands, but only in their exact forms (see Surfaces). Unlike `search` / `status`, a one-shot prompt that merely starts with one of these words stays a prompt.
- Forget's preview shows snippets of the matched text to the person who asked; earlier drafts returned locations only. The applied report and the audit log still carry no content.
- Export drops `.git/`, so soul history does not travel. Moving that history (a git bundle) is a follow-up, together with W8 sync.
