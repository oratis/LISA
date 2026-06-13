# PLAN · SENSE — 常驻感知层（v1.0）

> 本文档把 [ROADMAP_v1.0.md §3](./ROADMAP_v1.0.md) 的 Sense 支柱展开为可执行实现计划。
> 基线 v0.9.1。house style 同 [AUTONOMY_ROADMAP.md](./AUTONOMY_ROADMAP.md) / [ORCHESTRATOR_PLAN.md](./ORCHESTRATOR_PLAN.md)：
> 分子阶段 A/B/C，每阶段附**验收清单**，停下来等用户验收，不一次性交付。
> 隐私是本支柱的**头号设计约束**，不是事后补丁——见 §5 与 [PLAN_FOUNDATIONS_v1.0.md](./PLAN_FOUNDATIONS_v1.0.md)。

---

## 0. 目标 / 非目标

### 目标
一个**单一常驻服务**，在用户**逐项显式授权**的信号上持续采集、**本地优先**处理，沉淀为统一工作记忆：
1. 把已声称的 5 个 agent observer 深度补齐 + 新增 git / shell / 构建信号（低风险，兑现承诺）。
2. 在场判定从"是否在跟 LISA 说话"升级为系统级 idle / 锁屏 / 前台 app。
3. vision / voice 从按需走向 ambient（默认关、带 consent、本地优先）。
4. 剪贴 / 选区（最敏感，严格 opt-in）。
5. 采集 → 自动蒸馏进 memory + 本地语义检索。

### 非目标（避免范围蔓延）
- 不做键盘记录 / 鼠标轨迹（仅用焦点变化做在场判定，不存轨迹）。
- 不把原始截图 / 音频 / 剪贴内容默认持久化或默认上云。
- 不替代 Reve 的反思——Sense 只**采集与蒸馏**，"想"是 Reve 的事。
- 不在 Linux/Windows 上追平 macOS 的系统级钩子（v1.0 以 macOS 为先，其余降级为"仅 agent/git/shell"）。

### 一条贯穿原则
**默认最小、逐项 opt-in、能不离机就不离机。** 每加一个信号源，先问"它的默认值是不是关、它的 raw 数据是不是只在本地"。

---

## 1. 现状（file-level）

| 能力 | 现状 | 文件 |
|---|---|---|
| agent observer | claude-code 最深；codex/opencode Tier-2；aider 文件+轮次；github-pr 元数据 | `src/integrations/{claude-code,codex,opencode,aider,github-pr}/observer.ts`、`hub.ts` |
| observer 抽象 | `AgentObserver {agent, start(emit), list, stop}` + `registerIntegration()` 注册 | `src/integrations/types.ts`、`registry.ts` |
| 活动结构 | `SessionActivity {turnCount, lastTools, filesTouched, lastCommandName, lastError, gitBranch, tokens, pendingPermission}` | `src/integrations/types.ts:42` |
| 屏幕 | 按需 `screencapture`（interactive/full）+ 可选周期 advisor（默认关、≥10min） | `src/vision/capture.ts`、`src/screen_advisor/engine.ts`、`src/web/server.ts` |
| 语音 | TTS（`say`）；转写（Whisper API，**需文件路径**）；听写润色 | `src/voice/{speak,transcribe,dictation}.ts` |
| 在场 | 仅"是否在跟 LISA 交互"（每次输入 `tick()`，60s 轮询，默认 ~60min idle） | `src/idle/watcher.ts` |
| 记忆 | `~/.lisa/memory`+`~/.lisa/user`（read/append/replace/remove）；TF-IDF 检索（fingerprint 缓存） | `src/memory/{store,vector,tool}.ts` |
| 常驻 | `serve --web` 反应式后端；launchd autostart | `src/web/server.ts`、`src/autostart/install.ts` |

**关键缺口**：没有"非-agent 信号"的统一抽象（observer 只管 agent session）；没有独立于 web server 的采集循环；没有 consent 框架；没有 raw→memory 蒸馏。

---

## 2. 设计

### 2.1 两个抽象：复用 observer + 新增 SenseSource

agent / git / shell 三类信号天然是"会话/事件流"，**直接复用 `AgentObserver`**（git 的"会话"= 一个 repo 的活动，shell = 一个终端的活动），通过 `registerIntegration()` 注册——零新抽象。

vision / voice / clipboard / selection / presence 不是 agent session，新增一个并列的轻抽象：

```ts
// src/sense/types.ts  (NEW)
export type SenseSignal =
  | "screen" | "voice" | "clipboard" | "selection" | "presence";

export interface SenseEvent {
  signal: SenseSignal;
  at: number;                 // epoch ms
  /** 本地已蒸馏的结构化摘要，绝不是 raw 字节流。 */
  summary: string;
  /** 来源 app / 窗口标题（若可得），用于关联。 */
  sourceApp?: string;
  /** 仅当 consent 明确允许"保留 raw"时才有；默认 undefined。 */
  raw?: { kind: "image" | "audio" | "text"; ref: string };
}

export interface SenseSource {
  readonly signal: SenseSignal;
  start(emit: (e: SenseEvent) => void): Promise<void>;
  stop(): Promise<void>;
}
```

### 2.2 SenseService — 常驻采集循环

```ts
// src/sense/service.ts  (NEW)
// 拥有所有 source（agent/git/shell 经 hub；screen/voice/… 经 SenseSource），
// 应用 consent 闸，跑本地蒸馏，写工作记忆。事件驱动 + 低频轮询，绝不阻塞 chat。
class SenseService {
  start(): Promise<void>;   // 读 consent → 仅启用被授权的 source
  stop(): Promise<void>;
  recentEvents(sinceMs: number): SenseEvent[];  // 给 Reve / island 用
}
```

- 进程归属：**默认随 `serve` 起**，但与 chat 路径解耦（独立 async loop）；可单独 `lisa sense run`（前台调试）。launchd 复用 `autostart/install.ts`。
- 输出：所有 source 的事件进一个**有界环形缓冲**（内存）+ 选择性落 `~/.lisa/sense/events.jsonl`（仅结构化摘要，受 consent 控制保留期）。

### 2.3 Consent 框架（头号约束）

```jsonc
// ~/.lisa/sense.json  — 默认文件：所有"新/敏感"信号 enabled:false
{
  "screen":    { "enabled": false, "everySec": 60, "blacklistApps": ["1Password","Banking"] },
  "voice":     { "enabled": false, "pushToTalk": true },
  "clipboard": { "enabled": false, "storeContent": false, "blacklistApps": ["1Password"] },
  "selection": { "enabled": false },
  "presence":  { "enabled": true },          // 低风险，默认开
  "git":       { "enabled": true, "roots": ["~/code"] },
  "shell":     { "enabled": false, "argv0Only": true },  // 默认关，开后仅 argv[0]
  "distill":   { "enabled": true, "everyMin": 30 },
  "retentionDays": 7
}
```

- **UI 必须随时可见"现在在采什么"+ 一键全停**（island 顶栏一个 SENSE 指示灯 + popover）。
- 每个 source 启动时若 `enabled:false` 直接 no-op；服务绝不"先采后问"。
- 详细 consent / 脱敏规则集中在 [PLAN_FOUNDATIONS_v1.0.md §1](./PLAN_FOUNDATIONS_v1.0.md)。

### 2.4 本地优先蒸馏 → 工作记忆

```ts
// src/sense/distill.ts  (NEW) — 低频任务（everyMin），消费 recentEvents()
// 1. 本地判定"是否值得记"（前台 app 变化 / 出现 error 对话框 / git commit / 选区动作）
// 2. 命中才（可选）送模型蒸馏成 1–2 条 memory：「在 repo X 为 feature Y 调试 Z」
// 3. 写 memory/store.ts append + 本地 embedding 索引（与 Model M2 共用）
```

蒸馏质量受 Reve 反思门禁约束（[PLAN_REVE_v1.0.md R1](./PLAN_REVE_v1.0.md)）。raw 截图/音频在本地完成判定后即删（沿用 `vision/capture.ts` 的 finally 删除范式）。

---

## 3. 分阶段（映射 roadmap 里程碑）

### 阶段 S1 — 深化 observer + 低风险新源（→ 0.10，风险低）
**S1a · 补齐非-Claude 活动深度**
- codex/opencode/aider observer 产出完整 `SessionActivity`（`lastTools`/`filesTouched`/`pendingPermission`/`tokens`），让 6 个 advisor detector 对它们触发。
- 验收：
  - [ ] 三家 observer 各有测试断言 `activity` 字段非空且不泄漏 prompt/reply（planted-secret 测试）。
  - [ ] island 上非-Claude session 显示 tool/file 活动。

**S1b · git observer（新 AgentObserver，kind `"git"`）**
- watch `roots` 下各 repo 的 `.git/HEAD`、`logs/HEAD`、index mtime；派生 commit / branch-switch / dirty 状态为 `AgentSession`（project=repo 名，activity.filesTouched=`git diff --name-only`）。
- 验收：
  - [ ] 切分支 / commit 在 5s 内出现在 hub。
  - [ ] 无 `roots` 配置时 no-op。

**S1c · shell observer（新 AgentObserver，kind `"shell"`，默认关）**
- 尾随 `~/.zsh_history` / `~/.bash_history`，**仅取 argv[0] + 时间**（`argv0Only` 强制），绝不存完整命令。
- 验收：
  - [ ] 测试断言只暴露 argv[0]，完整命令永不进事件。
  - [ ] `sense.json` 默认 `shell.enabled:false`。

### 阶段 S2 — 在场判定升级（→ 0.10，风险低）
- `presence` SenseSource：macOS `ioreg -c IOHIDSystem`（系统 idle 秒数）/ `CGEventSourceSecondsSinceLastEventType` + 锁屏通知；把结果喂 `idle/watcher.ts`，替代"只认 LISA 交互"。
- 验收：
  - [ ] 用户在 VS Code 活跃但不理 LISA 时，**不**判 idle。
  - [ ] 锁屏即视为 away（触发 Reve dreams 更准）。
  - [ ] 非 macOS 优雅降级回旧行为。

### 阶段 S3 — ambient vision + voice（→ 0.13，风险高，consent 前置）
**前置**：[PLAN_FOUNDATIONS §1](./PLAN_FOUNDATIONS_v1.0.md) 的 consent 框架已落地。
- `screen` SenseSource：把 `screen_advisor` 泛化为可配 `everySec` 采集 + 前台 app/窗口标题；本地先判"是否值得上报"，命中才送模型；**截图绝不持久化**；`blacklistApps` 命中直接跳过该帧。
- `voice` SenseSource：录音 + 热键（push-to-talk 默认）+ 流式转写；探索 whisper.cpp 本地 STT 作离机选项（与 Model 支柱呼应）。
- 验收：
  - [ ] 默认 `enabled:false`；开启走一次性 consent 卡。
  - [ ] 黑名单 app 在前台时零采集（测试覆盖）。
  - [ ] island 实时显示"屏幕/语音 采集中"红点。

### 阶段 S4 — 剪贴 / 选区（→ 0.15，最敏感，最后）
- `clipboard` SenseSource：macOS `NSPasteboard.changeCount` 轮询；默认只记元数据 + 来源 app，`storeContent:false` 时绝不留内容。
- `selection` SenseSource：跨 app 选区 → "就这段聊"；体验最强、隐私最敏感，放 consent 体系最成熟后。
- 验收：
  - [ ] 默认全关；`storeContent` 默认 false。
  - [ ] 密码类 app（黑名单）剪贴零捕获。

### 阶段 S5 — 蒸馏 + 本地检索（贯穿，→ 0.11 起）
- `distill.ts` 落地（§2.4）；`memory/vector.ts` 接本地 embedding（详见 [PLAN_MODEL M2](./PLAN_MODEL_v1.0.md)）。
- 验收：
  - [ ] 一天工作后自动生成 ≤2 条高质量 memory，无噪声刷屏。
  - [ ] 语义检索能召回 TF-IDF 漏掉的近义查询。

---

## 4. 测试
- 每个 source 一个**隐私测试**：断言 raw 内容 / PII / 完整命令永不进 `SenseEvent.summary` 或落盘（沿用 `parser` 的 planted-secret 范式）。
- consent 测试：`enabled:false` → source `start()` 后零 emit；黑名单 app → 零捕获。
- 蒸馏测试：给定一串合成事件 → 产出稳定、有界的 memory 条数（不随事件数线性膨胀）。
- 在场测试：mock 系统 idle 秒数 → watcher 状态切换正确。

---

## 5. 隐私 / 安全（头号）
- **逐类开关、默认全关**（除 presence/git）；UI 永远可见正在采什么 + 一键全停。
- **本地优先**：raw 截图/音频/剪贴在本地完成判定/蒸馏，命中且必要才送模型；落盘的永远是结构化摘要。
- **黑名单**：app 级（密码/银行/隐私窗口）、路径级、PII 模式级。
- **保留期**：`retentionDays` 到期清 `sense/events.jsonl`；raw 即用即删。
- 详尽规则见 [PLAN_FOUNDATIONS_v1.0.md §1 隐私与同意](./PLAN_FOUNDATIONS_v1.0.md)。

---

## 6. 风险 / 开放问题
- **常驻 footprint**：低频轮询 + 事件驱动，需实测 CPU/能耗（[FOUNDATIONS §5]）。截图/音频帧率是主要成本旋钮。
- **跨平台**：系统级钩子 macOS 先行；Linux/Windows 何时追平？（开放，按用户群定）
- **本地 STT/embedding 质量**：whisper.cpp / 本地向量是否够用，还是仍要云兜底？（与 Model 支柱联合验证）
- **蒸馏噪声**：如何避免把"看了眼推特"也记成工作记忆？阈值需调。

---

## 7. 与 roadmap / 论文衔接
- S1/S2 是 0.10 低风险硬化，**先做**；S3/S4 是 0.13/0.15 的高风险扩张，**等 consent 就位**。
- 对论文：Sense 给 long-horizon coherence 任务喂**真实、连续的工作上下文**，比合成 benchmark 更有外部效度，可支撑并行的 CHI HCI track 长期用户研究（[ROADMAP §9](./ROADMAP_v1.0.md)）。
