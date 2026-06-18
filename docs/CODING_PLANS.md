# Coding plans — running LISA's work on a subscription, not just an API key

**Status: RESEARCH / DESIGN.** Nothing here ships yet beyond what the flagged
PTY-agent bridge (`LISA_PTY_AGENTS=1`, see [PTY_AGENTS.md](./PTY_AGENTS.md))
already does. This doc records the mechanism, the constraints that shape it, and a
phased plan.

## TL;DR

People who pay for **Claude Pro/Max**, a **ChatGPT plan** (which includes Codex),
or **GitHub Copilot** already have a large, flat-rate inference budget — their
"coding plan." Today LISA only spends **metered API keys** (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, …). The ask: let LISA *also* draw on a coding-plan budget.

There are two ways to do that, and they are not equally legitimate:

| | **A. Reuse the plan's token in LISA's own loop** | **B. Delegate work to the vendor's own CLI** |
|---|---|---|
| How | Read the OAuth token `claude`/`codex`/Copilot stored, send it as a Bearer header from LISA's provider | Drive the real `claude` / `codex` / `copilot` binary (which owns its own subscription auth) and read back its result |
| Whose loop runs | **LISA's** (her soul, her tools) | **The vendor CLI's** (its model, its tools); LISA conducts |
| ToS | ❌ **Prohibited** for Claude — subscription OAuth is "for ordinary individual use of Claude Code / native Anthropic apps" only; Anthropic sent a **legal request** that forced **OpenClaw** (one of LISA's own reference agents) to remove it. Gray-to-prohibited for OpenAI & Copilot too. | ✅ This *is* "ordinary individual use of Claude Code." The sanctioned path. |
| Durability | Fragile: token refresh, spoofed `anthropic-beta` / "You are Claude Code" constraints, server-side detection, **account-ban risk** | Stable: the vendor ships and supports the CLI; auth/refresh is their problem |
| Effort | Medium code, high maintenance + legal risk | Low — LISA already drives these CLIs via PTY agents |

**Recommendation: build on B.** Treat each logged-in coding-plan CLI as a
first-class **delegation backend** that LISA can route *coding tasks* to, alongside
the metered API providers she uses for her *own* turns. Reject A as the primary
mechanism (document it here so the decision is on record, not re-litigated).

This also happens to fit LISA's identity: her **soul is sovereign**, and you would
not want her *self* running on a token that must pretend to be Claude Code to
function. She keeps her own provider; she *spends your plan by conducting the tool
that owns it*.

---

## Background: two kinds of budget

- **API key (metered).** A console key billed per token. What LISA uses now.
  Routing lives in [`src/providers/registry.ts`](../src/providers/registry.ts):
  model-name prefix → provider, plus `LISA_BASE_URL` / `LISA_PROVIDER` overrides
  and 13 OpenAI-compatible presets. Clean, well-factored, pay-as-you-go.
- **Coding plan (flat-rate subscription).** Claude Pro/Max, a ChatGPT plan, or
  Copilot. You already paid; the marginal token is "free." Consumed today **only**
  through the vendor's own client (the `claude` / `codex` CLI, Copilot in your
  editor). There is no blessed "use my subscription as a generic API" surface — by
  design.

The whole point of the feature is to let LISA reach the second budget. The whole
*constraint* is that the vendors deliberately fence it to their own clients.

---

## Mechanism A — in-process credential reuse (researched, **not** recommended)

How it would work, per vendor (all confirmed against current docs — see Sources):

- **Anthropic.** Credentials live in the macOS Keychain (encrypted) or
  `~/.claude/.credentials.json` (Linux/Windows, mode `0600`), or a one-year token
  from `claude setup-token` exported as `CLAUDE_CODE_OAUTH_TOKEN`. The
  `@anthropic-ai/sdk` client LISA already uses can take an `authToken` (sent as
  `Authorization: Bearer`, the same slot as Claude Code's `ANTHROPIC_AUTH_TOKEN`).
  So technically: read token → `new Anthropic({ authToken })` → done.
- **OpenAI / Codex.** `~/.codex/auth.json` (or OS keyring; `CODEX_HOME` relocates
  it) holds the ChatGPT access/refresh tokens. The ChatGPT-backed endpoint is not
  the standard `api.openai.com`; it's a Codex-scoped backend keyed to your
  account.
- **GitHub Copilot.** Exchange the GitHub OAuth token at
  `api.github.com/copilot_internal/v2/token` for a short-lived Copilot token, then
  call the OpenAI-compatible `api.githubcopilot.com` with
  `Authorization: Bearer <copilot-token>` + `Copilot-Integration-Id: vscode-chat`.

**Why we reject it as the mechanism:**

1. **Anthropic forbids it and enforces.** Subscription OAuth is contractually
   limited to ordinary individual use of Claude Code and native Anthropic apps.
   Anthropic issued a **legal request to OpenClaw** — *a project LISA is explicitly
   built on top of* — to strip exactly this capability and redirect to API keys.
   Shipping A would walk LISA into the same wall, on the public record, in an MIT
   repo. The `setup-token` flow is "scoped to inference only" for *Claude Code's
   own* CI, not for re-hosting a different agent.
2. **OpenAI & Copilot are gray-to-prohibited too.** Codex access tokens are "for
   trusted scripts, schedulers, and private CI runners," scoped to ChatGPT
   workspace use — not a general third-party API. Copilot's terms restrict API use
   to the official editor integrations; community proxies exist but carry
   account-ban risk.
3. **It's brittle.** These backends sniff for client identity (system-prompt
   prefix, `anthropic-beta` flags, integration-id headers). Reusing the token from
   a foreign agent means *impersonating the official client* and chasing every
   server-side change. Token refresh is one more failure mode.
4. **Account risk lands on the user.** A ban hits the human's paid plan, not a
   throwaway API key.

There is **one narrow, fully-sanctioned slice of A worth taking anyway** — see
"Sanctioned win" below — because it serves real users (enterprise LLM gateways)
without touching subscription OAuth.

---

## Mechanism B — out-of-process CLI delegation (recommended)

Let the vendor's CLI keep being the only thing that holds its subscription token.
LISA becomes the **conductor**: she hands a task to `claude` / `codex` / `copilot`,
the CLI runs *its own* agent loop on *its own* plan, and LISA reads the result and
weaves it back into the conversation, the island, the recap.

This is not hypothetical — **LISA already does ~80% of it:**

- [`src/agents/pty.ts`](../src/agents/pty.ts) — `PtyAgent` / `PtyRegistry` spawn the
  real `claude` / `codex` binary under a pseudo-terminal (`node-pty`), type the
  task in, read the stream, support send/cancel. `resolveCli()` already locates the
  binary (`LISA_PTY_CLAUDE_CMD`, `LISA_PTY_CODEX_CMD`, else the newest app-bundled
  `claude`, else PATH).
- [`src/integrations/claude-code/liveness.ts`](../src/integrations/claude-code/liveness.ts)
  — adopt an **idle** Claude session you started yourself via `claude --resume <id>`,
  with a liveness guard so two writers never corrupt one transcript.
- The orchestrator hub, observers, advisor cards, and `/api/agents/*` endpoints
  already model, display, and control these agents.

When LISA drives a CLI you logged into with your Claude Max / ChatGPT plan, **that
work is already billed to your plan, not an API key.** The feature is mostly about
making that *first-class, detectable, and selectable* instead of a flagged spike.

### The honest tradeoff

Delegation means the heavy coding turns run in the **vendor's** loop — its tools,
its system prompt, its model — **not** LISA's soul-driven loop. So:

- ✅ Right for **"do this coding task on my plan"** (the literal ask — coding plans
  are for coding).
- ✅ ToS-clean, vendor-maintained, no token handling.
- ⚠️ LISA's persona/tools don't shape those turns; she frames, dispatches,
  supervises, and synthesizes around them.
- ⚠️ Control fidelity is coarse (TUI parsing) for interactive PTY; **headless
  modes are far cleaner** — see next.

### Use the headless modes, not just the TUI

Each vendor ships a non-interactive entry point that is much easier to drive than
scraping a TUI, and that still runs on the subscription:

- **Claude Code:** `claude -p "<prompt>" --output-format json` (print/headless).
- **Codex:** `codex exec "<prompt>"` (non-interactive).
- **Copilot:** the GitHub `copilot` CLI's non-interactive invocation.

A delegation backend should prefer these for one-shot subtasks (structured output,
clean exit codes), and fall back to the interactive PTY only when a task needs
back-and-forth (answering the CLI's prompts).

---

## Per-vendor reference

| Vendor | Plan that grants it | Where the CLI keeps auth | Sanctioned headless command | Third-party in-process reuse? |
|---|---|---|---|---|
| **Anthropic / Claude Code** | Claude Pro, Max, Team, Enterprise | macOS Keychain · `~/.claude/.credentials.json` (`0600`) · `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (1 yr) | `claude -p "…" --output-format json` | ❌ Prohibited & enforced (OpenClaw precedent) |
| **OpenAI / Codex** | ChatGPT Plus, Pro, Business, Edu, Enterprise | `~/.codex/auth.json` or OS keyring (`CODEX_HOME` relocates) | `codex exec "…"` | ❌ Gray; tokens scoped to ChatGPT workspace/CI |
| **GitHub Copilot** | Copilot Individual/Pro, Business, Enterprise | `gh`/Copilot OAuth → token exchange `copilot_internal/v2/token` → `api.githubcopilot.com` | GitHub `copilot` CLI (non-interactive) | ❌ Against editor-only terms; ban risk |

Detection should read **presence**, never **contents**: "a logged-in Claude plan is
available" = the Keychain item / credentials file exists *or* `claude` is on PATH
and `claude --version` / a `/status`-style probe succeeds — **without parsing the
secret**. Same posture as every LISA observer: metadata, not payload.

---

## Proposed architecture for LISA

Add the concept of a **backend** that sits beside the existing metered providers.
A backend is either:

- a **provider** (today's path) — an API-keyed `Provider` from `registry.ts`, used
  for LISA's *own* `runTurn`; or
- a **plan delegate** (new) — a coding-plan CLI that LISA dispatches *tasks* to via
  the PTY/headless bridge.

### 1. Plan-backend descriptors

```ts
interface PlanBackend {
  id: "claude" | "codex" | "copilot";
  label: string;                 // "Claude Max plan", "ChatGPT / Codex", …
  detect(): Promise<PlanStatus>; // presence-only: { available, loggedIn?, note }
  // one-shot subtask on the subscription (headless preferred, PTY fallback)
  run(task: string, opts: { cwd: string; signal: AbortSignal }): Promise<PlanResult>;
}
```

`detect()` reuses the existing binary resolution in `pty.ts` and the credential-
**presence** checks; it never reads token bytes.

### 2. Selecting a plan from the model picker

Reuse the `local://…` precedent in [`src/model/local.ts`](../src/model/local.ts).
Introduce a `plan://` scheme:

- `lisa model use plan://claude` → route delegated coding work to the Claude plan.
- `lisa model list` → also shows detected plans (`✓ Claude Max plan (logged in)`,
  `✗ Codex (run \`codex login\`)`).
- The web/island model selector lists available plans next to API models.

A `plan://` selection does **not** replace LISA's own loop (she still needs a
provider/local model for her soul-driven turns); it sets the **default delegation
target** for her coding-dispatch tools (`dispatch_agent`, `compare_agents`, the
PTY start endpoints), so "run this on my plan" becomes one click / one tool call.

### 3. Surfacing usage

Coding plans are rate-limited, not metered, so "usage" means *headroom*, not
dollars. Cheapest honest signal: surface what the vendor's own CLI reports
(`/status`, rate-limit lines in output) and LISA's own dispatch count, in the
existing autonomy ledger ([`src/autonomy/`](../src/autonomy/)) and the agents card.
No scraping of private billing endpoints.

### 4. Config

```jsonc
// ~/.lisa/agents.json  (existing file)
{
  "plans": {
    "claude": { "enabled": true },            // detected from login; opt-in to use
    "codex":  { "enabled": false },
    "copilot":{ "enabled": false }
  }
}
```

Plus the env overrides that already exist (`LISA_PTY_CLAUDE_CMD`, etc.), and the
master switch `LISA_PTY_AGENTS=1` until the bridge graduates from "spike."

### What exists vs. what to build

| Capability | State |
|---|---|
| Spawn & drive real `claude`/`codex` under PTY | ✅ exists (`src/agents/pty.ts`, flagged) |
| Adopt idle `claude` sessions (`--resume`) | ✅ exists (`liveness.ts`) |
| Binary resolution / env overrides | ✅ exists (`resolveCli`) |
| Observe/control via hub + `/api/agents/*` | ✅ exists |
| **Headless one-shot (`claude -p` / `codex exec`) backend** | ⬜ build |
| **`PlanBackend` + presence detection** | ⬜ build |
| **`plan://` model refs + picker integration** | ⬜ build |
| **Copilot CLI delegate** | ⬜ build |
| **Headroom/usage surfacing** | ⬜ build |

### Suggested phasing

1. **Detection + picker.** `PlanBackend.detect()` for claude/codex; `lisa model
   list` shows plans; `plan://` selection stored in config. (No new auth code.)
2. **Headless delegate.** Wrap `claude -p --output-format json` / `codex exec` as
   `run()`; wire `dispatch_agent` / a "run on my plan" action to it. Graduate the
   PTY flag.
3. **Copilot.** Add the GitHub `copilot` CLI delegate (or document the
   community-proxy route with its ToS caveat, opt-in only).
4. **Headroom surfacing** in the autonomy ledger + agents card.

---

## The one sanctioned in-process win: gateway / bearer auth

Independent of subscriptions, LISA's providers should accept a **bearer token and
custom headers**, because that is the *blessed* path for enterprise LLM gateways
(and mirrors Claude Code's own `ANTHROPIC_AUTH_TOKEN` precedence slot):

- Extend `AnthropicProvider` / `OpenAIProvider` constructors with
  `authToken?` and `defaultHeaders?` and pass them to the SDK
  (`new Anthropic({ authToken, defaultHeaders })`, `new OpenAI({ defaultHeaders })`).
- Read `ANTHROPIC_AUTH_TOKEN` (Bearer) alongside `ANTHROPIC_API_KEY` (`x-api-key`)
  in `registry.ts`, with the same precedence Claude Code uses.
- Optionally support an `apiKeyHelper`-style hook: a user-configured command whose
  stdout is the key/token, refreshed on a TTL or 401. This covers Bedrock/Vertex/
  Foundry and corporate gateways cleanly.

This is small, ToS-clean, useful on its own, and does **not** touch subscription
OAuth. It is the right "extra auth source" to ship; coding-plan *delegation* (B) is
the right answer to "use my subscription."

---

## Open questions

- **Headless fidelity.** Does `claude -p --output-format json` expose enough
  (final text, files touched, exit status) to fold into LISA's transcript without
  TUI scraping? (Spike in phase 2.)
- **Sub-task vs. whole-task.** Should a `plan://` backend take only self-contained
  subtasks (clean), or stream multi-turn (needs interactive PTY)? Start with
  self-contained.
- **Mixing.** When LISA's own loop runs on a local model but delegates coding to a
  plan, how do we present "who did what" honestly in the recap? (Attribution per
  turn.)
- **Copilot policy.** Ship only the official `copilot` CLI route by default; keep
  any proxy route opt-in and clearly ToS-flagged.

## Sources

- Claude Code — Authentication (creds storage, `CLAUDE_CODE_OAUTH_TOKEN`,
  `claude setup-token`, `ANTHROPIC_AUTH_TOKEN` precedence):
  <https://code.claude.com/docs/en/authentication>
- Anthropic legal request removing third-party subscription OAuth (OpenClaw):
  reported via <https://github.com/anthropics/claude-code/issues/18340> and
  community write-ups (e.g. <https://daveswift.com/claude-oauth-update/>).
- Codex — Authentication (`~/.codex/auth.json`, `CODEX_HOME`, token scope):
  <https://developers.openai.com/codex/auth> ·
  <https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan>
- GitHub Copilot token exchange / OpenAI-compatible endpoint (community):
  <https://github.com/ericc-ch/copilot-api>
- LISA's existing CLI-driving bridge: [PTY_AGENTS.md](./PTY_AGENTS.md),
  [`src/agents/pty.ts`](../src/agents/pty.ts).
