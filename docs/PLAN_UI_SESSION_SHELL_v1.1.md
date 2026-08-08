# PLAN_UI_SESSION_SHELL_v1.1 — Session Shell 后续波次（过程流 · 并发 · 深链 · iOS）

> **定位**：承接 [PLAN_UI_SESSION_SHELL_v1.0](PLAN_UI_SESSION_SHELL_v1.0.md)（三栏 shell + 双主题 + session 树 + Inspector，PR #343–#345）落地时登记的全部后续项：agent 只读过程流、会话自动命名、树按项目视图、右栏手动折叠、island 深链、iOS 双主题与树形 roster、以及 v1.0 辩论 D3 悬置的 **Lisa 本体真并发**。
> **关联源码**：[src/integrations/claude-code/](../src/integrations/claude-code/) · [src/web/server.ts](../src/web/server.ts) · [src/web/lisa-client.ts](../src/web/lisa-client.ts) · [src/web/island.ts](../src/web/island.ts) · [src/sessions/list.ts](../src/sessions/list.ts) · [packaging/ios-companion/](../packaging/ios-companion/)
> **编写日期**：2026-08-08 · **✅ 实现状态**：F1–F7 已实现并通过 e2e（stacked PR [#346](https://github.com/oratis/LISA/pull/346) F2-F4 → [#347](https://github.com/oratis/LISA/pull/347) F1 → [#348](https://github.com/oratis/LISA/pull/348) F5 → [#349](https://github.com/oratis/LISA/pull/349) F6 → [#350](https://github.com/oratis/LISA/pull/350) F7，接在 v1.0 的 #343→#344→#345 之后依序合并）

---

## 0. 范围

| # | 特性 | 来源 | PR |
|---|---|---|---|
| F1 | agent 只读过程流（turn 级步骤端点 + 主区 stream pane + agent tab） | v1.0 §5 裁剪项 / mockup pane B | PR4 |
| F2 | 会话自动命名（首条用户消息 → 树/tab 名称） | v1.0 §7 | PR5 |
| F3 | 树「按项目」视图切换 | v1.0 §7 / D2 反方 | PR5 |
| F4 | 右栏手动折叠 + 持久化 | v1.0 §7 / D4 | PR5 |
| F5 | island 药丸 → 主窗树节点深链 | v1.0 §7 | PR6 |
| F6 | Lisa 本体真并发（per-session ChatCtx） | v1.0 D3 悬置 | PR7 |
| F7 | iOS：Calm 主题 + roster 树形分组 | v1.0 非目标转正 | PR8 |

非目标：codex/aider 等其他 agent 的 turn 级步骤解析（结构与 claude-code 不同，各自跟进）；skill/技能市场类新功能；云端多租户下的 per-session 并发（per-uid 单 ctx 维持现状，见 F6 辩论）。

## 1. F1 · Agent 只读过程流

### 1.1 数据源与端点

- **claude-code（观察）**：新增 `parseSessionSteps(file, tailBytes)`（parser.ts）——复用 `parseSessionActivity` 的逐行解析，但**保留顺序**而非折叠聚合。输出（每行一步，仅结构元数据）：

```ts
interface AgentStep {
  ts: string;                    // ISO
  kind: "user" | "assistant" | "tool";
  tool?: string;                 // tool_use 名
  target?: string;               // 文件 basename / 命令 argv[0] —— 复用现有提取逻辑
  isError?: boolean;             // tool_result is_error
  turn?: number;                 // user 步自增的回合序号
}
```

- **观察者能力**：`AgentObserver` 接口增加可选 `steps?(sessionId): Promise<AgentStep[] | null>`；claude-code observer 用 watcher 的 sessionId→file 映射实现；pty observer 不实现（走既有 `/api/agents/pty/{id}/stream` SSE）；其余 agent 暂缺 → 端点回落到 `activity` 聚合。
- **端点**：`GET /api/agents/steps?agent=<kind>&id=<sessionId>` → `{ steps: AgentStep[] }`；404 无此会话；`visibility` 低于 `activity` 档 → `{ steps: [] }`。**红线不变**：不出 prompt/回复正文，target 只有 basename/argv[0]。

### 1.2 前端

- tab 模型扩展：`lisaOpenSessions` 由 `string[]` 变为 `Array<string | {t:'agent', agent, id, label}>`（旧字符串条目自动视为 Lisa 会话，向后兼容）。
- Inspector 增加「▤ open stream」动作（所有 agent 会话）→ 开 agent tab；agent tab 激活时 `#viewChat` 进入 stream 态：隐藏 `#log`/`#form`，显示 `#agentStream`（头卡 + 待批准横幅置顶 + turn 分隔步骤流 + 底部控制条——controllable 时复用 send/cancel/approve）。
- 刷新：可见时 4s 轮询 steps + `agent_session_update` SSE 触发；pty 会话改订 `/api/agents/pty/{id}/stream`（snapshot+chunk 帧直接渲染为终端 tail 文本）。

### 1.3 辩论 F1-D · steps 拉取 vs 全量 SSE 推送

- **正方（轮询+SSE 触发，选定）**：steps 只在 stream tab 可见时才需要；观察者本来就是 3s repoll 磁盘，端到端新鲜度受限于此，SSE 全量推送徒增总线流量与隐私审计面。
- **反方（推送）**：多窗口一致、无轮询空转。
- **结论**：v1.1 轮询（可见性门控），`agent_session_update` 作为提前触发信号。量化：单会话 steps ≤ 64KB tail 解析，4s 一次，可忽略。

## 2. F2 · 会话自动命名

- `listSessionsOnDisk` 增加 `firstUserMessage`（80 字符截断，与 lastUserMessage 同一次扫描顺带取得）。
- 客户端 `sessionLabel`：`firstUserMessage → lastUserMessage → id` 的优先级；树、tab、Inspector 头一致使用。
- 不做 LLM 摘要命名（成本/延迟不值当，首条消息即最强信号）；用户改名（Rename）列为 Inspector 的后续动作位，本波次不做持久化改名。

## 3. F3 · 树「按项目」视图

- 树头新增小切换钮（⇄ 图标）：`agent 视图`（默认，v1.0 结构）↔ `project 视图`。
- project 视图：根 = 项目（Lisa 会话按 `cwd` basename 归组；agent 会话按 `project`）；子节点 = 归属该项目的 Lisa 会话叶 + 各 agent 会话叶（叶上保留 agent glyph 以示来源）。LISA 身份组不再置顶，回应 D2 反方「任务视角」诉求。
- 持久化 `localStorage("lisaTreeMode")`；折叠状态两种视图各自独立 key 前缀。

## 4. F4 · 右栏手动折叠

- fnbar 右端新增 panel-right 图标钮：切 `body.rb-collapsed` → `.frame` 两栏化 + `.rightbar` 隐藏；`localStorage("lisaRightbar")` 持久化。
- 与响应式的关系：`≤1180px` 的自动隐藏优先（媒体查询独立生效）；手动折叠只作用于宽屏。展开入口 = 同一个 fnbar 钮（高亮态表示折叠中）。

## 5. F5 · island 深链

- island agent 行增加点击：`POST /api/island/focus-session {agent, sessionId}` → 服务端广播 SSE `focus_session` 帧。
- 主 shell 监听 `focus_session`：选中对应树叶、渲染 Inspector、若已开 stream tab 则激活；未开则仅选中（不强开 tab，保持只读轻量）。
- 主窗口置前：WKWebView 无法自我置前，Mac 侧由 island 的既有「打开主窗」路径顺带触发（若无现成路径则仅做 shell 内选中，Swift 置前列为独立小项）。hash 深链 `#agent=<kind>/<id>` 同步支持（刷新/外链可达同一状态）。

## 6. F6 · Lisa 本体真并发（v1.0-D3 的正式设计）

### 6.1 现状约束（v1.0 已查明）

- 单例 `globalChat: ChatCtx { session, history, chain, … }`；`/chat` 不带 sessionId；所有 turn 经 `chat.chain` 全局串行；`activate` 也排进同一 chain → **切换要等当前回复跑完**。
- turn 结束时 `history.length = 0; history.push(...)` 原地重写同一数组；`onMessagePersist` 在持久化时经 `chat.session` 动态解析。

### 6.2 目标语义

1. 每个 Lisa session 一条**独立的串行 chain**（session 内仍严格串行）；不同 session 的 turn **并发执行**；
2. `activate` 变为 O(1) 指针操作，不再等待任何 turn；
3. 发送方每次 `POST /chat` 显式携带 `sessionId`（缺省 = active，兼容旧客户端/island）；
4. 推理吞吐由既有 inference permit 信号量兜底（并发 session 抢同一配额，不新增模型侧并发）。

### 6.3 设计

```ts
// Mac 边（cloud per-uid 路径不变，见辩论）
const sessionCtxs = new Map<string, ChatCtx>();      // sessionId → ctx（LRU 上限 ~8，闲置逐出）
async function ctxForSession(id?: string): Promise<ChatCtx>  // 缺省解析 active 指针；懒加载 open+readMessagePage
let activeSessionId: string;                          // 原 active-web-session 指针的内存镜像
```

- `/chat`：`{ message, files, sessionId? }` → `ctxForSession(sessionId)`，turn 入**该 ctx 的 chain**；`onMessagePersist`/history 重写全部落在该 ctx——闭包持有 ctx 引用，无跨 session 泄漏。
- `/api/history?page=&sessionId=`：读指定 session（缺省 active）。
- `activate`/`POST /api/sessions`：写指针 + 广播，不再进 chain（各 ctx 自洽，无共享可污染状态）。
- `idle/reflect/heartbeat` 调度器：继续只作用于 **active ctx**（行为与今天一致）；ctx 逐出前若 chain 未空则等待。
- `TenantActivityState`/advisor：跟随 active ctx（镜像现状）；per-session activity 列为后续。

**客户端**：`runChat` 发送时捕获 `sessionId`；渲染条件由「generation 计数」改为「`ev` 所属 session === 当前活跃 session」；后台 session 回复完成 → 树叶/tab 亮未读点（`.unread`），切回时清除。发送后可立即切走再在新 session 发送——两条流各自渲染判定。

### 6.4 辩论 F6-D1 · per-session ctx vs 维持 chain 串行

- **正方（per-session，选定）**：这是「并行任务」的字面兑现；委派 agent 已并行，本体串行是最后一块短板；chain 串行下 activate 阻塞在长 turn 后面，实测是最刺眼的卡顿。
- **反方**：blast radius——server.ts 对 `globalChat` 的每处引用都要审计；idle/reflect/advisor 隐含单会话假设；内存 ×N（history 数组）。
- **结论**：做，但**范围收紧**：Mac 边先行；调度器/advisor 保持 active-ctx 语义；ctx LRU 上限 + 逐出等待；每处 `globalChat` 引用逐一迁移并配并发测试（A/B 双 session 并发发送 → 各自 JSONL 无串扰、无 history 交叉重写）。

### 6.5 辩论 F6-D2 · 云端 per-uid 是否同步放开

- **正方**：体验一致。
- **反方（选定）**：云端有配额/计费/隔离三重复杂度，per-uid 单 ctx 是 B2 隔离设计的一部分；贸然放开等于把并发计费问题提前引爆。
- **结论**：云端维持 per-uid 单 ctx（其内部仍旧 chain 串行），文档明示差异。

## 7. F7 · iOS

- **Calm 主题**：`Theme.swift` 以 §2（v1.0）token 表为唯一权威源增加 Calm palette；外观三选（跟随系统 / 星云 / 静界），`@AppStorage("appearance")`；SwiftUI 环境注入。Widget/GlanceColors 维持深色（菜单栏/锁屏语境）。
- **Roster 树形**：`RosterView` 由平铺列表改为 `agent 种类 → 项目` 两级 Section（与 web 树同构），行保留状态 pip 与活动一行；LISA 自己的会话列表（`/api/sessions`）如端点已在合约中则同屏加 LISA 组，否则仅 agent 组（合约新增列为后续）。
- 构建验证：XcodeGen 生成 + 模拟器构建跑通即可（UI 截图核对两主题）。

## 8. 分 PR 落地计划（stacked，基于 #345 分支续排）

| PR | 内容 | 验收 |
|---|---|---|
| PR4 | F1 全部 | 真实 claude-code 会话 stream tab 逐步渲染 turn 分隔步骤；pty 会话渲染终端 tail；visibility=metadata 时空列表；无正文泄漏（测试比照 channels 防泄漏用例） |
| PR5 | F2+F3+F4 | 树/tab 显示首条消息名；⇄ 切换两种分组且折叠态独立记忆；右栏折叠持久化且 ≤1180 行为不变 |
| PR6 | F5 | island 点行 → 主窗树选中 + Inspector 渲染；hash 深链直达 |
| PR7 | F6 | 并发测试：A 长 turn 未完成时 activate B 立即返回；A/B 并发发送各自落盘无串扰；后台完成未读点 |
| PR8 | F7 | 模拟器两主题截图；roster 两级分组 |

## 9. 工程约束（v1.0 §6 全部继承，另加）

1. steps 端点是新隐私面：测试断言 target 只含 basename/argv[0]，无路径全量、无参数、无正文；
2. tab 模型 localStorage schema 变更需向后兼容（旧 string[] 条目）；
3. F6 迁移期间 `globalChat` 引用清单化逐一处理，禁止留双写路径；
4. iOS Theme 变更后 `Theme.swift` 头注更新「mirrors …」指向 v1.0 §2 token 表。
