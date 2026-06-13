# PLAN · DISPATCH — 统一指挥层 + TakoAPI（v1.0）

> 展开 [ROADMAP_v1.0.md §4](./ROADMAP_v1.0.md) 的 Dispatch 支柱。基线 v0.9.1。
> 关键事实（已核对 `/Users/oratis/Documents/Claude/TakoAPI`）：**TakoAPI 是独立托管服务**
> （"OpenRouter for agents"，A2A + OpenAI shim），管**远程 agent**；LISA 管**本机 CLI agent**。
> 二者互补——LISA **接入**而非自建。这把本支柱范围缩小为：闭合本地命令回路 + 对接两个现成协议。

---

## 0. 目标 / 非目标

### 目标
1. **闭合本地 agent 命令回路**：从 fire-and-forget 升级为"看进度 / 转发审批 / 中途纠偏 / 接回结果"。
2. **接入 TakoAPI**：consumer 快路（OpenAI shim，近免费）+ A2A 原生 adapter（远程 agent 进 hub）。
3. **能力注册 + 路由**：LISA 据 agent 擅长什么选对 agent 派活。
4. **清掉 review 的 dispatch 债**：advisor 建议可点、多 agent 前端、写操作入 mutating 集。

### 非目标
- 不自建 agent 网关 / registry / billing —— TakoAPI 就是这层。
- 不做 TakoAPI publisher 的**入站**端点（方向二）于 1.0 内——放 1.0 后（§3 D5）。
- 不托管运行第三方 agent。

---

## 1. 现状（file-level）

| 能力 | 现状 | 文件 |
|---|---|---|
| headless 拉起 | 4 家 CLI（claude/codex/opencode/aider），detached + 账本 | `src/tools/dispatch_agent.ts` |
| 停止 | 仅杀自己账本里的 pid（SIGTERM→KILL） | `src/tools/signal_agent.ts` |
| 账本 | `~/.lisa/dispatches.json` | `src/integrations/dispatch-ledger.ts` |
| 定时派发 | `every:30m`/`daily:09:00` + maxRuns | `src/integrations/scheduled-dispatch.ts`、`src/tools/scheduled_dispatch.ts` |
| 并行对比 | worktree 隔离 A/B | `src/tools/compare_agents.ts`、`src/integrations/comparisons.ts` |
| 观察 | hub + 5 observer（见 [PLAN_SENSE](./PLAN_SENSE_v1.0.md)） | `src/integrations/hub.ts` |
| 远程安全 | `REMOTE_BLOCKED_TOOL_NAMES` 默认禁 dispatch；`unsafeFullTools` 开 | `src/tools/registry.ts:176`、`src/channels/router.ts` |
| advisor | recap / detector，但建议是死标签 | `src/orchestrator/{journal,recap}.ts`、`src/tools/agent_recap.ts` |

**核心缺口**：dispatch 单向（无反馈 / approval relay / steer）；agent 硬编码 4 家不可扩展；TakoAPI 零接入。

---

## 2. 设计

### 2.1 命令回路：DispatchSession（本地 agent）

现在 `launchAgent` 返回 pid 就结束。引入一个**回路对象**统一本地与远程：

```ts
// src/dispatch/session.ts  (NEW)
export interface DispatchHandle {
  id: string;
  target: "local-cli" | "takoapi";
  agent: string;            // "claude" | "codex" | slug
  status(): Promise<AgentSessionState>;  // 复用 integrations/types
  events(): AsyncIterable<DispatchEvent>; // 进度 / 结果 / 需审批
  steer(msg: string): Promise<void>;      // 中途注入
  approve(decision: "yes" | "no"): Promise<void>;
  stop(): Promise<void>;
}
export type DispatchEvent =
  | { kind: "progress"; activity: SessionActivity }
  | { kind: "needs-approval"; tool: string; detail: string }
  | { kind: "result"; text: string }
  | { kind: "error"; error: string };
```

- **本地 CLI 的回路靠观察 + 信号拼**：`events()` 由 hub 的 observer 流派生（progress / needs-approval 从 `SessionActivity.pendingPermission`）；`approve` / `steer` 通过给该 CLI 的受控输入通道（如 claude 的 `--resume` + stdin、或预留的 control-file）实现，能做到哪步取决于各 CLI 暴露面——**诚实标注每家能做到的回路深度**（claude 最深）。
- **审批转发**：observer 报 `pendingPermission` → DispatchEvent `needs-approval` → LISA 对话/island 提示 → 用户确认 → `approve()` 回传。**默认带人类批准闸**，远程来源默认禁（守 0.9.1 线）。

### 2.2 TakoAPI consumer（方向一）

TakoAPI 真实 API（Bearer `TAKO_KEY`）：
```
GET  /api/registry?q=&format=json          # 发现远程 agent（无 auth）
GET  /api/agents/{slug}                     # agent 详情 + 能力
POST /v1/agents/{slug}/message  {text}      # A2A 调用
POST /v1/agents/{slug}/stream               # SSE
POST /v1/chat/completions  {model:slug,…}   # OpenAI 兼容 shim
```

**D2(a) · OpenAI-shim 快路（近乎免费，0.12）**
LISA 已有 OpenAI 兼容 provider 路由 + `LISA_BASE_URL`（见 [PLAN_MODEL §2](./PLAN_MODEL_v1.0.md)）。零新协议代码：
```env
# ~/.lisa/config.env — 把一个 provider 指向 TakoAPI 网关
TAKOAPI_BASE_URL=https://takoapi.com/v1
TAKO_KEY=sk-tako-...
```
- 实现：providers/registry 加一条预设（model 前缀如 `tako/*` → baseURL=TAKOAPI_BASE_URL, apiKey=TAKO_KEY），`model=tako/<agent-slug>` 即把任意 TakoAPI agent 当"模型"调用。
- 也暴露一个轻量 `takoapi` 工具（discover + call），让 LISA 在对话里"找个会做 X 的远程 agent 并调它"。
- 验收：`lisa "用 takoapi 上的 <slug> agent 做 X"` 成功往返；401 时提示去 `/dashboard` 配 key。

**D2(b) · A2A 原生 adapter（更深，0.14）**
把远程 TakoAPI agent 变成 hub 里一等公民——**复用 observer 抽象**：
```ts
// src/integrations/takoapi/observer.ts  (NEW) — registerIntegration("takoapi", …)
// list(): GET /api/registry → AgentSession[]（agent="takoapi", project=slug）
// dispatch: POST /v1/agents/{slug}/message + 消费 /stream(SSE)，按 A2A TaskState
//           映射到 AgentSessionState；进度 → SessionActivity。
```
- **远程 agent 的命令回路基本由 A2A 自带**（TaskState + SSE + push webhook），DispatchHandle 的 `events()`/`status()` 直接桥接 A2A，不用自造（与本地 CLI 形成对照）。
- 验收：远程 agent 与本地 CLI 在 island 上并列；A2A 任务态实时更新。

### 2.3 能力注册 + 路由（D3）

```ts
// ~/.lisa/agents.json 扩展：每个 agent 声明能力
{ "integrations": {
    "claude-code": { "enabled": true, "skills": ["refactor","tests","debug"] },
    "aider":       { "enabled": true, "skills": ["small-edits","git"] } } }
```
- LISA 据 `skills[]` + 当前 hub 状态**选对 agent**派活；TakoAPI agent 的能力来自其 AgentCard `skills[]`，天然可比。
- 跨 agent token 预算：`dispatch-ledger.ts` 扩 `tokens` 字段，scheduled-dispatch 从"限次数"升到"限 token"。
- cwd ownership lock：用 `src/soul/lock.ts` 的 link 互斥，把冲突避免从反应式（查 hub state）变前置预约。

### 2.4 dispatch 债（D4，1.0 前必清）
- **advisor 建议可点**：island 卡片接真按钮——cancel→`signal_agent` 端点；dispatch/approve→prefill composer（**绝不自动执行**）。
- **多 agent 前端**：后端已发 `agent_session_update`，前端补齐消费（现仅消费 `claude_session_update`）。
- **写操作入 mutating 集**：`dispatch_agent`/`github` 写操作纳入 `DEFAULT_MUTATING_TOOLS`（复核 0.9.1 是否已修，未修则补）。

---

## 3. 分阶段（映射里程碑）

### D1 · 本地命令回路（→ 0.12，风险中，最高优先）
- DispatchHandle + DispatchEvent；从 observer 流派生 progress/needs-approval；approve/steer 通道（按各 CLI 能力诚实分级）。
- 验收：
  - [ ] claude-code 派活后能在 LISA 里看到进度、收到"需审批"、确认后 agent 继续。
  - [ ] 每个 approve/steer 默认走人类批准闸；远程来源禁用（测试覆盖）。

### D2(a) · TakoAPI OpenAI-shim 快路（→ 0.12，风险低）
- providers 预设 + `takoapi` 工具。
- 验收：见 §2.2。

### D3 · 能力注册 + 路由 + lock（→ 0.12）
- agents.json `skills[]`；token 预算；cwd lock。
- 验收：
  - [ ] 给定任务，LISA 推荐并派给"擅长该类"的 agent，附理由。
  - [ ] 同 cwd 并发派发被 lock 前置挡住。

### D4 · 清债（→ 0.10/0.12 穿插）
- 验收：
  - [ ] island advisor 建议可点（cancel 真停；dispatch 仅 prefill）。
  - [ ] 多 agent session 在前端正确渲染。
  - [ ] dispatch/github 写操作被 `--approval ask-mutating` 拦住。

### D2(b) · A2A 原生 adapter（→ 0.14，风险中）
- `takoapi` observer + A2A 桥接。
- 验收：见 §2.2。

### D5 · TakoAPI publisher（→ 1.0 后，DEFERRED）
- LISA 暴露 `/.well-known/agent-card.json` + A2A `message/send` 入站（**在现有 webhook channel 上演进**，`src/channels/webhook.ts` 已是带 bearer 的 POST 接收器，最接近 A2A 入站形态）。
- 把 LISA 自己上架 TakoAPI，被生态调用、助其冷启动供给侧。
- **为何 defer**：这把 LISA 变成"对公网可被调用的服务"，入站攻击面再扩一层——等 consent/安全体系成熟。

---

## 4. 测试
- 命令回路：mock observer 流 → DispatchHandle 正确派生 progress/needs-approval；approve 默认需人工确认。
- 远程安全回归：渠道来源默认拿不到 dispatch/signal/scheduled（断言 `remoteSafeSubset` 仍剔除它们）。
- TakoAPI consumer：mock `/v1/chat/completions` 与 `/v1/agents/{slug}/message` → 往返成功；401 路径有友好提示。
- A2A adapter：mock registry + SSE → TaskState 正确映射 `AgentSessionState`；上游响应当 hostile（注入测试）。

---

## 5. 隐私 / 安全
- **出站（TakoAPI）**：把网关返回的远程-agent 响应**当作不可信输入**（二阶 prompt injection，TakoAPI 技术架构文档 §11 也强调）；`TAKO_KEY` 走 `config.env`（0600）。
- **本地 dispatch 守 0.9.1 线**：`dispatch_agent`/`signal_agent`/`scheduled_dispatch` 远程来源默认禁、人类批准闸、审计账本。
- **approval relay 防伪**：转发的审批必须能验证来源是真 LISA 用户，而非被注入的渠道消息。
- publisher（D5）才是入站面 → 1.0 后再开。

---

## 6. 风险 / 开放问题
- **本地 CLI 的 steer/approve 深度受限于各 CLI 暴露面**：claude 可深，aider/codex 可能只能 kill+重启。诚实分级，别承诺做不到的"中途纠偏"。
- **TakoAPI 仍在演进**（Phase 2 网关、生产 DB 升配未完）：consumer 快路依赖其线上稳定性；adapter 要容错（A2A 断路器）。
- **能力声明可信度**：agent 自报 `skills[]` 可能不准——路由要留"用户否决"。

---

## 7. 与 roadmap / 论文衔接
- D1+D2(a)+D3+D4 在 0.12 同期（consumer 快路因近免费而提前）；D2(b) 在 0.14；D5 在 1.0 后。
- 对论文：多 agent 协作是 long-horizon coherence 在"她还要协调别的 agent"压力下的延伸实验（[ROADMAP §9](./ROADMAP_v1.0.md)）。
