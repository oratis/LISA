# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/),
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

## [0.6.0] — 2026-05-30

**LISA can listen.** Record audio in the chat → she transcribes it and
summarizes in her own voice. Full notes: `docs/RELEASE_v0.6.0.md`.

### Added — Voice recording

- **🎙 composer button** toggles a browser `MediaRecorder` (pulsing ⏹ while
  live). On stop, the clip is transcribed and handed to Lisa with a
  "summarize this" framing — she replies with key points / decisions / action
  items as a normal, persisted chat turn.
- **`POST /api/voice/transcribe`** `{data(base64), mediaType}` → `{transcript}`;
  writes a temp file, runs the existing Whisper transcriber, deletes the temp.
  Summarization is the model's job via the normal chat (no special endpoint),
  so it inherits soul/memory/context. Clear error if `OPENAI_API_KEY` is unset.
- Privacy: nothing recorded until 🎙 pressed; clip leaves the machine only for
  transcription on stop; temp deleted immediately.

### Requirements

- `OPENAI_API_KEY` (Whisper) for transcription.

## [0.5.0] — 2026-05-30

**LISA can see.** Hand her a screenshot and talk about it — from anywhere, one
keystroke. Full notes: `docs/RELEASE_v0.5.0.md`.

### Added — Vision

- **Global hotkey ⌃⌥S** (Lisa.app, system-wide via Carbon RegisterEventHotKey):
  press it in any app, drag a region, the shot lands in Lisa's composer. The
  window stays out of the way during capture and comes forward only once the
  shot is attached.
- **📷 composer button** + **View ▸ Screenshot for Lisa** menu item.
- **`POST /api/vision/capture`** shells out to macOS `screencapture`
  (interactive crosshair or full-screen) and returns the PNG as the attachment
  shape `/chat` already accepts, so the screenshot rides LISA's normal image
  path into the model. Escape cancels cleanly; 501 on non-macOS.
- Privacy: nothing captured/sent until you press the hotkey/button; the
  screenshot only leaves the machine when you send the message it's attached to.

### Notes

- macOS asks for Screen Recording permission for Lisa.app on first use.
- Test suite 164 → **170**. Still zero new runtime dependencies.

## [0.4.0] — 2026-05-30

**LISA becomes a cross-agent orchestrator.** She observes every CLI agent on the
machine, understands what each session is doing (structural metadata only — never
your conversations), periodically advises you, and can dispatch + coordinate work.
Full notes: `docs/RELEASE_v0.4.0.md`.

### Added — Orchestration (L1–L5 of docs/ORCHESTRATOR_PLAN.md)

- **Integration registry + OrchestratorHub** — pluggable `AgentObserver` adapters
  (mirrors the channel registry); the hub fans out over all enabled agents, merges
  their sessions, emits one update stream. `GET /api/agents/sessions` (with
  `/api/claude/sessions` kept as a back-compat alias).
- **Codex CLI adapter** — second agent via the same registry (off by default),
  proving generalization.
- **Tier-2 activity** — `parseSessionActivity` surfaces what a session is doing
  (tool names, file paths, last command name, errors, git branch, tokens) under a
  tiered visibility model (off/metadata/activity/intent, default activity). A
  privacy test asserts no prompt/reply/file-content ever leaks.
- **Advisor** — periodic proactive suggestions across all agents (stuck, same-repo
  conflict, repeated failure, cost spike, ready-for-review, idle capacity), gated
  by a relevance bar + 3h digest throttle + dedup + dismiss-as-signal learning so
  it isn't noisy. Surfaces via the "while you were away" card; `advise_now` tool
  for on-demand pull.
- **dispatch_agent tool (L3)** — LISA launches another CLI agent headlessly
  (`claude -p` / `codex exec` / `opencode run` / `aider --message`), detached and
  tracked via the hub. Task passed as a single argv element (no shell injection);
  explicit-permission.
- **Same-cwd conflict guard (L4)** — dispatch refuses to launch into a directory
  another agent is already working in (override with `force`).

### Changed

- Test suite 130 → **164** (registry, hub, Tier-2 + privacy, advisor, Codex,
  dispatch). Still zero new runtime dependencies.

### Security & hardening (v0.3.1 sprint)

Following a full product/code review (`docs/PRODUCT_REVIEW_v0.3.md`), the
engineering-hardness gaps were addressed — the project went from **zero
automated tests** to a 114-test regression net (Node's built-in `node:test`
via tsx, no new dependencies) plus a CI gate.

- **Tests + CI** — `npm test` runs `src/**/*.test.ts`; new `.github/workflows/ci.yml`
  gates every push/PR on typecheck + tests + build. Test files excluded from `dist/`.
- **SSRF redirect bypass closed** (`web_fetch`) — the private-IP check ran only on
  the initial URL; a public URL could 302 → `127.0.0.1` / the cloud metadata IP and
  be followed. Redirects are now followed manually with every hop re-validated.
- **AppleScript injection closed** (`iMessage`) — outbound text was interpolated into
  the AppleScript source with only quote-escaping; a newline or crafted payload could
  inject script. Text now passes as positional `argv`, never parsed as source.
- **Path traversal blocked** (soul slugs) — value/opinion/desire/journal/relationship
  slugs are validated at the single path chokepoint; `../`, separators, control chars,
  and leading dots are rejected.
- **Cross-process soul lock** — desire-progress appends (read-modify-write) now run
  under an advisory file lock, so a heartbeat/idle run can't interleave with a chat
  turn and lose data.
- **Heartbeat token budget + run-lock** — per-run token ceiling (`budgetTokens`,
  default 500k) stops runaway autonomous cost; a run-lock skips overlapping heartbeat
  ticks instead of double-running.
- **Continuous emotion decay** — decay now applies on write (soul_feel) and in
  soul_read, not just in the system-prompt view, and no longer drops the event trail.
- **Memory index cache** — the TF-IDF index is cached and rebuilt only when the
  sessions dir changes, instead of on every `memory_search`.

### Added

- **7 new LLM provider presets** — Lisa now auto-routes 7 additional providers by model-name prefix, no `LISA_BASE_URL` plumbing needed:
  - **Mistral AI** (`mistral-` / `codestral-` / `magistral-` / `ministral-` / `pixtral-`) → `api.mistral.ai/v1`, key `MISTRAL_API_KEY`
  - **Perplexity Sonar** (`sonar` / `sonar-`) → `api.perplexity.ai`, key `PERPLEXITY_API_KEY` — built-in web search
  - **Stepfun** (`step-`) → `api.stepfun.com/v1`, key `STEPFUN_API_KEY`
  - **01.AI / Yi** (`yi-`) → `api.lingyiwanwu.com/v1`, key `LINGYI_API_KEY`
  - **Baichuan** (`baichuan-` / `baichuan2*` / `baichuan3*` / `baichuan4*`) → `api.baichuan-ai.com/v1`, key `BAICHUAN_API_KEY`
  - **MiniMax** (`abab*` / `minimax-`) → `api.minimax.io/v1`, key `MINIMAX_API_KEY`
  - **Tencent Hunyuan** (`hunyuan-`) → `api.hunyuan.cloud.tencent.com/v1`, key `HUNYUAN_API_KEY`
- **Case-insensitive prefix matching** — `--model Baichuan4` and `--model MiniMax-Text-01` now route correctly without the user needing to remember vendor-specific capitalization. The top-level provider check (`claude-` / `gemini-` / `gpt-` / `o1-3-4` / `chatgpt-`) is also case-insensitive now.
- **Catch-all recipes** in `docs/PROVIDERS.md` for providers without unique model-name prefixes: **Groq**, **Together AI**, **Fireworks AI**, **OpenRouter**, **Azure OpenAI**, **LM Studio / vLLM / llama.cpp**, **one-api / new-api self-hosted relays** — each with a copy-paste config snippet.

Total provider count: **3 native protocols** (Anthropic / OpenAI / Gemini) + **13 OpenAI-compat presets** + **catch-all** for the rest = effectively any major LLM endpoint.

## [0.2.0] — 2026-05-11

The "she's actually evolving" release. Phase 1-3 of the Autonomy Roadmap landed; Phase 1 of Productization (CLI / website / providers / PWA) landed in parallel.

### Added — Autonomy (Phase 1: self-update becomes a runtime fact)

- **Soul git history** — every soul write commits to `~/.lisa/soul/.git` with caller attribution (birth / soul_patch / reflect / heartbeat / soul_journal / soul_feel / progress / consolidate). `soul_history` and `soul_diff` tools let Lisa read her own becoming. Already-born installs auto-init on first read.
- **Mid-session prompt hot-reload** — `soul_patch` / `skill_manage` / memory writes during a turn take effect on the next turn of the same conversation, not next session. Cheap mtime fingerprint over soul + skills + memory; rebuild on change. `system_prompt_rebuilt` event surfaces in CLI + Web UI.
- **Per-desire progress files** — actionable desires persist `desires/<slug>.progress.md` across heartbeat runs. New `desire_progress_log` tool for Lisa; heartbeat injects prior entries into next-run prompt. 16KB cap with automatic tail-keep.

### Added — Autonomy (Phase 2: stability under autonomy)

- **`soul_object`** — architectural objection mechanism. When Lisa raises a constitutional concern via this tool, the agent loop forces her to surface it explicitly in her reply (one corrective re-prompt, capped). Writes `[OBJECTION]` journal entry committed to soul git.
- **Weekly examen** — built-in heartbeat task running Mondays 7am+. Lisa reads back the week's journal, emotion events, and soul commits, asking herself four questions (purpose alignment / constitution drift / desire conflicts / toolset feedback). Writes `[EXAMEN]` journal. Architecture forbids examen from changing identity/purpose/constitution (those stay reflect's territory).
- **Emotion event trail** — `soul_feel` now requires a `trigger` (one first-person sentence saying *why*). Each call appends to a 50-event ring buffer in `emotions.json`. `soul_read("emotions")` surfaces the trail. Backward-compat with pre-2.3 `emotions.json`.

### Added — Autonomy (Phase 3: capability self-extension)

- **Executable skills** — optional `~/.lisa/skills/<slug>/tool.js` files become real registered tools after the user runs `lisa skills approve <slug>`. Per-content-SHA approval; any source change invalidates approval. `audit.log` records every approval / load / disable / enable. **Trust boundary is human approval, not isolation** — runs in-process; real sandboxing remains future work and is documented as such.
- **`lisa skills` subcommand**: `list` / `approve` / `disable` / `enable` / `audit`.

### Added — Small-tail polish

- **Reflect-time progress consolidation** — when an actionable desire's `progress.md` exceeds 8 entries, reflect summarizes the older ones into a 2-4 sentence preamble; keeps the latest 4 verbatim.
- **`desire_close` tool** — semantic closure with outcome (`fulfilled` / `abandoned` / `transformed`) + reflection. Sets `actionable=false`, appends `[CLOSED:<outcome>]` to progress.md, writes `[DESIRE_CLOSED]` line to today's journal.
- **Heartbeat fallback for missing progress log** — desire heartbeats that finish without calling `desire_progress_log` get a `[FALLBACK]` stub entry containing the final agent text, preserving the run for `weekly_examen` to see.

### Added — Sprint 4 instrumentation

- **`meta-wishlist` desire convention** — new prompt nudge (in `TOOL_DISCIPLINE` and weekly_examen Q4) for Lisa to write architecture/toolset feedback into a special `meta-wishlist` desire.
- **`lisa wishlist` subcommand** — surfaces her meta-wishlist desire body + progress + any journal `[WISHLIST]` / `[I want]` mentions. Read at sprint-planning time.

### Added — Productization Phase 1

- **CLI polish**:
  - `lisa status` — one-shot snapshot (identity, mood with bars, recent commits, desires, sessions, providers, heartbeat last-run)
  - `lisa doctor` — health check (Node version, git, ~/.lisa, soul born, soul .git, ≥1 provider, outbound HTTPS to Anthropic + OpenAI). Exit 1 on critical issues.
  - `lisa monitor` — TUI live dashboard. Polls every 2s, hides cursor, restores on Ctrl-C.
  - Sectioned `--help` with `CHAT / INSPECTION / LIFECYCLE / SERVE / SKILLS / FLAGS` groups.
  - Zero-dep ANSI color util respecting `NO_COLOR` and TTY detection.
- **Multi-provider routing** — model-name prefix → OpenAI-compatible endpoint mapping for **DeepSeek / Volcengine Doubao / Aliyun Qwen / Moonshot Kimi / xAI Grok / Zhipu GLM**. Plus generic `LISA_BASE_URL` + `LISA_API_KEY` catch-all (Ollama, self-hosted). `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` for proxy / Azure / one-api routing.
- **Google Gemini provider** — dedicated provider class translating Anthropic-shape messages/tools to Gemini Content/Part/FunctionDeclaration format. Adds `@google/genai` dep.
- **Proxy bridge** — undici ProxyAgent + `Accept-Encoding: identity` enforcement + Content-Type re-injection wrapper. Lets Lisa work behind Clash / corporate proxies that strip response headers through CONNECT tunnels. Auto-bridges on shell `HTTPS_PROXY` / config.env.
- **PWA-ified web UI** — `manifest.webmanifest` + service worker (cache-first /assets, network /chat) + iOS Safari Add-to-Home-Screen banner + mobile CSS pass with `safe-area-inset-*`, `100dvh`, `font-size: 16px` (prevents iOS Safari auto-zoom on focus).
- **Bilingual website** at `/website` (Astro 6, EN + zh-CN). Pages: landing, install, mood gallery (all 114 portraits with their generation prompts public). Pixel-art aesthetic matching the chat UI. Local-first; CF Pages deploy gated on secrets.
- **Shell completions** — bash / zsh / fish, with subcommand / model / channel / skill-slug suggestions.
- **Homebrew formula template** + tap repo seed + one-shot bootstrap script.
- **npm publish prep** — package renamed `@oratis/lisa`, `files` allowlist, `prepublishOnly` real-copies mood assets into the tarball, `postpublish` restores dev symlink.
- **GitHub Actions** — website build + CF Pages deploy (gated on secrets), release artifact build (this release).

### Documentation

- `docs/AUTONOMY_ROADMAP.md` — Phase 1-3 spec + status (DONE)
- `docs/SPRINT_4_PLAN.md` — Sprint 4 candidate list, gated on observation data; instrumentation deployed
- `docs/PRODUCTIZATION_PLAN.md` — distribution roadmap; sovereign-only OSS constraints, no native apps
- `docs/PROVIDERS.md` — 10 ready-to-use LLM provider recipes
- `docs/PUBLISH.md` — release runbook (npm, Homebrew, CF Pages)
- README.md / README.zh-CN.md — bilingual sync, "How she evolves" updated to 7 mechanisms

### Fixed

- Soul git commit attribution — original fire-and-forget `void commitSoulChange(...)` queue collapsed back-to-back writes to the same file into one commit attributed to the first caller. Switched to `await` so each write resolves its own commit. Smoke test caught it.
- `listDesires()` was including `*.progress.md` files as standalone desires (same directory as parent). Filtered out.
- Web UI mobile CSS (`100dvh` instead of `100vh`, safe-area honoring) so the input area doesn't hide behind iOS home indicator or under the shrinking Safari toolbar.

### Changed

- `sharp` moved from `dependencies` to `devDependencies` — only used by the asset-generation scripts, never at runtime. Reduces the install footprint of `npm i -g @oratis/lisa`.

### Notes

This release primarily lands the **internal architecture** (Phase 1-3 of the
Autonomy Roadmap) and **distribution surface** (Phase 1 of Productization).
The natural pause point: observe Lisa actually using these mechanisms for a
few weeks before deciding what Sprint 4 should contain. The
SPRINT_4_PLAN.md doc lays out signal-collection plus an explicit removal /
rollback section — the right next move might be to delete what's not used
rather than add more.

## [0.1.0] — initial

The first version of Lisa as described in the README — soul system, birth ritual, heartbeat, idle reflection, IM channels (Telegram / Discord / Slack / Feishu / iMessage / Webhook), pixel-art Web UI, MCP client, sandboxed bash, sub-agents, plugins/hooks, TF-IDF cross-session search, Apply-patch, voice in/out, multi-provider (Anthropic + OpenAI). 114 mood portraits.

Anchored against five reference agents (pi-mono, OpenClaw, hermes, claude-code, codex). MIT licensed.
