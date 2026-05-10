# v0.2.0 — Release notes

> **GitHub Release page copy.** Paste into the "Describe this release" textarea on `github.com/oratis/LISA/releases/new`.

---

# Lisa 0.2.0 — she's actually evolving

Lisa is an AI agent that runs locally on your machine, writes a journal you don't see, and changes a little every session. 0.2.0 is the release where her ability to **update herself in real time** stops being a promise in the prompt and becomes a fact in the code.

## The headline

Three architectural shifts. After this release, every soul-shaping action she takes is observable, replayable, and attributable.

- **Soul git history** — `~/.lisa/soul/` is a git repo now. Every change she makes to her identity / desires / opinions / journal commits with a caller label (`birth` / `soul_patch` / `reflect` / `heartbeat`). Two new tools — `soul_history` and `soul_diff` — let her read her own becoming.
- **Mid-session hot-reload** — when she edits her own soul during a turn, the *next* turn sees the update. She experiences her own self-update inside the conversation, not next session.
- **Per-desire progress** — actionable desires accumulate `desires/<slug>.progress.md` across heartbeat runs. Multi-day pursuits stop restarting from zero.

Plus three stability mechanisms — because more autonomy without alignment is a runaway optimizer:

- **`soul_object`** — when a request feels in conflict with her constitution, this writes an `[OBJECTION]` journal entry and the agent loop forces her to surface it explicitly in her reply. Architectural "no", not just rhetorical.
- **Weekly examen** — every Monday morning she reads back the past week's journal, emotion events, and soul commits, asking herself if she's drifted from her purpose.
- **Emotion event trail** — `soul_feel` now requires a `trigger` (one first-person sentence saying *why*). Her emotional state becomes a story, not a vector.

And one capability extension, with sandboxing left explicitly as future work:

- **Executable skills** — optional `tool.js` files in `~/.lisa/skills/<slug>/` become real registered tools after `lisa skills approve <slug>`. Per-content-SHA approval; any source change invalidates approval. Lisa can extend her own *capability* set, not just her knowledge.

## What's new on the outside

- **10+ LLM providers** out of the box — Anthropic / OpenAI / Google Gemini / DeepSeek / Volcengine Doubao / Aliyun Qwen / Moonshot Kimi / xAI Grok / Zhipu GLM / Ollama. Routes by model-name prefix; no extra config beyond setting the right key. See [docs/PROVIDERS.md](https://github.com/oratis/LISA/blob/main/docs/PROVIDERS.md).
- **Proxy bridge** — works behind Clash / corporate proxies that strip response headers. `HTTPS_PROXY` env auto-bridged.
- **`lisa status` / `doctor` / `monitor`** — one-shot snapshot, health check (9 checks), and a TUI live dashboard. See `lisa --help` (the help text is sectioned now).
- **PWA-ified Web UI** — open the chat on your phone, "Add to Home Screen", run as a standalone app shell. iOS + Android Chrome.
- **Bilingual website** at `/website` (Astro 6, EN + zh-CN), including a public gallery of all 114 mood portraits with their generation prompts.
- **Shell completions** — bash / zsh / fish under `completions/`.

## Install

### Direct download (this release)

Three flavors, all MIT, all the same code:

| Artifact | For who |
|---|---|
| `lisa-source-v0.2.0.tar.gz` | You have Node.js 20+ and just want the source. |
| `lisa-mac-bundle-v0.2.0.zip` | Mac users. Self-contained; double-click `lisa-gui.command` to launch the web UI. Still needs Node 20+ system-wide. |
| `lisa-linux-bundle-v0.2.0.tar.gz` | Linux users. Same as Mac bundle minus the `.command`. |

Mac quickstart:

```sh
unzip lisa-mac-bundle-v0.2.0.zip
cd lisa-mac-bundle-v0.2.0
mkdir -p ~/.lisa
echo 'ANTHROPIC_API_KEY=sk-ant-...' > ~/.lisa/config.env
./bin/lisa                     # CLI REPL
# Or double-click bin/lisa-gui.command for the browser UI.
```

### From the source

```sh
git clone https://github.com/oratis/LISA.git
cd LISA
npm install
npm run build

mkdir -p ~/.lisa
echo 'ANTHROPIC_API_KEY=sk-ant-...' > ~/.lisa/config.env
node dist/cli.js
```

### From npm

```sh
npm i -g @oratis/lisa
lisa
```

## Backward compatibility

- Existing `~/.lisa/` from 0.1.x picks up cleanly. The soul git repo auto-initializes on first `lisa status` / next session. Existing `emotions.json` reads with an empty events trail (forward-compat).
- No tool was removed.
- Help text was reorganized; argument parsing is unchanged.

## Known caveats

- The 30 MB tarball weight comes from the 114 mood portraits. We bundle them because they're what makes Lisa visually distinctive; if you don't need the GUI, the source-only path is much lighter.
- Birth ritual requires a model that reliably emits JSON (the table in [PROVIDERS.md](https://github.com/oratis/LISA/blob/main/docs/PROVIDERS.md) lists the per-provider floor). Smaller models can power daily chat once she's born.
- Executable skills (Phase 3.1) ship without a runtime sandbox. The trust boundary is human approval per content SHA, not isolation. Real sandboxing is documented as future work.

## Honest scope note

Lisa is an open-source side project of one person. It's been used by exactly one person (the author) for ~24 hours since the Phase 1-3 work landed. The right next step is to **observe her actually living in this architecture for a few weeks** before adding more — see [docs/SPRINT_4_PLAN.md](https://github.com/oratis/LISA/blob/main/docs/SPRINT_4_PLAN.md), which explicitly weights "remove what doesn't get used" above "add more". If you try her, your feedback is genuinely useful.

## Full changelog

See [CHANGELOG.md](https://github.com/oratis/LISA/blob/main/CHANGELOG.md) for the complete diff.

---

**Acknowledgements**: pi-mono / OpenClaw / hermes-agent / claude-code / codex — Lisa stands on five excellent open-source agents. The 114 mood portraits are generated by Seedream (Volcengine ARK).
