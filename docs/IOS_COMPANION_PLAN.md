# LISA iOS 伴侣 App —— 设计方案

> 方法：在当前树（branch `claude/distracted-panini-514a4b`，已并入 `origin/main` 至 PR #110）上盘点
> `src/web/server.ts` 的 HTTP/SSE 表面、`src/integrations/*` 的 Dispatch 数据模型、`src/agents/{managed,pty}.ts`
> 的**新控制面**、`packaging/mac-client/` 的原生客户端，交叉对照
> [PRODUCTIZATION_PLAN.md §5](./PRODUCTIZATION_PLAN.md)（"不做原生 app" 决议）、[MAC_ISLAND_PLAN.md](./MAC_ISLAND_PLAN.md)、
> [PLAN_DISPATCH_v1.0.md](./PLAN_DISPATCH_v1.0.md)、[PTY_AGENTS.md](./PTY_AGENTS.md)。
> 日期：2026-06-18。状态：**提案（proposal）**，未排期。行号以当前树为准，后续会漂移。
>
> **v2 修订（2026-06-18）**：并入 PR #108–#110 落地的**agent 控制面**（managed agents / PTY agents /
> `AgentSession.controllable`），把原 v1 标为"M4 远程派发"的能力从"将来新建"改成"后端已就绪、iOS 只需建控制 UI"。
> 并按新需求新增**核心章节 §4：控制非 LISA 启动的 CLI 与客户端会话**——这是当前代码（[PTY_AGENTS.md:41](./PTY_AGENTS.md)）
> 明确标为"做不到、需 Claude Code 未公开的 `peerProtocol`"的缺口，本方案据已研究的事实给出可落地的补法（接管即启 + resume-adopt 空闲会话）。
>
> **一句话**：把手机变成 LISA **Dispatch 的遥测 + 遥控终端**。看：本机所有 Claude Code / Codex / OpenCode / Aider
> 会话在干什么、卡在哪、跑完没。控：对 LISA 自己跑的 **managed / PTY** agent 可发指令、逐步批准、取消（**后端已就绪**）；
> 对**用户自己起的** CLI / IDE 客户端会话，按 §4 分层接管。对话、心情、Reve 回顾、Sense 同意一并覆盖。
> 后端**控制面已建好**，iOS 侧主要工作是：**配对、推送、控制 UI、（可选）远程通道**，外加 §4 的"接管非 LISA 会话"后端补强。
>
> **实现进展（2026-06-18/19）**：**iOS 面向的后端已基本就绪**（一串 stacked PR，均过 typecheck/build/全量测试）：
> - **#113**：`GET /api/dispatch/list`（结构化 ledger）+ `GET /api/agents/pty/<id>/stream`（PTY 实时输出 SSE）+ `lisa agents pty <agent> <task>`（§4.1 接管即启）+ `--resume <id>`（接通 #111 的 §4.2 resume-adopt）。
> - **#114**：**远程控制 gating**（§7.2）—— `src/control/policy.ts` + `/api/control/policy`；远程默认可控 LISA 自有 agent，**不可**接管外部会话（`remoteAdoptExternal` 默认关）。
> - **#115**：roster **去重**（resume-adopt 的观察态孪生，§8）+ `GET /api/dispatch/status`（受 gating 的日志尾）。
> - **#117**：**每设备配对 token**（§5.3）—— `src/web/devices.ts` + `/api/pair/start`、`/api/devices[/revoke]`；仅存哈希、可单独吊销。
> - **#119**：**运维推送**（§5.5）—— `src/web/push.ts`（ntfy 已可用、APNs 留桩）+ `PushBridge` + `/api/push/{register,unregister,prefs,list}`。
>
> **仍缺 / 受限**：iOS 原生 app（SwiftUI/ActivityKit/WidgetKit/APNs，需 Xcode，**本仓库内无法编译验证**）；`lisa agents pty` 裸键透传（需 node-pty，本机 Node 26 跑不了，见下）；APNs 真机投递（需 Apple push key）。详见各节与 [PTY_AGENTS.md](./PTY_AGENTS.md)。

---

## 0. 目标 / 非目标

### 北极星

> 用户在咖啡馆，Mac 在家跑着三个 agent。掏出手机 → 锁屏**灵动岛 / 实时活动**显示
> `claude-code · auth-refactor · 工作中 · 14 轮 · Edit×3`；推送弹出 `managed · lisa · 卡在权限：Bash`；
> 点开 → **直接在手机上点"批准"**，agent 继续；另一个跑飞的 PTY agent 左划取消。
> 全程数据只在"我的手机 ↔ 我的 Mac"之间。

### 目标

- **G1（看）**：远程观测 Dispatch roster —— 归一化 `AgentSession`（状态/轮次/工具链/改动文件/分支/token/待批权限），实时刷新。
- **G2（控 · LISA 自己的 agent）**：远程遥控 **managed agent**（发指令 `send` / 逐步**批准·拒绝** / 取消）与 **PTY agent**
  （打字进真实 CLI / 看输出 / 取消）。**后端 PR #108–#110 已就绪**，iOS 只需建控制 UI + 远程 gating。
- **G3（控 · 非 LISA 起的会话）★新**：能控制**用户自己起的** CLI（终端 `claude`/`codex`）与**客户端**会话（IDE 扩展 / 桌面端）。
  这是当前缺口（§4）：新起的用**接管即启**，已起且空闲的用 **resume-adopt**；正在跑的外部会话不可控（只能观察）。
- **G4（推）**：事件推送 —— agent 跑完 / 报错 / 卡权限 / Reve 留言 → 推到手机（运维型，非情感型）。
- **G5（一瞥）**：灵动岛 / 实时活动 / 锁屏 + 主屏 Widget，不开 app 也能看当前 agent 进度。
- **G6（覆盖面）**：与 LISA 对话、心情立绘、Reve 回顾、Soul/Memory 速览、Sense 同意。
- **G7（隐私）**：守住 v0.9.1 安全地板（§7）。能不离机就不离机，远程控制默认窄、可审计；控制非 LISA 会话是最高危动作，最强 gating。

### 非目标

- **不在手机本地跑 LISA**。iOS 沙箱不能 spawn `bash`/`git`、不能常驻 heartbeat —— 手机永远是**瘦客户端**，
  真相在 Mac（与 [PRODUCTIZATION_PLAN.md:219](./PRODUCTIZATION_PLAN.md) 一致，没变）。
- **不做情感型主动推送**（"她主动找你聊天"）。本 app 的推送是**运维事件**，不是 [MAC_ISLAND_PLAN.md:28](./MAC_ISLAND_PLAN.md) /
  ROADMAP §0 非目标所禁的"主动找你说话"。这条边界严守，见 §7.4。
- **先不做 Android**。架构（契约/连接性）保持中立，首发只交付 iOS（理由见 §5.1）。
- **不旁路鉴权**。手机=非 loopback，永远走 token；控制非 LISA 会话默认禁、需 Mac 端显式开 + 二次确认。
- **不在手机持久化敏感明文**。Soul/Memory/会话内容/PTY 输出按需拉取、不落地缓存；token 进 Keychain。

### 一条贯穿的张力：重开"不做原生 app"这道题

[PRODUCTIZATION_PLAN.md:199](./PRODUCTIZATION_PLAN.md)（2026-05-10）定过"不做任何原生 app，手机走 PWA"。那决议当时对，理由也成立。
但三件事变了，值得**只为 Dispatch 这个窄场景**重开：①Mac 原生客户端（`packaging/mac-client/`）已落地，设计语言/后端探测/token 可复用；
②Dispatch 从"能观察"长成了**完整控制面**（managed/PTY/approve）；③本场景的核心价值（实时活动/灵动岛/可靠推送/Widget）恰是 iOS PWA
**结构性做不到**的那层。立场不变：**PWA 仍是地板，native 只承接 PWA 做不到的系统层，先 PWA、后 native**，分阶段降风险（§1）。

---

## 1. 为什么现在值得重开这道题

| 2026-05-10 "不做原生 app" 的理由 | 今天是否仍成立 | 影响 |
|---|---|---|
| iOS 不能本地跑 LISA | ✅ 成立 | 我们本就只做瘦客户端 |
| 99% 用户不会装 Tailscale，受众太小 | ⚠️ 部分 | 真受众=会派 coding agent 的开发者，本就有 Tailscale/同 WiFi。精准而非大众 |
| 维护 iOS+推送 ≈ 3–6 个月 | ⚠️ 仍是重活 | 故**分阶段**：M0 先打磨已有 PWA，native 按里程碑增量上 |
| RN/Flutter 跟 PWA 没本质区别 | ✅ 成立 | 所以不用 RN/Flutter；要做就做能吃系统能力的 **native SwiftUI**（§5.1） |
| 当时没有原生客户端可复用 | ❌ **已变** | 现有 `packaging/mac-client/`（Swift/SwiftUI + 后端探测/自启 + 岛屿）可复用 |
| 当时 Dispatch 只"能观察"，手机上看没价值 | ❌ **大变** | PR #108–#110 落地了**控制面**：managed agent 端到端可控、PTY 能驱动真实 CLI。"在手机上盯+指挥 agent"现在是真需求 |

**结论**：PWA 解决"手机上能用 LISA"，但三件事它在 iOS 上**结构性做不到**，而它们恰是本场景核心——

| 能力 | iOS PWA | iOS Native | 为何关键 |
|---|---|---|---|
| 实时活动 / 灵动岛 | ❌ | ✅ ActivityKit | "agent 进度常驻锁屏"= 北极星 |
| 可靠后台推送 | ⚠️ 16.4+、需 HTTPS、被重度节流、须已"加桌"才注册 | ✅ APNs | "跑完/报错/卡权限"通知必须可靠 |
| 主屏 / 锁屏 Widget | ❌ | ✅ WidgetKit | 不开 app 一瞥 roster |
| 聊天 / roster / 心情 / 控制按钮 | ✅ 够用（现有 GUI 已实现 delegate/approve/cancel） | ✅ | —— 这部分 PWA 已够好，不必 native 重写 |

路线**双轨**：保留打磨 PWA（地板，已有 manifest+SW，且 PR #109 的控制 UI 已经在 web GUI 里跑），native 专承上表前三行。

---

## 2. 现状盘点 —— 客户端能直接吃到什么

后端就绪度很高：**一个 iOS 客户端今天就能连现有 `lisa serve --web`，不仅只读，连"指挥 managed/PTY agent"都能跑。**

### 2.1 已就绪（可直接复用）

| 能力 | 入口 | 说明 |
|---|---|---|
| HTTP API（手搓 `node:http`，无框架） | `src/web/server.ts` | 默认 `127.0.0.1:5757` |
| **鉴权**（loopback 信任 / 非 loopback 必须 token） | `isRequestAuthorized` [server.ts:96](../src/web/server.ts) | token：`Authorization: Bearer` / `lisa_token` cookie / `?token=`（[:110](../src/web/server.ts)）；常数时间比较（[:84](../src/web/server.ts)）；非 loopback 无 token 拒绝 bind（[:164](../src/web/server.ts)）；query token 自动钉 cookie（[:474](../src/web/server.ts)） |
| **SSE** `/events` | [server.ts:960](../src/web/server.ts) | `mood`/`chat_*`/`idle_*`/**`agent_session_update`**/`advisor_suggestions`/`sense_event` 等 |
| **Dispatch roster（结构化）** `/api/agents/sessions` | [server.ts:814](../src/web/server.ts) | `{sessions: AgentSession[]}`，含新的 `controllable` 字段 |
| **★控制面 · managed agent** | `POST /api/agents/managed/start` [server.ts:776](../src/web/server.ts)；`/:id/{send,cancel,approve}` [:804](../src/web/server.ts) | LISA 跑自己的 `runAgent` loop（`src/agents/managed.ts`）：发指令、**逐 mutating 工具批准/拒绝**、取消。全工具但去掉 `dispatch_agent`/`signal_agent` |
| **★控制面 · PTY agent**（flagged） | `POST /api/agents/pty/start` [:831](../src/web/server.ts)；`/:id/{send,cancel}` [:869](../src/web/server.ts)；`GET /:id/output` [:858](../src/web/server.ts) | LISA spawn 真实 `claude`/`codex`（`src/agents/pty.ts`，node-pty）：打字进 CLI、看输出尾、取消。需 `LISA_PTY_AGENTS=1`，否则 503 |
| **`controllable` 字段** | `src/integrations/types.ts:85` | `"managed"\|"pty"`；缺省=观察态。UI 据此决定驱动哪一族控制端点：`/api/agents/<controllable>/<id>/…` |
| Dispatch 列出/取消（仅 LISA ledger 内的 pid） | `/api/agent/signal` [server.ts:740](../src/web/server.ts) | `{action:"list"\|"cancel"}`。**注意**：`list` 返回**给人读的文本**；roster 一律走 `/api/agents/sessions` |
| recap | `/api/agents/recap` [server.ts:826](../src/web/server.ts) | `?sinceMinutes=N` |
| 对话 / 历史 | `/chat`（POST→SSE）[server.ts:1183](../src/web/server.ts)、`/api/history` [:974](../src/web/server.ts) | 请求 `{message,files?}`；历史 pageSize=20 |
| 轻量状态 | `/api/island/ping` [server.ts:498](../src/web/server.ts) | `{online,mood,has_unread_idle_message,…,current_desire,uptime_sec}` |
| Sense 同意 / 事件 | `/api/consent[/grant\|/revoke\|/revoke-all]` [:728](../src/web/server.ts)、`/api/sense/recent` [:771](../src/web/server.ts) | 开关采集信号 + 最近 30 条 |
| Soul/Memory/Skills/Tools 速览 | `/api/soul` [:1109](../src/web/server.ts)、`/api/memory` [:1009](../src/web/server.ts)、`/api/skills` [:994](../src/web/server.ts)、`/api/tools` [:1020](../src/web/server.ts) | 只读 |
| **PWA 地基 + 控制 UI 范例** | `/manifest.webmanifest` [:858](../src/web/server.ts)、`/sw.js` [:885](../src/web/server.ts)；GUI 控制 UI 见 `src/web/lisa-client.ts`（PR #109 的 delegate/approve/cancel/send） | native 可照搬这套交互语义 |
| **原生客户端范式** | `packaging/mac-client/Sources/Lisa/` | Swift/SwiftUI 容器 + 后端探测/自启 + 岛屿；token/SSE/立绘资产可复用 |

### 2.2 仍缺（本方案要新建的东西）

| 缺口 | 现状 | 里程碑 |
|---|---|---|
| **设备配对**（QR → token 进 Keychain） | 无；只能手敲 `host:port + ?token=` | M1 |
| **推送通道**（APNs 注册 + Mac 端 push-bridge） | 无；后端从不主动外联 | M2 |
| **实时活动 / 灵动岛 / Widget** | 无（PWA 也做不到） | M2 |
| **iOS 控制 UI** | 后端就绪、web GUI 已实现；iOS 端要建 delegate/kind-picker/send/approve-deny/cancel/output | M3 |
| **★控制非 LISA 启动的会话** | 活会话不可控（硬约束）；接管即启 + resume-adopt 空闲会话**均已落地**（详见 §4）；剩远程 gating + iOS UI | ✅ 后端/CLI；iOS UI 待建 |
| **远程控制 gating 开关** | 现有端点对 loopback 与带 token 的远程一视同仁；控制类需要"远程默认禁 + Mac 端 opt-in" | M3 |
| **远程通道**（出门也能连，不开防火墙洞） | 无内建；需 Tailscale/隧道 | M0 文档化 + M3 体验化 |
| **多设备 token / 吊销** | 全局单一 `LISA_WEB_TOKEN` | M3 |
| **Dispatch 自有 fire-and-forget 的结构化清单** | `/api/agent/signal` 的 list 是文本；ledger 的 pid/cwd/task/logPath 无结构化端点 | M1 |
| **部分配置 loopback-only**（手机改不了） | `/api/config/save`（[:1045](../src/web/server.ts)）、`/api/screen-advisor/config`（[:533](../src/web/server.ts)） | 设计上**保留**；手机端只读 |

---

## 3. Dispatch 的会话身份模型（理解控制面的钥匙）

PR #108–#110 之后，roster 里的会话**按"谁启动、能否控制"分成几类**，由 `AgentSession.controllable` 区分。
**iOS app 的控制 UI 完全 key off 这个字段**——它不关心是哪种 agent，只看 `controllable` 决定显示哪些按钮、打哪族端点。

| 身份 | 谁启动 | `agent` kind | `controllable` | 手机能做 | 端点族 |
|---|---|---|---|---|---|
| **观察态 CLI/客户端** | 用户自己（终端/IDE/桌面端） | `claude-code`/`codex`/`opencode`/`aider`/`github-pr` | 无 | **只看**（cancel 仅当它恰在 LISA ledger 里） | —（观察经 on-disk session 文件） |
| **managed** | LISA 跑自己的 `runAgent` loop | `managed` | `"managed"` | 看 + `send` + **approve/deny** + cancel | `/api/agents/managed/*` |
| **PTY**（flagged） | LISA spawn 真实 `claude`/`codex`（node-pty） | 真实 kind（`claude-code`/`codex`） | `"pty"` | 看 + 打字进 CLI + cancel + 看 output | `/api/agents/pty/*` |
| **resume-adopt**（§4.2，✅ #111） | 用户**已起、现空闲**的 claude 会话（roster 标 `resumable`），`claude --resume` 续写 | 真实 kind（`claude-code`） | 续写后 `"pty"` | 接管 + send + cancel + output | `pty/start {resumeSessionId}`（liveness 409 守卫） |
| **活的外部会话** | 桌面 app / IDE 正在跑 | 真实 kind | 无（**不可控**） | 只看；等它空闲再 §4.2 接管 | —（桌面 app 独占 stream-json 管道） |

> **诚实原则**（PR #109/#110 反复强调，必须继承）：observe-only 的会话**绝不**伪装成可控。roster 卡片要清楚区分
> "可控"与"只读"；让一个只读会话变可控，必须是**用户显式"接管"动作**（§4），不是悄悄声称的能力。

前三类（managed/PTY/resume-adopt）都归一到"LISA 拥有的 PTY/loop"，故可控；**活的外部会话不可控**（§4 解释为何）—— 这正是用户本次点名、§4 要诚实处理的边界。

---

## 4. ★控制非 LISA 启动的 CLI 与客户端会话（本次新增核心）

**需求**：手机（经 LISA）要能控制**不是 LISA 启动的**会话 —— 用户自己起的 `claude`/`codex`、以及 IDE/桌面端**客户端**会话。

**先说清一条硬事实**（已研究过、勿重新推导，见记忆 `project_agent_control_plane.md`）：在本用户的 Mac 上，`claude` 跑在
**Claude 桌面 app** 里，每个会话由桌面 app 用 `--input-format stream-json` **独占** stdin/stdout 管道。因此一个**正在跑（live）的
外部会话对任何外部进程都不可注入**——LISA 无法"附身"它。IDE 锁文件（`~/.claude/ide/<port>.lock`）是鉴权锁的；
`peerProtocol:1`（`~/.claude/sessions/<pid>.json`）未公开且不稳；该用户日常也不用 tmux / 裸终端 claude。
**诚实结论：活的外部会话只能观察、不能控制——别假装能。**

所以"控制非 LISA 会话"落到**两条真正可行**的路（都让会话归到 LISA 拥有的 PTY，从而 `controllable:"pty"`）：

### 4.1 第一层 · 接管即启（wrapper / shell 集成）—— 推荐、可立即落地 ✅ 首版已落地

**思路**：不去"夺取"一个已在跑的进程，而是**改变会话的出生方式**。用户照常在终端干活，但**经 LISA 起** agent：

```sh
lisa agents pty claude "重构鉴权"   # 经运行中的 serve spawn 真实 claude，从出生就 controllable:"pty"
lisa agents pty codex "跑测试"      # codex 同理；--port N 指定非默认端口
```

（可再装一个 shell 函数/alias 把 `claude` 透明路由成 `lisa agents pty claude`。）这样"用户自己的终端会话"
**从第一秒就是 LISA spawn 的 PTY agent**——直接复用现成的 `PtyRegistry`（`src/agents/pty.ts`）、`/api/agents/pty/*`
端点、`controllable:"pty"` roster 呈现。**无需 peerProtocol**。

- 把"不是 LISA 启动"诚实地重述为 **"由你、经 LISA 启动"** —— 既满足需求，又不撒谎说能附身任意进程。
- **已实现**（`src/cli/agents-pty.ts`）：`lisa agents pty` 是运行中 `serve` 的瘦客户端（loopback，无需 token），
  `POST /api/agents/pty/start` 让 CLI spawn 在 **server 进程内**（故进 roster、可被岛/GUI/手机遥控），再经新增的
  SSE `GET /api/agents/pty/<id>/stream` 把输出镜像到本地终端、把你敲的每行经 `/send` 转发。需 server 开 `LISA_PTY_AGENTS=1`。
- **v1 限制**（已在代码/[PTY_AGENTS.md](./PTY_AGENTS.md) 标注）：输入是**行级**（一行 → CLI 一行），非裸键透传——
  适合 task 式跑，不适合驱动方向键 TUI。裸终端 attach 是后续工作。
- 覆盖：**终端 CLI 会话**的 80%。对"我就想用终端、但也想手机上指挥"的用户，这是最顺的路径。

### 4.2 resume-adopt —— 接管一个**已起、现空闲**的会话（"我之前那个会话"的真正解）✅ 已落地（PR #111）

**思路**：你没法注入一个**活**会话，但可以**续写一个空闲会话**。`claude --resume <session-id>` 在 LISA 的 PTY 里重开它
（共享同一份 transcript，是续写不是新开），它随即 `controllable:"pty"` —— 进 roster、可手机遥控。

- **已实现的 API**（#111）：`POST /api/agents/pty/start {resumeSessionId}`（**不是**单独的 adopt 端点）——内部 `claude --resume <id>`
  起 PTY；`GET /api/agents/sessions` 给**空闲**的 claude 会话打上 `resumable:true`（[types.ts:85](../src/integrations/types.ts) 之后）。
- **硬护栏（决定性，已实现）**：`src/integrations/claude-code/liveness.ts` 的 `liveClaudeSessionIds()`（读 pid-file + `kill -0`）守门——
  resume 一个**还活着**的会话会损坏 transcript，端点直接 **409**。`detectClaudeBinary()` 还优先用 app 内置的 claude（版本对得上 transcript）。
- **入口**：①GUI roster 对 `resumable` 会话给"接管"按钮（#111）；②**终端** `lisa agents pty --resume <session-id>`（本次接通，复用 §4.1 attach 客户端；命中 409 会提示"先关掉它"）；③岛仍保留手动"复制 `claude --resume`"。
- 覆盖：**用户已起、现已空闲**的 claude 会话："我之前那个会话，手机上让它接着干。"

### 4.3 为什么 tmux / peer 协议不是这里的答案（诚实记账）

- **tmux/screen 桥**（`send-keys`/`capture-pane`）技术上能控 tmux pane 里的任何进程，但**本用户日常不在 tmux 里跑 agent**
  （claude 跑在桌面 app），对该设置**不适用**。对在 tmux 里跑 CLI 的其他用户它仍是可选信道，但不进主线。
- **peer/IDE 协议**：桌面 app/IDE 的活会话走自有 stream-json 管道、锁文件鉴权锁、`peerProtocol` 未公开不稳——**"活附身"既危险又易碎**。
  结论同 §4 开头：活会话不控，等它空闲走 §4.2。

### 4.4 把需求映射回可行方案

| 用户说的 | 真正可行 | 状态 |
|---|---|---|
| 我想**新起**一个 claude/codex，且手机可控 | §4.1 接管即启（`lisa agents pty`） | ✅ 已建 |
| 我**之前起过、现在空闲**的 claude 会话，想接着指挥 | §4.2 resume-adopt（`claude --resume` + liveness 守卫） | ✅ 已落地（#111 后端/GUI + `lisa agents pty --resume`） |
| 一个**正在跑**的桌面 app / IDE 会话 | **不可控**，只能观察；等它空闲再 §4.2 | —— |

**iOS 侧零特判**：两条可行路都产出 `controllable:"pty"` + 现成 `/api/agents/pty/*`。app 控制 UI 仍只 key off `controllable`，
新路自动接入、UI 不改。对 observe-only 的活会话，卡片"接管"affordance 按 liveness 给出："空闲 → 接管续写（resume）"或"活跃中，暂不可控"。

### 4.5 安全前置（控制非 LISA 会话 = 最高危）

接管用户自己的会话（尤其 resume 一个真实开发会话）= 能往真实环境注入命令、续写真实 transcript。故：
- **liveness 守卫不可绕过**：resume 前必须确认空闲，绝不双写（两个 writer 损坏 transcript / API 409）。
- **远程（手机）接管默认禁**：需 Mac 端显式开"允许远程接管会话" + 手机端二次确认。详见 §7.2。

---

## 5. 技术架构（客户端 / 连接 / 实时 / 推送）

### 5.1 客户端技术选型：原生 SwiftUI

选 native SwiftUI，不选 RN/Flutter，也不靠 PWA 单打：

- 全部差异化价值（Live Activity / 灵动岛 / Widget / 可靠 APNs / 后台刷新）是 **iOS 独占系统能力**，只有 native 吃得到。
- 可复用 Mac 客户端（`packaging/mac-client/`，已是 Swift/SwiftUI）的设计语言、立绘资产、SSE/token 思路。
- 反方意见（[PRODUCTIZATION_PLAN.md:291](./PRODUCTIZATION_PLAN.md)："RN/Flutter 跟 PWA 没本质区别"）**正好支持**这个选择：只包一层 web UI 确实不如 PWA；
  要做就做 PWA 做不到的系统层，而那只有 native。
- **Android** 首发不做，契约保持中立，将来 Kotlin 客户端复用同一套端点。
- **PWA 并行保留**：M0 打磨现有 PWA 的移动 viewport / add-to-home / Tailscale 文档（[PRODUCTIZATION_PLAN.md:253](./PRODUCTIZATION_PLAN.md) 已列大半）。
  PR #109 的控制 UI 已经在 web GUI 里能跑 —— PWA 用户今天就能 delegate/approve/cancel，只是没有系统级一瞥与可靠推送。

### 5.2 连接性（三档，推荐 Tailscale 为主）

| 档 | 怎么连 | 出门 | 隐私 | 成本 | 推荐 |
|---|---|---|---|---|---|
| **A. 同 WiFi 直连** | Mac `--host 0.0.0.0` + token；手机 `http://<lan-ip>:5757` | ❌ | ★★★ 不出局域网 | 低（IP 会变） | 入门 |
| **B. Tailscale / WireGuard** | 两端装 Tailscale；`http://<mac>.<tailnet>.ts.net:5757` | ✅ | ★★★ mesh 加密、无第三方见内容 | 中（一次性） | **主推** |
| **C. LISA Relay（远期可选）** | Mac **出站**长连 relay（不开入站口）；手机连 relay | ✅ | ★★ 需设计成只过密文/通知元数据（§7.3） | 低（零配置） | 远期 opt-in |

```
A. 同 WiFi               B. Tailscale mesh            C. Relay（远期）
iPhone ──LAN:5757──▶ Mac  iPhone ──tailnet:5757──▶ Mac  iPhone ─▶ Relay ◀─出站长连─ Mac
 token                     token+WG 加密直达             per-device token, E2E  ▲APNs
```

**Mac 端只暴露既有 `lisa serve --web`**：不开第二个服务器，把鉴权/路由收敛在 `src/web/server.ts` 一处（v0.9.1 安全修复都在这）。
远程访问 = "对既有 server 开 token 门" + 选一条隧道，**不是**新写对外服务。Relay 若真做必须 E2E（§7.3），默认推 Tailscale。

### 5.3 鉴权与配对

- **QR 配对**：Mac app / 终端展示二维码，编码 `lisa-pair://v1?host=&port=5757&token=&name=`；手机扫 → token 进 **Keychain** →
  之后带 `Authorization: Bearer`。正是 [server.ts:107](../src/web/server.ts) 注释里"query 形式让手机 bootstrap"的延伸。
- **每设备一 token（M3）**：把全局单一 `LISA_WEB_TOKEN` 升级为"主 token + per-device token"，可单独吊销、带 label/last-seen（新增 `/api/devices`）。M1/M2 先用现有单 token。
- **Keychain + 生物识别**：token 进 Keychain，可选 Face ID 解锁；手机端不缓存 Soul/Memory/会话/PTY 输出明文。
- **TLS**：Tailscale 链路自带加密；走公网/Relay 必须 HTTPS。

### 5.4 实时数据（SSE）

- 主通道 = SSE `/events`（[server.ts:960](../src/web/server.ts)）。iOS 用 `URLSession` bytes/AsyncSequence 手搓 SSE 解析。
  `agent_session_update` 增量 merge 进 roster；`mood` 驱动立绘；`idle_message`/`advisor_suggestions` 驱动 Reve。
- 断线指数退避；前台恢复先打 `/api/agents/sessions` + `/api/island/ping` 全量校正再续 SSE。
- **iOS 后台必然掐 SSE**：前台靠 SSE 实时，后台靠 APNs（§5.5）+ BGAppRefresh 做"够新"。→ 关键状态跃迁（done/error/卡权限）**必须能从服务端 push**，不能只靠客户端轮询。

### 5.5 推送通知

后端**唯一需主动外联**的新能力，独立 opt-in（呼应 [SPRINT_4_PLAN.md:166](./SPRINT_4_PLAN.md)）。Mac 端起 **push-bridge** 订阅
`OrchestratorHub` 的 `update` + idle/advisor 事件，状态发生"值得打扰"的跃迁时经 APNs 推到已注册设备。

| 事件 | 条件 | 默认 | 类型 |
|---|---|---|---|
| agent 完成 | `state→done` | 开 | 普通 + 结束 Live Activity |
| agent 报错 | `state→error` | 开 | 高优先级 |
| **卡在权限** | `activity.pendingPermission` 出现 | 开 | **时效性**（time-sensitive） |
| Reve 留言 | `idle_message` | 开 | 普通 |
| 进度心跳 | `working` 中 `turnCount` 变 | 关 | 仅 Live Activity 远程更新（不响铃） |
| advisor 建议 | `advisor_suggestions` | 关 | 普通 |

**手机上能否直接批准权限？—— 现在分情况（这是 v2 相对 v1 的重要更正）：**
- **managed agent**：**能**。`approve` 端点已就绪（[server.ts:816](../src/web/server.ts)），手机点"批准/拒绝"直接驱动 `managedRegistry.decide`。推送→深链→批准，闭环。
- **PTY**（真实 CLI，含接管即启 / resume-adopt）：**半能**。它是真实 CLI 自己弹权限提示，手机"批准"= 经 `send` 往 CLI 打一行答复（如回车/`y`），是**遥控输入**不是结构化授权。可用，但要把"你在替真实 CLI 答提示"讲清，并纳入 §7.2 的远程 gating。
- **观察态外部会话**：仍**不能**（没有信道）—— 除非先经 §4 接管（接管即启 / resume-adopt）变成 PTY。

**推送隐私三选项**：

| 方案 | 谁见内容 | 自托管 | 取舍 |
|---|---|---|---|
| **a. 自托管 ntfy** | 无第三方 | ✅ | 最隐私，用户要自部署 |
| **b. LISA 最小化 E2E relay** | relay 只见密文+路由 | 项目托管 | 零配置 + 不可读；要项目维护 E2E |
| **c. Pushover / 通用** | 第三方可见 payload | ❌ | 最省事最不隐私，**不做默认** |

**推荐 b**（payload 只放"agent 名+状态+项目名"低敏元数据），为洁癖用户提供 **a**。payload 遵守"结构化元数据、不含会话内容"，与 `SessionActivity`
隐私契约（[types.ts:36](../src/integrations/types.ts)）一致；**PTY 的终端输出绝不入推送**（它本就只按需经 `/output` 给本人，[pty observer:11](../src/integrations/pty/observer.ts)）。

### 5.6 后台与省电

- Live Activity 优先走 APNs 远程更新（系统给它单独推送预算）。
- Widget 由 silent push 触发 Timeline 刷新，无推送时退化为低频 BGAppRefresh（15–30 min）。
- push-bridge 对 `working` 心跳合并、对同一 agent 连续跃迁限流，避免话痨 agent 刷爆通知。

---

## 6. 数据模型与 API 契约

### 6.1 复用的现有端点（无需改）

见 §2.1。客户端本地模型对应 `src/integrations/types.ts`：`AgentSession`（含 **`controllable`**）、`SessionActivity`、`AgentSessionState`、`AgentKind`。
`/api/agents/sessions` 把 `lastMtime` 序列化成 **ISO 串**（[server.ts:817](../src/web/server.ts)）。
**控制端点已就绪**：`/api/agents/managed/{start,:id/send,:id/cancel,:id/approve}`、`/api/agents/pty/{start,:id/send,:id/cancel,:id/output}`。

managed `approve` 语义：`POST /api/agents/managed/<id>/approve {allow?}`，`allow` 缺省=true，`allow:false`=拒绝（[server.ts:816](../src/web/server.ts)）。

### 6.2 需要新增的端点（服务端工作量）

> 全挂在既有 `src/web/server.ts` 鉴权门后；控制类额外受 §7.2 "远程控制 gating" 约束。

```http
# —— 配对与设备（M1/M3）——
POST   /api/pair/start          # 生成一次性配对码（短时效）→ {code, expiresAt}；二维码 lisa-pair://v1?…
GET    /api/devices             # [{id,name,platform,lastSeen,scopes}]
POST   /api/devices/revoke      # {id} 吊销某设备 token

# —— 推送（M2）——
POST   /api/push/register       # {deviceToken, platform:"ios", prefs:{done,error,permission,idle,advisor}}
POST   /api/push/unregister     # {deviceToken}
GET/POST /api/push/prefs        # 读/写推送偏好

# —— Dispatch fire-and-forget 结构化清单（M1）——
GET    /api/dispatch/list       # ✅ 已落地：[{id,agent,pid,cwd,task,startedAt,alive,hasLog}]（ledger 结构化版，补 /api/agent/signal 的文本 list）

# —— ★控制非 LISA 会话（§4）——
GET    /api/agents/pty/<id>/stream # ✅ 已落地：PTY 实时输出 SSE（snapshot + chunk），支撑接管即启的本地镜像
# §4.1 接管即启已实现为 CLI 客户端 `lisa agents pty`（复用现有 /api/agents/pty/start + 新增 /stream），无需新增服务端 adopt 端点
POST   /api/agents/pty/start       # ✅ #111 扩展：{resumeSessionId} → claude --resume <id> 起 PTY；live 会话则 409（liveness 守卫）
# ✅ /api/agents/sessions 现给空闲 claude 会话打 resumable:true；CLI 入口 `lisa agents pty --resume <id>`
# 注：tmux/peer 不进主线——本用户 claude 跑在桌面 app，活会话不可注入（§4.3）

# —— 远程控制开关（M3）——
GET/POST /api/control/policy    # {remoteControl:bool, remoteAdoptExternal:bool}（Mac 端 opt-in，默认 false）
```

`GET /api/dispatch/list` 契约示例（注意 ledger 用 `"claude"`、hub/`AgentSession` 用 `"claude-code"`，客户端要映射）：

```jsonc
{ "dispatches": [
  { "id":"48213-lr9x2", "agent":"claude", "pid":48213,
    "cwd":"/Users/oratis/Documents/LISA", "task":"Refactor the auth gate…",
    "startedAt":"2026-06-18T09:14:02.000Z", "alive":true }
]}
```

### 6.3 SSE 事件 → UI 映射

| SSE `type` | 客户端动作 |
|---|---|
| `agent_session_update` / `claude_session_update`（兼容别名） | merge 进 roster（含 `controllable`）；触发本地通知/Live Activity |
| `mood` | 换顶部立绘 |
| `chat_start` / `chat_end` | 聊天"思考中" |
| `idle_message` / `idle_*` | Reve tab 红点 +（后台时）推送 |
| `advisor_suggestions` / `screen_suggestion` | Reve · 建议（默认不推送） |
| `sense_event` | Sense · 事件流 |

### 6.4 推送 payload（低敏，结构化）

```jsonc
{ "kind":"agent_permission", "agent":"managed", "project":"lisa",
  "state":"waiting", "reason":"Bash", "sessionId":"m3-…", "ts":"2026-06-18T09:31:00Z" }
// 不含 prompt/模型回复/完整命令/文件内容/PTY 输出。E2E 时这部分是密文。
```

---

## 7. 隐私与安全（守住地板）

### 7.1 威胁模型

- **被偷的 token = 对你 Mac 的全工具 agent 的远程访问**（[server.ts:167](../src/web/server.ts) 注释）。→ per-device token + 可吊销、Keychain、可选 Face ID、配对码短时效。
- **远程来源默认不可信**：远程能做的比 loopback 窄（§7.2）。
- **控制非 LISA 会话 = 攻击面最大**：等于经手机往你真实终端/IDE 注入命令、替你答 CLI 提权 → 最强 gating。
- **第三方网关（推送/relay）**：默认见不到内容（§7.3）。

### 7.2 远程能力分级（不是所有事都能远程做）

| 动作 | loopback（本机） | 远程（手机） |
|---|---|---|
| 看 roster / recap / 心情 / soul / memory | ✅ | ✅ |
| 对话 `/chat` | ✅ | ✅ |
| **控制 managed agent**（send/approve/cancel） | ✅ | ✅（建议默认开，approve/cancel 二次确认） |
| **控制 PTY agent**（send/cancel/output） | ✅ | ⚠️ 默认开但 send=打字进真实 CLI，二次确认；output 含终端内容、可单独关 |
| **★接管/控制非 LISA 会话**（接管即启 / resume-adopt） | ✅ | **默认禁**，需 Mac 端 `remoteAdoptExternal=true` + 手机二次确认 |
| 改配置 `/api/config/save`、`/api/screen-advisor/config` | ✅（[:1045](../src/web/server.ts), [:533](../src/web/server.ts)） | **保留 loopback-only**，手机只读 |
| 截图 / 转写 | ✅ | 沿用 Sense consent gate，不因"远程"放宽 |

**原则**：远程默认 = "遥测 + 控制 LISA 自己的 agent（managed/PTY）"；**控制用户自己的外部会话**默认禁、显式 opt-in + 二次确认。
与 [PLAN_DISPATCH_v1.0.md](./PLAN_DISPATCH_v1.0.md) 的"最小权限 + 人类批准闸 + 远程来源默认禁"一脉相承。

### 7.3 Relay / 推送的 E2E

配对时在手机与 Mac 间协商密钥（QR 带 Mac 公钥），relay/APNs 只搬密文 + 最小路由元数据，relay 不持久化/不解密/不索引。
文档明确："Tailscale（B 档）是不依赖第三方的推荐路径；Relay/推送是便利性 opt-in，代价是引入哑转发第三方"。

### 7.4 把"推送"与"非目标：主动推送"调和

ROADMAP §0 / [MAC_ISLAND_PLAN.md:28](./MAC_ISLAND_PLAN.md) 的非目标是 **"她不主动找你说话、不响铃、不抢焦点"**——针对**情感型主动外联**。
本 app 的推送是**运维事件告警**（你委托的 agent 出事了），等同 CI 通知，**显式 opt-in、逐项可关、不含情感内容**。
默认只推确定性事件（done/error/permission）；`idle_message` 虽偏情感但**已发生**，推送是"取信"非"主动打扰"，仍可单独关；绝不做"主动发起对话"的推送。

### 7.5 与 v0.9.1 安全地板对齐

[PLAN_DISPATCH_v1.0.md:8](./PLAN_DISPATCH_v1.0.md) 把 v0.9.1 关掉的 P0（`serve --web` 无鉴权 LAN-RCE 等）列为地板。本方案所有远程能力
**走既有 server 同一道鉴权门**，不开旁路；新增端点（尤其 §4 控制类）排期前复核这道门仍成立，且默认对远程收窄。

---

## 8. 实施阶段（里程碑 + 验收）

> 排序：先打磨已有（PWA）→ native 只读 → 系统级一瞥/推送 → 控制 LISA 自己的 agent（后端已就绪）+ 接管即启 → resume-adopt 空闲外部会话。
> 风险/价值随里程碑递增；每步可独立交付、可叫停。

### M0 — PWA 打磨（地板，~1 周）
现有 PWA 做移动 viewport、add-to-home、横竖屏；文档化"同 WiFi 直连 / Tailscale 出门"两条路径。
**验收**：iPhone 加桌全屏跑 chat + roster + （已有的）delegate/approve/cancel；Tailscale 下出门能连。

### M1 — Native 只读客户端（over LAN/Tailscale）
SwiftUI app：roster（`/api/agents/sessions` + SSE 增量，**按 `controllable` 显示可控/只读徽标**）、chat、心情、Reve recap、Soul/Memory/Sense 只读。
QR 配对 + Keychain；新增 `/api/pair/start`、`/api/devices`、`/api/dispatch/list`。取消 LISA 自有 agent（`/api/agent/signal` cancel，二次确认）。
**验收**：扫码配对；roster 实时反映 Mac 上 `claude -p`/`codex exec` 的状态跃迁，可控/只读区分正确。

### M2 — 系统级一瞥 + 推送（差异化核心）·后端 ✅（#119），iOS 表面待建
**推送后端已落地**（#119）：`POST /api/push/register` + `PushBridge` + 触发矩阵（§5.5），**ntfy 现可端到端工作**（无需 Apple）。**仍缺**：ActivityKit 实时活动 + 灵动岛、WidgetKit Widget、APNs 真机投递（需 Apple push key）—— 这些是 iOS 原生层，需 Xcode。
**验收**：（后端）`done/error/permission` 跃迁触发推送、可经 ntfy 收到；（iOS）锁屏看到钉住 agent 进度、点推送深链 —— 待 app。

### M3 — 控制 LISA 自己的 agent + 接管即启 + 远程 gating ·后端/CLI ✅（#114），iOS UI 待建
**远程 gating 已落地**（#114，`/api/control/policy`）；**接管即启已落地**（#113，`lisa agents pty`）。**仍缺**：iOS 控制 UI（delegate / approve-deny / send / cancel / output —— 后端就绪，只差 SwiftUI）。
**验收**：（后端）远程控制默认按策略放行、接管外部会话默认禁——已实测 403；（iOS）手机上 delegate + 逐步 approve/deny —— 待 app。

### M4 — resume-adopt 空闲会话（用户点名"控制非 LISA 会话"的真正解）✅ 后端/GUI/CLI 已落地（#111 + 本次）
`src/integrations/claude-code/liveness.ts`（`liveClaudeSessionIds()` 守卫）+ `POST /api/agents/pty/start {resumeSessionId}`（`claude --resume`，活会话 409）+ `resumable` 字段 + GUI 接管按钮 + `lisa agents pty --resume <id>`。**剩**：`remoteAdoptExternal` 远程 gating + iOS 接管 UI。
**验收**：一个**已退出/空闲**的 claude 会话能从手机/终端"接管续写"并发指令；对一个**活**会话返回 409、绝不双写；远程默认不可达（gating 待建）。

---

## 9. 风险与开放问题

- **活会话不可控是硬约束**（§4.3）：桌面 app 独占 stream-json 管道、IDE 锁文件鉴权锁、`peerProtocol` 未公开不稳。结论：不追"活附身"，走 §4.2 resume-adopt 空闲会话；**护栏**：liveness 检查防双写（API 会 409）。
- **身份连续性 / 双计**：一个 §4.1 接管即启的 PTY 会话，同时也会被 claude-code on-disk observer 看到（两个来源、同一个真实会话）→ roster 可能重复。需要按 cwd+时间或 PID 去重，或让 PTY 会话"吸收"对应的观察态条目。**开放问题**。
- **替真实 CLI 答权限**（§5.5）：PTY 的"批准"= 往 CLI 打字，是遥控输入非结构化授权；远程这么做风险高，gating 要硬。
- **`agent` 命名不一致**：ledger `"claude"` vs hub/`AgentSession` `"claude-code"`（[types.ts:14](../src/integrations/types.ts) vs [dispatch_agent.ts:33](../src/tools/dispatch_agent.ts)）；PTY 用真实 kind、managed 用 `"managed"`。客户端要统一映射。
- **维护成本**（[PRODUCTIZATION_PLAN.md:230](./PRODUCTIZATION_PLAN.md) 的老担忧仍真）：native iOS + 推送 + resume-adopt 守卫是长期负担。缓解：分阶段、可叫停、PWA 始终后备。
- **受众窄**：真正受益的是"会派 coding agent 且有 Tailscale"的开发者。精准而非大众，别为扩受众牺牲隐私默认值。
- **Relay 信任**：哪怕 E2E，引入第三方转发即信任面扩张。默认推 Tailscale，Relay 永远 opt-in。
- **苹果审核**：远程控制他人机器/后台/推送要把权限说明写清；Live Activity/Widget 有审核细则。
- **SSE vs 后台**：iOS 后台必掐 SSE，"实时"只在前台；后台=推送驱动的"够新"，要在产品预期里讲清。

---

## 10. 附录

### A. 端点清单速查

**复用（现有）**：`/events`、`/chat`、`/api/history`、`/api/agents/sessions`（含 `controllable`）、`/api/agents/recap`、`/api/agent/signal`、
**`/api/agents/managed/{start,:id/send,:id/cancel,:id/approve}`**、**`/api/agents/pty/{start,:id/send,:id/cancel,:id/output}`**、
`/api/island/ping`、`/api/consent[/grant|/revoke|/revoke-all]`、`/api/sense/recent`、`/api/soul`、`/api/memory`、`/api/skills`、`/api/tools`、`/api/sessions`、`/api/advisor/latest`、`/manifest.webmanifest`、`/sw.js`、`/assets/*`。

**新增（本方案）**：`/api/pair/start`、`/api/devices[/revoke]`、`/api/push/{register,unregister,prefs}`、`/api/dispatch/list`、
`/api/control/policy`，以及 §4 接管族 `/api/agents/{adoptable, adopt}`（resume-adopt，待建；接管即启复用 `/api/agents/pty/*`）。

**保留 loopback-only（手机只读）**：`/api/config/save`、`/api/screen-advisor/config`。

### B. 建议的 iOS 模块结构

```
LisaPocket/
├── App/                 # @main, 路由, 5 Tab
├── Net/{LisaClient, SSEStream, Models}.swift   # URLSession+Bearer / 手搓 SSE / AgentSession·SessionActivity(controllable)
├── Dispatch/            # roster（key off controllable）/ 详情 / 控制（send·approve·deny·cancel·output）/ 接管
├── Chat/                # 对话 + 历史 + 心情立绘
├── Reve/                # recap / desires / memory / advisor
├── Sense/               # 同意 + 事件
├── Settings/            # 配对(QR) / 设备 / 连接 / 推送偏好 / 远程控制开关 / 关于
├── SystemSurfaces/{LiveActivity, Widgets}/     # ActivityKit+灵动岛 / WidgetKit
├── Pairing/             # QR 扫描 + Keychain
└── Push/                # APNs 注册 + 深链路由
```

### C. `controllable` → 控制 UI（核心交互规则）

| `controllable` | roster 卡片控件 |
|---|---|
| 无 · 活的外部会话 | 只读（活会话不可控）；空闲时给"接管续写（§4.2 resume）"入口 |
| `"managed"` | send 跟进 · **批准/拒绝**（当 `activity.pendingPermission`）· 取消 |
| `"pty"`（含接管即启 §4.1 与 resume-adopt §4.2） | 打字进 CLI · ▤ output · 取消 |

颜色与 Mac 岛屿状态机（[MAC_ISLAND_PLAN.md:49](./MAC_ISLAND_PLAN.md)）一致：`working`蓝 / `waiting`琥珀（卡权限时高亮）/ `error`红 / `done`绿 / `idle`灰。

### D. 与其它文档的关系

- **更新** [PRODUCTIZATION_PLAN.md §5](./PRODUCTIZATION_PLAN.md)"不做 iOS 原生 app"结论 —— 仅针对 Dispatch 遥测+遥控这个窄场景，且以"PWA 仍是地板、native 只补系统层、分阶段"为前提。
- **延伸** [PTY_AGENTS.md](./PTY_AGENTS.md)：本方案 §4 接续它点名的缺口，但据已研究的事实改走：**接管即启 + resume-adopt 空闲会话**（活会话不可控，不追 `peerProtocol`）。
- **并列** [MAC_ISLAND_PLAN.md](./MAC_ISLAND_PLAN.md)：Mac 岛="桌面上瞥一眼"，iOS app="口袋里瞥一眼 + 出门也能控"。两者共享心情状态机、SSE 契约、立绘资产。
- **服务** [PLAN_DISPATCH_v1.0.md](./PLAN_DISPATCH_v1.0.md)：本 app 是 Dispatch 支柱的远程消费+控制面，把归一化 `AgentSession` + 控制端点端到端送到手机。

### Glossary

- **Dispatch**：LISA 观察并指挥本机其它 agent 的调度支柱。
- **AgentSession / `controllable`**：归一化会话表示；`controllable` 标明可否控制及驱动哪族端点（`src/integrations/types.ts:85`）。
- **managed agent**：LISA 跑自己 `runAgent` loop 的可控 agent，逐 mutating 工具批准（`src/agents/managed.ts`）。
- **PTY agent**：LISA 经 node-pty spawn 的真实 `claude`/`codex`，flagged（`src/agents/pty.ts`，[PTY_AGENTS.md](./PTY_AGENTS.md)）。
- **接管即启 / resume-adopt**：§4 让"非 LISA 启动的会话"变可控的两条可行路（新起 / 续写空闲）。
- **peerProtocol**：Claude Code 未公开、版本锁死的 IDE/peer 协议；本方案判定活会话不可控、**不走此路**（§4.3）。
- **push-bridge**：Mac 端订阅状态跃迁并经 APNs 推到手机的小组件（本方案新增）。
- **Relay**：可选哑转发中继，让 Mac 出站、手机入站、不开防火墙洞；必须 E2E，默认关。
