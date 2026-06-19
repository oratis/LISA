# Lisa v0.11.0

**Spend your subscription, reach her from your pocket.** Two threads land on top
of the v0.10 foundations: a **coding-plan** system that runs coding work on a
subscription you already pay for (Claude Pro/Max · ChatGPT/Codex · Copilot)
instead of metered API tokens, and the **iOS-companion control plane** — remote
gating, per-device pairing, push, and a native *Lisa Pocket* app — so you can
watch and steer the agents on your Mac from your phone.

112 new tests (692 → 804), every PR green through typecheck + build + the full
suite. No breaking changes — everything below is additive.

## ✨ Highlights

### Coding plans — run coding work on a subscription, not an API key
- **Detect + pick.** `lisa model list` detects your installed plan CLIs (Claude
  Code / Codex / Copilot) and login state; `lisa model use plan://<id>` selects a
  delegation target — presence-only detection, **no tokens read**.
- **Delegate.** The `run_on_plan` tool runs a coding task on the selected plan by
  driving the vendor's own CLI headlessly (`claude -p` / `codex exec` /
  `copilot -p`), so the work **bills to your plan, not an API key**. It is the
  *sanctioned out-of-process* path — LISA never extracts or replays subscription
  tokens (Anthropic's terms forbid that; they enforced it against OpenClaw). Gated
  like `dispatch_agent` (approval-required, off for autonomous/remote toolsets).
- **Real usage.** `lisa model list` shows honest rolling-window consumption read
  from local transcripts (`1.2M tok in 5h · 4.8M today`) — no faked "headroom %".
- **Web picker.** A **PLANS** panel in the web UI to select a plan and see
  status/usage.
- Full mechanism + rationale: [docs/CODING_PLANS.md](CODING_PLANS.md).

### Gateway bearer auth
- **`ANTHROPIC_AUTH_TOKEN`** is now honored — sent as `Authorization: Bearer`
  (vs `x-api-key`), taking precedence over `ANTHROPIC_API_KEY`, matching Claude
  Code. The sanctioned path for an Anthropic-compatible LLM gateway/proxy
  (Bedrock/Vertex/relay). OpenAI-compatible gateways already worked via `apiKey`.

### iOS companion — watch & steer your Mac's agents from your phone
- **Lisa Pocket** — a native SwiftUI companion app (roster, chat, control), plus
  **Live Activity + Dynamic Island** for a pinned agent. Self-contained under
  `packaging/ios-companion/`; talks only to your local `lisa serve --web`.
- **Pocket-control CLI + live output.** `lisa agents pty <agent> <task>` (a
  loopback thin-client), a `GET /api/agents/pty/<id>/stream` SSE for live terminal
  output, and a structural `GET /api/dispatch/list`.
- **Remote-control policy** (`/api/control/policy`). High-risk actions are gated
  for remote callers: adopting an *external* (non-LISA) session is **off by
  default**; controlling LISA's own agents is allowed for token-bearing devices.
  Config fails safe to the locked-down default.
- **Per-device pairing tokens** (`/api/pair/start`, `/api/devices`). A revocable
  credential per phone — 192-bit CSPRNG, only the **hash** stored (now in a
  `0600` file), constant-time compared, layered on top of `LISA_WEB_TOKEN`.
- **Operational push** (ntfy). `done` / `error` / `permission` agent transitions
  push to your phone (`/api/push/*`, `PushBridge`) — **metadata only**, never
  prompts/replies/file contents. APNs is stubbed for a later pass.

### Docs
- README (EN + zh) refreshed to reflect the orchestrator, PTY steering, session
  adoption, and coding plans. New [CODING_PLANS.md](CODING_PLANS.md) and
  [IOS_COMPANION_PLAN.md](IOS_COMPANION_PLAN.md).

## Behavior changes / new config

- `LISA_CODING_PLAN` (set by `lisa model use plan://<id>`) records the default
  coding-plan delegation target. It does **not** change LISA's own model.
- `ANTHROPIC_AUTH_TOKEN`, when set, takes precedence over `ANTHROPIC_API_KEY`.
- New web endpoints (`/api/plans*`, `/api/control/policy`, `/api/pair/*`,
  `/api/devices*`, `/api/push/*`, `/api/dispatch/*`) sit behind the existing
  loopback-or-`LISA_WEB_TOKEN` auth gate; minting/revoking pairing tokens and
  changing the control policy are loopback-only.
- The Live Activity / Dynamic Island and the iOS app are simulator-buildable
  today; real-device push (APNs) needs an Apple push key (tracked follow-up).

## Install

```sh
npm install -g @oratis/lisa
lisa serve --web
```

Mac app: download `Lisa-Suite-v0.11.0.dmg` from the GitHub Release.
