# Lisa v0.9.1

**A security + honesty release.** A full five-subsystem product review
([docs/PRODUCT_REVIEW_v0.9.md](PRODUCT_REVIEW_v0.9.md)) found one cross-cutting
hole — `lisa serve --web` bound every network interface with zero auth in front
of a full-tool agent — plus two advisor false alarms and a batch of unlocked
soul writes. All closed here, alongside deeper cross-agent observation and a
docs pass that pulls the marketing back in line with the code.

No new user-facing features to learn; if you run `serve --web` or IM channels,
read **Behavior changes** below — a couple of defaults tightened.

## 🔒 Security (the headline)

- **`serve --web` now binds `127.0.0.1` by default.** It used to bind every
  interface while *printing* "localhost", with `/chat` (a full-tool agent) and
  `/api/vision/capture` (a silent screen grab) reachable, unauthenticated, from
  anyone on your LAN. To expose it deliberately: set `LISA_WEB_TOKEN` and pass
  `--host 0.0.0.0`; remote devices authenticate with `?token=…` once (→ HttpOnly
  cookie).
- **IM channels run a remote-safe toolset by default** — no `bash`, file
  mutation, `dispatch_agent`, GitHub writes, `skill_manage`, etc. on
  remote-origin messages. A fully-trusted channel opts back in with
  `"unsafeFullTools": true`. The router warns loudly at startup for any channel
  left without an allow-list.
- **Self-driven autonomous runs are tool-bounded** — desire heartbeats, the
  weekly examen, and idle/dreams (prompts Lisa wrote for herself, running
  unattended) drop shell / fs-mutation / dispatch tools. Your own
  `heartbeat.json` tasks keep the full set. `LISA_AUTONOMOUS_FULL_TOOLS=1`
  restores the old behavior. This breaks the "indirect prompt injection →
  self-authored actionable desire → persistent unattended code execution"
  chain.
- **Feishu events are verified now** — `verificationToken` is required and
  actually checked; `X-Lark-Signature` + a 5-minute replay window are enforced
  when `encryptKey` is set (it was unauthenticated despite storing the token).
- **Plugin hooks fire on the web path** — `serve --web` wires
  PreToolUse/PostToolUse like the CLI (they were silently skipped before).

## 🛰 Advisor & orchestrator

- **Two trust-killing false alarms fixed:** a tool running >5s with a quiet
  transcript was reported as an **urgent** "waiting for permission" (every long
  `npm test` / `Bash` tripped it); an open PR idle >14 days was reported
  "merged/closed". Both corrected.
- **Island advisor cards are actionable** — each cross-agent suggestion gets a
  button that prefills the chat with a concrete ask (nothing auto-runs; `open`
  reveals the folder natively) and a ✕ that **persists** a dismissal, teaching
  the advisor to quiet that category over time (the previously dead
  `applyDismissal` loop is now wired).
- **Tier-2 activity for Codex / OpenCode / Aider** — structural activity
  (tools / files / last command / errors), gated behind each integration's
  `visibility` tier, with a planted-secret privacy test per adapter. All five
  observers now emit activity; **fidelity varies by what each agent records on
  disk (Claude Code richest; Aider gives files + turns, no tool stream), and
  the non-Claude depth is new and not yet battle-tested against live agents.**

## 🔧 Correctness

- **Abort actually cancels LLM streams** — all three providers forward
  `AbortSignal` to their SDKs. Ctrl-C used to stop tools but let the stream burn
  to completion.
- **`maxIterations` truncation is explicit** (`stopReason: "max_iterations"` +
  an info event) instead of silently returning stale text.
- **Empty assistant turns no longer poison history** (they 400 a later
  Anthropic call); **concurrent `/chat` no longer corrupts history** (turns are
  serialized; malformed JSON → 400, not a hung socket).
- **Soul writes are cross-process safe** — journal appends, emotion updates (now
  a shared decay-first path used by both `soul_feel` and reflect), and git
  commits run under cross-process locks; idle gained a run-lock like heartbeat's.
  **Tamper detection now sees deletions**, and a missing `emotions.json` no
  longer decays every feeling to zero.

## 🧹 Maintenance

- `src/web/lisa-html.ts` split 2326 → 196 lines (CSS + client JS into modules;
  served HTML byte-identical, sha256-pinned).
- Gemini SDK lazily imported — Anthropic-only users no longer load
  `@google/genai`.
- Release gated on `npm test`; bundles prune devDependencies (~59MB smaller).
- Docs honesty pass: the DMG ships one app (LisaIsland folded into Lisa.app in
  v0.7), "~11k" → "~22k lines", stale `0.2.0` version strings fixed, completions
  learn `autostart`.

## ⚠️ Behavior changes

- Reaching the web UI from another device now requires `LISA_WEB_TOKEN` +
  `--host` (the README documents the phone/PWA flow).
- Channel messages can no longer run `bash` / edit files unless that channel
  sets `"unsafeFullTools": true`.
- Desire-driven heartbeats and idle runs lose shell / dispatch tools by default
  (`LISA_AUTONOMOUS_FULL_TOOLS=1` to restore).
- **Feishu without `verificationToken` / `encryptKey` now refuses to start** (it
  was unauthenticated before — add either to `~/.lisa/channels.json`).

## Verification

`npm test`: **429 / 429 pass** (+101 over 0.9.0), `npm run typecheck` clean.

Full detail in [CHANGELOG.md](../CHANGELOG.md) and the review at
[docs/PRODUCT_REVIEW_v0.9.md](PRODUCT_REVIEW_v0.9.md).
