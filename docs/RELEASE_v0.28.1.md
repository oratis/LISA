# LISA v0.28.1 — Soft Ink, Tasks & Trust

LISA is an AI Personal Assistant for planning, writing and personal knowledge. This release introduces the Soft Ink visual identity and adds the groundwork for an assistant that works on your behalf while you are away — durable tasks and watchers, a deterministic approval layer, one gate for every proactive message, a credential broker and cost-aware model routing — and fixes a set of first-run, health and privacy issues. Most of the new machinery is off or opt-in; what changes on a default install is listed first.

## Reproducible release packaging

The release builder now installs the complete locked dependency graph for compilation, then prunes development tools before packaging the CLI bundles. Previously it installed TypeScript with `--no-package-lock` after a production-only install, which also re-resolved runtime dependency ranges and caused an IMAP type error despite green CI. The development environment is restored with the same lockfile after packaging.

v0.28.0 stopped at that packaging error before any npm package or GitHub release was published. v0.28.1 is the complete distribution of the changes below; the failed tag is retained without rewriting it.

## Soft Ink: Lisa's new visual identity

- **24 core expressions** in the approved Soft Ink illustration style replace the Web and Island portraits. All 114 existing mood identifiers remain supported; the other 90 states reuse a related core expression, and the original individual PNG endpoints remain available for older clients.
- **Eight downloadable stickers**, two illustrated rooms, a shared pose sheet and new app icons. Click Lisa's avatar to open the illustration gallery and download individual transparent PNGs. The room keeps its existing activity signals and changes lighting without moving its furniture.
- **Six scene illustrations**, with the welcome illustration connected to the chat empty state; the other five are prepared for later surfaces. The bilingual website gallery uses the same expression map.
- **Consistent, cached avatars.** Web and Island share a compact portrait atlas; rapid state changes cannot restore an older image, and failed loads preserve the last good portrait. The iOS source now uses the same mapping with a fallback for older servers; an updated iOS binary is a separate release.
- The gallery supports light/dark previews and 28–72px comparisons. Generated masters, prompts, deterministic export scripts and the [review gallery](design/2026-10-08-visual-refresh/index.html) are included in the repository.

## What changes on a default install

- **First-run with a non-Anthropic provider works.** Choosing DeepSeek, Grok, Mistral, Perplexity, Ark, MiniMax, Hunyuan or a custom OpenAI-compatible endpoint and saving a key now actually switches the model; before, turns kept going to Claude. Custom OpenAI-compatible endpoints (Ollama, LM Studio, self-hosted) are back in the provider picker. (#381)
- **Quiet hours for proactive pushes.** Mail digests, important-mail alerts, the knowledge-base daily brief, advisor digests and the "[while you were away]" note pass one reach-out gate. Between 22:00 and 08:00 their push waits until 08:00; they still appear in the app at once. Configure in web Settings → Proactivity, `lisa reachout`, or `/api/reachout/settings`. (#406)
- **One-time codes and sign-in links are hidden from mail.** Codes, magic / sign-in / verification links and password-reset links in inbound mail are replaced with placeholders before the model, digests or alerts see them. (#405, #418)
- **Safer, faster web reading.** `web_search` goes only to DuckDuckGo over HTTPS on every redirect hop; fetched pages are converted to text in one linear pass, so a hostile page can no longer stall the process; look-alike untrusted-content markers are defused. Users behind Clash / Surge fake-ip DNS keep working. (#404, #417)
- **`/health` on the Mac no longer exposes details before auth.** Public health shows ok, latency and edition; the rest needs a token. `lisa doctor --probe` reports a busy backend as degraded, not down. Restarts no longer re-send notifications for sessions already reported. (#381)
- **IMAP 2.** Mail uses imapflow 2 and tolerates missing or odd envelope dates. (#384)
- **Background classification uses a smaller model.** Mail and knowledge-base feed classification now run on the small model of your chat model's family — `claude-haiku-4-5` for Claude, `gemini-2.5-flash-lite` for Gemini, `gpt-4o-mini` for OpenAI — when you have credentials for it, and on your chat model otherwise. Set `LISA_MODEL_SMALL` to choose another model (including `local://` for Ollama, LM Studio or llama.cpp), or to your chat model to keep classification on it. (Before this release classification always used the built-in default model, whatever `LISA_MODEL` said.) The hosted edition keeps `gemini-2.5-flash`. (#407)

## New, opt-in or off by default

- **Task Engine** — `lisa tasks …`, `/api/tasks`. Routines, one-offs and web / RSS / mail watchers that run unattended under `serve --web` and the launchd heartbeat, with per-task leases, crash-safe resume, retries that continue the same run, and a write-ahead ledger so a side effect is not repeated. Tasks the model drafts start switched off; you enable them (`lisa tasks enable <id>`). Until approvals are wired to tasks, an unattended run may only make verified read-only calls. `heartbeat.json` chores keep running as before; `lisa tasks migrate-heartbeat [--dry-run]` moves them on request. Design and known gaps: [`DESIGN_TASK_ENGINE.md`](DESIGN_TASK_ENGINE.md). (#403)
- **Warden** — `--approval warden` or `LISA_APPROVAL=warden`. Each side-effecting tool call is allowed, denied, asked or handed back to you by a deterministic policy with scoped grants, conversation-long taint tracking and an audit log that records decisions without payload contents. The web approval card shows the complete request and approves exactly what was shown; `lisa approvals …` and `lisa warden …` on the command line. Off unless you turn it on: only the web client can answer an approval today. [`DESIGN_WARDEN.md`](DESIGN_WARDEN.md). (#402)
- **Credential broker** — `lisa secret set | list | rm`. Secrets referenced as `secret://name` handles, kept in the macOS Keychain or an encrypted file; values pass over stdin, never argv. Nothing else uses it yet. (#405)
- **Run budgets and a Gemini gateway.** `runAgent({ costCapMicroUSD })` is an estimate-based circuit breaker for integrators, not a guaranteed maximum charge. A signed-in account without its own Gemini key can use `gemini-2.5-flash` through LISA Cloud. See [`PROVIDERS.md`](PROVIDERS.md). (#407)
- **Cloud web tools** (`LISA_CLOUD_WEB_TOOLS=1`, server-side) and **hosted tasks** (`LISA_CLOUD_TASKS=1`) exist and are switched off in production.

## Behaviour changes to note

- `lisa heartbeat run <name>` runs heartbeat chores only; run a task with `lisa tasks run <id>`.
- Gemini resource names such as `tunedModels/…` are sent as written; base `gemini-*` ids are normalised. (#416)

## Also since v0.27.1

- Account lifecycle: new accounts get random uids; deletion drains tenant work, revokes Sign in with Apple tokens when configured and reports retryable failures. (#398)
- iOS (ships separately through the App Store): cloud onboarding, streamed replies and history restored; consumable credits refresh from the LISA ledger without Apple authentication; AI consent is explicit and revocable. Lisa Pocket 1.2 is waiting for App Review. (#392, #395, #411)
- Website and package metadata describe LISA as an AI Personal Assistant with clear Cloud / Mac boundaries. (#415)
- Dependencies updated within supported ranges; Astro 7 for the website; production `npm audit` reports 0 vulnerabilities. (#379, #394, #412)

## Known limits

- The remaining 90 moods do not yet have independent Soft Ink drawings. Room night skies, complex pose occlusion and the remaining scene placements are follow-up work.
- The Keychain backend of `lisa secret` has not been exercised against a real login keychain in CI; run `lisa secret set x`, `lisa secret list`, `lisa secret rm x` once on your Mac.
- Hosted tasks are safe for a single instance only (see "Known gaps" in the Task Engine design).
- No Tasks view or approval inbox in the iOS or Mac apps yet.

No credentials are included. LISA Cloud was updated separately on 2026-10-07 ([record](REVIEW_OPEN_PRS_2026-10-07.md)); this release does not change production flags and does not imply App Store approval.
