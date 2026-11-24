# PLAN — Model-handling tuning for LISA's Anthropic provider (v1.0)

**Status:** proposed → in progress
**Scope:** `src/providers/anthropic.ts`, `src/providers/types.ts`, `src/providers/registry.ts`, config plumbing.
**Origin:** research into OpenClaw's model handling (docs.openclaw.ai). This plan keeps only the parts that (a) apply to LISA's default model and (b) are worth the complexity — verified against the `claude-api` skill's authoritative API reference rather than OpenClaw's docs.

---

## 0. Context — what OpenClaw does vs. what LISA can use

OpenClaw exposes a set of per-model knobs (1M context auto-apply, tiered prompt caching, thinking effort, `/fast`→`service_tier`/fast-mode, task budgets). Two facts collapse most of that list for LISA:

1. **LISA defaults to `claude-sonnet-4-6`** (`src/llm.ts` `DEFAULT_MODEL`).
2. Several of those knobs are **model-gated to Opus 4.8/4.7 or Sonnet 5** and return 400 on Sonnet 4.6.

Grounded verdicts (per the `claude-api` skill + `shared/platform-availability.md`):

| OpenClaw knob | Sonnet 4.6 status | Verdict for LISA |
|---|---|---|
| 1M context window | **Native** (Sonnet 4.6 ctx = 1M; no beta header) | ✅ **Already have it** — nothing to build |
| Prompt caching, 1h TTL (`cache_control:{ttl:"1h"}`) | GA (5m + 1h) | ✅ **Build it** — the primary win |
| Thinking effort (`output_config:{effort}`) | GA (adaptive + effort) | ✅ **Build it** — cost/quality lever |
| Fast mode (`speed:"fast"`, beta) | **Opus 4.8/4.7 only** → 400 on Sonnet | ❌ Skip (model-gated) |
| Task budgets (`output_config:{task_budget}`, beta) | **Fable5 / Sonnet5 / Opus 4.8/4.7 only** | ❌ Skip (model-gated) |
| `service_tier`/priority | subsumed by fast mode; Opus-only | ❌ Skip (model-gated + network-bound latency) |

Net: **two** real, model-appropriate improvements — extended caching and effort control. Everything else is either already on or unavailable on the model LISA runs.

LISA already implements, in `anthropic.ts`: system-prompt caching (5-min ephemeral), last-message cache breakpoint (`withCacheBreakpoint`), adaptive thinking (binary), compaction beta, stream-retry, custom baseURL/authToken (now routed through the GCP relay). The two additions slot into that existing shape.

---

## A. Extended (1-hour) prompt caching on the stable prefix — PRIMARY

**What.** Put `cache_control: {type:"ephemeral", ttl:"1h"}` on the **system prompt** block (soul + skills + memory — the large, stable prefix), while leaving the conversational tail breakpoint (`withCacheBreakpoint`) at the default 5-minute TTL.

**Why it fits LISA specifically.** LISA is a *personal, bursty* agent: a few messages, then away for minutes-to-an-hour, then more. The system prompt is large and near-constant within a session (it only changes on soul/skills/memory edits, which `hotReload` already detects and which legitimately bust the cache). With the 5-minute default, any gap > 5 min between turns expires the cache and re-writes the whole system prompt at 1.25× on the next turn. A 1-hour TTL keeps that prefix warm across normal think-time gaps.

**Economics (from `shared/prompt-caching.md`).** Cache read ≈ 0.1× base input. Write: 5-min = 1.25×, 1-hour = 2×. Break-even: 5-min pays off at ≥2 reads, 1-hour at ≥3 reads. So 1-hour wins precisely when the same system prefix is reused ≥3 times across a window with gaps > 5 min — the common LISA session shape. It loses for (i) very sparse use (one turn per multi-hour gap: both TTLs expire) and (ii) tight continuous use (5-min stays warm anyway, and its writes are cheaper). Making the TTL configurable covers both tails.

### 正反方辩论 — A

**正 (do it):**
- Directly cuts cost/latency on LISA's dominant usage pattern (bursty personal chat); the system prompt is the single biggest cacheable, most-reused span.
- Two-line change in one file; GA on Sonnet 4.6 (no beta header, no relay change — the relay is a transparent pass-through).
- Aligns with the paper's long-horizon-coherence thesis: cheaper long stable context = more room for long sessions.
- Reversible and observable — `usage.cache_read_input_tokens` already surfaced; we can measure hit-rate before/after.

**反 (don't / caution):**
- 1-hour writes cost 2× vs 1.25×. For heavy continuous users the 5-min cache is already warm, so 1-hour is a strict cost *increase* on the write side.
- Extra TTL knob = extra config surface for a personal tool; risk of cargo-culting a "cloud-scale" optimization onto a single-user app.
- If the system prompt actually changes often (frequent soul/memory writes during a session), the longer TTL buys nothing — every edit busts it anyway.
- Anthropic could change 1h pricing; a config default embeds an assumption.

**Resolution.** Ship it **configurable, defaulting to 1h for the system prefix only**, because (a) the system prefix is exactly the "stable, large, reused" content 1h TTL is designed for, and (b) the conversational tail stays at 5-min where its cheaper writes fit its volatility. Expose `LISA_CACHE_TTL` (`5m` | `1h`, default `1h`) so heavy-continuous users can drop to `5m`. This neutralizes the strongest 反 point (write-cost) while keeping the win for the common case.

**Design.**
- `anthropic.ts`: system block `cache_control` gains `ttl: cacheTtl` where `cacheTtl = process.env.LISA_CACHE_TTL === "5m" ? undefined : "1h"` (undefined ⇒ default 5-min semantics, i.e. omit `ttl`).
- `withCacheBreakpoint` (conversation tail) unchanged (5-min default).
- Guard: only Sonnet-4.6+/Opus-4.x support 1h; if a future model doesn't, the SDK 400s — acceptable since LISA's models all support it, but we keep the env escape hatch.

---

## B. Thinking effort control (`output_config.effort`) — SECONDARY

**What.** Add an optional `effort` (`low`|`medium`|`high`|`xhigh`|`max`) threaded from config → `ProviderRunOpts` → `output_config.effort`. Default: omit (⇒ `high`, the API default). Let subagents/dispatch pass `low` for cheap parallel work.

**Why.** LISA currently uses adaptive thinking with **no** depth control → always effectively `high`. Effort is the sanctioned cost/quality lever (GA on Sonnet 4.6, combines with adaptive). Two concrete uses: a global `LISA_EFFORT` for users who want cheaper/faster routine turns, and `low` for dispatched subagents (mirrors Claude Code's Explore-on-Haiku pattern).

### 正反方辩论 — B

**正 (do it):**
- Real cost lever on the model LISA actually runs; `low` subagents can materially cut dispatch cost.
- Sanctioned API (`output_config.effort`, GA) — combines cleanly with the existing adaptive thinking.
- Small, additive: an optional field with a safe default (omit ⇒ high).

**反 (don't / caution):**
- For an interactive chat agent, `high` (the default) is usually the right call; effort mostly matters at scale, which a single-user app isn't.
- Touches more surface than A (types + registry + call sites), for a benefit that's mostly "nice knob," not a felt problem.
- Adaptive thinking already self-moderates depth per request; manual effort can *fight* adaptive if set too low on a hard turn (skill warns: raise effort rather than prompt around under-thinking).
- Risk of a wrong global default degrading chat quality to save pennies.

**Resolution.** Ship it **minimally and default-off**: thread an optional `effort` but do **not** set a global default (keep `high`). Wire exactly one real consumer — **dispatched subagents default to `low`** (the clear, safe win) — and expose `LISA_EFFORT` for power users, documented as "leave unset unless you know you want cheaper/faster at some quality cost." This captures the concrete benefit (cheap subagents) while dodging the "wrong global default" 反 risk.

**Design.**
- `types.ts` `ProviderRunOpts`: add `effort?: "low"|"medium"|"high"|"xhigh"|"max"`.
- `anthropic.ts`: `if (opts.effort) params.output_config = { ...(params.output_config), effort: opts.effort }`.
- Call sites: `/chat` reads `LISA_EFFORT` (unset ⇒ omit); `runSubagent` defaults `effort: "low"` unless overridden.
- (OpenAI/other providers ignore `effort` — Anthropic-only field.)

---

## C. Explicitly NOT doing (and why)

- **1M context beta wiring** — Sonnet 4.6 is natively 1M; adding a beta header would be wrong (that header is for older Sonnet 4). Already available. (If LISA ever defaults to a 200K model like Haiku, revisit.)
- **Fast mode / `speed:"fast"`** — Opus 4.8/4.7 only; 400 on Sonnet. Also premium-priced, separate rate limit, and LISA's latency is network-bound (China→relay), not model-speed-bound. If LISA switches default to Opus, reconsider as a per-turn opt-in.
- **Task budgets** — Fable5/Sonnet5/Opus-4.8/4.7 only. LISA already has server-side **compaction** for long runs, which covers the "don't blow the context" need on Sonnet 4.6.

---

## Phasing & verification

1. **A (caching)** — implement, `npm run typecheck` + `npm test` + `npm run build`; live-check `usage.cache_read_input_tokens` on a real second `/chat` turn (should be > 0 and grow across turns). Rebuild local dist + restart so the running backend benefits.
2. **B (effort)** — implement, typecheck/test/build; verify a dispatched subagent runs at `low` (no 400) and a normal `/chat` is unchanged (still high).
3. Each phase its own commit/PR to `main`; the running backend (voice-branch dist) picks it up via the same patch-and-rebuild path used for the relay.

**Non-goals honesty:** this is a small, model-appropriate tune-up, not an OpenClaw port. The biggest "feature" (1M context) needed no work because LISA's model already has it.
