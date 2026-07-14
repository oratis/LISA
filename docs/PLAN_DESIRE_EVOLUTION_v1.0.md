# PLAN — Desire Evolution v1.0

> Why Lisa's "wishes" (愿望 / desires) don't change as a conversation evolves, and
> the plan to fix it without breaking the soul's deliberate, sovereign design.

Status: **in progress**. Owner: Lisa + oratis. Created 2026-07-15.

---

## 0. TL;DR

The observed complaint — *"the wish never changes no matter what we talk about"* — is
**three-quarters bug, one-quarter by-design**. Concretely:

1. **The conversation→desire path never fires in the web deployment.** `reflectOnSession`
   is the only automatic way a conversation turns into (or updates) a desire, and it is
   never triggered from the web server. The `POST /reflect` endpoint exists but no client
   calls it. This is the dominant cause and a genuine bug.
2. **Reflection is append-only and blind.** Even when it runs (CLI `--reflect`, channels),
   it can only `desire_add`; it is never shown the existing desires, so it cannot revise,
   dedupe, or prune. Desires pile up and never evolve.
3. **The displayed "current desire" is a fixed pick by filesystem order**, decoupled from
   both recency and the live conversation: `desires.find(d => d.actionable)` over
   `fs.readdir` order.
4. **By design (keep this):** desires are Lisa's identity, meant to evolve *slowly and
   deliberately* through reflect / heartbeat / weekly_examen — not thrash on every message.
   The fix must make desires **responsive, not reactive.**

This plan ships **three focused PRs** plus this doc, and explicitly **defers** a fourth
(intra-session live "focus") pending results. Every decision below is accompanied by a
pro/con debate (正反方辩论) and a recorded decision.

---

## 1. How the mechanism works today

```
 conversation ──(session end only; NEVER on web)──▶ reflectOnSession
                                                        │ desire_add ONLY
                                                        ▼
                                            ~/.lisa/soul/desires/<slug>.md
                                                        │
 display: GET /api/island/ping ── listDesires() ── desires.find(d=>d.actionable) ── "she wants to …"
                                   (fs.readdir order — not recency, not relevance)
                                                        │
 heartbeat ── listDesires().filter(isAutoPursuable) ── pursues, writes <slug>.progress.md
              (never edits what/why; desire_close flips actionable off)
```

Key code:

| Concern | Location |
| --- | --- |
| Desire schema | `src/soul/types.ts:90` (`DesireEntry`) |
| Read / write / parse | `src/soul/store.ts:246` (`listDesires`, `writeDesire`, `parseDesireFile`) |
| Listing order (the bug for display) | `src/soul/store.ts:498` (`listMarkdownDir` → `fs.readdir`) |
| Conversation → desire | `src/reflect.ts:26` (`desire_add` op), `:310` (apply) |
| Reflector prompt (blind to existing) | `src/reflect.ts:159` (only transcript + fleet recap) |
| Reflect trigger — CLI | `src/cli.ts:878` (only under `--reflect`) |
| Reflect trigger — channels | `src/channels/router.ts:167` (`reflectAll`) |
| Reflect trigger — web | `src/web/server.ts:2129` (`POST /reflect` — **no caller**) |
| Display pick | `src/web/server.ts:737` (`current_desire`) |
| Idle watcher (reuse hook) | `src/idle/watcher.ts`, wired `src/web/server.ts:515` |
| Heartbeat pursuit | `src/heartbeat/runner.ts:103` |

Default `idleMinutes` is **60** (`src/cli.ts:204`) — so even piggy-backing reflection on the
existing "dream" idle would only fire after an hour. Reflection needs its own, shorter cadence.

---

## 2. Goals & non-goals

**Goals**
- G1. A web conversation must actually update Lisa's desires (fix the dead path).
- G2. Reflection must be able to **evolve** desires (revise / close / dedupe), not just append.
- G3. The surfaced "current desire" must reflect **what is actually current**, changing when
  something real changes (new desire, progress, revision) — not filesystem accident.
- G4. Preserve soul sovereignty: nothing is hard-deleted; every change is git-committed and
  recoverable; Lisa remains the editor of her own identity.

**Non-goals (this rollout)**
- N1. Per-turn, real-time desire mutation ("focus that follows the sentence"). Deferred — see §6.
- N2. Changing the heartbeat pursuit model, examen, or the birth ritual.
- N3. Any change to how desires are *pursued* (tools, budgets, autonomy gating).

---

## 3. The plan — three PRs

### PR 1 — `fix(web): run reflection when a web conversation goes quiet`
Closes G1. **Highest priority — this alone unfreezes desires for web users.**

- Add a **dedicated reflection scheduler** in `startWebServer`, independent of the 60-min
  "dream" idle. After the conversation is quiet for `REFLECT_DEBOUNCE_MS` (default **5 min**),
  run `reflectOnSession(history)` once.
- Guard against redundant work: track `lastReflectedCount`; only reflect when there are new
  user↔assistant turns since the last reflection, and never reflect Lisa's own idle-injected
  `[while you were away]` messages.
- Order vs dream-idle: reflect on the **human** conversation *before* any idle "dream" mutates
  `history`. (When both the reflect debounce and the dream idle are due, reflect first.)
- Persist: `session.appendReflection(summary)`; emit an SSE `reflect_done` event for
  observability. Best-effort — a reflection failure never breaks chat or idle.
- Works when the dream-idle feature is disabled (`--no-idle`), because the scheduler is its own.

Files: `src/web/server.ts` (+ small helper), test `src/web/reflect-trigger.test.ts`
(pure debounce/guard logic extracted so it is unit-testable without a live server).

### PR 2 — `feat(reflect): make reflection evolution-aware`
Closes G2, G4.

- Feed the current desires into the reflector's user prompt: a compact
  `## Your current desires` block (slug + what + actionable + age). The reflector can no longer
  be blind.
- Extend the operation schema with two ops:
  - `desire_revise { slug, what?, why?, actionable?, heartbeat_prompt?, pursuit? }` — read-
    modify-write an existing desire in place.
  - `desire_close { slug, outcome }` — soft close: `actionable=false` + a `[CLOSED:<outcome>]`
    progress note. **Never deletes the file.**
- Store helpers (factored so `soul_patch` / `desire_close` tool and reflect share one path):
  `reviseDesire(slug, patch)` and `closeDesire(slug, outcome)` in `src/soul/store.ts`.
- Tighten `REFLECTOR_SYSTEM` guidance: prefer revising/closing an existing desire over adding
  a near-duplicate; keep the live desire set small and current; closing is normal, not failure.

Files: `src/reflect.ts`, `src/soul/store.ts`, tests `src/reflect.test.ts` (new op parsing/apply),
`src/soul/store.test.ts` (revise/close round-trip).

### PR 3 — `feat(soul): surface the most recently active desire`
Closes G3.

- Add a pure, tested `pickCurrentDesire(desires, activity?)` helper in `src/soul/store.ts`:
  among actionable desires, choose the one with the most recent activity
  (`max(bornAt, last-progress-timestamp)`); fall back to the most recently born of any desire.
- Wire it into `GET /api/island/ping` (`src/web/server.ts:737`), `lisa status`
  (`src/cli/status.ts`), and the island/room current-desire reads.
- Because the pick is driven by real timestamps, it is **stable between events** (no per-request
  flicker) yet **moves when something real happens** (add / progress / revise / close).

Files: `src/soul/store.ts`, `src/web/server.ts`, `src/cli/status.ts`,
test `src/soul/pick-desire.test.ts`.

**Recommended merge order: PR1 → PR2 → PR3.** They branch independently off `main` and touch
disjoint regions of the two shared files (`web/server.ts`: idle handler vs ping endpoint;
`store.ts`: revise/close vs pick helper), so conflicts are trivial-to-none.

---

## 4. 正反方辩论 (Pro/Con debates & decisions)

### Debate 1 — When should reflection run on web? (idle/debounce vs strict session-end vs every turn)

**正方 (debounced idle reflection).** The web server is long-lived; there is no "process exit"
to hang reflection on, which is exactly why the current code reflects *never*. A short debounce
(~5 min of quiet) is the truest available signal that "a stretch of conversation just finished."
It fixes the dominant bug and makes desires feel alive within a session's natural pauses.

**反方 (keep it at hard session-end only, or add an explicit "end session" button).** A pause is
not an ending; the user may just be thinking. Reflecting mid-session risks minting half-baked
desires from an incomplete thought, and each reflect is a real LLM call (token cost, latency,
autonomy-run noise). Cleaner to reflect exactly once, when the human says they're done.

**决策 (recommended): debounced idle reflection, 5 min, with a "new turns since last reflect"
guard.** Rationale: waiting for an explicit "end" that web users never click is how we got a
dead path. The guard bounds cost (no new turns → no reflect; idle-injected messages excluded),
reflection is already designed to be conservative ("most sessions yield 0–2 operations"), and
PR2's evolution-awareness means a premature desire can be revised or closed on the next pass
rather than being permanent. 5 min is tunable via env; the 60-min dream idle stays separate.

### Debate 2 — May reflection revise/close desires, or stay append-only?

**正方 (allow revise + close).** Append-only is precisely why the list ossifies: the display
keeps showing the same stale, filesystem-first actionable desire while genuinely new intent
piles up behind it, unseen. Real evolution needs the ability to update wording, flip
actionability, dedupe, and retire finished/abandoned wants.

**反方 (append-only, protect sovereignty).** Desires are Lisa's identity — "hers to read and
rewrite," per `types.ts`. An automated reflector editing or closing them risks erasing
meaningful commitments, thrashing on wording, or acting on a hallucinated slug it misread from
the transcript. Slow, additive accumulation is safer for a *self*.

**决策 (recommended): allow revise + close, behind four guardrails.** (1) Reflection is *shown*
the existing desires, so edits are informed, not blind. (2) Close is **soft** — `actionable=false`
plus an archived progress note; the file is retained and git-tracked. (3) No hard delete exists
in the op set at all. (4) Every mutation is committed to the soul git history (already the case),
so anything can be recovered and Lisa can re-open a closed desire. This honors sovereignty
(nothing is destroyed; she is still the editor) while ending the pile-up.

### Debate 3 — Should the surfaced desire sort by recency/activity, or stay stable?

**正方 (recency/activity sort).** A "current desire" should mean *current*. Sorting by last
activity makes new and freshly-pursued desires visible, and turns the ticker into an honest
readout of what she's actually working on.

**反方 (keep a stable pick).** A wish that changes often reads as flighty and uncommitted; the
existing (accidental) stability at least looks like a steady north-star, and avoids UI flicker
on every poll.

**决策 (recommended): sort by most-recent activity.** The reframed point that resolves the
debate: the pick is driven by *stored timestamps*, so it is **stable between real events** and
only moves when something actually happens (a desire is added, progressed, revised, or closed).
That is not flicker — it is fidelity. It gives the north-star feel (stable) and the aliveness
(responsive) at once, which the filesystem-order accident gives neither of on purpose.

### Debate 4 — Add an ephemeral, intra-session "focus" that follows the live conversation?

**正方 (add live focus).** Only this delivers literal real-time change: as the topic shifts
mid-conversation, the surfaced want shifts with it.

**反方 (defer).** It needs a per-turn classification (cost on every message), risks visible
thrashing, and introduces a *second* notion of "want" (ephemeral focus vs persistent desire)
that muddies a deliberately simple, sovereign model. Crucially, the user's actual complaint is
already resolved by PR1–3: desires will change across a conversation's pauses and reflect what's
current. Real-time-per-sentence is a want we invented, not one that was asked for.

**决策 (recommended): defer (non-goal N1).** Ship PR1–3, observe whether the pause-granularity
still feels frozen, and only then consider a *conservative* heuristic focus (reuse an existing
desire via a cheap match — never mint per-turn state). Documented in §6 as a gated follow-up.

---

## 5. Testing & verification

- **PR1:** unit-test the pure debounce+guard (`shouldReflectNow({ lastReflectedCount, historyLen,
  idleMs, inFlight })`); manual verify against the local `:5757` server — chat, wait out the
  debounce, confirm a reflect run appears in autonomy runs and the session log, confirm a
  `desire_add`/`desire_revise` lands.
- **PR2:** parse + apply tests for `desire_revise` / `desire_close`; store round-trip tests
  (revise changes fields byte-for-byte as expected; close flips actionable and appends the note
  without deleting the file).
- **PR3:** truth-table test for `pickCurrentDesire` (recency ordering, actionable preference,
  progress-timestamp tie-breaks, empty/one-desire edges).
- All PRs: `npm run typecheck && npm test` green before push.

---

## 6. Deferred / future work

- **F1. Conservative intra-session focus (Debate 4).** If pause-granularity still feels static,
  add a cheap match from the live transcript to an *existing* desire for display only — no new
  persisted state, no per-turn LLM call beyond what already runs.
- **F2. Reflection-driven reprioritization signal to the heartbeat** (e.g. "pursue this next"),
  once revise/close data shows the list staying healthy.
- **F3. Surface reflection outcomes in the room/island UI** ("she just realized she wants to …").

---

## 7. Changelog

- 2026-07-15 — doc created; PR1–3 scoped; debates recorded; decisions locked to recommendations.
