# PLAN_UI_SESSION_SHELL_v1.0 — 三栏 Session Shell 重构

> **定位**：把 Lisa 主 GUI 从「单一永续对话 + 两栏布局」重构为「多 session 并行 + 三栏工作台」：左栏 session 树（Lisa 自己的会话与被监控 agent 平级）、中栏 tab 化会话/过程流、右栏结构化检查器面板；同时引入 N 星云 / C 静界双主题切换。
> **参考**：[DouDouAI2.0 设计库](https://github.com/DiogenesModel/DouDouAI2.0)（三栏工作台范式、过程可视化=信任、静界视觉方向）；Claude Code / Codex 的 session 列表与并行任务范式。
> **关联源码**：[src/web/lisa-html.ts](../src/web/lisa-html.ts) · [src/web/lisa-css.ts](../src/web/lisa-css.ts) · [src/web/lisa-client.ts](../src/web/lisa-client.ts) · [src/web/server.ts](../src/web/server.ts) · [src/sessions/](../src/sessions/) · [src/integrations/](../src/integrations/)
> **Mockup**：[reference/mockups/lisa-session-shell.html](../reference/mockups/lisa-session-shell.html)（v2，交互可点：树/tab/inspector/主题切换，已与 owner 确认）
> **编写日期**：2026-08-08 · **✅ 实现状态**：Phase 1–3 落地中（分 stacked PR），Phase 4 e2e 待跑

---

## 0. 目标 / 非目标

**目标**

1. **Session 模式**：Lisa 的对话从单一永续会话变为可并行的多 session（类 Claude Code / Codex）：新建、切换、恢复历史会话；tab strip 并行可见。
2. **Agent 树形平级**：被监控的外部 agent（claude-code / codex / opencode / aider / …）的 session 以树形结构与 Lisa 自己的 session 并列呈现：`agent 种类 → 项目 → session`，点击可开只读过程流 tab。
3. **左栏瘦身**：保留身份卡 + 3×3 九宫格；原左栏下半部（currently wanting / agents 卡 / mail 卡 / reflection）整体迁入右栏，右栏重构为**单一结构化面板**（Inspector + 状态分区）。
4. **双主题**：`N 星云 Nebula`（现行深色玻璃拟态，默认）与 `C 静界 Calm`（浅色专业风）作为正式功能切换，持久化。

**非目标**

- iOS 全面改版（本轮仅在 §6 说明 token 对齐义务；iOS 双主题另立 plan）。
- Room / Island / login / account 等其他 surface 的换肤（保持现状；见辩论 D5）。
- Lisa 本体 agent loop 的**真并发**执行改造（本轮做到「多 session 切换 + 流式互不串扰」；真并发列为 P2，见辩论 D3）。
- 移动端 Web（≤860px）只保证可用降级，不做专门设计。

## 1. 布局总览

设计基准 1440×900（Mac 默认窗口态），栅格 8px：

```
┌───────────────────────────── titlebar 36px（拖拽区，pointer-events:none）─┐
├──────────┬──────────────────────────────────────┬───────────────────────┤
│ 左栏 288 │ 中栏 fluid                            │ 右栏 320              │
│          │                                      │                       │
│ 身份卡    │ tabstrip: [会话tab×n] [+] ··· fnbar   │ INSPECTOR（头部）      │
│ 九宫格3×3 │ ┌────────────────────────────────┐   │ ├ session 头+状态chip  │
│──────────│ │ pane A: Lisa chat               │   │ ├ stat 三联块          │
│ SESSIONS │ │  消息流 + 折叠工具步骤            │   │ ├ KV 行(发丝线)        │
│ ▾ L LISA │ │  composer                       │   │ └ 动作按钮等宽栅格      │
│   ├ s1 ● │ ├────────────────────────────────┤   │───────────────────────│
│   ├ s2   │ │ pane B: agent 只读过程流         │   │ CURRENTLY WANTING     │
│ ▾ C CC   │ │  头卡+observing 徽章             │   │───────────────────────│
│   ▾ 项目 │ │  待批准置顶横幅 [Approve][Deny]   │   │ MAIL（tag 定宽对齐）    │
│     ├ …● │ │  turn 分隔的工具步骤流           │   │───────────────────────│
│ ▸ X Codex│ │  追问输入 + Cancel/Adopt        │   │ ★ LAST REFLECTION     │
│ footer   │ └────────────────────────────────┘   │                       │
└──────────┴──────────────────────────────────────┴───────────────────────┘
```

### 1.1 左栏（288px，单一玻璃面板）

| 区块 | 规格 |
|---|---|
| 身份卡 | 46px 头像 + 名字 + born/天数 + 情绪 chip（保留现状） |
| 九宫格 | 3×3 `.nav-item` 平铺，Chat/Dashboard/Control(角标)/Rêve/Room/Sense/Memory/Knowledge/Settings（保留现状） |
| SESSIONS 头 | 小型大写标题 + `＋ New` 主按钮（唯一高强调按钮） |
| Session 树 | 见 §3.1；行高 27px，pip + 名称(省略) + 相对时间 |
| footer | `lisa v{x}` + `N sessions · M live`（替换原 session-id 展示） |

### 1.2 中栏

| 区块 | 规格 |
|---|---|
| tabstrip | 打开的会话 = 编辑器式 tab（pip + 名称 + ×），`＋` 新建；**右端**收纳原 fnbar 图标（Soul/Skills/Tools/Find/主题切换） |
| pane A: chat | 现有消息流保持（markdown、情绪头像、KB 勾选）；工具步骤折叠为一行摘要（DouDou「过程可视化」原则：状态文案 = 人话 + 具体对象） |
| pane B: agent stream | 只读：头卡（glyph/名称/项目/分支/turns/tokens + `observing` 徽章）→ 待批准横幅（置顶）→ turn 分隔的结构化步骤流 → 底部追问输入 + Cancel/Adopt |
| composer | 现有结构保留（＋菜单 / 语音 / textarea / SEND） |

### 1.3 右栏（320px，单一结构化面板 — v2 定稿）

设计规则（这是 v1 mockup 被否掉后的修正，**必须遵守**）：

1. **一整块面板**，与左栏对称（同底、同圆角、同边框），不再是彩边卡片堆叠；
2. 分区之间只用 **1px 发丝线**（`--hairline`），统一 16px 水平内边距；
3. 分区标题统一：小型大写（10px/700/0.14em，左）+ 元信息（右）；
4. Inspector 数字用 **stat 三联块**（等宽 grid，数字 16px tabular-nums）；
5. KV 行两端对齐 + 行间发丝线；动作按钮**等宽栅格**（2 列或 3 列，高 29px）；
6. 彩色只用于语义（状态 chip / pip / tag），不用于容器装饰。

| 分区 | 内容 |
|---|---|
| INSPECTOR | 跟随左树选中项：session 头（glyph+名称+状态 chip+mono 路径）→ stat 三联（Lisa 会话: msgs/memory/active；agent: turns/tokens/files）→ KV（last tool / files / pending…）→ 动作（Lisa: Rename/Export/Archive 或 Resume；agent: Approve/Deny + Send/Cancel/Adopt） |
| CURRENTLY WANTING | 原 `#sbDesire` 内容 |
| MAIL | 原 mail 卡：tag 定宽（34px）+ 标题省略 + 时间右对齐；未连接时显示 connect 引导 |
| ★ LAST REFLECTION | 原 reflection 卡 + 相对时间 |

### 1.4 状态语义（沿用现有 pip 体系）

| pip | 含义 | 视觉 |
|---|---|---|
| working | 运行中 | `--proactive` 绿 + breathe 呼吸动画 |
| waiting | 需要你（审批/回复） | `--warm` 琥珀 + 3px halo |
| error | 出错 | `--err-color` 红 |
| idle/done | 空闲/完成 | `--fg-faint` 灰 |

### 1.5 响应式

- `≤1180px`：右栏隐藏（Inspector 降级为点击树行弹 modal —— 复用现有 `openSessionDetail`）；
- `≤860px` / `body.force-compact`：单栏（沿用现有移动端折叠策略，树置于抽屉）。
- `.frame` 的 grid 定义共**三处**需同步修改：基础规则、`≤720px` media query、`body.force-compact`（现状见 lisa-css.ts，另加 `≤1180px` 一处）。

## 2. 双主题 Token 规格

切换机制：`<body data-theme="nebula|calm">`；fnbar 右端月亮/太阳按钮切换；`localStorage("lisa-theme")` 持久化，启动时读取。CSS 全部走变量，calm 只是一块 `body[data-theme="calm"] { … }` 覆盖。

| Token | N 星云（默认） | C 静界 |
|---|---|---|
| `--accent` | `#6ad4ff` | `#4f5bd5` |
| `--proactive` | `#3ddc97` | `#1f9d6b` |
| `--warm` | `#ffd066` | `#d97706` |
| `--dream` | `#b487ff` | `#7c5cd6` |
| `--claude` | `#ff8c42` | `#e2681c` |
| `--codex`（新增） | `#7ea6ff` | `#3d6fd8` |
| `--err-color` | `#ff5577` | `#dc3545` |
| `--bg-deep / 页面底` | `#07091a` + 星云径向渐变 | `#f6f7f9` 平铺 |
| `--bg-panel` | 玻璃渐变 + blur(30px) | `#ffffff` + blur(12px) |
| `--bg-hover / --bg-inset` | `rgba(255,255,255,.05/.035)` | `rgba(16,24,40,.04/.028)` |
| `--border / --hairline` | `rgba(255,255,255,.07/.06)` | `#e4e7ec / #edf0f4` |
| `--fg / --fg-2 / --fg-3 / --fg-faint` | `#e8eaff / #aeb5d3 / #6c7398 / #444a6e` | `#1b2430 / #4d5666 / #8a919f / #c2c7d1` |
| 阴影 | 无（靠玻璃分层） | `0 1px 2px rgba(16,24,40,.05)` + 1px 边界 |
| 圆角 | 14 / 9 | 10 / 8 |
| `color-scheme` | dark | light |

纪律（来自 DouDou 三方向的教训）：**发光/动画只给「正在发生的事」**（working pip、待批准横幅），静态内容零发光；静界下数字（用量/tokens）永远清晰可见。

## 3. 数据模型与 API

### 3.1 Session 树

```
树 = [ LisaGroup ] ++ [ AgentGroup(kind) for kind in 活跃 agent 种类 ]
LisaGroup.children  = GET /api/sessions            （SessionInfo[]，按 startedAt 倒序）
AgentGroup.children = GET /api/agents/sessions 按 (agent, project) 二级分组
```

- 复用现有 `SessionInfo { id, startedAt, cwd, model, messageCount, lastUserMessage }` 与 `AgentSession { agent, sessionId, project, state, stateReason, activity, controllable, resumable, … }`，**不改动数据模型**（树只是 UI 分组）。
- Lisa 会话名：`lastUserMessage` 截断（后续 P2：会话自动命名）。
- 活跃窗口沿用现有 30min 规则；超窗的 agent session 收进「earlier」折叠组。

### 3.2 新增 / 改动端点

| 端点 | 动作 | 说明 |
|---|---|---|
| `POST /api/sessions` | 新建 Lisa session 并设为 active | 复用 CLI 的 session 创建路径；返回 SessionInfo |
| `POST /api/sessions/{id}/activate` | 切换 active web session | 写 `~/.lisa/active-web-session.txt`（`src/sessions/active.ts`）；SSE 广播 `session_switched` |
| `GET /api/sessions/{id}/history` | 分页读历史 | 现有 history 端点若已含 session 参数则复用，否则新增 |
| `GET /api/agents/steps?agent=&id=` | agent 结构化步骤流 | **仅结构元数据**（工具名+对象+时间戳+turn 边界），尊重 `~/.lisa/agents.json` visibility tier；`intent` 档才含 turn 摘要 |
| SSE `/events` | 增加 `session_switched` 事件 | 多窗口/iOS 同步 |

隐私红线（沿用 `SessionActivity` 的既有约定）：过程流**永不**外传 prompt/回复正文，只有结构化元数据；`metadata` 档不出 `lastError` 详情，`off` 档整组不出现在树里。

### 3.3 并行语义（Phase 2 范围）

- 多 Lisa session **共存 + 秒切**；发送消息附带 `sessionId`，服务端按 id 追加对应 JSONL；
- 同一时刻**一条流式回复**（active session）；后台 session 若有未读完成回复，树行出小蓝点（P2：真并发见 D3）；
- 被监控 agent 本来就是并行的，树/tab 只是呈现。

## 4. 正反方辩论

### D1 · 要不要 tab strip（vs 只靠左树切换）

- **正方（保留 tab）**：并行任务的核心体验是「同时盯几件事」，tab 是并行可见性的最强形态；观察 agent 的只读流 tab 与 Lisa 会话 tab 同构，心智统一；Claude Code 桌面版即此范式。
- **反方（去掉）**：树已能切换，tab 重复；小窗口 tab 挤压；多一层「打开/关闭」状态要维护。
- **结论**：**保留**。tab = 「打开的会话」，树 = 「全部会话」，两者职责不同；≤1180px 时 tab 自动溢出成下拉。反方的状态维护成本用「tab 集合仅存 client 内存 + localStorage」压到最低。

### D2 · 树分组：`agent → 项目 → session` vs `项目 → 混排`

- **正方（agent 优先，选定）**：与 Control 视图、`/api/agents/sessions` 的 `listByAgent` 天然对齐；agent 种类是用户对「谁在干活」的第一认知；Lisa 组永远置顶，身份感清晰。
- **反方（项目优先）**：同一项目下 Lisa + CC 的会话物理相邻，任务视角更连贯；DouDou 的任务中心即项目视角。
- **结论**：**v1 用 agent 优先**（实现成本低、与现有 API 同构）；树头预留排序切换（P2 加「按项目」视图），不落 v1 范围。

### D3 · Lisa 自身会话真并发 vs 切换即可

- **正方（真并发）**：「并行进行多个任务」字面要求两条 Lisa 会话同时跑；委派 agent 已并行，本体不并发显得半吊子。
- **反方（先切换）**：agent loop、SSE 总线、approval 回调当前均按单活跃会话设计，真并发要动 `src/agent.ts` 的核心循环与事件路由，回归风险波及全部 surface（island/iOS/channels）；且 Lisa 的「并行干活」主要形态本来就是**委派**（managed/PTY/run_on_plan），本体第二条会话多数时间在等人打字。
- **结论**：**Phase 2 落地切换 + 后台完成通知**（发送后可切走，回复完成时树行亮点），**真并发单独立项**。这保住 90% 的体验收益，避免一次性动核心循环。

### D4 · 右栏常驻 vs 可折叠

- **正方（常驻）**：desire/mail/reflection 是 Lisa「有自我」的存在感表面，常驻才有陪伴感；inspector 常驻减少一次点击。
- **反方（可折叠）**：写长文/看代码时想要最大化中栏；1280px 笔记本上 320px 是奢侈。
- **结论**：`≥1180px` 常驻；以下自动隐藏、树点击降级为 modal（复用 `openSessionDetail`）。手动折叠按钮列 P2（需要新增布局状态持久化，不值得进 v1）。

### D5 · 双主题的波及面（island / room / iOS 怎么办）

- **正方（全面双主题）**：体验一致性，静界用户切到 Room 突然回到深色会跳戏。
- **反方（主 shell 先行，选定）**：island.ts / room.ts / iOS Theme.swift 是三套独立 token（已知漂移风险），一次全改会把 PR 撑成巨无霸；Room 的像素艺术资产本身是深色设定，浅色化需要美术重做，不是换变量能解决的。
- **结论**：**v1 只做主 shell**。Room iframe 在静界下加 1px 边框以示「窗中窗」；island 保持深色（它悬浮在系统菜单栏旁，深色反而中性）；iOS 双主题另立 plan。§6 登记 token 同步义务。

### D6 · 树取代 Control 视图？

- **正方（取代）**：树 + inspector 已覆盖列表/审批/追问，Control 冗余。
- **反方（保留，选定）**：Control 是全量管理面（含历史 session、策略、批量操作），树只显示活跃窗口内的会话；九宫格挖掉一格会破坏 3×3。
- **结论**：**保留 Control**，树是高频入口，Control 是低频全量面；树行右键/inspector 的「Open」跳 Control 定位详情。

### D7 · 静界作为第二主题 vs 三主题（含暖屋）

- **正方（N+C 两套，选定）**：owner 已确认；两套 = 深/浅各一，覆盖投屏/白天办公（静界）与默认人格气质（星云）；维护面最小。
- **反方（加暖屋 W）**：DouDou 方向 A 的伙伴感契合 Lisa 人格。
- **结论**：**两套**。暖屋的暖色 token 已在 mockup v1 验证过可行，留档（git 历史可取回），有需求再加 —— token 体系已支持任意多主题，边际成本仅一块变量覆盖。

## 5. 分 PR 落地计划（stacked）

| PR | 分支（base） | 内容 | 验收 |
|---|---|---|---|
| **PR1** | `claude/lisa-style-redesign-bb58ad`（main） | 设计文档 + mockup；`.frame` 三栏 grid（4 处响应式）；右栏结构化面板承接 desire/mail/reflection + agents 卡（暂为现有卡样式迁移）；`--hairline/--bg-inset/--codex` token；calm 主题块 + 切换按钮 + localStorage 持久化；snapshot 哈希重算 | 全量测试绿；1440/1180/860 三档布局正确；主题切换即时生效且刷新后保持 |
| **PR2** | PR1 分支 | `POST /api/sessions`、`POST /api/sessions/{id}/activate`（+ SSE `session_switched`）；左栏 LISA 树组（列表/新建/切换/历史重载）；tabstrip（Lisa 会话 tab） | 新建→发消息→切旧会话→历史正确→切回，流式不串扰；badge/树计数实时 |
| **PR3** | PR2 分支 | agent 树组（kind→project→session，SSE 实时刷）；inspector 联动（approve/deny/send/cancel/adopt 复用现有端点）；agent 只读过程流 pane（`GET /api/agents/steps`，视 parser 现状裁剪：至少 lastTools 时间线，目标 turn 级步骤流）；原 `#sbClaudeRows` 渲染器与 Control 渲染器收敛为共享 formatter | 真实 claude-code 会话出现在树中；待批准会话 waiting pip + inspector 可批准；过程流不含正文内容 |
| **Phase 4** | — | 全量 `npm test`；独立端口起 dev 实例（**勿动 :5757 launchd 生产实例**）；浏览器 e2e：三栏/主题持久化/session 新建切换/agent 树/inspector 动作/过程流；截图归档 | e2e 清单全过，截图入 PR 描述 |

**iOS（P2 跟进，不在本轮）**：Theme.swift 增加 calm token 镜像 + 外观切换；RosterView 采纳树形分组。

## 6. 工程约束与风险登记

1. **快照测试**：`src/web/lisa-html-snapshot.test.ts` 钉死 `MAIN_HTML` 字节长度 + SHA-256 —— 每个改动 shell 的 PR 都要按文件头 recipe 重算，并在变更日志注释追加 "Then: …" 段。
2. **`MAIN_CLIENT_JS` 禁止反引号与 `${}`**（未转义模板字面量内嵌）；新客户端代码一律字符串拼接；`html-syntax.test.ts` 会用 `vm.Script` 编译兜底。
3. **titlebar 铁律**：36px、`pointer-events:none`、`padding-left:78px`（Mac 拖拽由 Swift `DragHandleView` 承担，HTML 仅装饰）。
4. **`.frame` grid 共 4 处**（基础 / `≤1180` 新增 / `≤720` / `force-compact`）必须同步。
5. **Token 漂移**：island.ts / room.ts / iOS `Theme.swift` + `GlanceColors.swift` 是独立副本；本轮不动它们，但 §2 表格是唯一权威源，后续同步以此为准。
6. **隐私**：agent 过程流端点是新的攻击面 —— 复用 `SessionActivity` 的「结构元数据 only」纪律与 visibility tier 门禁，测试比照 channels 适配器的防泄漏测试写。
7. **回归面**：lisa-client.ts 2890 行手写 JS，改动以「新增函数 + 最小改动现有 IIFE」为原则；`sbDesire` 等既有 ID 全部保留（DOM 挪位置不改 ID），把 JS 改动压到布局无关。
8. **生产实例**：本机 :5757 是 launchd 常驻的真实 Lisa（`ai.meetlisa.web`），e2e 一律用独立端口 + 独立 `LISA_HOME`（或等效隔离），验证后清理。

## 7. 开放问题（不阻塞 v1）

- 会话自动命名（首条消息摘要 → 树行名称）；
- 树「按项目」视图切换（D2 反方诉求）；
- 右栏手动折叠 + 布局状态持久化（D4）；
- Lisa 本体真并发（D3，独立 plan）;
- island 药丸点击 agent 行 → 深链到主窗对应树节点/tab。
