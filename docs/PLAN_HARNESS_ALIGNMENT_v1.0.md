# LISA × DeepSeek Harness 对齐计划 v1.0

> 依据：[RESEARCH_DEEPSEEK_HARNESS.md](./RESEARCH_DEEPSEEK_HARNESS.md)（2026-08-13 调研，2026-08-14 引入本仓）
> 日期：2026-08-14 · 基线：v0.23.0（`9cfe2a3`）· 关联：[ROADMAP_v1.0.md](./ROADMAP_v1.0.md)、[PLAN_FOUNDATIONS_v1.0.md](./PLAN_FOUNDATIONS_v1.0.md)、[PLAN_DISPATCH_v1.0.md](./PLAN_DISPATCH_v1.0.md)、[PLAN_CLOUD_v1.0.md](./PLAN_CLOUD_v1.0.md)
> 文中行号以当前树为准，后续修改会漂移。

## 0. 结论先行

对 LISA 而言，dsh **不是引擎候选，是一面镜子 + 一个新的被指挥对象**。

1. **生态兼容层无事可做。** dsh 花大力气建的兼容面（多提供方 + `apiKeyEnv` 引用、Claude Code `hooks.json`、`SKILL.md`、`mcp__<server>__<tool>` 命名、把 Claude Code / Codex CLI 当子代理），LISA **已经全部有了，部分还更全**。这一层照抄没有增量。
2. **真差距只有三处**，且每一处恰好卡在 1.0 的一条主线上：
   - **H1 能力 seam** — 工具直接 `import fs` / `spawn`，没有可替换的执行世界 → 卡住 Dispatch 的远程执行与 Cloud 的多租户隔离；
   - **H2 权限与沙箱** — 默认关、只包 `bash`、非 macOS 静默降级 → 卡住 Dispatch「闭合本地命令回路」的安全地板与 Sense 的隐私地板；
   - **H3 会话日志的真源地位** — 系统提示词一个字节都不进日志 → 卡住 Reve 的 drift/coherence 度量，也卡住论文的测量工具。
3. **唯一值得写代码"接入"的**：把 `dsh` 加成 `src/integrations/` 的第 11 个 observer / dispatch 目标。既有注册表天然支持，成本一天，收益直接落在 Dispatch 支柱上。
4. **明确不做**：不 fork、不把 dsh 当执行引擎、不引入 Cordis、不做 Code Mode（暂缓）。

一句话：**dsh 免费化的是 harness 管道，而 LISA 的护城河从来不是管道，是 soul / desire / mood / KB / Reve 这一层持久身份——dsh 这一层是零。** 这次调研对 LISA 的价值是"体检报告"，不是"选型报告"。

---

## 1. 逐项对照（现状盘点）

| dsh 概念 | LISA 现状 | 差距 | 结论 |
|---|---|---|---|
| 能力 seam（`ctx.fs` / `ctx.shell` / `ctx.subprocess` / `ctx.sandbox`） | `ToolContext = { cwd, signal, log, onObjection? }`（[types.ts:24](../src/types.ts)）；工具各自 `import fs from "node:fs"` / `spawn` | **大** | **H1 抄** |
| 权限：`sandbox/mode` ×3 + `approval/policy` ×2 + preset，fail-closed | `LISA_SANDBOX` 布尔且默认关（[sandbox.ts:50](../src/sandbox/sandbox.ts)）；只有 `bash` 走沙箱（[bash.ts:34](../src/tools/bash.ts)）；非 macOS **静默降级**（[sandbox.ts:46](../src/sandbox/sandbox.ts)）；`--approval` 默认 `auto`（[cli-args.ts:81](../src/cli-args.ts)） | **大** | **H2 抄** |
| 会话日志唯一真源 / 模型可见 ⟺ 已记录 | JSONL 只写 header / message / reflection（[sessions/store.ts](../src/sessions/store.ts)）；`tool_use`/`tool_result` 在 message 的 content block 里**已在**；但**系统提示词不在**，且中途会热重载（[agent.ts:225](../src/agent.ts)） | **中** | **H3 抄** |
| Agent Preset（用户可复制修改的模式） | 编译期 subset 函数：`readOnlySubset` / `autonomousSubset` / `remoteSafeSubset` / `cloudSafeSubset` / `desireReviewSubset`（[tools/registry.ts:128–306](../src/tools/registry.ts)） | 中 | **P2 缓**（见 §5） |
| 多提供方 + 凭据只存引用 | `OPENAI_COMPAT_PRESETS` 20+ 家含 DeepSeek，`apiKeyEnv` 引用制（[providers/registry.ts:38+](../src/providers/registry.ts)） | **无（LISA 更全）** | 不动 |
| Claude Code `hooks.json` | 已支持同形状 6 事件（[plugins/types.ts:27](../src/plugins/types.ts)、[hooks/runner.ts](../src/hooks/runner.ts)） | 无 | 不动 |
| `SKILL.md` | 已支持；但只有单层 `~/.lisa/skills`（[skills/manager.ts](../src/skills/manager.ts)），无项目级、无热监听 | 小 | **P1 小补** |
| MCP `mcp__<server>__<tool>` | 已同形状（[mcp/client.ts:76](../src/mcp/client.ts)） | 无 | 不动 |
| 把别家 CLI 当子代理 | `src/agents/pty.ts` + `managed.ts` + `dispatch_agent` 已可拉起/接管 claude / codex | **无（等价能力已有）** | 不动 |
| `AGENTS.md` / `CLAUDE.md` 指令链 | **无**（全仓无加载逻辑） | 小 | **P1 小补** |
| goal 三件套（跨轮次目标 + 人类根权限） | `soul/desires` + `desire_progress/revise/close` + `autonomy/runs` | **无（LISA 更强：desire 是人格化长期目标，不只是任务）** | 不动 |
| `session_search` / `session_trace` 模型可见 | 无会话检索工具；有 `memory_search` / `kb_search` | 小 | **P2 缓**（依赖 H3） |
| 压缩：pruner + spill store | `--compact` 直接开 Anthropic 原生 context management（[providers/anthropic.ts:85](../src/providers/anthropic.ts)） | 中 | **P2 缓** |
| Code Mode（`run_code`） | 无 | — | **不做**（见 §4） |
| ACP / SDK 程序化入口 | web server + `contracts/` API contract | 小 | 不动 |
| 桌面 / 移动 / 语音 / 常驻感知 | Mac Island、iOS Pocket、voice、Sense observers | **无（dsh 完全没有）** | 不动 |

**读法**：右侧只有三行写着"大/中 + 抄"。这就是本计划的全部实质。

---

## 2. H1 — 能力 seam：把 `ToolContext` 扩成能力容器

### 问题

LISA 的工具直接 `import fs from "node:fs/promises"`、直接 `spawn`。后果有三个，都已经在路线图上咬人：

- **Dispatch** 想把执行搬到远程/容器里，就得给每个工具写第二份实现；
- **Cloud** 的多租户隔离目前靠 `homeScope` AsyncLocalStorage 兜住 `lisaHome()`（[paths.ts:20](../src/paths.ts)），但 `write` / `edit` / `bash` 的 `ctx.cwd` 不受它管——所以云端只能用 `cloudSafeSubset` 白名单硬砍掉这些工具（[tools/registry.ts:283](../src/tools/registry.ts)）。**白名单是补丁，seam 才是解**；
- **测试**只能靠真实文件系统，没有内存实现。

dsh 的答案：`ctx.fs` / `ctx.shell` / `ctx.subprocess` 是接口，`local` / `sandbox` / `e2b` 是可换的提供方，工具只消费接口。**换提供方 = 换整个执行世界，一行工具代码都不改。**

### 做法（最小可行）

```ts
// src/types.ts — 扩 ToolContext，不改现有字段
export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  log: (msg: string) => void;
  onObjection?: (o: {...}) => void;
  /** 执行世界。缺省 = local 提供方（现行为，逐字等价）。 */
  caps?: Capabilities;
}

export interface Capabilities {
  fs: FsCapability;        // readFile/writeFile/stat/readdir/rm，带根目录约束
  shell: ShellCapability;  // run(cmd) → {stdout, stderr, code}
}
```

- **第一步只做 `fs` 与 `shell` 两个 seam**，提供方只做 `local`；
- 迁移顺序：`read` / `write` / `edit` / `apply_patch` / `ls` / `grep` / `bash` 七个工具改成 `ctx.caps.fs` / `ctx.caps.shell`；其余工具（soul / memory / kb / github / …）**不动**——它们操作的是 LISA 自己的 home，本来就该走 `lisaHome()`；
- `caps` 可选、缺省注入 local 提供方，所以**这一步对外行为零变化**，是纯重构。

### 为什么值得

它同时解锁 H2（沙箱提供方 = 换一个 `fs`/`shell` 实现，而不是在每个工具里加 if）、Cloud 的真隔离（per-uid 根目录的 fs 提供方，白名单可以退回成纵深防御而不是唯一防线）、以及远程执行（Dispatch 的容器化目标）。**一次重构，三条主线受益**——这是整份计划里性价比最高的一项。

### 验收

- [ ] `ToolContext.caps` 落地，local 提供方通过全部现有测试且无行为变化；
- [ ] 七个 fs/shell 工具不再直接 `import node:fs` / `node:child_process`（留一条 lint/grep 断言防回归）；
- [ ] 新增一个内存 fs 提供方，至少 3 个工具测试用它跑，不落盘。

---

## 3. H2 — 权限与沙箱：三档 + fail-closed + 会话级固定

### 问题（按严重度排序）

1. **`write` / `edit` / `apply_patch` 完全不受沙箱约束。** `wrapForSandbox` 唯一调用点是 `bash.ts:34`；三个写工具都是 `path.resolve(ctx.cwd, input.path)`（[write.ts:24](../src/tools/write.ts)、[edit.ts:33](../src/tools/edit.ts)、[apply_patch.ts:58](../src/tools/apply_patch.ts)），绝对路径与 `../` 一律照收。即使 `LISA_SANDBOX=1`，`bash` 被关进 cwd 而 `write` 能写满盘——正是 dsh 明确要避免的「bash 与 fs 限制到不同的根目录」。（对照：KB 写工具是路径 jail 的，[kb/tool.ts:5](../src/kb/tool.ts)——说明这个模式在本仓已被证明可行。）
2. **非 macOS 静默降级成不受限 `/bin/bash -lc`**（[sandbox.ts:46](../src/sandbox/sandbox.ts)）。dsh 的规矩是 `SANDBOX_UNAVAILABLE` 直接拒绝执行。**"以为开了沙箱其实没开"比"没有沙箱"更危险。**
3. **默认全关**：`LISA_SANDBOX` 不设 = 无沙箱，`--approval` 默认 `auto` = 无审批。本地 attended REPL 这样没问题（和 Claude Code 同一姿态），但 1.0 要闭合的是**本地 agent 命令回路**——dispatch 出去的是**无人值守**的运行，那时"默认全关"就不再是合理默认。

### 做法

- **三档 `sandboxMode`**（对齐 dsh 词汇，别自造）：`read-only` / `workspace-write` / `danger-full-access`；
- **在 H1 的 seam 上实现**：`fs-sandbox` 与 `shell-sandbox` 两个提供方共享同一份根目录策略，天然保证两者边界一致；
- **fail-closed**：`workspace-write` 在无可用强制机制的平台（Linux 无 bwrap/Landlock、Windows）**报错拒绝**，不降级。想在这些平台跑，用户须显式选 `danger-full-access`；
- **会话级固定**：模式写进 `SessionHeader`，会话创建时定死，中途改配置不影响进行中的会话；
- **默认值按 surface 分层**（LISA 已有 surface 概念，只是没连到沙箱）：
  | surface | sandboxMode 默认 | approval 默认 |
  |---|---|---|
  | 本地 attended REPL / Island | `danger-full-access` | `auto`（现状不变） |
  | dispatch / 无人值守运行 | `workspace-write` | `auto` |
  | idle / heartbeat（Reve） | `read-only` | `auto`（已有 `autonomousSubset` 兜底） |
  | 渠道（remote-origin） | `read-only` | `auto`（已有 `remoteSafeSubset` 兜底） |
  | cloud | 不适用（无 fs/shell 工具） | — |

  注意最后三行**已经有工具级边界了**——加沙箱是把"能不能拿到工具"的单层防御，变成"拿到了也出不去"的纵深防御。

### 验收

- [ ] `write`/`edit`/`apply_patch` 在 `workspace-write` 下拒绝写出根目录（含 `../` 与符号链接逃逸），有测试；
- [ ] Linux 无 bwrap/Landlock 时 `workspace-write` 抛 `SANDBOX_UNAVAILABLE`，**不**静默降级，有测试；
- [ ] `SessionHeader` 记录 `sandboxMode`，`version` 升到 2 且旧会话可读；
- [ ] `docs/FOOTPRINT.md` / README 的安全叙事同步更新（1.0 判定标准第 2 条：叙事 = 代码）。

---

## 4. H3 — 会话日志成为唯一真源（论文的测量工具）

### 问题

LISA 的会话 JSONL **已经**记录了 `tool_use` / `tool_result`（它们是 `StoredMessage` 的 content block），这点比预想的好。真正缺的是**系统提示词**：

- 系统提示词由 soul + memory + skills + mood + KB 摘要动态构建（[prompt.ts:66](../src/prompt.ts)）；
- 而且**会话中途会热重载**——`soul_patch` / `memory` 写入后，下一轮就换了一份系统提示词（[agent.ts:225–242](../src/agent.ts)），只发一个 `system_prompt_rebuilt` 事件，**不落盘**；
- 结果：**拿着一条历史会话，无法重建当时模型看到的东西**。dsh 的不变量「模型可见 ⟺ 已记录」在 LISA 这里对消息成立、对提示词不成立。

这不是洁癖。ROADMAP §1.0 判定标准第 4 条要求「可复现的自主性度量：Reve 能产出 drift / coherence 指标」，而 drift 的定义就是"她的自我描述随时间怎么变"——**如果日志里没有当时的自我描述，这个指标根本无法离线复算**。同一条也直接卡住论文：长时程连贯性的任何测量，都要求知道每个时点模型看到的 persona 是什么。

### 做法（分两步，第一步很便宜）

**Step 1（低成本，先做）**：新增一类日志条目 `{type:"prompt", ts, fingerprint, text, reason}`，`reason` 区分 `initial`（本次运行的开局提示词）与 `rebuilt`（中途热重载）。

`getPromptFingerprint` 已存在（[prompt.ts:237](../src/prompt.ts)），热重载点也已存在（`agent.ts:228` 的 `if (next.fingerprint !== currentFingerprint)`），改动面很小。体积可控：一份系统提示词几 KB，一次会话通常个位数次重载。`fingerprint` 用正文的内容哈希、连续相同不重复写，所以"第 N 条时生效的提示词"= 最近的前一条 prompt 条目，从不自我修改的长对话只花一条。

**Step 2（可选，之后再说）**：把 `SessionStore` 从"消息日志"推向"事件日志"，加一条运行时断言——任何进入 `provider.runTurn` 的输入都必须能从日志重建。这是 dsh 的完整形态，成本高，**不是 1.0 必需**。

**明确不做**：不抄 `assistant/chunk` 级别的流式保真（LISA 的 UI 不需要逐 chunk 回放），不引入 SQLite 持久化（JSONL 够用，projection cache 等有性能问题再说）。

### 实现中发现的边界（Step 1 已落地，见 PR #357）

`systemPrompt` 是**逐字精确**的。但 `messages` 只是会话正典全量，**不等于每轮真正发出去的消息窗口**：web 表层把 `modelContext.history`（历史的有界后缀）传给 `runAgent`，而会话文件保留完整历史（[web/server.ts:4060](../src/web/server.ts) 的注释自己写明了这点）；CLI 与渠道表层不做窗口，两者一致。

也就是说 H3 的不变量目前对**提示词**成立、对**消息窗口**不成立。做 token 级精确重放的调用方需自行处理；做"她被告知自己是谁"分析的不受影响——而后者正是本项的目的。补上窗口边界记录属于 **Step 2**。

### 验收

- [x] 会话 JSONL 含 `prompt` 条目，`SessionHeader.version` 同步升级（v1 → v2，旧会话仍可读）；
- [x] 写一个离线脚本：读一条历史会话 → 重建每一轮的 `(system, messages)` 输入（`src/sessions/replay.ts` + `scripts/replay-session.ts`，随 #357 落地）；
- [ ] 该脚本成为 Reve drift 指标与论文实验的取数入口（这是本项的真实交付物，不是日志本身）——**还没接上，是下一步**。

---

## 5. I1 — 唯一的"接入"：dsh 成为第 11 个 Dispatch 目标

LISA 的 `src/integrations/` 已有 10 个内建 observer（claude-code / codex / github-pr / opencode / aider / git / shell / takoapi / managed / pty，见 [integrations/registry.ts:52](../src/integrations/registry.ts)），`AgentKind` 是开放字符串联合（[integrations/types.ts:14](../src/integrations/types.ts)），加一种不用改类型。

dsh 是**目前唯一一个既有本地会话文件、又有 headless CLI、还带 star 势能的新 harness**。把它接成 LISA 能观察和指挥的对象，直接服务 Dispatch 支柱「用户跟 LISA 对话即可指挥本机全部其它 agent」。

**两个层级，按成本**：

1. **L1 OBSERVE**：写 `src/integrations/dsh/observer.ts`，读 dsh 的会话日志映射到 `AgentSession`。
2. **L3 COMMAND（L1 之后）**：`dispatch_agent` 增加 `dsh` 后端，用 `dsh --profile headless "job"` 拉起一次性运行。这是 dsh 最稳定的接口（无服务器、跑完退出），比接 ACP/SDK 风险低得多。

**不做**：不接 ACP、不接 dsh SDK、不做 resume-adopt（同 codex 的理由，见 [PTY_AGENTS.md](./PTY_AGENTS.md)）。

### ⚠ 格式核查结果（2026-08-14）：L1 比预估贵得多，**暂缓**

本节原估 L1「约 1 天」，并注明「做之前先确认 dsh 的磁盘格式」。核查做了（读 `deepseek-ai/deepseek-harness` 的 `packages/session/session-persistence-jsonl/src/{format,index}.ts` 与 `docs/subsystems/persistence.md`），**结论推翻了估算**：

| 核查项 | 实际 | 对适配器的影响 |
|---|---|---|
| 物理编码 | **默认 Zstandard**（`session.jsonl.zstd`），且 header 单独占一个可独立解码的首帧；dsh 自带 `zstd-*-decoder.ts` | 不是"读一个 JSONL"。要么实现兼容其分帧约定的 zstd 解码，要么只支持用户显式配了 `compression: 'none'` 的部署 |
| 日志根目录 | `root` 是**必填插件配置、无默认值**（他们明确拒绝默认 `process.cwd()`） | 没有 `~/.claude/projects` 那样的公知路径可监听。适配器得解析当前 profile 的 `cordis.patch.yml` 才知道去哪找 |
| 事件行 | `packChunks` **默认 true**，delta 会被打包成 `text-chunks`/`reasoning-chunks`/`tool-call-chunks` 行，需 `decodeStorageRecord` | 第二层解码 |
| 目录布局 | `<root>/--<cwd 转义>--/<会话 id 转义>/session.jsonl[.zstd]`，转义规则自定义（`~XXXX`） | 可实现，但要照抄两套转义函数 |
| 版本 | `SESSION_FORMAT_VERSION`，遇到不认识的版本主动拒绝，且 README 不给兼容承诺 | 每次 dsh 升版都可能要跟 |

**决定：L1 暂缓，不写投机适配器。** 在本机没有装 dsh、无法对真实产物验证的情况下照着源码猜一个解析器，正是 [OBSERVER_FIDELITY.md](./OBSERVER_FIDELITY.md) 记录过的那类问题——单测能证明解析逻辑对得上 fixture，证明不了 fixture 对得上真实工具写出来的东西。

**重新排期**：
- **先做 L3**（`dispatch_agent` 的 dsh 后端）。它依赖的是 README 明文承诺的 CLI 契约（`dsh --profile headless "job"` → 跑完打印最终答案退出），面比磁盘格式窄得多、也稳定得多，而且不需要先有 L1。原文把 L1 排在 L3 前面是错的。
- **L1 的前置条件**：本机装一个真实 dsh、跑出几个会话、按 `scripts/verify-observers.ts` 的路子对真实产物核对字段。没有这一步就不要开工。

### 验收
- [ ] （L3）`dispatch_agent(backend:"dsh")` 能跑通一个真实任务并回收输出；dsh 未安装时给出清晰错误而非崩溃；
- [ ] （L1，前置满足后）`lisa` 能在 hub 里列出正在跑的 dsh 会话，字段深度对齐 Tier-2 基线；
- [ ] （L1）dsh 未安装 / 格式变更时适配器降级为"不可见"，不报错、不崩 hub。

---

## 6. 明确不做

| 项 | 理由 |
|---|---|
| fork dsh 主干 | Developer Preview + 219 包 + 每文件 100% 覆盖率门禁；LISA 是单人维护 |
| 把 dsh 当 LISA 的执行引擎 | LISA **自己就是 harness**，不是需要引擎的产品壳。接进来等于两套工具层 + soul/memory 状态被劈成两半，是净负债 |
| 引入 Cordis | 元框架的收益在"219 个包要解耦"时才兑现；LISA 32 个 `src/` 模块、单人维护，收益 < 认知成本。**只抄 seam 这一个概念，不抄框架** |
| Code Mode（`run_code`） | 省 token 是真的，但它要求工具管线可重入 + worker vm 沙箱，前置是 H1+H2 全做完。**H1/H2 落地后再评估**，不进 1.0 |
| 抄 Agent Preset 的完整形态 | LISA 的 subset 函数已经覆盖了核心用例，且**安全边界写在代码里比写在用户可编辑的 yml 里更难被绕过**。用户可编辑的 preset 是 2.0 话题 |
| 追 dsh 的 rc 版本 | 观察 1–2 个月的破坏性变更频率，再决定 I1 的适配器要不要加固 |

---

## 7. 排期

状态列更新于 2026-08-14。

| 优先级 | 项 | 规模 | 服务的支柱 | 状态 |
|---|---|---|---|---|
| **P0** | H3 Step 1 提示词入日志 + 离线重建脚本 | **小** | Reve / **论文** | ✅ #357 |
| **P0** | H1 能力 seam（fs + shell，local 提供方） | 中（纯重构，行为零变化） | Dispatch / Cloud / 测试 | ✅ #358 |
| **P0** | H2 沙箱三档 + fail-closed + 会话级固定 | 中（依赖 H1） | Dispatch / Sense / Foundations | ✅ #359（栈在 #358 上） |
| **P1** | `AGENTS.md` / `CLAUDE.md` 指令链加载 | 小 | 生态兼容 | ✅ #360 |
| **P1** | Skills 加项目级目录 | 小 | 生态兼容 | ✅ #360 |
| ~~P1~~ | ~~Skills 热监听~~ | — | — | ❌ 不做：skills 本来就经提示词指纹每轮重读，加 chokidar 依赖是纯冗余 |
| **P1** | H3 的取数入口接进 Reve drift 指标 / 论文实验 | 小 | **论文** | 待做（H3 的真实交付物） |
| **P1** | I1 **L3** dsh dispatch 后端 | 小 | Dispatch | 待做（**已提到 L1 前面**，见 §5 的格式核查） |
| **P2** | 按 surface 收紧无人值守沙箱默认值（§3 的表） | 小 | Foundations | 待做（会改行为，单独一步） |
| **P2** | H3 Step 2：记录消息窗口边界 | 中 | 论文精确性 | 待做（见 §4 的边界说明） |
| **P2** | 工具结果 pruner + spill store | 中 | 成本 | 待做 |
| **P2** | `session_search` 模型可见工具 | 小（依赖 H3） | 记忆 | 待做 |
| **暂缓** | I1 **L1** dsh observer | **大**（原估"小"，核查后推翻） | Dispatch | ⛔ 前置未满足，见 §5 |
| **缓** | Code Mode / 用户可编辑 preset | 大 | — | — |

**建议起手**：**H3 Step 1**。它最小、最独立（不依赖 H1/H2）、且直接产出论文要用的测量工具——先拿到"能离线重建每一轮模型输入"这个能力，后面的 drift/coherence 实验才有地基。然后做 H1，H2 自然长在 H1 上。

*（回看：这个顺序是对的。H3 独立落地，H1 是纯重构、行为零变化，H2 只是在 H1 的 seam 上加一个提供方——如果先做 H2，那三个洞就得在七个工具里各补一遍。）*

---

## 8. 风险

| 风险 | 说明 | 处置 |
|---|---|---|
| H1 重构面广 | 七个高频工具 + 全部相关测试 | 分两个 PR：先加 `caps` 与 local 提供方（不改工具），再逐个迁移工具；每步跑全量测试 |
| H2 收紧默认值会破坏现有用户流程 | dispatch / idle 收到 `read-only` 后可能失败 | 本地 attended 姿态**保持不变**；只对无人值守 surface 收紧，且先出一版只 warn 不 enforce |
| H3 日志体积 | 每次热重载写全文系统提示词 | 只在 fingerprint 变化时写；观察实际体积，超标再改为 fingerprint 引用 + 单独的 prompt 内容池 |
| dsh 磁盘格式变更 | `SESSION_FORMAT_VERSION = 0`，无兼容承诺 | I1 适配器对未知字段宽容、解析失败降级为"不可见"；不把 hub 的稳定性押在它上面 |
| 被"抄 dsh"带偏节奏 | ROADMAP 的核心诊断是"每版加一个新大件而不打深" | 本计划的 P0 三项**全部是把已声称的能力做实**（沙箱、隔离、可复现度量），没有一项是新大件。I1 是唯一新增，且落在既有注册表里 |

---

## 9. 与论文的衔接

用户的论文方向是**长时程连贯性（主线）+ soul 稳定性机制（消融）**，目标 COLM/ICLR 2027。本计划里与之直接相关的只有一项，但很关键：

**H3 = 论文的测量工具。** 没有"每一轮模型看到的 persona 是什么"的完整记录，drift 与 coherence 都只能在线测、无法离线复算、无法对同一批会话跑多种指标、无法做消融。H3 Step 1 是几百行的改动，却是把 LISA 的纵向部署数据从"日志"变成"数据集"的那一步。

其余各项（H1/H2/I1）是工程债与产品能力，与论文无关——**不要为了论文去做它们，也不要用论文当它们的理由**。
