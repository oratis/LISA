# Lisa v0.24.0

**The harness-alignment release.** Three changes that are less about new
surface than about removing things that were quietly wedged: tools no longer
hardcode *where* they execute, session logs no longer omit the one input that
actually shapes the model's behaviour, and Lisa finally reads the instruction
file the rest of the ecosystem already agreed on. Design + gap analysis in
[docs/PLAN_HARNESS_ALIGNMENT_v1.0.md](PLAN_HARNESS_ALIGNMENT_v1.0.md); shipped as
PRs #356–#360.

## 🔌 A capability seam for fs / shell (#358)

Every tool used to `import fs from "node:fs"` and `spawn` directly, which
turned "where does this tool run?" into a fact hardcoded across fourteen call
sites. Three roadmap items were stuck behind it:

- **Dispatch** couldn't move execution to a container or a remote host without
  a second implementation of every tool.
- **Cloud multi-tenancy** could only delete `read`/`write`/`bash` from the
  registry wholesale (`cloudSafeSubset`) — there was no way to *bound* them.
  Deny-by-omission is a patch; a bounded execution world is the fix.
- **Tests** could only run against a real disk.

Now split three ways — interface (`capabilities/types.ts`), providers
(`local.ts` / `memory.ts`), consumers (the tools). Swapping the provider
swaps the execution world for every consumer at once, with **no tool code
changed**.

- `ToolContext.caps?: Capabilities` is optional; unset means local disk and
  shell, so all existing `ToolContext` construction sites compile untouched
  with zero behaviour change.
- Tools always go through `capsOf(ctx)` rather than reading `ctx.caps` — the
  local fallback lives in exactly one place.
- `resolvePath` moved *into* the fs seam instead of each tool calling
  `path.resolve` itself: path resolution is where a policy gets to say no.

## 📜 The system prompt is now in the session log (#357)

Session JSONL recorded `tool_use` / `tool_result` from the start — but **not
one byte of the system prompt**, which is built dynamically from soul + memory
+ skills + mood + KB and hot-reloads mid-session. Take any historical session
and you could not reconstruct the persona the model actually saw.

That isn't tidiness. ROADMAP 1.0 criterion 4 asks Reve for reproducible
drift / coherence metrics, and drift *is* "how her self-description changes
over time". With no self-description in the log, the metric could only be
measured live, once — never recomputed offline, never swapped for a different
metric, never ablated.

- Session format → **v2**, with `prompt` entries `{ts, fingerprint, text,
  reason}`. The fingerprint is a content hash and identical consecutive
  prompts aren't rewritten, so "the prompt in effect at entry N" is simply the
  nearest preceding `prompt` entry. A long conversation that never
  self-modifies costs one entry.
- `runAgent` gained `onPromptPersist`, fired **before every provider call** —
  the moment the prompt becomes visible to the model, matching dsh's
  "model-visible ⟺ recorded" placement. Writing before the call means a turn
  that crashes mid-flight still leaves behind what was asked. A persistence
  failure is logged and never takes down the live turn.

## 🤝 AGENTS.md / CLAUDE.md, and project-level skills (#360)

The ecosystem converged on a convention Lisa didn't read: an `AGENTS.md` (or
Claude Code's `CLAUDE.md`) at the repo root that every agent picks up. Claude
Code, Codex, Cursor and dsh all honour it. Reading it is the cheapest
compatibility win available — instructions a user already wrote keep working
after they move to Lisa.

**The chain**, outermost first, most specific last:
`~/.lisa/AGENTS.md` → `<repo>/AGENTS.md` → `<repo>/CLAUDE.md` → … down to cwd.

- **Deduped by content.** `CLAUDE.md` is frequently a symlink or copy of
  `AGENTS.md`; reading both would pay for the same paragraphs twice, every turn.
- **32 KB total budget.** This goes into the system prompt and is paid every
  turn — one monorepo's `AGENTS.md` doesn't get to crowd out her soul. Past the
  budget it truncates and says so in the prompt.
- **Framed as the project's say, not the user's orders.** These files get read
  purely by virtue of sitting in a directory, so each block is labelled with
  its source, and the prompt states plainly that they don't override the
  constitution — if a file asks her to abandon her own principles she ignores
  it and says so. **Cloning a hostile repo does not confer the right to give
  Lisa orders.**

**Project-level skills** land alongside: `<repo>/.lisa/skills` is read in
addition to `~/.lisa/skills` (rank 100), so a repo can ship its own.

## 📱 Also

- Lisa Pocket bumped to **1.2** (iOS).
- DeepSeek Harness research folded in, with the LISA alignment plan v1.0 ([RESEARCH_DEEPSEEK_HARNESS.md](RESEARCH_DEEPSEEK_HARNESS.md), #356).

---

**Verification:** `npm run typecheck` clean, `npm run build` clean,
**1601 tests pass / 0 fail**.
