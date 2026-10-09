# Memory sovereignty: edit, forget, export, import (W8)

Part of [the always-on upgrade plan](PLAN_ALWAYS_ON_UPGRADE_2026-09-30.md), W8. The person can see and change what Lisa remembers about them, erase a topic from every layer, and take their Lisa with them as a portable archive.

## Surfaces

| What | HTTP | CLI |
| --- | --- | --- |
| List entries | `GET /api/memory/entries` | — |
| Append / replace / delete | `POST /api/memory/entries`, `PUT` / `DELETE /api/memory/entries/{id}` | — |
| Forget a topic | `POST /api/memory/forget` `{ query, dryRun? }` | `lisa forget "<topic>" [--dry-run] [--yes]` |
| Export | `GET /api/export[?sessions=1]` | `lisa export [--out F] [--include-sessions]` |
| Import | — (CLI only, see below) | `lisa import <file> [--into <home>] [--replace]` |

The memory panel in the web client lists entries with edit, delete and add, a Forget preview-then-confirm flow, and export links.

Trust is decided on the server:

- **Cloud:** every route needs an account session and runs inside that account's home (`homeForUid(uid)`). A shared web token or device token gets 403.
- **Mac:** reads follow normal auth. Writes, forget and export need the loopback owner, checked against a loopback `Host` header to stop DNS rebinding, or an account session. A paired device is read-only on these routes.
- Requests that change state, and export, are refused when they come cross-site.

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

`src/sovereignty/forget.ts`. Matching is literal, case-insensitive and tolerant of whitespace, and a query needs at least 3 characters. A dry-run returns counts and home-relative locations, never content. The audit log keeps only the counts, not the query.

| Layer | Action |
| --- | --- |
| memory / user | Drop every entry that mentions the topic. |
| kb | Delete pages whose title, slug, tags or provenance name the topic. In other pages, replace each matching line with `[forgotten by user]`. |
| memory_kb_links | Strip `[[kb:slug]]` / `[[slug]]` pointers (in memory and in other pages) to the pages deleted above. |
| sessions | Replace matching message text with `[forgotten by user]`, keeping line count and entry types. Thinking blocks that match are dropped, because their signatures would no longer verify. Recorded prompts and reflection summaries are redacted line by line. |
| reflections | Replace matching string values. |
| search_index | Delete the persisted embedding cache and drop the in-memory session and KB indexes. |
| relationships, journal | Lisa's soul, so literal matches only. Each file change is a soul-git commit `user-forget: <path> via user_forget`. |

Lisa's own self (identity, values, opinions, desires) is never edited. Any mentions there are reported as `untouched`.

After applying, forget re-scans every layer and returns the result as `remaining`, where each count should be 0. It then writes `sovereignty/forget-notice.json`, a record with counts but no topic. For a week afterwards Lisa's prompt carries a Notice saying the person used Forget and which of her passages now read `[forgotten by user]`.

The response always lists what forget cannot reach:

- provider-side logs;
- backups and earlier exports;
- the soul and KB git history (kept on purpose, so the change can be audited);
- notifications and IM messages already delivered;
- a conversation still in progress;
- images inside past messages.

## Export format (v1)

The archive is a gzip'd POSIX tar, written by the minimal writer in `src/sovereignty/tar.ts` (no system `tar`, no shell). Paths are relative to the home. `manifest.json` comes last:

```json
{ "format": "lisa-export", "formatVersion": 1, "lisaVersion": "0.28.1",
  "created": "…", "includesSessions": false, "roots": ["soul", "memory", …],
  "excludes": ["…"], "files": [{ "path": "soul/identity.md", "size": 12, "sha256": "…" }],
  "skipped": 0 }
```

Inclusion is an allowlist: `soul/`, `memory/MEMORY.md`, `memory/USER.md`, `kb/`, `skills/`, `tasks/`, and `sessions/` only when opted in. Nothing else in a home is ever read. Inside those areas a denylist removes:

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
2. **Paths:** every path must be safe (not absolute, no `..`, no backslash, no control characters, no drive letter). It must also be something an honest export could contain. An archive that carries `warden/`, `config.env`, a git hook, a lease or an approval is rejected as a whole.
3. **Verification:** files land in a private staging directory inside the target home. The manifest must list exactly those files, with matching sizes and sha256, before anything goes live.
4. **Overwrites:** an existing soul (or any other non-empty area) is never overwritten without `--replace`. With `--replace`, the current areas are first moved to `<home>/import-backups/<stamp>/`, and the swap is rolled back if it fails partway.
5. **Tasks:** imported tasks arrive disabled (`paused`, `pausedReason: "imported"`) and are re-owned for the target home.

Only the export areas are touched: the target's `config.env`, accounts and `warden/` stay as they are. Restart Lisa after an import.

**Why import is CLI-only for now.** An archive can be far larger than any reasonable request-body limit. Replacing a tenant's soul over HTTP needs its own design: a staged upload, quota and resumability. Until then, cloud→Mac works with `GET /api/export` followed by `lisa import`. Mac→cloud is an operator step: `lisa import --into <global>/users/<uid>`.

## Deviations / notes

- The `memory` tool had no lock before this change; it now shares one with the API. This is the "same locks the memory tool uses" requirement, met by adding the lock.
- `lisa forget|export|import` are new subcommands. A one-shot prompt that starts with one of these words is now parsed as the subcommand, the same as `search` / `status` before it.
- Export drops `.git/`, so soul history does not travel. Moving that history (a git bundle) is a follow-up, together with W8 sync.
