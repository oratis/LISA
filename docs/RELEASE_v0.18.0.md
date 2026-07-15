# Lisa v0.18.0

The **"her wish finally moves"** release. v0.17 gave web conversations the power
to *trigger* reflection (PR1 of the desire-evolution plan); v0.18 completes the
arc — Lisa's desires can now **evolve, close, and follow the conversation**
instead of only ever piling up. Plus a reworked **九宫格 nav** with real Mail and
Settings homes.

Typecheck green · full test suite green (**1011 tests**, snapshot refreshed) · no
breaking changes.

## ✨ Desire evolution — the arc completes (PRs 2–4)

Root cause of *"the wish never changes no matter what we talk about"* was three
independent gaps ([`docs/PLAN_DESIRE_EVOLUTION_v1.0.md`](PLAN_DESIRE_EVOLUTION_v1.0.md)).
v0.17 closed the first (web conversations now reflect, #242). v0.18 closes the
rest:

### Reflection can revise & close desires, not just append (#249)

Reflection is the path that turns a conversation into a desire — but it could
only `desire_add`, and it was never shown the desires Lisa already had, so it
appended near-duplicates blind and the set only grew. Now:

- Reflection **sees its own desires** (a compact list in the reflector prompt).
- **`desire_revise`** — read-modify-write by slug; only supplied fields change,
  an `undefined` never wipes an existing value, `bornAt`/`slug` are immutable,
  and it throws (never silently creates) on an unknown slug.
- **`desire_close`** — a **soft** close: `actionable` off + a `[CLOSED]` progress
  note + a `[DESIRE_CLOSED]` journal line. The file is **retained and
  git-tracked** — reversible, nothing destroyed. This is the guardrail that lets
  reflection prune without violating soul sovereignty.

### The surfaced desire tracks what's actually active (#250)

The "current desire" ticker read `desires.find(d => d.actionable)` over
`fs.readdir` order — an arbitrary static pick. Now `pickCurrentDesire` prefers
actionable desires and, within those, the **most recently active** (authored or
pursued), falling back to most-recently-born. Because the key is a stored
timestamp, the pick is stable between real events and only moves when something
actually happens.

### …and follows the conversation, turn by turn (#248)

The finest-grained version: when a conversation is live and *clearly* about one
of her desires, the surfaced desire is that one. A pure lexical-overlap
`pickFocusedDesire` (no per-turn LLM call, no persisted state, display-only) —
**cross-lingual** (latin tokens + CJK bigrams, so it works in Chinese too),
behind a 15-minute freshness gate, and strict: a weak (< 2 shared tokens) or tied
match returns `null` and falls back to the recency pick, so it **can never invent
focus**.

## ✨ Web — 九宫格 nav with Mail + Settings (#245)

The left-rail nav is now a tile grid with unified line-SVG icons, growing two
real destination views:

- **Mail** — reuses the `/api/mail/*` endpoints and the guided connect modal from
  v0.17, and adds per-account enable/disable/remove plus a "needs-you" badge.
- **Settings** — API-key management (`/api/config/*`, localhost-only), and the
  Proactive-autonomy and Compact-mode switches, relocated out of the sidebar
  footer.

The Knowledge (kb) tile is retained, so the grid holds all ten destinations.

## 🛡️ Review hardening

Every PR was reviewed before merge; the fixes folded in:

- **`desireActivity` no longer aborts `lisa status`** (#250) — it built file paths
  (which run `assertSafeSlug`) outside its try/catch, so a stray unsafe-named file
  (e.g. a macOS `._x.md` AppleDouble in the git-synced soul dir) rejected the whole
  scan. `/api/island/ping` swallowed it; `lisa status` didn't. Fixed + regression
  test; plus a deterministic tie-break so an exact recency tie can't fall back to
  readdir order.
- **Locked the desire revise/close read-modify-write** (#249) under `withSoulLock`,
  matching the other soul RMW paths — now that web idle-reflect can race a CLI
  reflect on the same slug.
- **Skip `desireActivity`'s fs.stat on an island-ping focus hit** — the `??`
  short-circuits the recency pick, so its per-desire stat work is only done when
  actually needed.

## 📝 Notes

- No breaking changes; the desire files stay plain Markdown, closing is soft +
  reversible, and focus is display-only (it chooses which existing desire to show,
  never creates one).
