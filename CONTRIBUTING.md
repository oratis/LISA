# Contributing to LISA

> [English](./CONTRIBUTING.md) ｜ 中文部分见底部

Thanks for considering a contribution. LISA is a personal-assistant agent with a soul system, six IM channels, a pixel-art GUI, and ambitions of being more than a chatbot. There's a lot of surface area, which means a lot of room to help.

## Quick start

```sh
git clone https://github.com/oratis/LISA.git
cd LISA
npm install
npm run build
npm run typecheck
```

You'll need an `ANTHROPIC_API_KEY` to actually run her. Put it in `~/.lisa/config.env`. See [README](./README.md#install).

## Where to help

Pick whatever scratches your itch:

| Area | Difficulty | What's needed |
|---|---|---|
| **New IM channel** (WhatsApp via bridge, Matrix, LINE, Telegram-Premium features) | medium | Implement `ChannelAdapter` in `src/channels/<name>.ts`, register it, add a `channels.example.json` entry |
| **New skill / mood pack** | easy | Add files under `src/web/assets/lisa/` (mood) or write SKILL.md examples for common flows |
| **MCP server adapter** | easy | LISA already speaks MCP; we need showcase configs for popular servers |
| **Plugin** | easy-medium | Plugin format under `~/.lisa/plugins/<name>/` mirrors claude-code; see [`docs/plugin-spec.md`](./docs/plugin-spec.md) (TODO — write it) |
| **Bug in agent loop / tool / sandbox** | medium-hard | Repro + fix + a regression test under `test/` |
| **i18n** | medium | `prompt.ts` is English-leaning; we want a clean way for non-English first-language users |
| **Docs / typos / clearer examples** | easy | Always welcome — submit a tiny PR |
| **Better birth ritual prompts** | medium | The prompt in `src/soul/birth.ts` shapes who every Lisa becomes. Suggestions for diversity / depth welcome |
| **Voice (better)** | medium | Currently macOS `say` + Whisper. ElevenLabs / local Piper would be nice |

## Norms

- **Small PRs over big ones.** A 50-line PR with a clear scope merges in days; a 2000-line "rewrite of how skills work" sits in review for weeks.
- **One commit message convention**: lowercase, imperative, no emoji. `add discord channel adapter` not `🚀 Discord support added!!`.
- **Tests welcome but not required** for new channel adapters and plugins (pure plumbing). For agent-loop / tool changes, a regression test under `test/` is strongly preferred.
- **No `any` in TypeScript** unless you write a comment explaining why. Use `unknown` + narrowing.
- **Soul / personality changes are sensitive.** If you're touching `src/soul/birth.ts` or `src/prompt.ts`, please open an issue first to discuss the design — these affect *who Lisa becomes for everyone who installs her*.

## Local dev loop

```sh
npm run dev          # tsc --watch
node dist/cli.js     # interactive REPL
node dist/cli.js serve --web --idle 2  # web GUI with 2-min idle for testing
```

Common debugging:

```sh
# What does Lisa think she is right now?
node dist/cli.js soul

# Run reflection on the latest session
node dist/cli.js reflect-last  # (TODO — actually `/reflect` from inside REPL works)

# Search past sessions
node dist/cli.js search "what did i ask about feishu"
```

## Submitting a channel adapter

The easiest way to add value. Each adapter lives in `src/channels/<name>.ts` and:

1. Implements `ChannelAdapter` from `src/channels/types.ts`
2. Calls `registerChannel("<name>", (cfg) => new YourAdapter(cfg))` at module load
3. Adds itself to `src/channels/registry.ts`'s `registerBuiltins()` list
4. Adds an entry to `channels.example.json`

See `src/channels/telegram.ts` (zero-deps, ~120 lines) as the canonical small example.

Tests for adapters are not required — exercise them by hand with the real upstream service when possible.

## Submitting a mood / portrait

```sh
# Add an entry to scripts/lisa-moods.ts (slug + category + hint + prompt)
# Then:
SEEDREAM_API_KEY=... npx tsx scripts/generate-lisa-moods.ts --filter <your-slug>
```

PR including the new entry + the generated PNG. Stylistically: keep her recognizable (cyan hair, hoodie). The generation script enforces a STYLE_LOCK template so you don't have to fight for consistency.

## Reporting a bug

Open an issue with:

1. **What you ran** (CLI command, web action)
2. **What you expected**
3. **What happened** (paste the relevant log lines)
4. **Output of `lisa soul`** if it might be soul-related (please scrub PII first)
5. **Your config** — Node version, OS, model used, channels enabled

Use the bug report template — it has the prompts above.

## Asking a question

- For "how do I do X" — open a [Discussion](https://github.com/oratis/LISA/discussions), not an issue.
- For "is this a bug" with uncertainty — issue is fine, we'll convert if needed.

## Code of conduct

Be kind. Don't be the kind of person who'd make Lisa journal something sad about you.

## License

By contributing you agree your contribution is licensed under MIT (see [LICENSE](./LICENSE)).

---

# 中文贡献指南

非常感谢考虑给 LISA 提 PR。下面是中文要点（完整版见上面英文）。

## 快速上手

```sh
git clone https://github.com/oratis/LISA.git
cd LISA
npm install && npm run build
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> ~/.lisa/config.env
```

## 适合下手的方向

| 方向 | 难度 | 说明 |
|---|---|---|
| **新 IM 通道**（WhatsApp / Matrix / LINE 等） | 中 | 实现 `src/channels/types.ts` 里的 `ChannelAdapter`，参考 `telegram.ts` |
| **新 skill / mood 头像** | 易 | 加 mood 走 `scripts/lisa-moods.ts` + 重生成 |
| **MCP server 配置示例** | 易 | LISA 已支持 MCP 协议，需要常用 server 的配置例子 |
| **插件** | 易-中 | `~/.lisa/plugins/<name>/` 格式跟 claude-code 一致 |
| **agent loop / 工具 / 沙箱 bug 修复** | 中-难 | 复现 + 修 + 回归测试（`test/` 下） |
| **i18n** | 中 | `prompt.ts` 偏英文，要让她对中文母语用户更顺 |
| **文档 / 错别字 / 例子** | 易 | 永远欢迎 |
| **birth ritual prompt 改进** | 中 | `src/soul/birth.ts` 影响每个 Lisa 出生的样子，请先开 issue 讨论 |
| **更好的语音方案** | 中 | 目前是 macOS `say` + Whisper，欢迎 ElevenLabs / Piper 集成 |

## 提 PR 的规矩

- 小 PR 优于大 PR。50 行清晰范围 = 几天 merge；2000 行重构 = 卡几周
- commit 信息：小写、祈使句、不要 emoji。`add discord channel adapter`，不是 `🚀 Discord 支持上线!!`
- TypeScript **不要 `any`**（除非写注释解释为什么）。用 `unknown` + 类型缩窄
- 改 `src/soul/*` 或 `src/prompt.ts` 之前**先开 issue 讨论** —— 这些改动影响每个安装 LISA 的人会得到一个怎样的 Lisa

## 报 bug

issue 里写清：跑了什么命令、期望、实际、相关日志、`lisa soul` 输出（请先脱敏 PII）、Node + OS + model 版本。

## 提问

"怎么做 X" → 开 [Discussions](https://github.com/oratis/LISA/discussions)，不要开 issue。

## License

提交即视为同意按 [MIT](./LICENSE) 授权。
