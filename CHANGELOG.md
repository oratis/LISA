# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/),
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

—

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
