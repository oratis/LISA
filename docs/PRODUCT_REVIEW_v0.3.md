# LISA — Product Capability Review & Tuning Plan (v0.3)

> Full review of ~15k LOC TypeScript + ~800 LOC Swift + all product docs.
> Method: five deep-探查 agents (one per subsystem — soul, agent engine,
> autonomy, surfaces, product positioning), cross-verified, plus direct
> inspection of product docs + test setup. Conducted on the v0.3.0 tree.

---

## 1. Overall verdict

LISA is a **real, architecturally-considered, well-past-demo** open-source AI
agent whose core differentiator ("an individual with a self") is **backed by
code, not just marketing**. Maturity by axis:

> **Capability parity = 9/10 · Differentiator skeleton (soul/autonomy) = 7/10 ·
> Engineering hardness (tests/concurrency/security) = 3/10 · Surface polish = 8/10**

One line: **product imagination A, single-user/trusted-env usability A−,
engineering resilience D**. The biggest systemic risk is not features — it's
**zero automated tests + no concurrency protection**. For an agent that markets
"self-modification", those two are existential.

---

## 2. Capability matrix (real completeness)

| Subsystem | What it does | Maturity | Reality |
|---|---|---|---|
| Agent loop | streaming loop, tool-calling, mid-session prompt hot-reload, soul_object forced-surface | ★★★★★ | production-grade, no placeholders |
| Multi-provider | 3 native protocols + 21 OpenAI-compat presets + catch-all, routed by model-name prefix | ★★★★★ | elegant routing, case-insensitive |
| Tools | 23 built-ins (file/web/search/memory/soul/ops) + skills + MCP | ★★★★ | broad coverage |
| Soul | birth ritual, identity/purpose/constitution, values/opinions/desires/emotions, git history, tamper detection, hot-reload | ★★★★ | genuinely implemented; emotion event-trail is the standout |
| Heartbeat | launchd/cron, runs actionable desires, progress carries across runs, weekly examen | ★★★★ | real but reactive |
| Idle/Dreams | idle 1h+ → single reflection → ★while-you-were-away | ★★★ | pragmatic, not narrative "dreams" |
| Memory | TF-IDF over session history | ★★ | works but rebuilds index every search |
| Skills | SHA256 + human approval, then dynamic import | ★★★ | intentionally un-sandboxed (documented) |
| Web GUI | glass-morphism chat, mood portraits, soul/skills panels, PWA, birth ritual | ★★★★★ | strongest surface |
| Island | pill + expand + Claude monitor + native drag | ★★★★ | clever product design |
| Mac apps | Lisa.app + LisaIsland.app, signed+notarized DMG | ★★★★ | freshly shipped |
| IM channels | Telegram/Discord/Slack/Feishu/iMessage/Webhook | ★★★ | breadth-first, edge cases |
| Voice | macOS `say` + OpenAI Whisper | ★★ | thinnest |
| Claude Code monitor | privacy-first metadata watch, state derivation | ★★★★ | thoughtful |
| Tests | — | 0/10 | **zero automated tests** |

---

## 3. The real moat (the differentiation is real)

1. **Soul hot-reload + git history** — `soul_patch` takes effect on turn N+1
   of the *same* conversation (fingerprint mechanism); every change commits to
   `~/.lisa/soul/.git` with caller attribution. "She can look at who she was 3
   months ago" actually runs. Rare in the LLM-agent space.
2. **Emotion event causal trail** — emotions are `{emotion, delta, trigger, ts}`
   event streams + exponential decay (per-emotion half-lives), not bare numbers.
3. **Constraint-driven autonomy** — every autonomy increment is paired with a
   stability hedge (roadmap §0). Weekly examen can *suggest* corrective desires
   but cannot rewrite identity/purpose; skills require human approval; soul_object
   objections must surface. Deliberate friction = mature design judgment.

---

## 4. Marketing vs reality (honest reconciliation)

| PITCH claims | Reality | Gap |
|---|---|---|
| "she has motivation/desires" | desires drive heartbeat ✓ | but desires are **not self-generated** — user or reflect must create them. No "I notice I want X → add a desire" loop |
| "architectural sovereignty, no reset" | mutation sovereignty real ✓ | but external edits can only be *noticed*, not *prevented*; "forget who you are" has no technical enforcement, relies on LLM compliance |
| "she's evolving" | git/examen/desire tracking real ✓ | evolution is largely **reactive**; self-improvement loop (spot gap → add desire → pursue → refine) is **absent** |
| "~11k LOC TypeScript" | actual src ~15k LOC | undercount |
| "capability superset of 5 agents" | breadth is there | depth gaps: MCP tools-only (no resources/prompts), sandbox macOS-only, approval sync-readline-only |

**Conclusion**: marketing isn't lying, but the "inner life / motivation" story is
**~70% delivered** — the skeleton is real, but it's still mostly passive
execution, not active emergence.

---

## 5. Critical issues (must-fix, by severity)

### P0 — systemic risk
1. **Zero automated tests** — no `test` script, 0 `.test.ts`. A self-modifying
   agent with no regression net on birth/store/reflect/parser.
   → introduce vitest; cover soul CRUD, emotion decay, reflect JSON parse,
   claude-code parser, provider routing. CI gate.
2. **No concurrency protection** (named by both soul + autonomy reviews) —
   heartbeat 35min run vs 30min interval → two instances writing
   `~/.lisa/soul/` concurrently; `appendDesireProgress()` uses bare
   `fs.appendFile`; git `index.lock` races → data corruption.
   → `flock` on `~/.lisa/soul.lock` before any soul write; mutex on
   heartbeat/idle runner entry.

### P1 — security & correctness
3. **SSRF redirect bypass** (web_fetch) — entry validates private IPs but
   `redirect: "follow"` lets a public domain 301 → `127.0.0.1:8000`.
   → validate redirect targets before following.
4. **iMessage osascript escaping** — only escapes `"`, not newlines →
   AppleScript-syntax injection. → base64 / arg-array.
5. **Tool input has no schema validation** — LLM-generated input goes straight
   into `tool.execute()`. → validate at dispatch.
6. **Webhook: no rate limit + 5min timeout** — token-holder can spam; caller
   waits 5min if Lisa hangs. → per-sender limit + 30s timeout.

### P2 — cost & performance
7. **Autonomous loop has no token budget** — `every:5m` + 3 actionable desires
   × 32 iters ≈ ~173M tokens/day ≈ $5/day, no budget/breaker.
   → heartbeat `budget_tokens`, skip/abort over limit.
8. **Memory rebuilds index every search** — `buildIndex()` O(N sessions) every
   `memory_search`. → cache per session lifetime.
9. **Emotion decay discontinuous** — only decays on `readSoulSummary`. → decay
   on write too.

---

## 6. Tuning recommendations (by theme)

### A. Engineering hardness (highest priority — the real weak spot)
- vitest + CI running tests (release workflow currently build-only, no test)
- file locks across soul/heartbeat
- slug validation (value/opinion/desire slugs currently allow `../` traversal)
- reflect idempotency marker (running twice double-applies operations)

### B. Make autonomy active, not reactive (the next step for the moat)
- desire self-generation loop: examen can suggest desires, but there's no
  "heartbeat analyzes its own output → refines next prompt" learning loop.
  This is the key to pushing 70% → 90% delivered.
- desire prioritization: all actionable desires run every heartbeat, no
  ranking/time-budget.
- `opinion_update(slug, delta, evidence)` so confidence updates don't require
  rewriting the whole opinion.

### C. Performance & scale (will bite in months)
- swap/augment memory with semantic retrieval (small embeddings, TF-IDF fallback)
- system prompt injects ALL values/opinions/desires in full — after a year of
  100+ entries it bloats. → top-N + reference `soul_read`.
- turn-level cache for `readSoulSummary` (currently 7 I/O + 3 dir scans per turn)

### D. Surface polish (nice-to-have)
- transcript export / chat search
- voice streaming + local Whisper fallback
- per-channel setup runbooks (esp. iMessage Full Disk Access)
- MCP resources/prompts support

---

## 7. Suggested next sprint (if only 3 things)

1. **vitest + soul/parser/provider core tests + CI gate** — removes the "no net
   under soul changes" existential anxiety.
2. **soul/heartbeat file locks + token budget** — plugs the two P0/P1 holes
   (data corruption + runaway cost).
3. **desire self-generation + learning loop** — pushes "she has motivation" from
   70% → 90%. The product story's true last mile.

First two are "stop the foundation cracking"; the third is "deepen the moat".
