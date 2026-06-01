# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/),
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added — GitHub PR observer (orchestrator O4: cloud agents)

- **`github-pr` integration** treats your open pull requests as agent sessions:
  CI running → `working`, checks failed → `error`, awaiting/declined review →
  `waiting`, merged/closed → `done`. It's the first **polling** observer (no
  files to tail) — proving the `AgentObserver` registry generalizes from local
  CLI agents to cloud/API work. Off by default; opt in via `~/.lisa/agents.json`
  (`"github-pr": { "enabled": true }`), optionally scoped to
  `"repos": ["owner/repo"]` for full check/review state. With no repos it lists
  your open PRs across GitHub via `gh search`. No-op if `gh` is missing or
  unauthenticated. Privacy: only your own PR metadata (number, title, branch,
  check/review status) — never diff or review content.

### Added — OpenCode + Aider observers (orchestrator O3/O4)

- **`opencode` integration** reads OpenCode's SQLite session DB
  (`~/.local/share/opencode/opencode.db`) via the system `sqlite3` CLI (no new
  dependency). State from the session row + its newest message: archived →
  `done`, compacting → `working`, last message errored → `error`, assistant
  replied → `waiting`, mid-turn / user turn → `working`.
- **`aider` integration** watches the per-project `.aider.chat.history.md`
  transcripts under the `watchRoots` you configure (Aider keeps no central
  store). State is a tolerant tail heuristic: an error after the last `####`
  user turn → `error`, an assistant reply after it → `waiting`, none yet →
  `working`.
- Both off by default; opt in via `~/.lisa/agents.json`
  (`"opencode": { "enabled": true }`, `"aider": { "enabled": true, "watchRoots": ["~/code"] }`).
  Graceful no-op when the tool/DB/roots are absent. Privacy: only structural
  metadata (session title, dir, token counts, role/error) — never transcript or
  message text. Verified against real OpenCode + Aider sessions on-device.

### Added — vibe-coding tools

- **`github_link`** — turn the local git context into a shareable GitHub URL:
  repo, branch, commit, file (with optional line range), or pr/issue by number.
  So LISA hands you a clickable link instead of a bare path. Pure git (parses
  origin, GitHub + Enterprise hosts); no gh needed; open:true opens the browser.

- **`compare_agents`** — run the same task across multiple agents in isolated
  git worktrees and compare results (a workflow: agents run for minutes).
  start → launch each in its own worktree; status → live state + files changed;
  collect → diff each result side by side; cleanup → remove worktrees. Pick the
  best output.

- **`scheduled_dispatch`** — schedule an agent to run a task recurringly
  (every:30m / every:2h / every:1d / daily:HH:MM), fired by the heartbeat. For
  standing autonomous work (nightly issue triage, periodic sync). Auto-launches
  unattended, so each entry has a maxRuns cap (default 30). add/list/remove.
  (Shared `launchAgent()` extracted from dispatch_agent.)

- **`inspect_agent`** — deep-dive one observed session (by id/prefix or project):
  full structural activity — state+reason, branch, turns, every tool run, all
  files touched, last command, pending permission, errors, tokens. The detail
  view to list_agents' roster.

- **`pr_status`** — open PRs with each one's CI rollup (✓/✗/⏳) and review
  decision, sorted failing-first. For when several agents have PRs open. Needs
  `gh`; read-only.

- **`run_checks`** — the quality gate: auto-detects typecheck/lint/test/build
  from package.json scripts and runs them, reporting pass/fail + the tail of any
  failure. "Does the agent's work pass?" before merge.

- **`review_diff`** — show the actual code diff in a repo (uncommitted vs HEAD,
  working/staged, any ref/range, or a GitHub PR via `gh`) so LISA can review an
  agent's work before merge. Read-only, output capped.

- **`repo_digest`** — what actually changed in a repo (or every repo your agents
  touch): recent commits in a window, branch, uncommitted count + diff stat,
  ahead/behind. Answers "what did <agent> do today" with git truth (the
  orchestrator only sees structural activity). Read-only.


### Added — list_agents tool

- **`list_agents`** lets LISA enumerate the agent sessions she observes (Claude
  Code, Codex, …) with their structural activity — state, project, git branch,
  last tool/command name, files touched, pending permission, errors. Fills the
  gap where she could only give the relevance-gated `advise_now` summary or list
  her *own* dispatched agents (`signal_agent`), so "what are my agents doing?"
  is answerable in chat. Structural metadata only — never conversation content.

### Added — Lisa Island built into Lisa.app

- The notch pill is now a **feature of Lisa.app**, not a separate
  `LisaIsland.app` you launch by hand. Toggle it from the **Settings…** window
  (⌘,) → *Show Lisa Island*; the choice persists across launches (off by
  default), with a *Reset Island Position* button. The island's "open full
  chat" brings the in-process chat window forward instead of launching another
  app.
- **Standalone `LisaIsland.app` retired.** The DMG now ships only `Lisa.app`;
  the `packaging/island-mac/` package is removed (its window code lives under
  `Sources/Lisa/Island/`). Release signing/notarization and the install docs
  are updated to the single app.

### Changed — app icon

- **New Lisa.app icon**: the canonical pixel-art hoodie girl (Lisa's cyan
  hair + circuit hoodie, same character as the mascot) on a **flat solid
  background with no glow/aura** and native rounded corners — replacing the
  glowing mascot render. Generated by `scripts/generate-app-icon.ts` via
  Seedream (`SEEDREAM_API_KEY`; background and prompt overridable via
  `ICON_BG` / `ICON_BG_NAME` / `ICON_PROMPT`); `build.sh` builds the `.icns`.

### Added — login autostart

- **`lisa autostart install`** keeps the backend (`lisa serve --web`) running
  from login onward, so the Mac apps / island / channels find it already up.
  On macOS it writes a `ai.lisa.autostart` LaunchAgent with `RunAtLoad` +
  `KeepAlive` (starts at login, restarts on crash) and loads it immediately
  (`--no-load` to only write it). Flags pass through: `--port N`,
  `--channels <list>`, `--imessage`. On Linux it prints a ready-to-paste
  `systemd --user` unit (hands-off, like the heartbeat's crontab stance).
- **`lisa autostart status`** / **`lisa autostart uninstall`** to inspect and
  remove it. Logs at `~/.lisa/autostart.log`.

### Fixed

- **The entire web GUI's JavaScript was dead since v0.6.0.** The voice
  feature's transcript-framing string was written with `\n` *inside the page's
  outer template literal*, so it expanded to a raw newline inside a
  double-quoted JS string in the served HTML — a `SyntaxError` that made the
  browser discard the page's single `<script>` wholesale. Result: no chat send,
  no SSE mood/idle updates, and the Claude-Code monitor stuck at "0 / idle"
  even with active sessions. Fixed the escaping (`\\n`), and added a
  compile-only test (`html-syntax.test.ts`) that parses both inline scripts so
  this class of break can't ship again.
- **Sidebar session-count badge always blank.** It fetched `/api/sessions`,
  which didn't exist (404). Added the route (`{ sessions }` from
  `listSessionsOnDisk()`), so the footer badge shows the real count.
- **`heartbeat install --load` / `--every` threw `unknown flag`.** The arg
  parser validated unknown `--flags` globally before subcommand args were split
  out, so the heartbeat installer's own flags never reached its handler. Flags
  after a raw-args subcommand (`heartbeat`, `autostart`) are now collected
  verbatim. Shared launchd helpers extracted to `src/launchd.ts`.

## [0.7.0] — 2026-05-31

**LISA can stop the agents she starts.** Completes the orchestrator's DISPATCH
layer (O5, active control) — and fixes a v0.4.0 bug where the dispatch/advise
tools were never actually callable.

### Added — `signal_agent` tool (orchestrator O5: active control)

- **`signal_agent`** completes the dispatch loop: `action:"list"` shows the
  agents LISA launched via `dispatch_agent` that are still running (id, agent,
  pid, uptime, cwd, task); `action:"cancel"` stops one — SIGTERM to its process
  *group*, escalating to SIGKILL after a grace period (`force:true` kills
  immediately). It can only target agents LISA herself dispatched (the ledger
  holds their pids); the user's own sessions carry no pid and are unreachable.
- **Dispatch ledger** (`~/.lisa/dispatches.json`) — `dispatch_agent` now records
  each launch so it can be controlled from a later turn or after a restart
  (detached agents outlive the spawning turn's handle). Dead pids are pruned on
  read.

### Fixed

- **`advise_now` and `dispatch_agent` were never registered.** Both were
  imported into the tool registry but never added to the tool array (and
  `tsconfig` has no `noUnusedLocals` to catch it), so the model could not call
  either one — `dispatch_agent` shipped dead in v0.4.0. Both are now wired up,
  with a registry regression test asserting all three orchestration tools are
  present.

## [0.6.1] — 2026-05-31

**Release hardening — fully notarized + stapled Mac apps.** No app/runtime
changes; this is a packaging fix.

### Fixed — DMG signing pipeline

- The signed-DMG flow now notarizes and **staples the `.app` bundles before**
  they are assembled into the DMG, so `Lisa.app` / `LisaIsland.app` carry their
  own stapled notarization ticket and pass `xcrun stapler validate` even fully
  offline. Previously only the DMG was stapled; the contained apps were
  Gatekeeper-accepted online but not individually stapled (the old step stapled
  a runner-side copy that never made it into the DMG).
- `scripts/build-mac-apps.sh` split into `apps` / `dmg` / `full` phases so CI can
  notarize the apps between build and DMG assembly. `full` (default) keeps the
  one-command local dev path unchanged. The `dmg` phase never re-signs the apps
  (which would strip the staple); `cp -R` preserves the ticket.

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
