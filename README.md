# LISA

[![npm](https://img.shields.io/npm/v/@oratis/lisa?color=cb3837&label=npm)](https://www.npmjs.com/package/@oratis/lisa)
[![Homebrew](https://img.shields.io/badge/homebrew-oratis%2Ftap%2Flisa-fbb040)](https://github.com/oratis/homebrew-tap)
[![Mac DMG](https://img.shields.io/github/v/release/oratis/LISA?label=Mac%20app&color=000000&logo=apple)](https://github.com/oratis/LISA/releases/latest)
[![License: MIT](https://img.shields.io/github/license/oratis/LISA?color=blue)](./LICENSE)
[![GitHub Repo stars](https://img.shields.io/github/stars/oratis/LISA?style=social)](https://github.com/oratis/LISA/stargazers)
[![Discussions](https://img.shields.io/github/discussions/oratis/LISA?logo=github&color=8A2BE2)](https://github.com/oratis/LISA/discussions)

> English ｜ [中文](./README.zh-CN.md)

**An open-source personal AI assistant with persistent memory, an evolving identity, and tools to work alongside you.** Plan a day, draft a message, build a personal knowledge base, or coordinate coding agents from your Mac. Use LISA Cloud for hosted chat, or run your own instance with your choice of model.

[Website](https://meetlisa.ai) · [Guide](docs/GUIDE.md) · [Latest release](https://github.com/oratis/LISA/releases/latest) · [Roadmap](docs/PLAN_ALWAYS_ON_UPGRADE_2026-09-30.md)

## Choose where Lisa runs

| Entry point | What you get | Requirements |
| --- | --- | --- |
| **Mac app** | Web workspace, menu-bar Island, local tools and agent controls | Download the signed, notarized **Lisa-Suite.dmg** from Releases; Node and the backend are bundled |
| **CLI / self-hosted web** | Local assistant, configurable providers, knowledge, integrations and development tools | Node **22.19+** and a provider key or local model |
| **LISA Cloud** | Account-based chat, memory and knowledge tools, without setting up a Mac | [Sign in](https://meetlisa.ai/cloud/); usage allowance and optional credits apply |
| **Lisa Pocket (iOS)** | Cloud chat or access to your reachable Mac; separate saved connections | Native app is in App Store review remediation; **not yet publicly approved** |

Cloud and Mac are **separate instances**: their histories, memories and credentials do not automatically sync. Local tools need your Mac to be running and reachable. Cloud does not expose your Mac's shell, mail, coding agents or host-level push services.

<a id="install"></a>

## Quick start

For the Mac app, download **Lisa-Suite.dmg** from the [latest release](https://github.com/oratis/LISA/releases/latest). For the CLI, choose one install command:

```sh
brew install oratis/tap/lisa
# or
npm install -g @oratis/lisa
```

Configure a model, then start Lisa:

```sh
mkdir -p ~/.lisa
# Add your own key to ~/.lisa/config.env, for example:
# ANTHROPIC_API_KEY=your-key

lisa                    # terminal chat; first launch creates Lisa's identity
lisa serve --web        # web workspace at http://localhost:5757
```

Anthropic, OpenAI, Gemini, OpenAI-compatible services and local models are supported. See [providers](docs/PROVIDERS.md) for keys, model selection and Ollama / LM Studio setup. Coding work can also use supported CLI subscriptions through [coding plans](docs/GUIDE.md#coding-plans--use-a-subscription-instead-of-an-api-key).

## What you can do

- **Start with everyday work.** Planning, writing and idea starters open editable drafts. Chat supports streaming replies, tool activity, history, cancellation and retry.
- **Build lasting context.** File-backed identity, memories, opinions and journals evolve across sessions within the same instance. Review and reflection can update Lisa's desires and skills.
- **Keep a personal knowledge base.** Save links, ingest supported articles and video transcripts, search a linked wiki, and generate briefs from configured feeds.
- **Coordinate coding agents.** Observe supported Claude Code, Codex, OpenCode and Aider sessions; dispatch work, compare worktrees and approve LISA-managed agent actions. Available controls depend on the integration and local configuration.
- **Connect your local workflow.** Optional read-only mail, MCP tools, skills, plugins and Telegram / Discord / Slack / Feishu / iMessage / webhook channels. These require setup; a cloud login does not connect them for you.
- **Give Lisa time to work.** Configured heartbeat and reflection runs pursue standing chores and desires. The always-on personal task engine is still under review; an in-memory coding agent is not a durable task.
- **Keep her in view.** A pixel-art room, mood portraits and the Mac Island reflect real activity. Mobile widgets and Live Activities depend on a configured, reachable Mac and notification setup.

## Memory, identity and control

LISA's **SOUL** is a set of persistent files for identity, purpose, constitution and values. **DESIRES** guide autonomous work; **HEARTBEAT** and **REVE** provide scheduled work and reflection. These are software mechanisms for continuity and behavior, not a claim of consciousness.

Local data lives under `~/.lisa` by default. Choosing a remote model sends relevant context to that provider; local storage does not mean local-only inference. Lisa Pocket discloses recipients before AI chat and supports withdrawing permission. See the [privacy policy](https://meetlisa.ai/privacy/) and [security policy](docs/THREAT_MODEL.md).

On current `main`, **Warden** adds deterministic action decisions, scoped grants, an approval inbox and audit records. It is **opt-in for web chat**:

```sh
# Build current main first; this is newer than the v0.27.1 release.
lisa serve --web --approval warden
lisa approvals list
```

Warden does not cover every execution surface and does not replace an OS sandbox. Credential handles and inbound-mail filtering provide additional building blocks; they are not a complete cloud connector platform. Read [the design and limits](docs/DESIGN_WARDEN.md) and [threat model](docs/THREAT_MODEL.md).

The merged **reach-out gate** applies source controls, quiet hours, deduplication and budgets to integrated proactive senders. Approval and critical notices have special delivery rules; cloud APNs and a cross-device relay remain future work. See [the reach-out policy](docs/POLICY_REACH_OUT.md).

## Development status

The latest tagged package is **v0.27.1**. Current `main` includes later work; a merged feature is not proof that it has been deployed to Cloud or released in a native binary.

| Workstream | Status on 2026-10-07 |
| --- | --- |
| Personal-assistant entry, Cloud/Mac isolation, streaming/history fixes | Merged; native and production evidence recorded in the [execution log](docs/EXECUTION_PERSONAL_ASSISTANT_2026-09-27.md) |
| Warden core / credential broker / reach-out gate | Merged to `main`; Warden web-chat policy requires opt-in |
| Durable goals, routines and watchers | [PR #403](https://github.com/oratis/LISA/pull/403), not merged |
| Guarded cloud web search / fetch | [PR #404](https://github.com/oratis/LISA/pull/404), not merged; proposed feature is off by default |
| Purpose-based model routing and cost controls | [PR #407](https://github.com/oratis/LISA/pull/407), not merged |
| Cross-device memory, tenant-level push, calendar/mail-write connectors, computer use | Planned; not advertised as available |
| iOS App Store | October 5 rejection: consumable-credit restore and AI disclosure; [current remediation](docs/REVIEW_2026-10-07.md) |

Product research on Muse and other personal assistants informs the direction, with implementation boundaries documented in the [Muse review](docs/RESEARCH_MUSE_2026-09-27.md), [always-on research](docs/RESEARCH_ALWAYS_ON_AGENTS_2026-09-30.md) and [upgrade plan](docs/PLAN_ALWAYS_ON_UPGRADE_2026-09-30.md). LISA is an independent project.

## Screenshots

<table>
<tr>
<td width="50%" align="center">
  <a href="assets/screenshots/shell-nebula.png"><img src="assets/screenshots/shell-nebula.png" alt="LISA session shell — Nebula theme"></a><br>
  <b>Session shell — Nebula</b><br>
  <sub>Session tree · chat · inspector rail. Her portrait swaps live with her mood; agents she watches sit in the tree next to her own sessions.</sub>
</td>
<td width="50%" align="center">
  <a href="assets/screenshots/shell-calm.png"><img src="assets/screenshots/shell-calm.png" alt="LISA session shell — Calm theme"></a><br>
  <b>Session shell — Calm</b><br>
  <sub>The same shell in the light theme. Two themes, one Lisa.</sub>
</td>
</tr>
</table>

<p align="center">▶ <a href="https://www.youtube.com/watch?v=J_00iwAB_WI">Watch the 2-minute demo on YouTube</a></p>

## Develop and contribute

```sh
git clone https://github.com/oratis/LISA.git
cd LISA
npm ci
npm run build
node dist/cli.js serve --web
```

Before submitting a change, run the relevant checks:

```sh
npm run typecheck
npm run typecheck:client
npm test
node scripts/check-md-links.mjs
node scripts/check-readme-drift.mjs
```

See [Contributing](CONTRIBUTING.md) for the full development workflow and native build instructions in [iOS](packaging/ios-companion/README.md) / [Mac](packaging/mac-client/README.md).

## Learn more

- [User guide](docs/GUIDE.md): installation, channels, knowledge, mail, autonomy, permissions and tools.
- [Docs index](docs/README.md): plans, research, release notes and runbooks.
- [Changelog](CHANGELOG.md) · [Releases](https://github.com/oratis/LISA/releases).
- [Issues](https://github.com/oratis/LISA/issues) for bugs · [Discussions](https://github.com/oratis/LISA/discussions) for questions and ideas.

## License

MIT — see [LICENSE](LICENSE). Architecture draws on pi-mono, OpenClaw, hermes-agent, Claude Code and Codex; [credits](docs/GUIDE.md#credits).
