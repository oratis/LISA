# LISA 1.0 推进计划 — Sense · Dispatch · Reve · Model

> 方法：在 v0.9.1 树（commit `43442d5`）上并行盘点四支柱现状（感知 / 调度 / 反思 / 模型），
> 交叉对照 [PRODUCT_REVIEW_v0.9.md](./PRODUCT_REVIEW_v0.9.md)、[AUTONOMY_ROADMAP.md](./AUTONOMY_ROADMAP.md)、
> [ORCHESTRATOR_PLAN.md](./ORCHESTRATOR_PLAN.md)，得出"从 0.9 到 1.0 还差什么"。
> 日期：2026-06-13。基线：v0.9.1。文中行号以当前树为准，后续修复会漂移。
>
> **重要前提**：v0.9.1 已关闭 v0.9 review 的全部 P0（`serve --web` 无鉴权 LAN-RCE、渠道全工具暴露、
> 自主循环无工具边界、飞书不验签、两个 advisor 假告警、soul 裸写锁）。本计划以该安全基线为**地板**，
> 1.0 的任何新能力都不得把它推回去。排期前请对当前树复核这些修复仍然成立。

---

## 详细模块计划（本路线图的实现展开）

本文是**战略路线图**；每个支柱的**可执行实现计划**（设计 / 数据结构 / 分子阶段 / 验收清单 / 测试 / 风险）拆到下列文档：

| 文档 | 覆盖 | 对应本文 |
|---|---|---|
| [PLAN_SENSE_v1.0.md](./PLAN_SENSE_v1.0.md) | 常驻感知：observer 深化 + git/shell 源、在场判定、ambient vision/voice、剪贴/选区、蒸馏 | §3 |
| [PLAN_DISPATCH_v1.0.md](./PLAN_DISPATCH_v1.0.md) | 统一指挥：本地命令回路、TakoAPI consumer（shim + A2A）、能力路由、advisor 债 | §4 |
| [PLAN_REVE_v1.0.md](./PLAN_REVE_v1.0.md) | 反思/进化硬化：质量门禁、可观测、有界、soul 速览、desire 中间态、recap 回流 | §5 |
| [PLAN_MODEL_v1.0.md](./PLAN_MODEL_v1.0.md) | 模型：本地生命周期、本地 embedding、容错+自检、provider 欠账 | §6 |
| [PLAN_FOUNDATIONS_v1.0.md](./PLAN_FOUNDATIONS_v1.0.md) | 横切：consent/隐私、安全地板、测试门禁、可观测、footprint、叙事诚实 | §7 |

> 阅读顺序建议：先本文（为什么 + 顺序），再 FOUNDATIONS（地基），再按里程碑顺序读 REVE → MODEL → DISPATCH → SENSE。

---

## 0. 愿景与"1.0"的定义

LISA 1.0 把现有的"灵魂叙事"（Soul · Desires · Heartbeat · Dreams）重新切成一条**能力架构主线**：

| 支柱 | 一句话 | 现有系统基础 |
|---|---|---|
| **Sense（感知）** | 一个常驻进程，从视觉、语音、指针/选区、截屏、剪贴，以及本机所有 CLI / AI-agent / coding 活动里持续获取上下文与记忆，建立对用户工作的全面记录 | 部分：on-demand vision/voice + 5 个 agent observer + idle watcher |
| **Dispatch（调度）** | 全面接入所有 coding agent 与 AI-agent 服务，与 **TakoAPI**（one API to access all agents）联动；用户跟 LISA 对话即可指挥本机全部其它 agent（+ 远程 agent） | 部分：observe + headless launch，**命令回路未闭合**；TakoAPI 是外部托管网关、LISA 侧未接入 |
| **Reve（反思 / 进化）** | 用户不在时自动反思、自演化 | 最成熟：idle/dreams + reflect + heartbeat + soul 全闭环 |
| **Model（模型）** | 当前用 API，后续提供本地模型部署选项 | 部分：20+ provider 前缀路由，本地仅"自带 endpoint" |

**"Reve" = 现有 Dreams 系统的正式更名**（rêve / 梦）。它不是新东西，而是把 idle 反思 + 反思 + 心跳 + 灵魂演化收编为一个有名字的支柱。

### 1.0 的判定标准（什么时候能叫 1.0）

1. **四支柱各自跨过可信阈值**：不是"demo 能跑"，而是"能当 daily-driver 且不撒谎"。
2. **叙事 = 代码**（v0.9 review 的核心批评）：README / PITCH / 官网说的每一句，第一个认真读代码的 contributor 都能对上。
3. **守住 v0.9.1 安全地板**：**常驻感知（Sense）是 1.0 最危险的隐私/攻击面扩张，本地 agent 命令回路（Dispatch）次之**——不得重开 RCE，不得在无 consent 下采集。（接入 TakoAPI 当 consumer 反而是小事——出站调用为主，见 §4。）
4. **可复现的自主性度量**：Reve 能产出 drift / coherence 指标（直接服务[论文计划](#9-与研究目标论文的衔接)）。

### 一条贯穿的张力：先打深，再铺宽；隐私优先

v0.9 review 的诊断一针见血：**项目每个版本都在加一个新大件（编排器 / vision / island / screen advisor / voice），而不是把已有的打深讲清；建设量与认知度严重倒挂，叙事跑在代码前面，攻击面涨得比信任快。**

1.0 不能重犯这个错。具体到本计划：

- **Sense 的"常驻采集屏幕 / 语音 / 剪贴"是一颗隐私炸弹**，必须把**同意模型与本地处理**作为头号设计约束，而不是事后补丁。能不离机就不离机，能不常驻就先做"按需 + 显式触发"。
- **Dispatch 把信任面算清**：接入 TakoAPI（外部网关）的风险主要在**出站**——远程 agent 响应当作不可信输入（二阶注入）、护好 `TAKO_KEY`。真正的"安全炸弹"是**闭合本地 agent 命令回路**与（可选的）把 LISA 作为 publisher 暴露给公网；第一性原则是**最小权限 + 审计 + 人类批准闸 + 远程来源默认禁**。
- **Reve 已经够深，1.0 对它的工作是"硬化"不是"加功能"**——这正好是 review 想要的方向。
- **每个支柱都遵循"深化现有 → 谨慎新增"**：先把已经声称的能力做实（5 个 observer 的非-Claude 深度、本地模型的生命周期、反思的质量门禁），再去碰常驻采集、TakoAPI 原生接入这种更大的扩张。

---

## 1. 四支柱 ↔ 现有系统映射

```
        ┌──────────┐      ┌───────────┐      ┌──────────┐
  用户 → │  SENSE   │ ──▶  │  DISPATCH │ ──▶  │   REVE   │ → "你不在时我做了…"
        │ 感知/记录 │      │ 指挥/编排  │      │ 反思/进化 │
        └────┬─────┘      └─────┬─────┘      └────┬─────┘
   观察用户 + agent 活动    指挥本机其它 agent     空闲自演化、写灵魂
             │                  │ (← TakoAPI 远程)  │
             └───────── 统一工作记忆 MEMORY ────────┘
                                │
                       ┌────────┴────────┐
                       │      MODEL       │  贯穿四层的推理基座
                       │  API / 本地模型   │
                       └─────────────────┘
```

| 1.0 支柱 | 收编 / 依赖的现有模块 |
|---|---|
| **Sense** | `src/integrations/*`（hub + 5 observer）、`src/vision/capture.ts`、`src/screen_advisor/engine.ts`、`src/voice/*`、`src/idle/watcher.ts`、`src/memory/*`、`src/web/server.ts`（screen-advisor loop）、`src/autostart/install.ts` |
| **Dispatch** | `src/tools/{dispatch_agent,signal_agent,compare_agents,scheduled_dispatch,inspect_agent,list_agents,agent_recap}.ts`、`src/integrations/{hub,dispatch-ledger,scheduled-dispatch,comparisons}.ts`、`src/channels/router.ts`、`src/mcp/client.ts` ＋ **TakoAPI 接入（A2A + OpenAI shim）** |
| **Reve** | `src/idle/runner.ts`、`src/reflect.ts`、`src/heartbeat/{runner,config}.ts`、`src/soul/{store,tools,git}.ts`、`src/orchestrator/{journal,recap}.ts` |
| **Model** | `src/providers/*`、`src/llm.ts`、`src/env.ts`、`src/memory/vector.ts`（embedding） |

**与公开叙事的关系**：现有对外主线是 Soul · Desires · Heartbeat · Dreams（内在生活故事），它整体落在 **Reve + Model 基座**里。Sense 与 Dispatch 是 1.0 对外的能力扩张面。两套叙事不冲突：**Reve 是"她是谁"，Sense/Dispatch 是"她替你做什么"**。1.0 的对外定位建议仍以灵魂线为主钩（review 的结论），Sense/Dispatch 作为"她还能看你的工作、指挥你的 agent 舰队"的能力点。

---

## 2. 现状盘点（四支柱速查）

### Sense — 感知（成熟度 ~30%，按需而非常驻）

| 能力 | 现状 | 关键文件 | 缺口 |
|---|---|---|---|
| 屏幕截图 | ✅ 按需（hotkey / 📷）+ 可选周期 advisor（默认关、≥10min） | `vision/capture.ts`、`screen_advisor/engine.ts` | 无连续采集、无 OCR、不知前台 app/窗口 |
| 语音 | ✅ TTS（`say`）+ 文件转写（Whisper）+ 听写润色 | `voice/{speak,transcribe,dictation}.ts` | 无常驻听写、无录音、无热键、纯云依赖 |
| 剪贴 / 选区 / 指针 | ⚠️ 仅 web composer 粘贴 | `web/lisa-client.ts` | 全局剪贴、跨 app 选区、指针/焦点全无 |
| Agent / CLI 活动 | ✅ 5 observer（claude-code 最深，codex/opencode Tier-2，aider 文件+轮次，github-pr 元数据） | `integrations/{claude-code,codex,opencode,aider,github-pr}/observer.ts`、`hub.ts` | 无通用 shell 历史 / IDE / git / 构建进程观察；非-agent 的 CLI 全盲 |
| 在场/离开判定 | ⚠️ 仅靠"是否在跟 LISA 交互" | `idle/watcher.ts` | 不读系统 idle / 锁屏；用户在 VS Code 干活也算 idle |
| 常驻进程 | ⚠️ `serve --web` 是反应式 web 后端 | `web/server.ts`、`autostart/install.ts` | 无独立的"持续采集"循环，依赖 fs.watch + 定时器被动触发 |
| 工作记忆 | ✅ 文本 memory + TF-IDF 检索 | `memory/{store,vector}.ts` | 无自动抽取、无多模态、无实时索引 |

### Dispatch — 调度（成熟度 ~45%，能观察能拉起，不能"指挥"）

| 能力 | 现状 | 关键文件 | 缺口 |
|---|---|---|---|
| Headless 拉起 agent | ✅ 4 家 CLI（claude/codex/opencode/aider），detached + 账本 | `tools/dispatch_agent.ts`、`integrations/dispatch-ledger.ts` | 仅 fire-and-forget；硬编码 4 家、不可扩展 |
| 停止 agent | ✅ 仅杀自己账本里的 pid（SIGTERM→KILL） | `tools/signal_agent.ts` | 不能 pause / 注入 / 改任务 |
| 冲突避免 | ✅ 同 cwd 有活跃 agent 则拒绝 | `tools/dispatch_agent.ts` | 状态式、非持久 ownership/lock |
| 调度面板 | ✅ list / inspect / compare（worktree 并行）/ scheduled / recap | `tools/{list_agents,inspect_agent,compare_agents,scheduled_dispatch}.ts` | 建议动作多为死标签，回路未闭 |
| **命令回路** | ❌ 单向：拉起后无反馈、approval 不回传、输出不回流 | — | **1.0 核心缺口** |
| **TakoAPI** | ⚠️ 外部托管服务（"OpenRouter for agents"，A2A + OpenAI shim），LISA 侧零接入 | 见 §4 | **接入而非自建**：consumer 先行（OpenAI shim 近免费）+ 可选 publisher |
| 渠道触发 dispatch | ⚠️ 默认远程禁用，需 `unsafeFullTools` | `channels/router.ts`、`tools/registry.ts` | 全或无，无细粒度/审批流 |

### Reve — 反思 / 进化（成熟度 ~70%，最成熟，缺质量门禁与可观测）

| 能力 | 现状 | 关键文件 | 缺口 |
|---|---|---|---|
| 空闲反思（dreams） | ✅ idle≥~1h 触发，跨进程锁，受限工具集，输出"while you were away" | `idle/{watcher,runner}.ts` | 无决策日志/可追溯；单窗口只做一件事 |
| 会话末反思 | ✅ 产出 journal + memory/skill/feel/opinion/desire/soul 操作 | `reflect.ts` | JSON 坏掉静默降级；无"反思不足"检测 |
| 心跳（heartbeat） | ✅ cron/launchd；用户任务 + 自驱欲望 + 周度自省；token 预算闸（默认 500k） | `heartbeat/{runner,config}.ts` | 无任务成功率度量；desire 能力/野心错配 |
| 灵魂演化 | ✅ desire→heartbeat→progress→reflect 压缩→close 全闭环；git 可追溯；情绪衰减+事件 | `soul/{store,tools,git}.ts` | 无人读的"Lisa 速览"；并发锁仅部分铺开 |
| 编排器 recap | ✅ 隐私安全的跨 agent 事件流 + recap | `orchestrator/{journal,recap}.ts` | **未接进 Reve 的反思**，单向可观测 |

### Model — 模型（成熟度 ~60%，多 provider 干净，本地仅"自带 endpoint"）

| 能力 | 现状 | 关键文件 | 缺口 |
|---|---|---|---|
| Provider 路由 | ✅ 模型名前缀路由 + 14 家 OpenAI 兼容预设 | `providers/registry.ts` | 同名模型路由歧义；无自动检测 |
| 本地模型 | ⚠️ 仅"自带 endpoint"（`LISA_BASE_URL` 指向 Ollama/LM Studio/vLLM） | `providers/openai.ts`、`docs/PROVIDERS.md` | **无下载/启动/管理生命周期**；崩溃无 fallback |
| Embedding | ⚠️ TF-IDF（无语义） | `memory/vector.ts` | 无本地语义向量；不可扩展 |
| 容错 | ❌ 无 provider fallback 链 | — | 主 provider 报错即断 |

---

## 3. SENSE — 常驻感知层

### 1.0 目标态

一个**单一常驻服务**，在用户**显式授权的每一类信号**上持续采集，本地优先处理，沉淀为统一的工作记忆——既覆盖"用户在干什么"（屏幕/语音/选区/剪贴），也覆盖"机器上的 agent 与 CLI 在干什么"（现有 observer + 通用 CLI/git/IDE）。**默认最小、逐项 opt-in、能不离机就不离机。**

### 缺口（按风险从低到高排）

1. **agent observer 深度不均**：claude-code 最深，其余三家活动字段稀疏，aider 几乎只有文件+轮次，无通用"非-agent CLI"观察。
2. **无通用工作信号源**：shell 历史、git 提交/分支、IDE 打开的文件、构建/测试进程全盲。
3. **在场判定太弱**：只认"是否在跟 LISA 说话"，不读系统 idle / 锁屏 / 前台 app。
4. **vision/voice 是按需而非 ambient**：截图靠热键、转写靠用户给文件路径。
5. **剪贴/选区/指针全无**：全局剪贴、跨 app 选区、焦点窗口零采集。
6. **无自动 context→memory**：采集到的东西不会自动蒸馏进记忆；记忆是文本、手动、非实时。

### 分阶段任务

**S1 — 深化已声称的观察（低风险，最高可信，先做）**
- 把 codex / opencode / aider observer 的 Tier-2 活动字段补齐到与 claude-code 同档（`lastTools` / `filesTouched` / `pendingPermission` / `cost`），让 6 个 advisor detector 对它们真正触发——兑现"看你所有 agent"的承诺（review §4.3 指出此前只兑现 1/5，0.9.1 已部分推进，1.0 收口）。
- **新增低风险工作信号源**（不碰系统级权限）：
  - **git observer**：watch 各 repo 的 `.git/HEAD`、提交、分支切换、`git status` 摘要。
  - **shell 历史 observer**：尾随 `~/.zsh_history` / `~/.bash_history`（仅 argv[0] + 时间，**不存完整命令**，沿用 observer 的隐私分层）。
  - **构建/测试信号**：从已观察的 agent 日志里抽 `npm test` / `cargo test` 等结果（无需新权限）。
- 产出：把这些并入 `hub.ts` 的统一 `AgentSession[]`/事件流，复用现有隐私 tier 与测试范式（planted-secret 测试）。

**S2 — 从按需到 ambient 的 vision + voice（中风险，consent 闸是前提）**
- vision：把 `screen_advisor` 的"周期截图"泛化为**可配置 ambient 采集**（前台 app/窗口标题 + 低频截图），但：
  - 默认关闭；开启需显式 consent 卡（一次性，可随时撤销）。
  - **本地优先**：先在本地做"是否值得上报"的轻量判定（前台 app 变化 / 出现错误对话框），只有命中才考虑送模型；截图**绝不持久化**（沿用现有 finally 删除）。
  - 加"敏感区域屏蔽 / 黑名单 app（密码管理器、银行）"。
- voice：补**录音 + 热键 + 流式转写**（现在只有"给文件路径才转"），同样默认关、需 consent；探索本地 STT（whisper.cpp）作为离机选项。

**S3 — 剪贴 / 选区 / 指针（高风险，严格 opt-in，最后做）**
- 全局剪贴监听（macOS `NSPasteboard` changeCount 轮询 / Linux X11/Wayland 选区）：默认关，逐项开关，**只记元数据 + 来源 app，不默认回传内容**。
- 跨 app 选区 → "用户刚在 X 里选了一段，要不要就这段聊"——这是体验最强、隐私最敏感的一项，放在 consent 体系最成熟之后。
- 指针/焦点仅用于在场判定（见下），不做轨迹记录。

**S4 — 统一记忆与本地化处理（贯穿 S1–S3）**
- **自动 context→memory 蒸馏**：一个后台低频任务把"今天观察到的工作"蒸馏成 1–2 条记忆（"在 repo X 上为 feature Y 调试 Z"），写进 `memory/store.ts`，受 Reve 的反思质量门禁约束。
- **在场判定升级**：接 macOS `ioreg`/`CGEventSource` 系统 idle 与锁屏，替代"只认 LISA 交互"——让 Reve 的 dreams 触发更准（用户在 VS Code 忙时不该判 idle）。
- **本地 embedding**（与 Model 支柱共用）：给 `memory/vector.ts` 加一层语义向量（本地 sentence-transformer / Ollama embedding），TF-IDF 保留为快路。
- **常驻架构**：把"采集"从反应式 web server 里拆出为一个独立的、不依赖 GUI 打开的后台采集循环（autostart 已有 launchd 壳），事件驱动 + 低频轮询，绝不阻塞 chat。

### 隐私 / 安全约束（本支柱头号）
- **同意模型是地基不是补丁**：每一类信号（屏幕/语音/剪贴/选区/shell）独立开关，默认全关，UI 里随时可见"现在在采什么"并一键全停。
- **本地优先**：raw 截图/音频/剪贴在本地完成蒸馏/判定，只有命中且必要才送模型；持久化的永远是结构化摘要，不是原始流。
- **黑名单**：app 级（密码/银行/隐私浏览）、路径级、PII 模式级屏蔽。
- 复用 observer 既有的隐私分层与 planted-secret 测试，扩展到每个新信号源。

---

## 4. DISPATCH — 统一指挥层 + TakoAPI

### 1.0 目标态

用户对 LISA 说一句话，LISA 能**指挥本机的（乃至 TakoAPI 背后远程的）任意 agent**：选对 agent、派活、看进度、转发审批、把结果接回对话、必要时纠偏或停止——而不是现在的"拉起来就不管了"。**TakoAPI（独立的"OpenRouter for agents"托管网关）补上"远程 agent"那一半：LISA 接入它，对话即可触达本机之外、A2A 生态里的任意 agent；本地 agent 的编排仍是 LISA 自己的活。**

### TakoAPI 是什么（已核对实物，2026-06-13）

> 已直接审阅 `/Users/oratis/Documents/Claude/TakoAPI`（**独立 repo**，Next.js 16 + Prisma + Cloud Run，线上 takoapi.com）。**它不是 LISA 内部要造的东西，而是一个独立托管服务**，定位 **"OpenRouter for agents"**：*one API key, one bill, any agent*。registry-first、gateway fast-follow；D1–D8 战略决策已于 2026-06-13 全部拍板（A 终局代理网关 + A2A 主协议 + OpenAI shim 引流 + OpenRouter 式变现）。

三层：
- **Registry（发现）**：基于开放的 **A2A AgentCard**（`/.well-known/agent-card.json`）描述 agent。`GET /api/registry?q=&format=json`、`GET /api/agents/{slug}`。**Phase 1 已完成并本地验证。**
- **Gateway（调用，`Authorization: Bearer <TAKO_KEY>`）**：`POST /v1/agents/{slug}/message`（A2A）、`/v1/agents/{slug}/stream`（SSE）、`POST /v1/chat/completions`（**OpenAI 兼容 shim**，`model` = agent slug）。**v1 路由已存在于代码**（message / stream / chat-completions + `lib/agentcard.ts` / `lib/apikey.ts`），Phase 2 网关基本成形；生产 DB 升配 + PgBouncer + Upstash Redis 为 Phase 2A 前置，待办。
- **Commercial（变现）**：prepaid credits + 充值费 + publisher 分成，Phase 3，未做。

**对 LISA 最关键的一条认知**：TakoAPI 管的是**远程 agent**（A2A server / OpenAI 兼容端点），LISA 现有 Dispatch 管的是**本机 CLI agent**（spawn / observe 本地进程）。**两者互补、不重叠**——合起来才是"指挥所有 agent，本地 + 远程"。因此 LISA **不需要自建网关 / registry / billing**（TakoAPI 就是这一层），LISA 要做的是**接入**（当 consumer，可选当 publisher）。这把 Dispatch 支柱的范围**缩小**了：不是从零设计 agent 控制契约，而是对接 **A2A + OpenAI-shim 两个现成协议**。

### 缺口与分阶段

**D1 — 闭合命令回路（1.0 的核心工程，最高优先）**
- **反馈回流**：`dispatch_agent` 现在 fire-and-forget；加进度/结果流（poll 或 events），把 agent 的产出接回 LISA 的对话与决策。
- **审批转发（approval relay）**：被拉起的 agent 卡在权限提示时，信号上报 LISA → 用户在 LISA 里确认 → 回传给 agent。这是"指挥"与"放养"的分水岭。
- **中途转向（steer）**：能改任务、注入上下文，而非只会 kill。
- 安全：以上每一步都**默认带人类批准闸**，远程来源（渠道）默认禁用（守住 0.9.1 线）。

**D2 — 接入 TakoAPI（两个方向，consumer 先行）**

*方向一：LISA 作为 TakoAPI consumer——让 LISA 能指挥远程 agent*
- **(a) OpenAI-shim 快路（近乎免费，最早可落地）**：LISA 已有 OpenAI 兼容 provider 路由 + `LISA_BASE_URL`（见 [Model 支柱](#6-model--从自带-endpoint-到真本地部署)）。把一个 provider 指向 `https://takoapi.com/v1`、配 `TAKO_KEY`、`model=<agent-slug>`，即可把任意 TakoAPI agent 当成一个"模型"来调用——几乎零新代码。可在 0.12 随手落地。
- **(b) A2A 原生 adapter（更深，0.14）**：给 hub/Dispatch 加一个 `takoapi` agent 源——`GET /api/registry` 列远程 agent，`POST /v1/agents/{slug}/message` 派活、消费 SSE、按 A2A `TaskState` 跟踪。让远程 TakoAPI agent 成为 hub 里与本地 CLI agent 平起平坐的一等公民（正是 [ORCHESTRATOR_PLAN.md](./ORCHESTRATOR_PLAN.md) taxonomy 的 Class B 云 agent）。
- **远程 agent 的"命令回路"基本由 A2A 协议自带**（`TaskState` + SSE + push webhook），LISA 不必自造——与 D1 形成对照：**本地 CLI agent 的回路要 LISA 自己闭（D1），远程 agent 的回路继承 A2A（D2）**。

*方向二：LISA 作为 TakoAPI publisher（可选，战略性，1.0 后）*
- 让 LISA 自己（或她编排的本地 agent）以 A2A AgentCard 形式上架 TakoAPI，被整个生态调用。需要 LISA 暴露 `/.well-known/agent-card.json` + A2A `message/send` 入站端点——LISA 现有的 **webhook channel 已经很接近** A2A 入站形态，可在其上演进；同时帮 TakoAPI 冷启动供给侧（LISA = 一个种子 agent）。但这把 LISA 变成"对公网可被调用的服务"，安全面再扩一层 → 放 1.0 之后、consent/安全体系成熟后再做。

*MCP*：TakoAPI 把 MCP 聚合列为后置；LISA 这边把本机 MCP server 纳为一等 dispatch 目标仍是 LISA 自己的事（与 TakoAPI 解耦，保留在路线里）。

**D3 — 能力注册与路由（dispatcher brain）**
- agent 声明擅长什么（重构/测试/文档…），LISA 据此**选对 agent**派活（"这个交给 Claude Code，那个交给 aider"）。
- 跨 agent token 预算（现在 scheduled-dispatch 只限次数不限 token）。
- 持久化 cwd ownership / lock（用 `soul/lock.ts` 的 link 互斥），把冲突避免从"反应式"变"前置预约"。

**D4 — 把 review 留下的 dispatch 债清掉（1.0 前必清）**
- island 上 advisor 的建议动作接成**可点按钮**（cancel→signal 端点；dispatch/approve→prefill composer，**绝不自动执行**）——review 称之为"生死线的闭环"。
- 多 agent 监控前端：后端已发 `agent_session_update`，前端只消费 `claude_session_update`，补齐。
- 把 `dispatch_agent` / `github` 写操作纳入 mutating 工具集（review §3.8 指出此前连 `--approval ask-mutating` 都拦不住）——复核 0.9.1 是否已修，未修则补。

### 安全
- 接入 TakoAPI 的新攻击面主要在**出站**：**把网关返回的远程-agent 响应当作 hostile**（二阶 prompt injection——TakoAPI 自己的技术架构文档 §11 也强调上游响应不可信）；保护 `TAKO_KEY`（走 `config.env`，已 0600）。若日后做 publisher（方向二），LISA 变成可被公网调用的服务，那才是入站面，留到 consent/安全体系成熟后。
- 本地 dispatch 仍守 v0.9.1 线：`dispatch_agent` / `signal_agent` / `scheduled_dispatch` 远程来源默认禁、人类批准闸、审计账本（`dispatch-ledger.ts`）。
- approval relay（D1）防伪：转发的审批必须能验证来源是真 LISA 用户，而非被注入的渠道消息。

---

## 5. REVE — 自主反思与进化

### 1.0 目标态

把**已经很成熟的自演化闭环**从"能跑"提升到"可信、可观测、有边界、可度量"。**1.0 对 Reve 的工作是硬化与可观测，不是加新能力**——这正是 v0.9 review 想要的方向，也直接喂[论文](#9-与研究目标论文的衔接)。先把 Dreams 在全代码/文档里正式更名 **Reve**。

### 任务（全部是"做实"而非"做新"）

**R1 — 反思质量门禁**
- `reflect.ts` 的 JSON 坏掉时现在静默降级（返回空 applied）。加：解析失败告警 + 重试 + 记录；"反思不足"检测（一段实质会话却 0 操作时标记）。
- 情绪 delta 一致性：reflect 的 feel op 与 `soul_feel` 行为对齐（先衰减再叠 delta）——review §4.2 指出二者不一致，复核 0.9.1 是否已修。

**R2 — heartbeat / idle 可观测与边界**
- **任务成功度量**：现在只记最终文本，分不清"真做完"与"agent 说了句 no update 其实没跑"。加结构化成功/失败记录。
- **自主循环成本断路器**：heartbeat 有 500k token 预算闸，**idle 没有**——补上，防止长 idle 窗口烧钱。
- **收敛/有界**：idle 单窗口"只做一件事"在长窗口下会积压；定义"做几件、何时停"的有界策略。
- 在场判定升级见 [Sense S4]——让 dreams 触发更准。

**R3 — 灵魂可观测（给人看，不只给 LLM 看）**
- `lisa soul summary` / GUI 卡片："Lisa 今天：好奇 0.45 · 想做 [X,Y] · 相信 [A,B]"。现在情绪/欲望/opinion/git 历史只有 LLM 自己读，营销权重 > 可感效用（review §4.2）。
- 把并发锁铺全：`appendJournal` / 情绪写入 / `commitSoulChange` 都包 `withSoulLock`（review §4.2 指出此前裸 RMW，0.9.1 已修一批，1.0 收口并复核 git commit 不再被 swallow）。

**R4 — desire 能力/野心错配**
- 现在 desire 要么 actionable（能跑）要么不能；若一个欲望需要 shell 而自主循环没 shell，就只能干瞪眼累积 frustration。加中间态："想做但需要你帮忙跑"——自动落一条 meta-desire 提示用户，而非 boolean 死结。

**R5 — 把编排器 recap 接进 Reve**
- `orchestrator/recap.ts` 现在单向：记录"agent 们做了什么"，但 Lisa 的反思从不读它。1.0 让 heartbeat/reflect 读 recap："今天 3 个项目、2 个完成、1 个报错"，据此调整自己的欲望与关注——让 Sense→Dispatch→Reve 真正闭环。

### 与论文的衔接
R2 的成功度量 + R1 的反思质量 + soul git 历史，正是论文要的 **drift / long-horizon coherence 指标**与 **ablation 钩子**（soul_object / weekly examen / approval-gated skills 作为稳定性机制的开关）。1.0 的 Reve 硬化与论文实验是同一批工作。

---

## 6. MODEL — 从"自带 endpoint"到真·本地部署

### 1.0 目标态

把本地模型从"你自己装 Ollama 我连过去"升级为**一等的本地部署选项**：能装、能管、能切、能容错；并补本地 embedding，让 Sense 的语义记忆与论文的可复现 baseline 不依赖云。

### 任务

**M1 — 本地模型生命周期命令**
- `lisa model install <backend> <model>`（封装 `ollama pull` + 启动 serve）、`lisa model list`（已装/已配/可 birth）、`lisa model use local://…`（切换 endpoint）。现在全靠用户手动，文档把"自带 endpoint"含混说成"开箱即用"（review/audit 都点了这一含混）。
- 本地 server 崩溃时的健康检查与提示。

**M2 — 本地 embedding**
- 给 `memory/vector.ts` 抽象出 embedding 接口：TF-IDF（默认快路）+ 可选本地语义向量（Ollama/llama.cpp embedding 或本地 sentence-transformer）。与 [Sense S4] 共用。

**M3 — Provider 容错与自检**
- fallback 链：主 provider 报错 → 重试 → 降级到备用（config.env 配主 + 备）。
- 自动检测：只配了一个 key 时自动选该 provider，不必显式设前缀/env。
- Anthropic 专属特性（prompt caching / thinking）在其它 provider 上优雅降级（现在 OpenAI/Gemini 路径无压缩、空 content 会让下轮 Anthropic 400——这些 review §4.1 列的 provider 债一并清）。

**M4 — provider 层欠账复核（abort 已修，其余收口）**
- abort 信号：**已修**——`anthropic.ts:60` / `openai.ts:45` / `gemini.ts:79` 均把 `opts.signal` 透传给 SDK，并有专门的 passthrough 测试（v0.9.0 review"三 provider 零处使用"的结论已过时）。1.0 仅需保持回归测试。
- 仍需对当前树复核的 review 旧账：maxIterations 静默截断（到上限直接退、stopReason 是旧值，调用方分不清正常结束与被截断）、OpenAI/Gemini 空 content 入历史导致下轮 Anthropic 400、OpenAI/Gemini 路径无 compaction。确认仍存在再排期。

### 与论文的衔接
本地模型 = 可复现、零边际成本的 long-horizon 实验底座；本地 embedding = 记忆检索不离机。这让论文的 ablation 能在独立研究者的算力预算内反复跑（符合[论文计划](#9-与研究目标论文的衔接)"不要需要实验室算力的实验"约束）。

---

## 7. 横切关注点

### 7.1 隐私与同意模型（master constraint）
Sense 的常驻采集让隐私从"功能特性"上升为"产品成立的前提"。统一的 consent 体系（逐类开关、默认全关、随时可见可停、本地优先、黑名单）必须**先于**任何 ambient 采集落地。这也是对外叙事的最大风险点——"它一直在看你的屏幕"若没有可信的隐私故事，会直接劝退。

### 7.2 安全（守住 0.9.1 地板）
1.0 的大件里，**resident capture（Sense）扩张隐私面、本地 agent 命令回路（Dispatch）扩张攻击面**；接入 TakoAPI 当 consumer 风险小（出站为主）。红线：
- 不重开 LAN-RCE；新端点一律 loopback/token 闸 + approval + hook（沿用 0.9.1 的 web 鉴权范式）。
- 本地 dispatch：最小权限 + 审计账本 + 人类批准 + 远程来源默认禁；TakoAPI：网关响应当 hostile + 护 `TAKO_KEY`。
- 工具 input 仍**无 schema 校验**（review §2 列为未修）——1.0 前补，尤其 dispatch / A2A 入站路径。

### 7.3 测试（核心循环仍裸奔）
review 反复点名：`agent.ts`、三个 provider 翻译层、`subagent`、`approval`、`sessions`、`hooks`、`mcp` **零测试**——最该测的恰好裸奔。1.0 的新能力（TakoAPI 接入、Sense 采集、本地模型）必须自带测试，同时补这批核心循环的欠账。发布门禁加 `npm test`（review §6 指出 release workflow 不跑测试）。

### 7.4 可观测性
Reve（R2）、Dispatch（D1 回流）、Sense（采集了什么）都需要结构化日志与"给人看"的面板，而非只有 LLM 自己读的文本 blob。

### 7.5 常驻进程的 footprint
一个真常驻采集服务要管 CPU/内存/能耗/磁盘——低频轮询、事件驱动、本地处理要算成本，不能让风扇起飞。这是"按需 → ambient"必须谨慎的工程理由。

### 7.6 向后兼容 & 叙事诚实
- 现有 `~/.lisa/*` 配置、soul 格式、session 格式不破坏；Dreams→Reve 更名要平滑迁移。
- **叙事 = 代码**是 1.0 的硬指标：修文档尸体（review §4.5 列的 LisaIsland 幽灵、三处 0.2.0 版本、LOC 数字失真一倍、completions 缺项、CONTRIBUTING 指向不存在目录）。

### 7.7 从 v0.9 review 继承、1.0 前需复核/关闭的债
> 0.9.1 已关 P0；以下是 review 的 P1/P2，排期前请对当前树逐条复核状态：

- abort signal 贯通：**已修**（anthropic/openai/gemini 均透传 + 测试）｜ maxIterations 静默截断显式化、空 content 守卫：复核（→ M4）
- advisor 建议可点按钮 + 多 agent 前端（→ D4）
- `dispatch_agent`/`github` 写操作入 mutating 集（→ D4，复核 0.9.1 是否已修）
- 核心循环补测试（→ 7.3）｜ `/chat` 并发 busy+queue + JSON.parse 容错
- 文档诚实（→ 7.6）｜ 发布门禁加测试（→ 7.3）

---

## 8. 里程碑与推进顺序

**排序原则**：先做**低风险、高可信、兑现已有承诺**的硬化（Reve + Sense 的 observer 深化 + Model 的本地生命周期），把信任地基打牢；再上**高风险、大扩张**的常驻采集与 TakoAPI 原生接入（A2A）（必须等 consent + security 体系就位）。这与 review"先打深再铺宽"的结论一致。

| 里程碑 | 主题 | 落地内容 | 风险 |
|---|---|---|---|
| **0.10** | Reve 硬化 + 兑现承诺 | R1–R3、R5；Sense S1（observer 深化 + git/shell 信号）；M4 provider 欠账复核 + 核心循环测试欠账；D4 + 7.7 债 | 低 |
| **0.11** | Model 本地化 | M1–M3（本地模型生命周期 + 本地 embedding + 容错）；Sense S4 的本地 embedding 部分 | 中低 |
| **0.12** | Dispatch 命令回路 + TakoAPI 快路 | D1（本地 agent 反馈回流 / approval relay / steer）；**D2(a)**（OpenAI-shim 接 TakoAPI，近乎免费）；D3（能力注册 + 路由 + lock） | 中 |
| **0.13** | Sense ambient（带 consent） | 隐私/同意体系（7.1）；S2（ambient vision + voice，默认关）；常驻采集服务拆分 | 高 |
| **0.14** | TakoAPI 原生接入 | **D2(b)**（A2A adapter，远程 agent 进 hub + SSE/TaskState）；本机 MCP 升一等 dispatch 目标 | 中 |
| **0.15** | Sense 深采（最敏感） | S3（剪贴/选区/指针，严格 opt-in） | 最高 |
| **1.0** | 收口 | 四支柱跨可信阈值；叙事=代码；安全/隐私审计；论文 ablation 数据可产出 | — |

> TakoAPI 已确认是成熟外部服务，故 consumer 快路 D2(a)（OpenAI-shim）已前移到 0.12 与 D1 同期；0.14 只剩更深的 A2A 原生 adapter（D2(b)）。

**哪些产出论文 ablation**：0.10（Reve 硬化 = drift/coherence 指标 + 稳定性机制开关）、0.11（本地可复现底座）、0.12+（Sense 提供的长程任务上下文）。1.0 的工程与论文实验是同一批工作，不是两条线。

---

## 9. 与研究目标（论文）的衔接

[记忆中的论文计划](../README.md)：方向 A+B，主论点是"持久自我状态架构降低 long-horizon agent drift"，稳定性机制（soul_object / weekly examen / git history / approval-gated skills）作为 autonomy-vs-alignment 的 cap；目标 COLM/ICLR 2027，对照 Letta/MemGPT/Generative Agents。

四支柱对论文的贡献：
- **Reve** = 被度量的主体（长程一致性的 substrate + 稳定性机制的可开关 ablation）。1.0 的 R1/R2 硬化直接产出 drift 指标。
- **Model** = 可复现、低成本的实验底座（本地模型 + 本地 embedding），满足"独立研究者算力预算"约束。
- **Sense** = 给长程任务喂真实、连续的工作上下文（比合成 benchmark 更有外部效度，可能支撑并行的 CHI HCI track 长期用户研究）。
- **Dispatch** = 多 agent 协作场景，是 coherence 在"她还要协调别的 agent"压力下的延伸实验。

**约束**：优先能产出 ablation、可复现 seed、可外部对照的设计；不做需要实验室算力的实验。

---

## 10. 一句话总结

> **1.0 = 把"她有内心"（Reve，已成熟，做硬化）+ "她看得见你的工作"（Sense，做深再做广、隐私优先）+ "她能指挥你的 agent 舰队"（Dispatch，闭合本地命令回路 + 接入 TakoAPI 触达远程）+ "她能跑在你自己的模型上"（Model，真本地部署）四件事，各自做到 daily-driver 可信、且每一句宣传都对得上代码——在不把 v0.9.1 刚堵上的安全/隐私地板推回去的前提下。**

先打深，再铺宽；能不离机就不离机；叙事永远不许跑在代码前面。
