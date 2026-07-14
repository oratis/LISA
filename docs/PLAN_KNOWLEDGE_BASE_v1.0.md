# PLAN — Personal Knowledge Base (PKB) for LISA · v1.0

**Status:** design of record · **Date:** 2026-07-15 · **Author:** Claude (for Oratis)

A built-in, user-owned personal knowledge base for LISA, modeled on Andrej
Karpathy's 3-layer "LLM Wiki", woven into Lisa's existing memory, journal, and
reflection mechanisms so the user can capture chat into it and retrieve it live
mid-conversation.

---

## 1. Background

### 1.1 Karpathy's LLM Wiki (the 3 layers)

Karpathy's `llm-wiki` pattern (gist, April 2026) is three layers:

1. **Sources** — a curated collection of raw documents (articles, notes, pasted
   text). **Immutable**: the LLM reads them but never edits them. The source of truth.
2. **Wiki** — a directory of **LLM-generated & maintained** markdown pages:
   summaries, entity pages, concept pages, an overview, syntheses. The LLM *owns*
   this layer — it creates pages, updates them as sources arrive, keeps
   cross-references consistent. You read it; the LLM writes it.
3. **Schema** — a rules document (his is a `CLAUDE.md`) that tells the LLM how the
   wiki is structured, the conventions, and the workflows to follow when ingesting
   a source, answering a question, or maintaining the wiki.

His own instance grew to ~100 articles / ~400k words that he never wrote by hand —
he fed sources and let the system build itself. Sources:
- <https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f>
- <https://www.mindstudio.ai/blog/andrej-karpathy-llm-wiki-knowledge-base-claude-code>

### 1.2 LISA's existing mechanisms (integration surface)

| Mechanism | Where | Behavior |
|---|---|---|
| **Memory** (`memory` tool) | `src/memory/store.ts` → `~/.lisa/memory/{MEMORY,USER}.md` | Small (4KB/2KB cap), **always-on** — injected verbatim into the system prompt each turn (`prompt.ts:149`). Not retrieved; always present. |
| **Transcript search** (`memory_search`) | `src/memory/{search_tool,vector,embedding}.ts` | TF-IDF (optional Ollama embeddings) over all `~/.lisa/sessions/*.jsonl`, fingerprint-cached. On-demand. |
| **Journal** (`soul_journal`) | `src/soul/store.ts` → `~/.lisa/soul/journal/<date>.md` | One file/day, append-under-lock + git-commit. **Private to Lisa** (never in prompt, never shown in web). |
| **Soul** (`soul_*`) | `src/soul/*` | Versioned, attributed self-state (identity/purpose/desires/opinions/values). Its own git repo; `withFileLock` + `commitSoulChange`. |
| **Prompt assembly** | `src/prompt.ts:57` + fingerprint `:184` | Builds the always-on system prompt; a **hot-reload fingerprint** (`:187-206`) triggers mid-session rebuild when soul/skills/memory change. |
| **Retrieval model** | `src/agent.ts` | **No RAG step.** Context = system prompt + full history + on-demand tool calls. |
| **Idle / reflect** | `src/idle/runner.ts`, `src/reflect.ts`, `src/heartbeat/runner.ts` | The existing "distill accumulated raw experience into durable structured state" engine (`consolidateDesireProgress` at `reflect.ts:403` is the precedent). Runs under `autonomousSubset(tools)`. |
| **Sessions / web** | `src/sessions/store.ts`, `src/web/server.ts` | JSONL transcripts; `GET /api/history`; a view/modal web console (`lisa-client.ts`). |

**Key reuse:** the KB's storage can copy the soul append-under-lock + git pattern;
its search can reuse `memory/vector.ts` + `memory/embedding.ts` verbatim (both are
generic over "a list of docs"); its always-on hook is `prompt.ts` (+ fingerprint).

---

## 2. Requirements (from the user)

1. Build a personal knowledge base into LISA, modeled on Karpathy's 3-layer MD system.
2. During a conversation, the user can **select chat messages → generate a markdown
   entry → add it to the KB**.
3. **Integrate** Lisa's memory + journal mechanisms with the KB.
4. The user can **retrieve their KB in real time during a conversation**.

---

## 3. Design — the 3 layers, mapped to LISA

Everything lives under **`~/.lisa/kb/`** (a new top-level LISA dir, its own git repo
for provenance — separate from `soul/` to avoid bloating soul's history and to keep
the privacy boundary: soul is Lisa's private self, the KB is the user's shared knowledge).

```
~/.lisa/kb/
├── SCHEMA.md            # Layer 3 — the rules/conventions doc (seeded, user+Lisa editable)
├── index.md            # generated table-of-contents of the wiki (small, always-on)
├── sources/            # Layer 1 — immutable raw captures
│   └── 2026-07-15-oauth-pkce-chat.md
├── wiki/               # Layer 2 — Lisa-maintained pages
│   ├── oauth.md
│   └── pkce.md
└── .git/               # provenance (best-effort, like soul)
```

- **Layer 1 · Sources** (`kb/sources/`) — raw, faithful, append-only captures. A
  "select chat → add to KB" writes a source here verbatim. Also holds user-pasted
  docs. Frontmatter: `title, created, origin (session id | "manual"), tags`. Lisa
  reads sources; she does **not** rewrite them.
- **Layer 2 · Wiki** (`kb/wiki/`) — Lisa-owned concept/entity/synthesis pages. She
  creates and updates them from sources **and from her own memory/journal insights**
  during reflection/idle. Frontmatter: `title, updated, sources: [...], tags`. The
  user can view and hand-edit them in the web UI (user override wins).
- **Layer 3 · Schema** (`kb/SCHEMA.md`) — how the KB is organized and the workflows
  Lisa follows (ingest a source, answer from the KB, tend the wiki). Seeded with a
  sane default; both the user and Lisa may edit it. Injected always-on so Lisa
  always knows the rules.

**Ownership split (the important invariant):** the **user owns Layer 1** (adds/removes
sources) and may edit anything; **Lisa owns Layer 2** (curates the wiki). This mirrors
Karpathy exactly and cleanly divides "raw truth" from "curated knowledge."

---

## 4. Retrieval — "real-time" without blowing the context

The KB can grow far past the context window (Karpathy: 400k words), so it **cannot**
be always-on in full. We split awareness from content:

- **Always-on (small, in every system prompt):** `SCHEMA.md` + `index.md` (the wiki's
  table-of-contents: each page's title · tags · one-line gist). Capped (e.g. ≤ 3-4 KB
  like MEMORY.md). This is what makes retrieval feel "live" — Lisa always *knows what
  the KB contains and how to query it*, so she reaches for it unprompted.
- **On-demand (full content):** `kb_search` (TF-IDF / semantic, reusing
  `memory/vector.ts` + `embedding.ts`) and `kb_read(path)` pull full sources/wiki
  pages only when relevant.
- **Web:** a live search box in the KB view + `GET /api/kb/search` for the user's own
  direct retrieval.

The KB dir is added to `getPromptFingerprint` so edits (new sources, updated wiki,
schema changes) hot-reload **within** the current conversation (`agent.ts:212`).

---

## 5. Tools

| Tool | Access | Purpose |
|---|---|---|
| `kb_search(query, layer?, k?)` | read-only, remote-safe | Ranked search over sources+wiki. |
| `kb_read(path)` | read-only, remote-safe | Read one source/wiki page in full. |
| `kb_list(layer?)` | read-only, remote-safe | List entries (titles/tags). |
| `kb_add(title, content, tags?)` | **autonomous-allowed** | Capture a **source** (Layer 1). Backs the web "add to KB". |
| `kb_write(slug, content, sources?, tags?)` | **autonomous-allowed** | Create/update a **wiki** page (Layer 2). Lisa's curation tool. |

`kb_add`/`kb_write` are deliberately **allowed for autonomous runs** (omitted from
`AUTONOMOUS_BLOCKED_TOOL_NAMES`) so idle/heartbeat reflection can tend the wiki. They
write only under `~/.lisa/kb/` (path-jailed), so this is safe. All writes go through
`withFileLock` + best-effort git commit.

---

## 6. Chat → markdown (the web capture flow)

1. In the chat log, the user enters a lightweight **select mode**, ticks one or more
   messages, and clicks **"Add to KB"**.
2. Client `POST /api/kb/add` with `{ title?, messages: [...text], sessionId }`.
3. Server writes a **Layer-1 source** verbatim (faithful capture — no lossy LLM
   rewrite at capture time), via `kb_add`. Title defaults to a slug of the first
   line / timestamp; the user may type one.
4. A toast confirms; the source is immediately searchable. Wiki-building (Layer 2)
   happens later, asynchronously, when Lisa tends the wiki (idle/reflect) — or the
   user can hit "distill now."

Rationale for capture-raw-then-distill: Karpathy's Layer 1 is immutable truth;
distillation is Layer 2's job. Capturing raw keeps the flow instant and faithful and
avoids an LLM call (and possible distortion) on the hot path.

---

## 7. Memory / journal ⇄ KB integration

This is requirement #3 — making the KB part of Lisa's cognition, not a bolt-on:

- **Distillation pass (idle / heartbeat):** a "tend the wiki" step where Lisa reads
  *new sources since last pass* + relevant **memory/journal** and creates/updates
  wiki pages via `kb_write`, cross-referencing what she already knows about the user.
  This slots next to `weekly_examen` (`heartbeat/runner.ts:318`) and mirrors
  `reflect.ts`'s consolidate pattern. The wiki thus becomes a synthesis of *user
  sources + Lisa's accumulated understanding.*
- **Journal ← KB:** when Lisa updates the wiki she may journal *why* (private), so her
  reasoning about the user's knowledge is part of her own becoming.
- **Memory ← KB:** the always-on `index.md` gives Lisa a durable, queryable map of the
  user's knowledge — complementary to `MEMORY.md` (facts about the user) and distinct
  from `memory_search` (raw transcripts). We keep `kb_search` **separate** from
  `memory_search`: curated user knowledge vs. raw conversation history are different
  provenances and shouldn't be blended in ranking.

---

## 8. 正反方辩论 (pro / con debate)

### D1 — Separate KB store, or reuse memory/journal?
- **FOR reuse:** fewer subsystems; one "memory" concept.
- **FOR separate (chosen):** memory is 4 KB-capped and always-on (can't hold a wiki);
  journal is *Lisa's private* space; the user asked for a distinct, user-owned
  "personal knowledge base" à la Karpathy, which is explicitly layered and large.
- **SYNTHESIS:** separate `kb/` store, but *integrated* via always-on index +
  autonomous distillation from memory/journal. Memory/journal stay Lisa's; the KB is
  the shared, user-owned knowledge layer Lisa curates.

### D2 — Always-on full KB vs. on-demand retrieval?
- **FOR always-on:** maximal "real-time" awareness.
- **AGAINST:** a real KB exceeds the context window; token cost every turn.
- **SYNTHESIS (chosen):** always-on **schema + compact index**; full pages on-demand
  via `kb_search`/`kb_read`. Awareness is cheap and constant; content is pulled when
  needed. This is what actually delivers "live retrieval" at scale.

### D3 — Who writes the wiki (Layer 2)?
- **FOR user-authored:** full control.
- **FOR Lisa-authored (chosen, = Karpathy):** the whole point is the LLM builds it;
  leverages Lisa's reflection/idle and fulfills "combine memory+journal with the KB."
- **SYNTHESIS:** Lisa owns/maintains Layer 2; the user owns Layer 1 (sources) and can
  hand-edit any wiki page (override wins). Clear split of raw truth vs. curated knowledge.

### D4 — KB in the soul git repo, or its own?
- **FOR soul repo:** one history.
- **AGAINST:** a 400k-word KB would bloat soul's git; soul is Lisa's private self, the
  KB is user-shared — different privacy domains.
- **SYNTHESIS (chosen):** KB gets its **own** `~/.lisa/kb/.git` (best-effort, reusing
  the soul git helper pattern), separate from soul.

### D5 — Capture raw vs. LLM-distilled at "add to KB" time?
- **FOR distilled:** cleaner entries.
- **AGAINST:** latency + an LLM call on the hot path + possible distortion of the user's
  actual words.
- **SYNTHESIS (chosen):** capture **raw** into Layer 1 (instant, faithful); distill into
  Layer 2 asynchronously. Optional "distill now" button for the impatient.

### D6 — `kb_search` merged into `memory_search`, or separate?
- **SYNTHESIS (chosen):** **separate.** Curated user KB and raw transcripts are different
  provenances; merging muddies ranking and intent. The always-on index means Lisa
  reaches for `kb_search` naturally.

### D7 — Are autonomous runs allowed to write the KB?
- **AGAINST:** autonomous file writes are normally blocked (`AUTONOMOUS_BLOCKED`).
- **FOR (chosen):** `kb_add`/`kb_write` are **path-jailed to `~/.lisa/kb/`** and are the
  literal mechanism of requirement #3 (Lisa tending the wiki on idle). Safe because
  scoped; not general filesystem access.
- **SYNTHESIS:** allow `kb_*` writes for autonomous runs; keep them jailed + locked + logged.

---

## 9. Phased implementation (multiple PRs)

Each PR builds + typechecks + tests green, and is independently mergeable.

- **PR A — this doc.** Design of record.
- **PR B — storage foundation.** `src/kb/paths.ts` (layout under `KB_DIR`),
  `src/kb/store.ts` (frontmatter parse/serialize, list/read/add-source/write-wiki,
  `withFileLock`, best-effort git, index.md regeneration), seed `SCHEMA.md`. Unit tests.
- **PR C — tools + search.** `src/kb/search.ts` (reuse `memory/vector.ts` +
  `embedding.ts` over KB docs), `src/kb/tool.ts` (`kb_search/kb_read/kb_list/kb_add/
  kb_write`), register in `registry.ts` with subset membership. Tests.
- **PR D — always-on context.** Inject `SCHEMA.md` + `index.md` into
  `buildSystemPromptSnapshot`; add `KB_DIR` to `getPromptFingerprint`. Tests.
- **PR E — web UI.** Chat select-mode + "Add to KB" → `POST /api/kb/add`; a **KB** nav
  view with live search/list/read; `GET /api/kb`, `/api/kb/search`, `/api/kb/entry`.
- **PR F — autonomous distillation.** A "tend the wiki" idle/heartbeat pass that
  ingests new sources + memory/journal → wiki via `kb_write`; wire the capture→distill
  loop. Update this doc's status to "shipped."

Ship order B→C→D→E→F. B–D are the engine; E delivers the user-visible capture+retrieve;
F closes the memory/journal integration loop.

---

## 10. Privacy & safety

- KB writes are **path-jailed** to `~/.lisa/kb/` (jail-check in `store.ts`); no tool can
  escape it.
- The KB is **100% local**, under `~/.lisa` — consistent with LISA's sovereignty stance;
  never transmitted.
- `kb_search`/`kb_read`/`kb_list` are **remote-safe** (readable over IM channels);
  `kb_add`/`kb_write` are local/autonomous only unless a channel opts into full tools.
- Sources are immutable by convention (Lisa's tools only *append* sources, only
  *rewrite* wiki) — the user's captured words are never silently altered.

## 11. Open questions (revisit during build)

- Index size policy: cap `index.md` and elide oldest/least-touched pages, or summarize?
  (Start: cap ~4 KB, newest-first, note truncation.)
- Should `kb_add` optionally auto-tag via a cheap classifier, or leave tagging to the
  distillation pass? (Start: manual/optional tags; Lisa tags during distillation.)
- Embedding backend: reuse the existing optional Ollama embedder; TF-IDF default.
