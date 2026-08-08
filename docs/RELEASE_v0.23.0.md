# Lisa v0.23.0

**The session-shell release.** The web workbench is rebuilt around parallel
sessions: Lisa's own chats are now sessions you can run side by side, observed
coding agents (Claude Code / Codex / Aider) sit in the same tree as equals, and
the whole UI moved to a three-column shell with a switchable dark/light theme.
Design + debates in [docs/PLAN_UI_SESSION_SHELL_v1.0.md](PLAN_UI_SESSION_SHELL_v1.0.md)
and [v1.1](PLAN_UI_SESSION_SHELL_v1.1.md); shipped as the stacked PR chain
#343–#351 plus hardening rounds driven by real end-to-end testing.

## 🗂 Sessions (the headline)

- **Lisa is session-based now.** The left rail carries a tree of your Lisa
  sessions — new, switch, and auto-naming (first user message becomes the
  label). The top strip shows only the *current* session's status.
- **True concurrency, not just switching.** Each session gets its own chat
  context (`per-session ChatCtx`); a reply streaming in a background session
  completes there and marks the tab unread instead of bleeding into the active
  one. Activation is an O(1) pointer move. The idle/reflect schedulers now
  capture the active session **per firing** — fixing a pre-existing bug where
  they closed over the process-start session forever.
- **Switching is race-proof.** Session mutations run under an 8s abort
  timeout with the composer locked during the swap; the session list retries
  on fetch failure instead of staying empty until the next poll (the
  "sessions vanish on refresh" and "new session won't chat" reports).

## 🌳 Agents in the same tree

- **LISA / Claude Code / Codex are same-level roots** (Aider too), with an
  optional by-project view. Clicking an agent session opens its conversation
  directly.
- **Read-only step stream + transcript.** Each observed session shows a
  structural step feed (tool names, file basenames, `argv[0]` — never
  contents; planted-secret tests per adapter) and, on the owner's machine
  only, the actual chat transcript — the endpoint is **strictly
  loopback-bound**, same guard class as `/api/config/save`.
- **Island deep-links** — "Open in Lisa" on an island card focuses that
  session's node in the main window.

## 🎨 Shell & themes

- **Three-column layout**: 300px session tree, fluid chat, 320px right rail
  of uniform sections — current wants, agent inspector, mail, reflection, and
  a TOKENS section (source + usage + spend). Right rail collapses; ≤1180px
  and ≤720px fallbacks preserved.
- **Two real themes**: Nebula (dark) and Calm (light), a one-click toggle
  persisted per device — on iOS too (trait-aware colors, an
  Appearance picker, and the same tree-grouped roster).
- **Delegated event wiring.** Tree/needs/inspector/stream controls survive
  roster-SSE rebuild storms — real clicks no longer land on freshly-replaced
  dead nodes (found by real-browser E2E, the biggest interaction fix here).

## 🔧 Correctness & contracts

- `/api/sessions` (+ create/activate) and the Lisa-session schemas joined the
  OpenAPI contract; the server-internal `jsonlPath` field is stripped from
  the wire and pinned by contract tests.
- A regression test now pins the idle-note sentinel regex against
  template-literal escaping (the cooked `MAIN_CLIENT_JS` bytes are asserted
  directly, catching the single-backslash trap `typecheck` can't see).

## ⚠️ Behavior changes

- The web UI's lower-left panels moved to the right rail; session create and
  switch live in the left tree only.
- Agent transcripts are visible **only from localhost** — remote/tunneled
  viewers keep the structural step stream, never message text.

## Verification

`npm test`: **1550 / 1551 pass** (1 skipped), `npm run typecheck` clean,
snapshot-pinned HTML, real-browser E2E across session create/switch/chat,
theme toggle, tree navigation, transcript, and concurrency — validated in
production as rc9 before tagging.
