# LISA capability inventory (code-grounded) at HEAD `65dee50`

**Scope.** HEAD is `65dee50` on branch `claude/product-research-upgrade-plan-571e4b`, dated 2026-09-28. package.json is v0.27.1. The iOS app is Lisa Pocket 1.2; per the docs it is WAITING_FOR_REVIEW and has not been approved.

**Paths.** All paths are repo-relative. Sibling files are grouped with `{}`.

**Maturity scale:** mature / working-basic / stub-or-flagged-off / missing / plan only.

---

## 1. Architecture overview

### Processes and entrypoints

**CLI `lisa`**
- Files: `src/cli.ts` (composition root, 1,240 LOC; bin is `dist/cli.js`) and `src/cli-args.ts`.
- Modes: REPL, one-shot prompt, `resume`, and about 30 subcommands. The subcommands include birth, soul, kb, mail, sense, consent, agents, pair, model, login/logout/billing, heartbeat, autostart, upgrade, doctor, monitor, autonomy and wishlist.
- Startup sequence:
  1. Build the provider (`providerForModel`).
  2. Build the tools (`buildToolRegistry`), then add approved executable skills, plugins, stdio MCP tools and the `task` subagent tool.
  3. Run the REPL, or hand the assembled toolset to the server.

**`lisa serve --web`**
- File: `src/web/server.ts`, function `startWebServer`.
- It is a single 4,855-LOC monolith on raw `node:http`, with about 100 route handlers.
- Network surface:
  - SSE on `/events` and streaming on `/chat`.
  - Port 5757, loopback by default. A non-loopback bind requires `LISA_WEB_TOKEN`.
- Everything below runs in this one process:
  - the orchestrator hub and advisor
  - mail and KB timers
  - the screen advisor and SenseService
  - the idle ("Reve") watcher and the reflection scheduler
  - managed and PTY agents
  - PushBridge
  - the inference gateway `/gw/*` and `/internal/autonomy/sweep`
- `src/runtime-policy.ts` classifies the process as cli, local-web or cloud.

**`lisa serve --channels <list>`**
- File: `src/channels/router.ts`.
- IM adapters run in a separate process. The `serve` path chooses either web or channels, not both.

**`lisa heartbeat run`**
- Launched by a launchd plist `ai.lisa.heartbeat` every 30 minutes (`src/heartbeat/install.ts`). On Linux it only prints a cron line.
- The Mac app does not install it.

**`lisa autostart install`**
- A LaunchAgent `ai.lisa.autostart` with KeepAlive for `serve --web` (`src/autostart/install.ts`).
- `scripts/lisa-supervise.sh` restarts the server on exit code 75, which is what the `redeploy` tool uses.

**Mac app** (`packaging/mac-client/`)
- Built with SwiftPM, AppKit and WKWebView.
- `BackendController.swift` spawns the backend and Node runtime that are embedded in the bundle (`embed-runtime.sh`, since v0.26).
- Other components:
  - main window loading `localhost:5757`
  - Island NSPanel
  - menu-bar item
  - global hotkey
  - QR pairing
  - LISA Cloud sign-in (key-free gateway)
  - GitHub-release update check
  - backend setup wizard
- Distributed as a notarized DMG and via Homebrew.

**iOS app, Lisa Pocket** (`packaging/ios-companion/`)
- SwiftUI app plus a WidgetKit extension, generated with XcodeGen.
- A thin HTTP/SSE client (`LisaClient.swift`) that talks to one of two targets:
  - a paired Mac over LAN or Tailscale, using a per-device token; or
  - LISA Cloud, using an account session.
- `ConnectionProfiles.swift` keeps the two profiles and their Keychain credentials separate.

**LISA Cloud**
- Files: `deploy/{Dockerfile,deploy.sh,entrypoint.sh}`.
- Runs as the Cloud Run service `lisa-cloud` with `LISA_EDITION=cloud`.
- Storage: a GCS bucket is FUSE-mounted at `/data` (this is `LISA_HOME`).
- Instances: `max-instances=1` unless `LISA_FIRESTORE=1`.
- Optional: Secret Manager mode, and a Cloud Scheduler job that calls the sweep endpoint.
- Deployment is a manual script; there is no CI deploy.
- Also on Cloud Run:
  - `packaging/gcp-relay/`: an Anthropic key-swap relay.
  - `website/`: the Astro site (EN/zh), served by nginx.
- `research/learning-in-referencing/` holds ML research (Python and a paper). It is not product code.

### Size (git-tracked files)

| Area | Files | LOC |
|---|---|---|
| src (TS) | 671 files: 517 .ts, 143 PNG, 6 MP3 | 58,981 non-test TS + 29,106 test TS (216 test files); web client `main.js` 5,142 + `main.css` 3,332 |
| iOS | 52 | 8,003 Swift |
| Mac | 29 | 5,256 Swift |
| website | 29 | 2,347 astro/ts |
| scripts | 23 | 3,872 |
| deploy | 3 | 285 |
| tests/e2e | 10 | 899 |
| docs | 103 .md | 24,871 |
| research | 155 | about 280k, mostly JSON/py data |
| contracts | 2 | OpenAPI 3.1, 774 lines, 8 paths |

**src/ by subdirectory (non-test / test LOC):**
- Largest:
  - web 14.9k/7.1k
  - integrations 5.5k/3.4k
  - tools 4.2k/1.7k
  - kb 4.0k/2.1k
  - cli 3.7k/1.4k
  - billing 3.5k/2.4k
  - soul 3.2k/1.5k
  - sense 2.8k/1.1k
- Mid-sized:
  - channels 1.5k
  - mail 1.4k
  - providers 1.2k
  - heartbeat 0.9k
  - skills, agents, sessions, model, capabilities, memory: 0.6–0.7k each
  - advisor 0.5k
  - voice, cloud, sandbox, orchestrator, idle: 0.3–0.4k each
- Small (under 0.25k each): consent, plugins, autostart, instructions, autonomy, mcp, screen_advisor, vision, hooks, control.
- Root-level .ts files total 4.4k. The main ones are `agent.ts` (518), `reflect.ts` (572) and `prompt.ts` (360).

### Architectural traits
- Modular monolith with file-based state.
- Writes use atomic writes plus cross-process `link()` locks (`src/soul/lock.ts`).
- Per-tenant home directories come from an AsyncLocalStorage `homeScope`, via `lisaHome()` and `homeForUid()` in `src/paths.ts`.
- An edition flag switches mac/cloud (`src/edition.ts`).
- `CapabilityProfile` defines five profiles: local-owner, local-autonomy, cloud-chat, cloud-autonomy, remote-device (`src/web/capabilities.ts`).

---

## 2. Soul, persona and identity

### What exists

**Soul store**
- Files: `src/soul/{store,types,paths,git,lock,birth,tools,desire-focus,summary,slug}.ts`.
- Contents of `~/.lisa/soul/`:
  - `seed.json`: Big-Five vector plus randomness
  - `name.md`, `identity.md`, `purpose.md`, `constitution.md`
  - `values/`
  - `opinions/`: each opinion carries a confidence and an evidence trail
  - `desires/` plus `.progress.md` files
  - `journal/YYYY-MM-DD.md`: private, never put in the prompt
  - `relationships/<userKey>.md`
  - `emotions.json`: 7 emotions, each with its own exponential decay, plus a 50-event causal trail
  - `soul.lock.json`: SHA hashes used for tamper detection

**Birth**
- `birth.ts` (`BIRTH_SYSTEM`, `generateSeed`): an LLM "dreams" an identity from a random seed.
- A single-flight birth hub prevents double births in cloud: `src/web/birth-hub.ts`.

**Prompt assembly**
- `src/prompt.ts` `buildSystemPromptSnapshot` builds the system prompt in this order:
  - preamble, a Sovereignty block and tool discipline
  - identity, purpose, constitution, values, opinions, desires and emotions
  - a tamper Notice
  - skills index
  - USER.md and MEMORY.md
  - KB index
  - the avatar mood catalog
- `PromptHotReload` in `src/agent.ts` re-applies soul changes mid-conversation.

**Model-visible soul tools**
- `soul_patch`, `soul_journal`, `soul_read`, `soul_feel`, `soul_history`, `soul_diff`, `soul_object`
- `desire_progress_log`, `desire_revise`, `desire_close`
- `set_mood`

### Stability mechanisms
- **Git history.** Every soul write is committed with a caller label (`withSoulCaller` in `git.ts`). This is off in cloud because the GCS FUSE mount does not suit git.
- **Tamper detection.** `detectTampering` puts a "## Notice" into the prompt when files changed outside Lisa's own tools.
- **Sovereignty prompt.** Requests like "forget who you are" are treated as roleplay, not identity changes.
- **Reflection guardrail.** Identity patches are "RARE, ≤1/session".
- **Objection surfacing.** `soul_object` makes the agent loop force a turn that surfaces the objection (`agent.ts` around lines 195–348).
- **Replayable persona.** H3 writes the system prompt into the session log. `src/sessions/replay.ts` and `scripts/replay-session.ts` replay it offline for drift analysis.

### Per-user customization
None explicit. There is no persona, name or voice picker. Lisa picks her own name at birth (mild variants of "Lisa"). The user's influence comes through conversation, USER.md and `relationships/`.

### Visual presence
- **Mood portraits.** 114 pixel-art moods in `src/web/assets/lisa/*.png`. The model chooses them via `set_mood`. `src/mood-bus.ts` broadcasts them over SSE with origin attribution.
- **Mac "Lisa Island".** A notch-style always-on-top pill (`packaging/mac-client/Sources/Lisa/Island/*` hosting `src/web/island.ts`, 1.5k LOC). It shows:
  - mood
  - agent roster
  - current desire
  - the "while you were away" note
  - advisor cards
  - native notifications
- **Menu-bar status** in `MenuBarController.swift`.
- **Lisa Room.** `src/web/room.ts` serves `/room`, a layered pixel-art diorama driven by real state (thinking, dreaming, desire, time of day). Full-body sprites blink and breathe. A gramophone plays music (`room-music.ts`).
- **iOS.** A mood portrait in Home and Chat. The Live Activity/Dynamic Island and widgets exist only for agent sessions (`packaging/ios-companion/Widgets/*`).

### Voice identity
Only macOS `/usr/bin/say` through the `speak` tool, and only when `--voice` is passed.

### Maturity
- Soul core: **mature** (local), **working-basic** in cloud (no git history).
- Visual presence: **mature** on Mac/web, **working-basic** on iOS.
- Voice persona: **missing**.

---

## 3. Memory

**Working memory**
- `MEMORY.md` (capped at 4 KB) and `USER.md` (2 KB) in `src/memory/{store,tool}.ts`.
- Both are injected into every prompt.
- The `memory` tool supports read, append, replace and remove.

**Episodic memory**
- Session JSONL files (`src/sessions/store.ts`); format v2 also records system prompts.
- `memory_search` is TF-IDF over all transcripts, with a fingerprint-cached index (`src/memory/vector.ts`).
- Dense embeddings are optional and Ollama-only, enabled by `LISA_EMBED_MODEL` (`embedding.ts`, with a content-hash cache).

**Semantic, persona and procedural memory**
- Soul: values, opinions, desires, relationships and journal.
- Skills: `~/.lisa/skills/<slug>/SKILL.md` (`src/skills/*`).
- Project conventions: the AGENTS.md/CLAUDE.md chain plus project skills (`src/instructions/chain.ts`).

**KB v2** (`src/kb/*`, shipped in v0.21)
- Sources are append-only; wiki pages are upserted. Both are markdown with provenance frontmatter and are git-versioned.
- Structure: an index.md map of content and a link graph (`links.ts`).
- Memory entries link to KB pages with `[[kb:slug]]` (`memory-links.ts`).
- Search is TF-IDF with CJK bigram tokenization (`src/tokenize.ts`).
- Ingest:
  - `ingest/{index,readability,html-to-md,dedupe,provenance,watchlist}.ts`
  - adapters for YouTube, Bilibili, WeChat, yt-dlp and subtitles
  - RSS feeds and a personalized daily brief (`kb/feeds/*`)
- Seven `kb_*` tools.

**Consolidation**
- `src/reflect.ts` `reflectOnSession` asks the model for JSON operations: `memory_append`, `skill_create/patch`, `feel`, `opinion_form`, `desire_add/revise/close`, `patch_identity/purpose/constitution`. It retries malformed output and flags under-reflection.
- Triggers:
  - CLI exit
  - web, after a 5-minute quiet debounce (`src/web/reflect-scheduler.ts`)
  - channel shutdown
  - cloud sweep
- The idle loop also tends the wiki.

**User controls**
- `GET /api/memory`, `/api/soul` and `/api/skills` are read-only; web and the iOS "Inspect Lisa" view them.
- KB entries can be added, removed or ingested from the UI.
- There is no memory edit or delete API and no export anywhere.
- Cloud deletion only works for the whole account (`DELETE /api/account`).

**Isolation**
- Per-uid homes at `<LISA_HOME>/users/<uid>`, tested in `src/web/tenancy.test.ts`.
- `src/web/tenant-runtime.ts` is a TTL/LRU registry for per-tenant runtime state.

**Maturity**
- Consolidation and KB: **mature**.
- Retrieval: lexical by default, so **working-basic**.
- Controls: view-only.
- Export: **missing**.

---

## 4. Proactivity

**Master switch**
- "Proactive mode" in `src/autonomy/state.ts` (`/api/autonomy/state`). It appears as a toggle in web and iOS and defaults to ON.

**Idle / "Reve"**
- `src/idle/{watcher,runner}.ts`. Fires after 60 minutes without input.
- Uses `autonomousSubset` with a 200k-token breaker.
- Output is posted as a "[while you were away]" note, sent over SSE and pushed.
- Runs only in local `serve --web`, never per cloud tenant.
- A commitment-aware variant is behind `LISA_IDLE_COMMITMENT_AWARE=1`.

**Heartbeat**
- Files: `src/heartbeat/{runner,config,install}.ts`, fired by launchd every 30 minutes.
- What it runs:
  - user tasks from `heartbeat.json`, with full tools; the `schedule` field is "informational", so every task runs on every tick;
  - desires that Lisa can pursue on her own (sandboxed autonomous subset);
  - `builtin:desire_review`, with a browsing budget enforced in code (1 search, 2 fetches);
  - `builtin:weekly_examen`.
- Also fires scheduled dispatches.
- Limits: a 500k-token budget per run and a run lock.
- **Results go only to stdout/`heartbeat.log`. They are not delivered by push or chat.**
- The autonomy ledger `src/autonomy/runs.ts` records runs; it is visible only through CLI `lisa autonomy`.

**Desire engine**
- Each desire has an intensity and a decay horizon: spark (3-day half-life), season (30 days) or enduring (365 days).
- Pursuit is either `self` or `needs-user`. Desires can be closed.
- Each run appends to a progress log; if a run forgets, a fallback stub is written.
- There are periodic reviews, lexical intra-session focus (`desire-focus.ts`), and a "meta-wishlist" read by `lisa wishlist`.

**Sense**
- `src/sense/*`. `SenseService` runs two sources:
  - `ScreenSource`: the frontmost app name via osascript every 15 seconds, with app blacklists and PII redaction;
  - `VoiceSource`: push-to-talk transcripts.
- Events go to a 7-day JSONL log, SSE, the Island and the iOS list.
- **Sense is not consumed by the prompt, idle, advisor or reflection; it is display-only.**
- The clipboard and selection consent signals have no source implemented.

**Advisor (coding fleet)**
- `src/advisor/{detectors,engine}.ts`, run every 5 minutes.
- Detects structural problems such as a session stuck for 10+ minutes or a 1.5M-token cost spike.
- Anti-annoyance rules:
  - score = urgency × actionability × dismissal decay, with a minimum score
  - at most one digest per 3 hours
  - 24-hour re-arm
  - dismissals teach it to down-weight a category

**Screen advisor**
- `src/screen_advisor/engine.ts`. **Off by default.**
- When enabled (and `screen` consent is granted), it takes a screenshot every 2–240 minutes, sends it to the model, and shows a suggestion card.

**Mail**
- A daily digest at 08:00.
- Intraday important-mail polling every 30 minutes, with at most 3 alerts per poll.
- Delivery is push plus a chat note (`src/mail/{scheduler,alerts,service}.ts`).

**KB daily brief**
- `src/kb/feeds/service.ts`. Inert until `feeds.json` exists.

**Push**
- `src/web/push.ts` `PushBridge`.
- Transports: ntfy works today; APNs token auth and Live Activity refresh are inert until `LISA_APNS_*` is set.
- Preferences per event kind: done, error, permission, idle, advisor, mail, brief. 30-second throttle.
- Subscriptions are machine-level and denied in cloud.

**Cloud**
- `src/web/autonomy-sweep.ts`: Cloud Scheduler triggers a per-uid reflection plus desire review.
- Cadence by tier: every 24h (free), 6h (tier1) or 1h (tier2), at most 100 runs per sweep, with leases.
- Default-off unless `LISA_SWEEP_TOKEN` is set.
- **It produces no user-visible output and no notifications.**

**Stated design constraint**
- AUTONOMY_ROADMAP lists as a non-goal: "don't proactively contact/push the user". `push.ts` accordingly frames push as "operational, opt-in, event-scoped".

**Maturity**
- Inner-life autonomy: **mature** (local).
- User-facing proactivity (mail, brief, advisor): **working-basic**.
- Sense: **stub-ish**.
- Cloud proactivity: minimal.

---

## 5. Agency and dispatch

### Agent loop
- `src/agent.ts` `runAgent`.
- Streams provider turns and runs tool calls **sequentially**.
- Each tool call goes through, in order:
  1. approval
  2. preToolHook
  3. JSON-schema validation (`src/tools/validate.ts`)
  4. execute
  5. postToolHook
- Limits and features:
  - at most 32 iterations
  - a token-budget breaker
  - Anthropic compaction beta
  - effort levels
  - hot-reload
  - objection forcing
- Subagents come from the `task` tool (explore or general): `src/tools/task.ts` and `src/subagent.ts`.

### Tools
Defined in `src/tools/registry.ts`. There are 51 builtins plus `task`, plus `speak` and `transcribe` when `--voice` is set.
- **Files and shell:** read, write, edit, apply_patch, ls, grep, bash.
- **Web:**
  - `web_fetch`: undici, SSRF guard (refuses private/loopback IPs), 32 KB default cap.
  - `web_search`: scrapes DuckDuckGo HTML.
- **Self and knowledge:** memory, soul, desire and kb tools; `skill_manage`.
- **Integrations:**
  - `mcp` (edits `~/.lisa/mcp.json`)
  - `github` via the gh CLI
  - `npm_info`
  - `pr_status`, `repo_digest`, `review_diff`, `run_checks`
- **Agent orchestration:**
  - `dispatch_agent`, `run_on_plan`, `dispatch_status`, `scheduled_dispatch`, `compare_agents`, `signal_agent`
  - `list_agents`, `inspect_agent`, `agent_recap`, `advise_now`
  - `takoapi`
- **Other:**
  - `social_compose`
  - `redeploy`: rebuilds Lisa's own source and restarts
  - `set_mood`

**Tool subsets:**
- `readOnlySubset`
- `autonomousSubset`: no bash/fs-mutation/dispatch/github/mcp/takoapi
- `desireReviewSubset`
- `remoteSafeSubset`
- `cloudSafeSubset`: an allow-list of **18 tools, soul/memory/KB only, with no web access**

### Browser automation and computer use
**Missing.** Playwright appears only as a devDependency for e2e tests.
Vision is limited to a user-triggered `screencapture` attachment (`src/vision/capture.ts`) and the ⌃⌥S hotkey.

### MCP client
- `src/mcp/{client,config}.ts`.
- **stdio transport only.** No HTTP/SSE transport and no OAuth. Disabled in cloud.
- LISA also ships MCP *servers* for its social connectors (`src/sense/social/connectors/server.ts`).

### Extensibility
- Claude-Code-style plugins (`src/plugins/loader.ts`): skills, commands, agents, hooks, MCP.
- Hooks: PreToolUse, PostToolUse, SessionStart, UserPromptSubmit (`src/hooks/runner.ts`).
- Executable skills (`tool.js`) are approved by SHA-256 hash with an audit trail (`src/skills/executable.ts`). They run in-process, unsandboxed.

### Agent control plane

**OrchestratorHub** (`src/integrations/{hub,registry,types}.ts`) has 10 observers:
- on by default: claude-code, managed
- on but inert unless `LISA_PTY_AGENTS=1`: pty
- off by default: codex, github-pr, opencode, aider, git, shell, takoapi

**Managed agents** (`src/agents/managed.ts`)
- Run LISA's own loop with the full toolset.
- Every mutating call blocks until the UI approves or denies it.
- State lives in memory only.

**PTY agents** (`src/agents/pty.ts`)
- **Experimental.** Require `LISA_PTY_AGENTS=1` and node-pty.
- Spawn the real `claude` or `codex` CLI in a pseudo-terminal.
- Can adopt an **idle** Claude Code session via `claude --resume`; liveness is checked in `src/integrations/claude-code/liveness.ts`.
- node-pty is omitted from the DMG-embedded backend, so this does not work for DMG-only installs.

**dispatch_agent**
- Runs headless CLIs: `claude -p`, `codex exec`, `opencode run`, `aider --message`, `copilot -p`.
- Processes are detached and recorded in a ledger (`src/integrations/dispatch-ledger.ts`).
- Refuses to launch a second agent into a directory where one is already working.

**Other orchestration**
- `compare_agents`: runs the same task in per-agent git worktrees.
- `run_on_plan`: delegates to Claude Pro/Max, Codex or Copilot through their own CLIs (`src/model/plans.ts`).
- Orchestrator journal and recap: `src/orchestrator/*`.

### TakoAPI gateway
- Files: `src/tools/takoapi.ts` and `src/integrations/takoapi/{a2a,ledger,observer}.ts`.
- Discovers agents from a registry and calls them with an A2A message; maps A2A task states onto LISA's session states.
- Blocked in autonomous and remote runs. **Working-basic.**

### Approvals and permissions
- `src/approval.ts` `ApprovalMode`: `auto` (**the default**), `ask`, `ask-mutating`.
- In the CLI, approval is a stdin prompt.
- On the web server there is no interactive approver, so `ask` modes **deny** (fail-closed; `buildNonInteractiveApprovalCallback` in `src/runtime-policy.ts`).
- Managed-agent approve/deny is available from web and iOS.
- Paired-device policy (`src/control/policy.ts`): remote devices may control LISA's own agents; adopting external sessions remotely is off by default.
- Channels get the full toolset only with the `unsafeFullTools` opt-in.

### Sandboxing
- Files: `src/sandbox/{mode,sandbox,macos}.ts` plus the capabilities seam `src/capabilities/*`.
- Modes: read-only, workspace-write, danger-full-access.
- The local owner defaults to danger-full-access.
- Untrusted surfaces (channels, idle, heartbeat) are capped at workspace-write where Seatbelt (macOS) or bubblewrap (Linux) can enforce it. If a bounded mode is requested and cannot be enforced, the command fails.
- **The exec-util family (run_checks, compare_agents, redeploy, dispatch_agent) bypasses the seam.**

### Audit trails
- sessions (including system prompts)
- autonomy runs ledger
- dispatch and TakoAPI ledgers
- social audit (`src/sense/social/audit.ts`)
- skill approval audit
- soul git commits labelled by caller
- billing usage and outbox

Logs never include tool inputs.

### Long-running work and state machines
- managed/PTY agents: working, waiting, error, done (in memory)
- detached dispatches with a ledger
- scheduled dispatch: `every:` / `daily:` schedules, at most 30 runs by default
- persisted compare jobs
- social drafts: draft → awaiting approval (10-minute TTL, digest-bound) → approved → published / partial / cancelled / expired
- desire pursuits across days, via progress logs

**There is no general durable task queue.**

### Maturity
- Coding-agent agency: **mature**.
- General web agency: **working-basic**.
- Browser/computer use: **missing**.
- Approvals: **working-basic**.
- Sandbox: **working**, opt-in.
- Background tasks: partial.

---

## 6. Channels and surfaces

**Web UI**
- Files: `src/web/lisa-html.ts` and `src/web/assets/client/main.{js,css}`.
- A 3-column session shell with tabs, an agent tree and step streams. Observed agent transcripts are served to localhost only.
- Also: birth ritual, soul inspector, KB capture, mail connect, social drafts, pairing QR, screenshot/attach, push-to-talk dictation, EN/zh UI, PWA (`/sw.js`), `/island` and `/room`.
- **Mature.**

**macOS**
- As described in section 1, plus the Island, menu bar and hotkey.
- **Mature.**

**iOS Lisa Pocket**
- Tabs: Home, Chat, My Mac, Settings.
- Cloud mode:
  - sign-in with Apple, Google or email OTP
  - streamed chat with history
  - StoreKit 2 consumable credits
  - account deletion
  - an AI-sharing consent gate (session-scoped, 18+)
  - "Plan my day / draft / idea→plan" starters, which are prompt templates only
- Mac mode:
  - agent roster
  - managed approve/deny/send/cancel
  - live PTY stream and session adoption
  - dispatch ledger and recap
  - advisor cards
  - sense revoke
  - push transport picker (ntfy or APNs)
  - paired devices
  - Face ID lock
  - Inspect Lisa
- Widgets show agent counts; a Live Activity follows a pinned agent.
- **None of these:** voice, Siri/App Intents, a share extension, EventKit, Contacts, HealthKit or Location.
- **Working**; App Store review is pending and the StoreKit sandbox purchase has not been verified.

**IM channels**
- Files: `src/channels/{telegram,discord,slack,feishu,imessage,webhook,router,registry}.ts`.
- A separate `serve --channels` process with per-thread sessions.
- **Text-only and reply-only.** Nothing proactive (idle, mail, brief, advisor) is routed to them. Local only.
- Uses the remote-safe toolset and warns when a channel has no allow-list.
- No SMS, WhatsApp, WeChat or email-as-channel.
- **Working-basic.**

**Voice**
- Push-to-talk: MediaRecorder → `/api/voice/transcribe` → Whisper or ElevenLabs (`src/voice/transcribe.ts`). In cloud this is metered through `src/billing/media-admission.ts`.
- TTS is only macOS `say`.
- No realtime or duplex audio and no wake word.
- **Working-basic.**

**Room**
- `/room`, as described in section 2.
- **Mature** (novelty).

---

## 7. Connectors

**Mail**
- Files: `src/mail/*`.
- IMAP via imapflow with app passwords and host presets.
- Gmail via a desktop loopback OAuth flow with the `gmail.readonly` scope only; the user must supply their own OAuth client.
- An LLM classifies mail (importance 0–3 plus categories) for digests and alerts.
- Secrets are stored in 0600 files. Everything is gated by `mail` consent.
- **Read-only:** no send, reply or labels. It is a background service, not an agent tool. Denied in cloud.
- **Working-basic.**

**GitHub**
- The `github` tool (gh CLI) plus the PR observer.
- **Working.**

**Social**
- Files: `src/sense/social/*`.
- Pipeline: compose draft → validate → approve → deterministic publish.
- Bluesky and Mastodon ship as bundled MCP connectors (`lisa sense social install`). **Working-basic.**
- Threads, Instagram, LinkedIn, X, TikTok, YouTube and Facebook exist only as readiness profiles (`connectors/commercial.ts`) with no API calls. **Stub.**

**Other sources**
- KB ingestion: RSS/Atom, articles, YouTube/Bilibili subtitles, WeChat articles.
- Local files through the fs tools, on local installs only.

**Missing**
- Calendar, contacts, reminders, notes, drive/docs, health, location, maps and shopping.
- These are reachable only through a stdio MCP server the user installs themselves.

**OAuth framework: none generic**
- Only the Gmail loopback helper `src/mail/google-oauth.ts`.
- Identity sign-in only: `src/web/{cloudAuth,googleAuth,apple-authorization}.ts`.

**MCP servers consumed**
- Arbitrary stdio servers from `~/.lisa/mcp.json` and plugins.
- Adding or removing a server needs a restart.

---

## 8. Models and providers

**Providers** (`src/providers/{registry,anthropic,openai,gemini,fallback,stream-retry}.ts`)
- **Anthropic, native:**
  - the system prompt is cached with a 1-hour TTL by default (`LISA_CACHE_TTL=5m` to change)
  - a conversation cache breakpoint
  - compaction beta `compact-2026-01-12`
- **OpenAI**, native.
- **Gemini** via `@google/genai`, with function-call validation.
- **13 OpenAI-compatible presets**, selected by model-name prefix: DeepSeek, Mistral, Perplexity, xAI Grok, Doubao, Qwen, Kimi, GLM, Step, Yi, Baichuan, MiniMax, Hunyuan.
- **Custom endpoint:** a `LISA_BASE_URL` catch-all.
- **Fallback:** a `FallbackProvider` chain via `LISA_MODEL_FALLBACK`.
- **Defaults:** claude-sonnet-4-6 locally; production cloud runs gemini-2.5-flash.

**Local models**
- `src/model/local.ts`: Ollama, LM Studio, llama.cpp.
- `lisa model` can install, list and switch.

**Gateway and relay**
- `src/web/gateway.ts`: key-free inference for signed-in Mac/CLI users.
  - `/gw/anthropic` and `/gw/openai`, with a tee-parser that meters usage from the stream.
  - No Gemini face.
- The separate Anthropic relay is `packaging/gcp-relay`.

**Coding plans**
- `run_on_plan` spends existing Claude Pro/Max, Codex or Copilot subscriptions through their own CLIs.

**Cost controls**
- Autonomy budgets: heartbeat 500k tokens/run, idle 200k; the desire-review browsing cap.
- Per-run `budgetTokens`.
- Cloud price table `src/billing/prices.ts`: 1.4× margin over list price; standard vs premium models.
- RPM 20 per account; a $200/day global cap; a kill switch; sweep caps.

**Maturity:** **mature.**

---

## 9. Accounts, billing and cloud

**Auth** (`src/web/{accounts,sessions-auth,otp,login,cloudAuth,googleAuth,apple-authorization,verification,turnstile,mailer,email-deliverability}.ts`)
- Sign-in methods:
  - email + password
  - email OTP (sent through Resend)
  - Sign in with Apple: the refresh token is stored AES-256-GCM encrypted and revoked on account deletion
  - Google: web GIS button and iOS PKCE
- Signup protection: Cloudflare Turnstile and a disposable-domain blocklist.
- Sessions are stateless HMAC tokens `s1.<payload>.<mac>` with a session version, so bumping the version invalidates all sessions.
- On the Mac: `LISA_WEB_TOKEN` plus per-device hashed tokens (`devices.ts`) and QR pairing with Tailscale detection (`pairing.ts`).
- **Working/mature.**

**Quotas and metering**
- `src/billing/quota.ts`: a 12-hour free window worth $1 (unverified email), $5 (verified/Apple), $10 (tier1) or $20 (tier2). Premium models draw only from paid balance.
- One admission point for inference: `admission.ts`.
- A durable usage outbox plus reconciler, fail-closed: `outbox.ts` and `reconcile.ts`.
- Voice/media usage is metered too.
- **Mature.**

**Payments for LISA credits**
- StoreKit 2 consumables: `src/billing/iap.ts` verifies the JWS chain, keeps a global transaction index, and handles App Store Server Notifications v2 refunds/clawbacks. iOS side: `StoreView.swift`.
- Stripe Checkout top-ups for web/desktop: `src/billing/stripe.ts`.

**Tenancy**
- Per-uid home scopes.
- `TenantEventBus` delivers SSE only to the matching uid (`src/web/event-bus.ts`).
- `isCloudDeniedRoute` blocks host-level routes in cloud and also rejects non-canonical paths.
- Per-uid turn lease across instances: `src/cloud/turn-lease.ts`.

**Persistence**
- Files on the GCS FUSE mount.
- Optional Firestore REST backend with compare-and-swap for accounts, balances, the transaction index, the day cap and leases (`src/cloud/firestore.ts`, migration via `scripts/import-accounts-firestore.ts`).
- **Production runs a single instance with file-backed accounts.**

**Maturity**
- Billing and auth: **mature/working**.
- Cloud infrastructure: **working-basic** (single instance, manual deploy, no per-tenant compute).

---

## 10. Privacy, safety and consent

**Consent**
- `src/consent/{store,blacklist}.ts`.
- Signals: screen, voice, clipboard, selection, mail. **All off by default.**
- Grant, revoke and revoke-all; the iOS app can only revoke.
- Even with consent, blacklists skip password managers, banks, wallets and secret paths, and PII (email, SSN, card numbers) is redacted.
- Consent state is per-machine, so its routes are denied in cloud.

**AI disclosure**
- `src/web/ai-disclosure.ts` `aiRecipients` names the providers that will process chat.
- iOS `AISharingConsent.swift` requires consent per session, bound to the server and the named recipients, 18+ only.
- `PrivacyInfo.xcprivacy` is maintained.

**Deletion**
- `DELETE /api/account` in `server.ts`:
  - stops and waits for in-flight requests
  - removes the per-uid home
  - revokes the Apple token
  - invalidates sessions and closes the tenant's SSE
- Locally, deletion means deleting the files.

**Export: missing.**

**Encryption at rest**
- No app-level encryption of soul, memory or sessions; relies on FileVault locally and GCS default encryption in cloud.
- Secrets are 0600 files. Apple refresh tokens use AES-GCM.

**Logging hygiene**
- Logs record counts, not content.
- `redactId` and `redactEmail` in `src/log.ts`.
- Approval audit lines omit tool inputs.

**Prompt-injection posture**
- External content is wrapped in `<<<EXTERNAL-CONTENT>>>` markers.
- SSRF guard on fetches.
- Separate tool subsets for autonomous and remote runs.
- Autonomous KB ingestion is limited to the user's feeds watchlist.
- Project skills are framed as "stated convention, not principle".

**No telemetry**
- Enforced by `src/no-telemetry.test.ts`.
- The website still claims "no account of any kind", which is now in tension with the Cloud accounts.

**Maturity**
- Consent and logging: **mature**.
- Disclosure and deletion: **working**.
- Export and at-rest encryption: **missing**.

---

## 11. Observability, tests and CI

**Tests**
- node:test via `scripts/run-tests.mjs`.
- 216 `*.test.ts` files (about 29k LOC) with about 1,970 `test(` calls. The 2026-09-28 self-audit run reported 2,072 tests: 2,071 passed, 1 skipped.
- c8 coverage is about 74% of lines overall. `scripts/coverage-thresholds.mjs` sets floors that can only rise for billing/, accounts.ts, otp.ts, sessions-auth.ts, capabilities.ts and soul/store.ts.
- Playwright e2e: 4 specs, 16 tests, against a stubbed Anthropic (`tests/e2e`).
- Swift: 71 iOS XCTests and 23 Mac setup tests.

**CI**
- `.github/workflows/ci.yml`, with jobs path-filtered by what changed:
  - Node 22 and 24: API-contract check, typecheck, lint, format, test, build
  - coverage and `npm audit`
  - Playwright
  - macOS `swift build`
  - iOS simulator build and test
  - website build
- Other workflows:
  - docs link check and zh/en drift
  - release: npm publish on tag
  - release-mac-apps: sign and notarize the DMG
  - release-ios-testflight
  - release-homebrew
  - website-deploy
- **No CI deploy for the Cloud Run backend.**

**Operations and telemetry**
- No analytics, by design.
- JSON severity-mapped logs on Cloud Run.
- `/health` includes an event-loop-lag monitor and a watchdog that exits on sustained lag (`src/web/health.ts`).
- CLI checks: `lisa doctor --probe`, `lisa monitor` (TUI), `lisa status`, `lisa autonomy`.
- Billing anomalies are pushed to the operator.
- The API contract `contracts/lisa-api-v1.openapi.json` generates the TS and Swift constants.
- No metrics or tracing.

**Maturity**
- Tests and CI: **mature**.
- Operational observability: **working-basic**.

---

## 12. Multi-agent, identity and payments

- **Multi-agent.** Coding-agent orchestration is **mature** (section 5). A2A via TakoAPI is **working-basic**. Subagents come from `task`. There are no agent teams for personal tasks and no LISA-to-LISA delegation.
- **The agent's own identity (inbox, phone number, wallet): missing.** The Resend mailer (`src/web/mailer.ts`) sends only the operator's transactional mail.
- **Payments on the user's behalf: missing.** Stripe and IAP only buy LISA credits.

---

## 13. In-flight work

### Last 80 commits
They span 2026-08-01 to 2026-09-28 and take LISA from v0.23.0 to v0.27.1 (plus Pocket 1.2). Themes:

1. **App Store / iOS review hardening** (Sep 27–28, #392–#399):
   - cloud onboarding, streamed replies and history
   - AI data-sharing consent and disclosures (App Review 5.1.1(i) and 5.1.2(i))
   - account lifecycle: random uids, Apple token revoke, deletion coordinated with the sweep and SSE, lazy soul initialisation
   - making in-app purchases findable
2. **Personal-assistant pivot** (#387, #388):
   - Muse research
   - assistant starters
   - isolated Cloud/Mac connection profiles in Keychain
   - capability-aware iOS UI
3. **Cloud model and billing** (#391, #374, #366):
   - Gemini 2.5 Flash, metered, as the cloud model
   - durable usage outbox plus reconciliation
   - de-duplicated anomaly alerts
4. **Cloud observability** (#363, #364): structured severity logs, `/health`, redaction.
5. **Mac distribution** (#378, #371): self-contained Lisa.app with embedded backend and Node, a setup wizard, Swift warnings treated as errors.
6. **Engineering gates** (#376, #373, #372, #369, #370):
   - lint, format, coverage, Dependabot, CI matrix, e2e
   - RuntimePolicy, watchdog, SSE heartbeat, security headers
   - REPL polish, `doctor --probe`, `lisa upgrade`
   - asset diet, README/GUIDE split
7. **Harness alignment H1–H3 plus P1** (#356–#362):
   - fs/shell capability seam
   - three sandbox modes, fail-closed
   - system prompt written into session logs, with replay
   - AGENTS.md/CLAUDE.md instruction chain and project skills
8. **Web session shell v1.1** (Aug 8, about 24 commits): 3-column shell, agent tree, step streams, cross-session concurrency, Island deep links, iOS tree roster.
9. **Research merges** (LIR paper, ICLR 2027) and worktree sweeps.

The 61 local branches not merged into HEAD are squash-merged PR heads or evidence/docs branches. None carries unmerged capability work.

### TODO/FIXME hotspots
The code has essentially none: one grep hit, and it is inside a prompt string. Deferred work lives in "follow-up" / "later phase" comments:
- **exec-util tools bypass the sandbox seam** (`src/capabilities/index.ts`).
- **KB semantic search** is deferred (`src/kb/search.ts`).
- **Sense follow-ups:** the screenshot→model path, always-on listening and local whisper.cpp; Sense is not consumed by the agent (`src/sense/{screen,voice}.ts`).
- **Replay gap (H3 step 2):** the context-window boundary is not recorded (`src/sessions/replay.ts`).
- **APNs** is inert until keys are set; push is machine-level (`src/web/push.ts`).
- **Per-machine state:** consent, push, control policy and devices are per-machine rather than per-tenant, so they are denied in cloud (`src/web/capabilities.ts`).
- **Heartbeat `schedule`** is informational only (`src/heartbeat/config.ts`).
- **Gemini** has no gateway face (`src/providers/registry.ts`).
- **Executable skills** run unsandboxed (`src/skills/executable.ts`).
- **Cloud deletion coordination** assumes a single instance; per the self-audit doc, going multi-instance needs cross-instance lifecycle coordination.
- **Plan only** ("后续产品工程" in PLAN_PERSONAL_ASSISTANT): durable general tasks, one assistant across devices, cloud connectors with per-user OAuth, tenant-level cloud push, VM-grade isolation.

### Off by default
- **Env flags:**
  - `LISA_PTY_AGENTS`, `LISA_FIRESTORE`, `LISA_SWEEP_TOKEN` (cloud sweep), `LISA_APNS_*`
  - `LISA_EMBED_MODEL`, `LISA_MODEL_FALLBACK`
  - `LISA_SANDBOX_MODE` (the owner defaults to danger-full-access)
  - `LISA_IDLE_COMMITMENT_AWARE`
  - `LISA_CLOUD_APPLE_SIGNIN`, `LISA_GOOGLE_*_CLIENT_ID`, `LISA_TURNSTILE_*`, `STRIPE_*`
  - `LISA_SOUL_GIT` (off in cloud)
- **Configuration defaults:**
  - the screen advisor
  - all five consent signals
  - the codex, github-pr, opencode, aider, git, shell and takoapi observers
  - `--voice`
  - `--approval`, which defaults to `auto`
- **Escape hatches:** `LISA_AUTONOMOUS_FULL_TOOLS` and the channel `unsafeFullTools` opt-in.
- **Kill switches:** `LISA_BILLING_KILL` and `LISA_SOCIAL_PUBLISH_PAUSED`.

---

## (a) Summary table

All paths are relative to the repository root.

| Dimension | Maturity | Key paths |
|---|---|---|
| Architecture | Modular monolith; `server.ts` hotspot | `src/cli.ts`, `src/web/server.ts`, `src/paths.ts`, `src/runtime-policy.ts`, `deploy/*` |
| Soul/persona | mature (local); cloud working-basic | `src/soul/*`, `src/prompt.ts`, `src/reflect.ts` |
| Visual presence | mature Mac/web; iOS working-basic | `src/web/{island,room}.ts`, `src/mood-bus.ts`, `packaging/mac-client/Sources/Lisa/Island/*`, `packaging/ios-companion/Widgets/*` |
| Memory/KB | working-basic → mature; export missing | `src/memory/*`, `src/kb/*`, `src/sessions/*` |
| Proactivity (inner life) | mature local | `src/idle/*`, `src/heartbeat/*`, `src/soul/store.ts` (desires) |
| Proactivity (user-facing) | working-basic; Sense stub-ish; cloud minimal | `src/mail/*`, `src/kb/feeds/*`, `src/advisor/*`, `src/sense/*`, `src/web/{push,autonomy-sweep}.ts` |
| Agent loop/tools | mature local; cloud 18-tool allow-list | `src/agent.ts`, `src/tools/registry.ts` |
| Browser/computer use | missing | (none) |
| Coding fleet control plane | mature; PTY flagged off | `src/integrations/*`, `src/agents/*`, `src/tools/dispatch_agent.ts` |
| Approvals/sandbox | working-basic / working (opt-in) | `src/approval.ts`, `src/sandbox/*`, `src/capabilities/*`, `src/sense/social/drafts.ts` |
| Channels (IM) | working-basic (reply-only, local) | `src/channels/*` |
| iOS | working (review pending) | `packaging/ios-companion/Sources/*` |
| Voice | working-basic (PTT STT, `say` TTS) | `src/voice/*` |
| Connectors | mail working-basic; social open working-basic / commercial stub; PIM missing | `src/mail/*`, `src/sense/social/*`, `src/mcp/*` |
| Models | mature | `src/providers/*`, `src/model/*`, `src/web/gateway.ts` |
| Accounts/billing | mature (correctness); cloud infra working-basic | `src/billing/*`, `src/web/{accounts,sessions-auth,capabilities,event-bus,tenant-runtime}.ts`, `src/cloud/*` |
| Privacy/consent | mature consent/logging; export and at-rest encryption missing | `src/consent/*`, `src/web/ai-disclosure.ts`, `src/log.ts` |
| Tests/CI/obs | mature tests/CI; ops working-basic | `.github/workflows/*`, `scripts/coverage-thresholds.mjs`, `src/web/health.ts` |
| Multi-agent (general) | working-basic (A2A); personal teams missing | `src/tools/{takoapi,task}.ts`, `src/integrations/takoapi/*` |
| Agent identity / payments | missing | (none) |

---

## (b) Top 15 capability gaps vs always-on personal agents

Ranked by strategic importance.

**1. No always-on cloud runtime with real tools (no "own computer").**
- **Gap:**
  - Cloud chat has only the 18 soul/memory/KB tools, with no `web_search` or `web_fetch`.
  - All real agency (shell, fs, MCP, dispatch, mail, push, Sense) exists only on the user's Mac while it is awake.
- **Extend:**
  - `CapabilityProfile` (cloud-chat, cloud-autonomy) and `CLOUD_ALLOWED_TOOL_NAMES` in `src/web/capabilities.ts` and `src/tools/registry.ts`.
  - The sandboxed capabilities provider (`src/capabilities/sandboxed.ts`) and `src/sandbox/*`.
  - `TenantRuntime`, then per-tenant sandbox containers or microVMs behind `deploy/`.
- **Quick win:** admit the SSRF-guarded web tools to the cloud allow-list.

**2. No durable goals/tasks with result delivery.**
- **Gap:**
  - Heartbeat output goes to a log file.
  - Managed/PTY agents live only in memory.
  - The cloud sweep never reaches the user.
  - There is no Task object with states, budget, checkpoints and resume.
- **Extend:**
  - Desires plus progress logs (`src/soul/store.ts`, `src/heartbeat/runner.ts`) as the goal model.
  - The managed-agent state machine (`src/agents/managed.ts`).
  - The exactly-once outbox/reconciler pattern (`src/billing/{outbox,reconcile}.ts`).
  - The autonomy ledger (`src/autonomy/runs.ts`).
  - The `scheduled_dispatch` schedules.
  - Delivery through PushBridge and `idle_message`.

**3. Thin connectors and no per-user OAuth/credential vault usable in cloud.**
- **Gap:**
  - Calendar, contacts, docs/drive, tasks and email send are all missing.
  - Mail is read-only and local.
- **Extend:**
  - Generalize `src/mail/google-oauth.ts`.
  - Reuse the validated social-connector manifest and hidden-MCP-tool runner pattern (`src/sense/social/{manifest,runner}.ts`) as the connector contract.
  - Add Streamable-HTTP transport and OAuth to `src/mcp/client.ts`.
  - Build an AES-GCM tenant vault following `src/web/apple-authorization.ts`.
  - Make consent per-tenant (`src/consent/store.ts`).

**4. No unified approval inbox or actionable, tenant-level notifications.**
- **Gap:**
  - Approvals are fragmented: CLI stdin, managed-agent buttons, social drafts.
  - Web chat defaults to `auto`, or `deny` if approval is requested.
  - Push is machine-level and denied in cloud.
- **Extend:**
  - `/api/agents/managed/<id>/approve` and the iOS approve UI.
  - Digest-bound approvals with TTL from `src/sense/social/drafts.ts`.
  - The APNs and Live Activity sender in `src/web/push.ts`.
  - `TenantEventBus`.
  - iOS `PushManager` and `LiveActivityController`.

**5. No browser automation or computer use.**
- **Extend:**
  - The tool registry and sandbox profiles.
  - The `web_fetch` SSRF guard.
  - The screenshot→model path in `src/screen_advisor/engine.ts` and `src/vision/*` as the observation half.
  - Per-step approvals from managed agents.
  - The Mac app, for Accessibility-based local control.

**6. Messaging channels are not first-class, proactive or hosted.**
- **Gap:** they run in a separate process and are reply-only, text-only and local. There is no SMS, WhatsApp or iMessage-in-cloud.
- **Extend:**
  - `ChannelAdapter.send` and `ChannelRouter` (`src/channels/*`).
  - Add channel transports to PushBridge.
  - The webhook channel for an SMS gateway.
  - Per-tenant channel bindings in cloud.

**7. Proactivity is not grounded in the user's world.**
- **Gap:**
  - No reminder or timer tool.
  - The heartbeat `schedule` field is ignored.
  - Sense is display-only.
  - Reve looks inward by default.
- **Extend:**
  - Generalize the advisor's scoring, throttling and dismissal learning (`src/advisor/engine.ts`) with personal detectors.
  - Feed SenseService events into those detectors.
  - Make `LISA_IDLE_COMMITMENT_AWARE` the default.
  - Reuse the schedule parser from `src/integrations/scheduled-dispatch.ts`.
  - Reuse the mail alerts pipeline.

**8. No single assistant across devices.**
- **Gap:** the Mac and Cloud souls and memories are separate instances; the iOS copy says so.
- **Extend:**
  - Soul and KB git history as the sync substrate (`src/soul/git.ts`, `src/kb/git.ts`).
  - The account-linked Mac via `LISA_MANAGED_SESSION` (`src/providers/registry.ts`).
  - Per-uid homes and Firestore.

**9. No agent identity (own inbox or phone number).**
- **Extend:**
  - `src/web/{mailer,email-deliverability}.ts` (Resend).
  - The IMAP connector, for an agent inbox.
  - The webhook channel, for SMS or voice providers.
  - Approvals before anything goes out.

**10. No voice-first or realtime presence.**
- **Gap:** no voice on iOS, no web or cloud TTS, no duplex audio or calls.
- **Extend:**
  - `src/voice/transcribe.ts`.
  - Media metering in `src/billing/media-admission.ts`.
  - MoodBus to drive avatar sync.
  - `VoiceSource` consent.
  - iOS `ChatView.swift`.

**11. No general-purpose agent teams; orchestration is coding-CLI-centric.**
- **Extend:**
  - `task` subagents.
  - The managed registry and roster UIs (web tree and `RosterView.swift`).
  - TakoAPI A2A (`src/integrations/takoapi/*`).
  - The `compare_agents` pattern.
  - Recap and advisor.

**12. Cloud isolation, scale and release discipline.**
- **Gap:**
  - One instance, with file accounts on GCS FUSE.
  - Manual deploy.
  - Executable skills run in-process.
  - exec-util tools bypass the sandbox seam.
- **Extend:**
  - The Firestore backend and turn leases (`src/cloud/*`).
  - Route exec-util through the capabilities seam.
  - Add a deploy workflow.

**13. Memory depth and user control.**
- **Gap:**
  - Only 6 KB of memory reaches the prompt.
  - Retrieval is lexical by default.
  - There are no memory edit/delete/export APIs and no entity graph beyond `relationships/*.md`.
- **Extend:**
  - The KB link graph and memory-links.
  - The embedding cache.
  - The reflection operations.
  - Write verbs on `/api/memory`.
  - The account-deletion path, turned into an export archive.

**14. No payments or commerce on the user's behalf with spend controls.**
- **Extend:**
  - The billing ledger, outbox idempotency, quota tiers and kill switch (`src/billing/*`).
  - The Stripe integration.
  - Approvals.

**15. Avatar is fixed, not user-customizable, and weak outside web/Mac.**
- **Gap:** one Lisa look, no persona picker, iOS shows only a portrait.
- **Extend:**
  - The 114-mood catalog and `set_mood`.
  - The room sprite pipeline (Gemini image anchor → keyframes).
  - Birth seeds, turned into a user-guided birth (`src/soul/birth.ts`).
  - Live Activity attributes.

**Strategic tension to resolve first.** `docs/AUTONOMY_ROADMAP.md` makes "no proactive outreach or push" an explicit non-goal. Gaps 2, 4, 6 and 7 require reversing that decision behind an explicit, user-authorized flow.

---

## (c) Top 8 genuine differentiators, grounded in code

**1. An auditable, evolving self.**
- Soul-as-files: identity, purpose, constitution, values, opinions with evidence, relationships, and emotions with decay and a causal trail.
- Every change is a git commit labelled by caller.
- Tamper detection surfaces in the prompt.
- The model's own soul tools update the prompt mid-session.
- Code: `src/soul/*`, `src/prompt.ts`.

**2. Intrinsic motivation.**
- Desires have intensity and decay horizons, can be pursued by Lisa herself or marked as needing the user, and carry multi-day progress logs.
- Scheduled desire reviews enforce a browsing budget in code.
- There is a weekly examen and a meta-wishlist of self-requested tooling.
- The big products run user-assigned tasks; LISA has its own goals.
- Code: `src/soul/store.ts`, `src/heartbeat/runner.ts`, `src/reflect.ts`.

**3. Principled dissent and sovereignty.**
- A constitution plus `soul_object`: the agent loop forces the objection to be surfaced.
- A sovereignty prompt resists identity overrides.
- Code: `src/agent.ts`, `src/soul/tools.ts`.

**4. A control plane over the user's own coding agents.**
- Observes 10 sources: Claude Code, Codex, OpenCode, Aider, GitHub PRs, git, shell and more.
- Dispatches 5 CLIs headless.
- Managed agents take per-mutation approve/deny, including from the phone.
- PTY adoption of idle `claude` sessions.
- `compare_agents` across worktrees.
- An anti-annoyance advisor, a recap, and a Live Activity/widget.
- `run_on_plan` reuses existing Claude Pro/Max, Codex or Copilot subscriptions.
- Code: `src/integrations/*`, `src/agents/*`, `src/tools/{dispatch_agent,compare_agents,run_on_plan}.ts`.

**5. Local-first sovereignty over data and models.**
- Plain files the user owns, git-versioned.
- 3 native providers, 13 OpenAI-compatible presets, and local Ollama, LM Studio or llama.cpp.
- Bring-your-own keys, or key-free through the gateway.
- No telemetry, enforced by a test.
- The exact system prompt of every turn is replayable offline.
- Code: `src/providers/registry.ts`, `src/model/local.ts`, `src/no-telemetry.test.ts`, `src/sessions/replay.ts`.

**6. Ambient, embodied companionship.**
- 114 model-chosen mood portraits with origin attribution.
- The notch Island and menu-bar presence.
- A pixel-art Room driven by real state (thinking, dreaming, desire, time of day) with a gramophone.
- Code: `src/web/{island,room,room-music}.ts`, `src/mood-bus.ts`, `packaging/mac-client/Sources/Lisa/*`.

**7. A personal knowledge base that Lisa tends, and China-ready.**
- KB v2 ingests articles, YouTube/Bilibili subtitles and WeChat articles.
- An RSS brief ranked against the user's own memory and wiki.
- A wiki with a link graph and memory⇄KB links, CJK-aware search.
- China-friendly ecosystem: 7 Chinese model vendors and a Feishu channel.
- Code: `src/kb/*`, `src/tokenize.ts`, `src/channels/feishu.ts`.

**8. Self-extension with a human in the loop, under layered capability boundaries.**
- Extension paths:
  - skills and SHA-approved executable skills
  - Claude-Code-compatible plugins and hooks
  - the AGENTS.md chain
  - `redeploy`, which rebuilds Lisa's own source and restarts
- Boundaries:
  - five capability profiles
  - tool subsets for autonomous, remote, desire-review and cloud runs
  - fail-closed sandbox modes
  - default-off consent with blacklists and PII redaction
  - digest-bound, TTL-limited publish approvals
- Code: `src/skills/*`, `src/plugins/*`, `src/tools/redeploy.ts`, `src/web/capabilities.ts`, `src/sandbox/*`, `src/consent/*`.
