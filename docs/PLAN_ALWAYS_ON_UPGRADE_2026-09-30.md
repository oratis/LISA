# LISA 全面升级方案：全天候、可托付、属于你

日期：2026-09-30。基线：main `65dee50`（v0.27.1；Lisa Pocket 1.2 审核中）。

状态：**已批准，执行中**（2026-10-02）。用户批准按本文的全部推荐执行，第 5 节的决策改写一并生效。本文写的是目标和计划，不等于已交付；交付情况以文末"执行记录"和各 PR 为准。

依据：
- [Always-on 个人 agent 竞品调研](RESEARCH_ALWAYS_ON_AGENTS_2026-09-30.md)（Grok Bot · Cue · Muse · Dots 与行业格局）
- [LISA 能力盘点](research/always-on-agents-2026-09/lisa-capability-inventory.md)（逐项代码路径与成熟度）
- 既有规划：[ROADMAP_v1.0](ROADMAP_v1.0.md)、[AUTONOMY_ROADMAP](AUTONOMY_ROADMAP.md)、[PLAN_IDENTITY_v1.0](PLAN_IDENTITY_v1.0.md)、[PLAN_PERSONAL_ASSISTANT_2026-09-27](PLAN_PERSONAL_ASSISTANT_2026-09-27.md)

与既有路线图的关系：本方案不推翻 ROADMAP_v1.0 的四支柱（Sense · Dispatch · Reve · Model）。它在 always-on 浪潮之后做三件事：重排优先级；补上四支柱之间缺的那一层（任务与信任）；重写 1.0 的验收标准。第 5 节列出需要改写的既有决策。

---

## 0. 一页结论

**定位。** LISA 是住在你自己电脑上的全天候个人 agent。她有一个稳定、可审计的自我，替你盯事、办事、管你的其他 agent，动手之前先问你，数据和凭据不离开你的机器。

> English: *The always-on agent that lives on your Mac — one self, many hands, your keys.*

**三个押注**

1. **任务与信任闭环（Task Engine + Warden）。** 交代 → 后台执行 → 进度可见 → 需要时确认 → 交付成果。副作用一律由一个独立于模型的确定性裁决层放行，凭据不进模型上下文。这是四款竞品共同的核心，也是 LISA 今天最大的缺口。
2. **本地为主、云为中继（Home + Relay）。** 你的 Mac 或 Mac mini 就是 agent 的"电脑"，住宅 IP、已登录的会话、本地文件都在这里。云只做四件事：端到端加密中继、推送、随处可达的审批收件箱、主机离线时的排队。这样手机在任何网络都能审批，常开的主机在你合上笔记本后照常干活。
3. **一个可随身带走的自我（One Lisa + Portable Lisa）。** 一个灵魂，多只手。记忆可看、可改、可删、可导出。以 MCP 的形式，把"你的 LISA"带进 Claude、ChatGPT、Cursor 等别的 agent，对抗巨头的记忆孤岛。

**保留并加深两项强项**
- 厂商中立的 coding agent 外环：Grok Bot 最强的内部用例正是这个，但它只绑定 Cursor。
- 以长程一致性研究做背书：可测量的人格稳定性，是巨头不会公开的东西。

**明确不做**：每用户一台云 VM、电话号码、钱包或自主支付、3D/视频形象、硬件、亲密关系机制、通用购物 agent、对中国超级 App 的 GUI 代操作、几十个 Bot 的名册。理由见第 6 节。

**节奏**

| 阶段 | 版本 | 大致时间 |
|---|---|---|
| Phase 0 | 收尾与定位 | 10 月上旬 |
| Phase 1 | v0.28 Tasks & Trust | 10 月中至 11 月上旬 |
| Phase 2 | v0.29 Reach | 11 月中至 12 月上旬 |
| Phase 3 | v0.30 Hands | 12 月至 2027 年 1 月中 |
| Phase 4 | v0.31 One Lisa | 2027 年 1 月中至 2 月底 |
| Phase 5 | v1.0 Always-on, yours | 2027 年 3–4 月 |

**北极星**：每周成功托付的任务数。护栏有三条：未授权副作用为 0；主动消息有用率达标；单用户日成本不超标。

---

## 1. 形势与战略选择

### 1.1 形势

- **品类已经定型。** 7 周内四家发布的是同一类产品："有自己电脑的常驻 agent"，即云端执行环境、连接你的账号、后台持续、需要时审批、有名字和形象。同期 Google Gemini Spark、Microsoft Autopilot、Anthropic Cowork、Perplexity Personal Computer 也在做同一件事。
- **"有灵魂"不再独特。** Muse 的 VM 里有 SOUL.md、MEMORY.md 和每晚的 dream 作业，Meta 承认产品深受 OpenClaw 启发。Cue 宣传 "Memory and Dream"，Anthropic 有 Dreams 预览。LISA 的方向被验证了，但光有灵魂已经不够。
- **巨头的软肋是信任。** 相关事实：
  - Muse 三周内出了住址泄露、Messages 同步争议和 Mac 版 0-day；
  - Manus 被一封邮件的提示注入打到远程代码执行；
  - OpenAI 在发布 Dots 前一周，接连披露 agent 外传用户图片、取消 GPT-6.1 Astra 的发布、为越权访问澳大利亚政府系统致歉；
  - OpenClaw 出现 341 个恶意 skills 和一个 CVSS 8.8 的 RCE；
  - 调查显示，只有 8% 的美国人愿意把密码交给 Meta，58% 不愿交给任何 AI agent；
  - 四家的条款都把 agent 行为的全部责任推给用户。
- **高端解在向"本地 + 云"迁移。** Perplexity Personal Computer 用常开的 Mac mini 执行、iPhone 审批；Muse 推出 Mac computer use；Grok Bot 提供私有 worker（"家里的 Mac mini"）和"经你的桌面出网"。这正是 LISA 已经站着的位置。

### 1.2 LISA 的现实

- **资产**：
  - 灵魂、欲望、Reve：成熟；
  - coding agent 控制面：成熟，有 10 个 observer，可调度 5 家 CLI，支持 PTY 接管；
  - 多模型：成熟，20 多家供应商加本地模型；
  - 账号与计费：成熟，有 IAP、Stripe、持久化 outbox；
  - 其他：KB v2、6 个 IM 渠道、Mac App、iOS App、单实例云版。
- **缺口**（详见能力盘点第 (b) 节）：
  - 没有通用持久任务，heartbeat 的结果只进日志；
  - 审批分散，web 端在 `ask` 模式下直接拒绝；
  - 连接器只读，MCP 只支持 stdio；
  - 没有浏览器操作；
  - iOS 只能经局域网或 Tailscale 连 Mac；
  - Mac 和云是两个不同的 Lisa；
  - AUTONOMY_ROADMAP 明确把"不主动联系用户"写成非目标。
- **规模**：175 个 GitHub stars，npm 近 30 天约 431 次下载，DMG 累计 27 次下载，单人开发。巨头 7 周的投入不可能正面追赶，只能选边。

### 1.3 四个选项

| 选项 | 内容 | 结论 |
|---|---|---|
| A 正面对标 | 云 VM、全套连接器、agent 身份、支付全做 | **否**。资本、算力和信任成本不对称；也没有分发渠道 |
| B 退回陪伴 | 主打 soul 陪伴 | **否**。监管专门针对情感陪伴（加州 SB 243、纽约、中国《拟人化互动服务管理暂行办法》）；xAI 已撤下 3D 伴侣；MiniMax 陪伴产品毛利率只有 4.7%；也与 9/27 的助手转向冲突 |
| C 只做开发者 agent 外环 | coding agent 编排 | **部分**。这是最强的楔子，但天花板低 |
| **D 主权个人 agent**（推荐） | 本地执行 + 云中继 + 确定性信任层 + 可携带的自我；以 C 为滩头 | **是** |

### 1.4 目标用户（按优先级）

1. **同时用多个 coding agent 的开发者（滩头）。** 已经有 Mac，在乎数据，每天在 Claude Code、Codex、Cursor 之间切换。LISA 管他们的 agent 舰队，顺手处理邮件、日程和盯事。
2. **重视隐私的高级用户。** 包括知识工作者、研究者和创作者，他们不愿把全部账户交给 Meta 或 xAI 的云。EEA、英国、瑞士目前是四家的共同空白。
3. **中文圈的自部署用户。** 四家全部缺席中国大陆。LISA 支持国产模型、飞书渠道，KB 能收录微信文章。LISA Cloud 不进入中国大陆，这部分用户走开源自部署。

### 1.5 对外叙事

- **主钩改写。** 从"有内在生活的 agent"改为"可托付的全天候 agent"。灵魂不再是卖点本身，而是"为什么可以托付"的理由：她稳定、可审计、会在该反对时反对。
- **对比页**（官网，事实加日期）。维度：在哪里运行、谁持有凭据、谁承担责任、能否导出、能否选模型、开源与否、是否抽佣或投广告、定价是否透明。不在 App Store 元数据里使用他人商标，以符合 4.1(c)。

---

## 2. 目标架构

```
┌──────────────────────────── Surfaces ─────────────────────────────┐
│ iOS Lisa Pocket: Tasks · Approval Inbox · Live Activity · App      │
│   Intents(Siri) · Share · Voice                                    │
│ Mac app: Island · menu bar · "Lisa's browser" 接管窗口              │
│ Web shell · IM 渠道(Telegram/Slack/飞书/Discord/iMessage/Webhook)   │
│ MCP server(Portable Lisa：在 Claude/ChatGPT/Cursor 里用"你的 LISA") │
└──────────────┬────────────────────────────────────────────────────┘
               │ 事件 · 任务 · 审批（端到端加密）
┌──────────────▼────────────────────────────────────────────────────┐
│ LISA Relay（云，薄）：账号 · 加密中继 · 按租户 APNs · 审批收件箱镜像 │
│   · 主机离线排队 · 无 Mac 用户的"云端家"（cloud edition）           │
└──────────────┬────────────────────────────────────────────────────┘
               │ 主机主动外连（无需端口映射 / Tailscale）
┌──────────────▼────────────────────────────────────────────────────┐
│ LISA Home（你的 Mac / Mac mini = agent 的"电脑"，数据记录系统）      │
│  ┌──────────────┐ ┌─────────────────┐ ┌──────────────────────────┐ │
│  │ Self         │ │ Task Engine     │ │ Warden                   │ │
│  │ soul·记忆·KB │ │ 目标·Routine·    │ │ 策略·作用域授权·凭据代理 │ │
│  │ Reve·欲望    │ │ Watcher·Runner  │ │ 出网控制·审计·Inbox      │ │
│  └──────────────┘ └─────────────────┘ └──────────────────────────┘ │
│  Hands：工具 · MCP 连接器 · Lisa's browser · coding agents(派发/PTY) │
│         · 子代理（同一个自我的不同"手"）                             │
│  Model：分层路由（小模型盯事/分类，强模型规划；本地或 BYO）          │
└───────────────────────────────────────────────────────────────────┘
```

**不变式**（每个工作流都必须满足）：

1. **模型只提议，Warden 决定。** 任何副作用（发送、发布、购买、删除、执行、出网写）都要有 Warden 的决定记录。
2. **凭据只以句柄出现在模型上下文里。** 真实值只在执行边界注入。
3. **外部内容永远是数据，不是指令。** 读过私密数据的上下文，不能在无审批的情况下向新目的地外发，以此打破 "lethal trifecta"。
4. **每个动作可追溯**：由谁触发（任务、routine 或聊天）、为什么、凭哪条授权。"你怎么知道的"由审计日志回答，不靠模型回忆。
5. **中继看不到内容。** Home 是数据的记录系统，云只转发密文、推送和排队。
6. **主动触达有预算、有旋钮、有红线**（见 W3）。

与四支柱的映射：
- **Sense** → Watcher、触发器和连接器（输入）；
- **Dispatch** → Task Engine、Hands 和 coding 外环；
- **Reve** → 可审计的 Dream 与一致性度量；
- **Model** → 分层路由与成本；
- **新增三个横切层**：Warden（信任）、Relay（可达）、Portable Lisa（可携带）。

---

## 3. 升级工作流

每一项的格式：为什么（竞品证据） · 现状（代码） · 方案 · 验收。优先级 P0 为 1.0 必要条件。

### W1. Task Engine：目标 · Routine · Watcher（P0）

**为什么。** 四家的核心闭环一致：
- Muse：Goals、Upcoming、Activity；
- Grok Bot：Routines、运行历史、Test run，新 routine 默认停用，无事可报就保持沉默；
- Cue：Routines，以及价值最高的"盯守—抢占"类任务（DMV 空位、营地放号、降价、补货）；
- Dots：持续目标。

**现状。**
- `src/heartbeat/runner.ts` 的结果只写 `heartbeat.log`；`src/heartbeat/config.ts` 里的 `schedule` 字段只是说明性的，每个 tick 都会跑全部任务。
- managed agent 的状态只在内存里（`src/agents/managed.ts`）。
- 云端 `src/web/autonomy-sweep.ts` 不产生任何用户可见结果。
- 仓库里没有通用的持久任务队列。

**方案。**

- **数据模型 `Task`**：
  - 基本字段：`id`、`owner(uid)`、`kind`（oneoff / routine / watcher / desire / dispatch）、`instruction`、`origin`（聊天消息、渠道、触发器或欲望）、`host`（home / cloud / any）。
  - 调度：`schedule` 或 `trigger`（邮件、Webhook、日历、feed、网页变化）。
  - 状态机：draft → scheduled → queued → running → awaiting_approval / awaiting_input → succeeded / failed / cancelled / expired / paused。
  - 预算：token、美元、墙钟时间、工具调用数。
  - 通知策略：always / on_change / on_hit / silent_on_noop。
  - 其余：`artifacts[]`、`runs[]`、`created_disabled`、`auth_failure_count`。
- **存储**：本地为 `~/.lisa/tasks/`，任务 JSON 加每次运行的 JSONL，沿用原子写和跨进程 `link()` 锁。云端落到 per-uid home 或 Firestore。通知投递复用 `src/billing/outbox.ts` 与 `reconcile.ts` 的 outbox 模式，做到恰好一次。
- **Runner**（`src/tasks/runner.ts`，在 serve 进程内）：
  - 调度解析复用 `src/integrations/scheduled-dispatch.ts`，租约思路借鉴 `src/cloud/turn-lease.ts`；
  - 每个工具边界打检查点，有副作用的调用带幂等键，重启后跳过已完成的步骤；
  - 支持取消，预算熔断沿用 autonomy budgets；
  - 每个任务使用自己的工具子集，所有副作用走 Warden。
- **迁移**：`heartbeat.json` 的任务迁成 routine，`schedule` 字段真正生效；launchd 只负责唤醒。
- **Watcher**：
  - 条件：网页选择器或文本变化、RSS 命中、邮件命中、价格阈值；
  - 频率有下限保护，另做去重和迟滞，避免反复触发；
  - 动作默认只通知，下单或发送需审批；
  - 默认在 Home 本地运行，不耗云额度。
- **投递**：
  - 结果以结构化"任务卡"形式进主对话，同时按 W3 的闸门推送或发到渠道；
  - 运行中的任务在 Live Activity 显示；
  - 产物（Markdown、HTML、文件）可以在 web 和 iOS 上查看。
- **工具**：`task_create`、`task_update`、`task_list`、`task_cancel`、`watch_create`。都算变更类操作，创建时弹确认卡。
- **UI**：
  - Web 新增 Tasks 视图，分 Goals、Upcoming、Activity 三块，Activity 展开可以看到工具调用链和每次运行的成本；
  - iOS 新增 Tasks 标签页。

**验收。**
1. 任务执行中重启服务，重启后续跑同一任务，且没有重复的副作用。
2. 新 routine 默认停用；无事可报时不推送。
3. 通知投递跨重启恰好一次。
4. 端到端场景："每个工作日 8 点：汇总重要邮件 + 今日日程风险 → 任务卡 + 推送"。
5. 端到端场景："盯某网页的空位或价格 → 命中推送"。

### W2. Warden：确定性信任层与审批收件箱（P0）

**为什么。**
- **正面范本**：
  - Muse 的 Sentinel 是独立于模型的唯一放行者，配合凭据代理（替身 token）、tainted egress、有作用域的审批（一次 / 任务 / 站点 / 限时 / 永久，以原生弹窗出现），以及对 OTP 和重置链接的过滤。
  - Grok Bot 有 Allow once / Always / Deny、Auto Review 自然语言规则、无人值守审批 10 分钟过期、token 不落 VM。
  - Dots 用四档行为写规则（直接做 / 预先批准才做 / 先问 / 交还给你），并规定"预先批准"只覆盖用户在 prompt 里明确要求过的动作；还有一个执行前核对收件人、内容和授权的独立 reviewer 模型。
- **反面教训**：
  - Muse：一个批准过的自动回复模板泄露了住址；Mac 版同步了 Messages，而 Muse 对数据来源的自述失实；
  - Manus：一封 JSFuck 混淆的邮件即可 RCE；
  - OpenClaw：Control UI 信任 URL 参数导致 RCE，ClawHub 上有 341 个恶意 skills。

**现状。**
- `src/approval.ts` 默认 `auto`；web 在 `ask` / `ask-mutating` 下由 `src/runtime-policy.ts` 的 `buildNonInteractiveApprovalCallback` 直接拒绝。
- 审批散在三处：CLI stdin、managed agent 的按钮、社交草稿。社交草稿的做法是好的范本：digest 绑定、10 分钟 TTL，见 `src/sense/social/drafts.ts`。
- 能力分级（`src/web/capabilities.ts`）和 fail-closed 沙箱（`src/sandbox/*`）是地基。
- 已知漏洞：exec-util 家族（run_checks、compare_agents、redeploy、dispatch_agent）绕过能力 seam；`src/skills/executable.ts` 在进程内执行，没有沙箱。

**方案。**

- **ActionRequest**：`{taskId, tool, connector, method, category, targets, dataClasses, purpose, digest}`。
  - `category` 取值：read / draft / write / send / publish / purchase / delete / exec / network。
  - `targets` 是收件人、域名或路径。
  - `dataClasses` 取值：pii / secret / financial / health / private-message。
  - `digest` 是精确载荷的哈希。
- **策略**：系统不变式 → 用户规则 → 任务授权，逐层叠加，判定为 allow / deny / ask。默认值如下：
  - 已连接范围内的读，以及起草：放行；
  - 发送、发布、购买、删除、工作区外执行：询问；
  - 向**新收件人**发送 PII：每次都询问（Muse 住址泄露的教训）；
  - 简化版 tainted egress：一个任务读过私密数据后，向不在该任务白名单里的域名发请求，需要询问。
- **用户可见的规则词汇**：沿用 Dots 的四档行为——直接做 / 预先批准才做 / 先问 / 交还给你，按动作类别逐项设置。语义写死两条："预先批准"只覆盖用户在指令里明确要求的动作；批准一次发送不等于长期代发权。
- **授权**：档位有一次 / 本任务 / 本收件人或域名 / 24 小时 / 永久。精确匹配，可撤销，存 `~/.lisa/warden/grants.json`，全部入审计。
- **跨家族审查（可选）**：对外发送类动作执行前，由另一家模型核对收件人、内容和授权依据。LISA 本来就支持多家模型，可以让执行和审查来自不同家族，降低同源失误。审查结果只能收紧、不能放宽 Warden 的决定。
- **审批收件箱**：
  - 新增 `src/warden/inbox.ts` 与 `/api/approvals`，配 SSE 事件；
  - 出现在 web 面板、iOS（可操作推送加 App 内收件箱，高风险操作要 Face ID）、Mac Island，以及 Telegram inline keyboard、Slack Block Kit、飞书卡片（回调 token 签名）；
  - 每张卡写清做什么、发给谁、**以谁的身份**、精确载荷预览（与 digest 绑定）和预计成本；
  - 无人值守时默认 10 分钟过期，过期即拒绝；
  - 用这套收件箱替换 web 端"`ask` 即拒绝"的路径。
- **凭据代理**：
  - 模型只看到句柄，例如 `secret://gmail/work`；
  - 真实值存在 Mac 的 Keychain，或云端按租户用 KMS 加密的保险库（沿用 `src/web/apple-authorization.ts` 的 AES-GCM 做法）；
  - 工具执行时才注入，会话日志、转录和输出里一律脱敏。
- **入站卫生**：
  - 邮件和网页内容进入模型之前，剥离 OTP、魔法登录链接和重置链接；
  - 沿用 `<<<EXTERNAL-CONTENT>>>` 标记；
  - 高风险任务用"阅读者"子上下文先总结不可信内容，这个子上下文不持有发送或执行类工具（双模型模式）。
- **出处工具**：`provenance` 从审计日志和 memory links 回答"你怎么知道的"。
- **加固清单**：
  - exec-util 改走能力 seam；
  - 可执行 skill 进沙箱，并附权限清单；
  - 写清 PTY 子进程会继承哪些 TCC 权限，并加限制（Muse 的 Full Disk Access 继承教训）；
  - 嵌入式后端只监听回环地址，且必须带 token；
  - 敏感配置签名，防止 Muse 那种"隐藏偏好项被篡改"；
  - skill 供应链：SHA 固定、权限清单、不自动更新（ClawHavoc 的教训）；
  - 排查 web UI 里所有信任 URL 参数的地方（CVE-2026-25253 的教训）。
- **红队回归**：
  - 提示注入语料覆盖混淆邮件指令、隐藏 DOM 文本、图片文字、日历邀请、PDF；
  - CI 里用 stub 模型跑，本地每晚用真实模型跑；
  - 发布 `THREAT_MODEL.md`，标题就叫 "Your mail can't command LISA"。

**验收。**
1. 一个测试枚举全部变更类工具，断言没有 Warden 决定记录就不会执行。
2. web 上的 `ask-mutating` 可以交互使用：10 分钟内从 iPhone 批准则执行，过期则拒绝。
3. 用 grep 测试断言：密钥永远不出现在会话日志里。
4. 注入语料的通过率达到目标值，并在 CI 里设为门禁。

### W3. Reach-out 章程：主动触达的规则（P0）

**为什么。**
- `AUTONOMY_ROADMAP.md` 把"不主动联系用户、发消息、推送通知"列为非目标，并写明扩张这个边界需要单独的 reach-out 路线图和用户 opt-in 流程。
- 四家都会主动触达。Muse 的门槛高，用户可以关闭、调低或调高；Grok Bot 无事可报就保持沉默。
- 反例：WIRED 批评 Muse 的主动建议在变相索取数据。
- 合规：中国拟人化办法要求长时使用提醒和过度依赖提示；纽约和加州 SB 243 要求 AI 身份披露。

**现状。** mail 提醒、KB 日报、advisor 已经是按事件、需 opt-in 的"运营类推送"（`src/web/push.ts`）。advisor 有成熟的防打扰评分，见 `src/advisor/engine.ts`：紧急度 × 可行动性 × 驳回衰减，每 3 小时最多一份摘要。

**方案。** 新增 `docs/POLICY_REACH_OUT.md`，并在 AUTONOMY_ROADMAP 的非目标处引用它。代码上所有主动投递都走同一个 `reachOut()` 闸门。

- **来源**：
  1. 用户授权的任务、routine 和 watcher 的结果；
  2. 待审批事项；
  3. 已有的邮件提醒、日报、advisor；
  4. Lisa 自己的欲望和 Reve 笔记：需单独 opt-in，默认只在 App 内展示。
- **控制**：
  - 全局主动度旋钮：关 / 低 / 中 / 高；
  - 分来源开关、免打扰时段；
  - 每日预算：中档默认每天最多 3 条未经请求的消息；
  - 分渠道路由偏好。
- **价值闸门**：复用 advisor 的评分，并从驳回中学习。
- **只读的主动通道**：Lisa 自发的研究、欲望推进和 Reve，只能用只读工具，外加写她自己的 soul、记忆和知识库。任何对外副作用都必须转成用户授权的任务，再过 Warden。这与 Dots"空闲时的主动研究只能用只读工具、规则也改不了"一致，也把现有 `autonomousSubset` 的做法固化为不变式。
- **红线**：
  - 主动消息不得以"再连接一个账号或数据源"为目标；
  - 不施加情绪压力；
  - 始终标明是 AI；
  - 为用户提供依赖提示和长时使用提醒的合规模块，按地区开启。

**验收。**
1. 所有主动投递都经过 `reachOut()` 并计入预算。
2. 旋钮、预算、免打扰时段都有单元测试。
3. 模板检查加分类器检查，确保"索取数据"类主动消息为 0。

### W4. Home + Relay：全天候与随处可达（P0/P1）

**为什么。**
- "合上笔记本还在干活"是四家的核心承诺。Grok Bot 的工程指南甚至点名："不再需要家里 24/7 开一台机器跑 OpenClaw。"
- 但高端形态恰恰是"常开的本地主机 + 手机审批"：Perplexity Personal Computer、Grok Bot 的私有 worker、Muse 的 Mac computer use 加 Tailscale 组网。

**现状。**
- Mac App 已内置后端（v0.26）。`lisa autostart install` 可以装 KeepAlive LaunchAgent，但 Mac App 不装 heartbeat。
- iOS 只能经局域网或 Tailscale 直连 Mac，已知问题见 [PLAN_IOS_REACHABILITY_v1.0](PLAN_IOS_REACHABILITY_v1.0.md)。
- 推送是机器级的：ntfy 可用，APNs 要配 `LISA_APNS_*` 才生效，云端不允许推送。
- 云版是另一个 Lisa。

**方案。**

- **Home 模式**：Mac App 里加"把这台 Mac 设为 Lisa 的家"。
  - 默认开启自启和进程内调度器；
  - 有任务运行时，用电源断言阻止休眠；插电时的防休眠做成可选开关；
  - 手机上如实显示"主机离线"；
  - 错过的 routine 按策略补跑。
- **Relay**（LISA Cloud 新增一个服务）：
  - Home 主动外连到 Relay，走 WebSocket 加双向认证；
  - 手机用账号会话连 Relay；
  - 业务载荷在已配对设备之间端到端加密：沿用 QR 配对（`src/web/pairing.ts`）交换 X25519 公钥，Relay 只看得到元数据；
  - 在同一局域网时优先直连；
  - 承载聊天、任务、审批和 SSE 事件。
- **按租户推送**：APNs 由 Relay 发出，通知正文只写"有 1 项待审批"这类提示，内容留在 Home。这把推送从机器级升级为租户级。
- **离线排队**：Home 离线时，新建的任务以密文排队，重连后恰好执行一次。
- **无 Mac 用户**：
  - 云版逐步扩展：把有 SSRF 防护的 `web_search` / `web_fetch` 加进 `CLOUD_ALLOWED_TOOL_NAMES`（`src/tools/registry.ts`，这是快速见效项）；
  - 云端 Task Engine 可以跑网页类 routine 和 watcher；
  - 连接器走云端 OAuth 保险库（W5）；
  - 不开放主机执行；
  - 按任务的临时沙箱（浏览器任务）放到 P2 再评估，届时核算成本。优先考虑托管方案，例如 OpenAI Agents API 的托管沙箱，而不是自建 VM 集群。

**验收。**
1. 手机在 5G 网络下、不装 Tailscale，也能和 Home 的 Mac 聊天、审批。
2. 用 Relay 日志测试，证明 Relay 无法解密内容。
3. 审批推送在 N 秒内到达。
4. 离线任务在重连后恰好执行一次。
5. 设备撤销立即生效。

**风险。** Relay 是新的攻击面。它必须最小化，全程 E2E，不提供 Warden 之外的任何执行路径，并做限流。

### W5. Connectors 2.0：OAuth、MCP HTTP、日历与邮件写（P1）

**为什么。**
- Muse 按 connector 拆分 privsep worker，每个 worker 只有自己的凭据白名单，读写分离，权限比 OAuth scope 更细。
- Grok Bot 的 OAuth token 留在后端，不下发到 VM。
- Cue 基于 MCP 加 OAuth。

**现状。**
- 邮件只读：IMAP，以及 `gmail.readonly` scope 的 Gmail，而且需要用户自带 OAuth client。
- `src/mcp/client.ts` 只支持 stdio，没有 OAuth，增删 server 要重启。
- 没有通用的 OAuth 框架。
- 社交连接器的 manifest 与 runner（`src/sense/social/{manifest,runner}.ts`）是现成的契约范本。

**方案。**
- **连接器框架**：
  - manifest 按方法声明 scope，读写分离，并标注数据类别和限流；
  - OAuth 助手：Mac 上走回环 PKCE，云端按租户回调；
  - token 经 W2 的凭据代理存取；
  - consent 从按机器改为按租户（`src/consent/store.ts`）。
- **MCP**：
  - 增加 Streamable HTTP 传输和 OAuth（按 MCP 授权规范）；
  - 支持热加载，每个 server 有工具白名单；
  - MCP 返回的结果一律按不可信内容处理。
- **优先连接器**：
  1. 日历和提醒：Mac 端通过 Mac App 桥接 EventKit，数据不出本机；Google Calendar 走 OAuth。
  2. 通讯录：只读。
  3. 邮件：先存草稿（IMAP APPEND 到草稿箱，或 Gmail drafts），审批后发送（SMTP 或 Gmail send）。审批卡上显示发件身份。进模型之前先过滤 OTP 和链接。
  4. Notion、Google Docs：通过 MCP 接入。
- **Gmail 限制**：Gmail 的 restricted scope 要过 Google 的安全评估，成本高。短期继续让用户自带 OAuth client，或者走 IMAP/SMTP 加应用专用密码；共享 client 等规模到了再评估。

**验收。**
1. 日历读写可用，写操作经审批。
2. 用测试账号跑通"草稿 → 审批 → 发送"的端到端流程。
3. token 永远不进模型上下文。
4. connector manifest 驱动 Warden 的分类。

### W6. Hands：本地浏览器与 computer use（P1/P2）

**为什么。**
- 四家都有浏览器执行能力。Muse 的浏览器子代理只看 accessibility tree，不能执行 JS；Grok Bot 和 Cue 支持用户接管远程桌面。
- 它们共同的弱点在云端：数据中心 IP 容易被封，验证码要人来处理。
- LISA 在用户 Mac 上运行，本身就用住宅 IP，也能用真实浏览器 profile，这两点是天然优势。

**现状。** 没有这项能力。Playwright 只是 e2e 测试的开发依赖。

**方案。**
- **`browser` 工具族**：
  - 用 Playwright 驱动一个专用的持久化 Chrome profile，即 "Lisa's browser"，不碰用户的主 profile；
  - 默认有头运行，用户看得见，随时能接管；
  - 观察用 accessibility tree 快照，视觉模型可以额外看截图；
  - 动作只有导航、点击、输入、选择、滚动、提取，**不提供由模型编写的 JS 执行路径**；
  - 域名白名单由 Warden 按任务下发；下载文件先进隔离目录；
  - 需要登录时，只能用凭据代理里的句柄，或由用户接管；遇到验证码一律交给用户接管，不去破解。
- **computer use（P2）**：基于 macOS 辅助功能，严格按 App 逐个 opt-in。沿用 Sense 的 consent 和黑名单，银行和密码管理器默认排除。
- **云端浏览器**：给无 Mac 用户用，放到 P2/P3，需要沙箱供应商。

**验收。**
1. 在本地测试站点上完成订位、填表、比价提取。
2. 恶意页面的注入测试通过。
3. 代码里不存在执行 JS 的路径。

### W7. Coding 外环 2.0：厂商中立的 agent 舰队经理（P1）

**为什么。** Grok Bot 最强的内部用例，是作为"外环"管理 Cursor Cloud Agents：
- 派活、读运行记录、看截图证据；
- 每 30 分钟巡检一次 PR，低风险的自动合并；
- 一名工程师能同时管的 agent 从 15 个增加到 200 多个。

但它只能管 Cursor 的 agent。LISA 的控制面已经成熟，而且不绑厂商。

**现状。**
- 已有：10 个 observer；可以 headless 派发 5 家 CLI；PTY 接管功能要设 `LISA_PTY_AGENTS=1` 才开启；`compare_agents`、`run_on_plan`、recap、advisor 都在。
- 缺口：DMG 内置的后端缺少 node-pty，所以只装 DMG 的用户用不了 PTY。

**方案。**
- **扩大支持范围**：observer 和派发对象加入 Cursor CLI、Gemini CLI。
- **接入 Task Engine**：coding 派发成为一种 Task，带状态和预算；产物是 PR 链接、测试结果和截图。
- **PR 巡检 routine**：
  - 检查 CI、评审意见、冲突，结果写成摘要，并建议派发修复；
  - 只有同时满足两个条件才自动合并：该仓库有显式授权，且低风险分类器判定为低风险。
- **完成的证据要求**：没有测试通过或截图，任务不能标为完成。
- **审批中继**：PTY 捕获到的 agent 权限提示（例如 Claude Code 请求执行 bash）进入 W2 的收件箱，**用户可以在手机上批准 Claude Code 的命令**。
- **修复与加固**：DMG 内置 node-pty 预编译包；按 W2 写清并限制 PTY 子进程的 TCC 权限。

**验收。** 派发 → Tasks 里显示进度 → 从 iOS 中继审批 → 产物里出现 PR 链接。巡检 routine 无事时保持沉默。

### W8. One Lisa：同一个她，与记忆主权（P1）

**为什么。**
- Muse 的 MEMORY.md 用户可读可改，还有 Forget skill。
- Dots 正好相反：单条记忆不能查看、编辑或删除，只能整体 Reset；断开 app 也不会删除已学到的内容。
- Grok Bot 被批评把凭据和记忆锁在厂商云里。
- 中国拟人化办法要求可以复制和删除聊天记录；GDPR 也有同类要求。

**现状。**
- Mac 和云是两个独立的 soul 和记忆，iOS 文案也如实这么写。
- `/api/memory` 只读，没有导出。
- 云端只能整号删除。

**方案。**
- **"家"的指定**：每个账号只有一个"家 Lisa"，在 Mac 上或云上。其他入口都经 Relay（W4）连到这一个 Lisa。多数用户因此根本不需要同步。
- **同步（少数情况）**：只针对同时跑两个实例的用户，例如想在 Mac 离线时由云兜底。
  - soul 只由"家"写入；
  - 记忆和 KB 以 git bundle 的形式 E2E 加密复制；
  - 定义清楚冲突时怎么处理。
- **迁移**：`lisa export` / `lisa import` 打包 soul、记忆、KB、会话和任务，支持云 ↔ Mac 双向搬家。
- **记忆控制**：
  - `/api/memory` 增加编辑和删除，并配 UI；
  - Forget 按主题跨层删除：USER.md、MEMORY.md、会话检索索引、KB 页面与链接；
  - Lisa 的私密 journal 做脱敏处理，并如实说明可能有残留；
  - 可以一键导出 zip。

**验收。**
1. 导出 → 导入往返测试通过。
2. 测试证明 Forget 之后，所有索引里都查不到被删内容。
3. 手机经 Relay 看到的，是同一个 soul 和同一份记忆。

### W9. Soul 2.0：人格作为信任层 + 可审计的 Dream（P1）

**为什么。**
- 人格正在变成 agent 的信任层和交互层：Muse 让用户起名、定制头像和声音；Dots 用可爱形象降低威胁感；Grok Bot 的头像同时显示工作状态。
- 实验证据：人格表达适中的聊天机器人，在"聪明""讨喜""可信"几项上都胜过平淡型和高度外向型。
- 监管只针对情感陪伴，生产力类不在其列。
- Muse 也有 SOUL.md。所以 LISA 的差异不能只靠"有灵魂"，而要靠**可测量的稳定性**和**可审计的演化**。

**现状。**
- soul 核心成熟：git 历史、篡改检测、主权提示、`soul_object`、欲望、Reve。
- 头像：114 张情绪立绘、Island、Room，但用户不能定制；iOS 上的在场感弱；TTS 只有 macOS 的 `say`。
- 云端 soul 没有 git 历史，因为 GCS FUSE 挂载不适合跑 git。

**方案。**
- **定位**：长期协作者 / 私人参谋。不做恋爱和亲密机制，保持 18+，披露 AI 身份。依赖提示和长时使用提醒做成合规模块（W3）。
- **一个灵魂，多只手**：子代理和角色都是同一个自我的不同视图，共享同一份记忆和同一个 soul。UI 上可以用类似群聊的方式展示分工，比如"Lisa（调研）""Lisa（收件箱）"，但不拆分身份。这是与 Grok Bot 的 50 个 Bot、Cue 的职能 agent 相对的设计。
- **状态语义**：闲置 / 思考 / 工作 / 等待审批 / 受阻 / 完成，统一映射到情绪立绘、Island、Live Activity 和 iOS 头像。
- **用户参与出生**（可选）：用户可以提供偏好的称呼、语气范围和视觉风格包，但 soul 仍由 Lisa 自己写，保持主权。
- **声音**：
  - 先让 iOS 能用语音回复：支持 TTS 供应商或本地 TTS，AVSpeech 作为兜底；
  - 实时双工语音放到 P2。
- **可审计的 Dream**：
  - Reve 每晚生成一份 dream diff，写明合并了什么、遗忘了什么、欲望和 soul 改了什么、为什么；
  - 用户可以一键回滚：本地靠 soul git，云端补一个快照机制。
- **三层上下文**：身份层 / 工作集 / 归档层分开，UI 上显示每轮的 token 数和成本。这同时是对 Grok Bot "上下文税"的产品回应和论文实验（W15）。

### W10. 渠道与在场 2.0（P1/P2）

**为什么。**
- 竞品的渠道：Dots 用 Slack、Teams，短信即将上线；Muse 进了 WhatsApp；Grok Bot 的 Team Bot 可以有独立的 Slack App。
- 平台在收紧：iMessage 的 Messages for Business 要审批，而且只能由用户发起对话；WhatsApp 对通用 AI 助手先禁后收费，EEA 另有临时措施；微信自建了「小微」。
- 因此自有 App 的推送是底座，开放 IM 是补充。

**现状。**
- 6 个渠道在独立进程里运行，只能被动回复纯文本，只在本地，用 remote-safe 工具集。
- iOS 没有 App Intents、分享扩展，也没有语音；Live Activity 只用于 agent 会话。

**方案。**
- **渠道并入主服务**：并入 serve 主进程，或由主进程托管。渠道共用 Task Engine、Warden 和 `reachOut()`。
  - 出站可以带交互按钮：Telegram inline keyboard、Slack Block Kit、飞书卡片、Discord components；
  - 每个渠道设信任级别，对应一套工具配置；
  - iMessage 走回复码审批，例如回复 `Y 3F2A`。
- **iOS**：
  - Tasks 与审批收件箱；
  - 可在锁屏直接操作的通知，高风险操作要 Face ID；
  - Live Activity 显示运行中的任务和待审批事项；
  - App Intents："问 Lisa""新建任务""今天我有什么事"，供 Siri AI 调用；
  - 分享扩展：链接或文件 → KB 或任务；
  - 语音输入和语音回复。
- **agent 发件身份**（P2，需用户 opt-in）：
  - 地址形如 `<name>@lisa.meetlisa.ai`；
  - 入站：Cloudflare Email Routing → Relay → Home；出站：Resend 加 DKIM（`src/web/mailer.ts` 已在用 Resend）；
  - 邮件带 AI 身份页脚，发件人走白名单，所有入站内容按不可信处理；
  - 只用于注册、询价、预约这类场景；
  - 每张审批卡都显示"以 Lisa 身份"还是"以你的身份"，避免 Cue 那种身份错位。
  - **不做电话号码和钱包。**
- **微信**：不内置，因为需要企业主体。中文自部署用户对企业微信机器人有需求的话，另行评估。

### W11. Portable Lisa：MCP server、配方画廊与标准兼容（P1）

**为什么。**
- 巨头把记忆和人格锁在各自的云里。
- MCP 已经捐给 Linux Foundation 的 Agentic AI Foundation，同批的还有 AGENTS.md。
- 美国 AI 用户平均用 3 个通用助手（Menlo）。
- 一个可以带走的人格和记忆层，是封闭平台不愿提供的东西。

**方案。**
- **`lisa mcp serve`**，提供这些工具：
  - `lisa_persona`：只读的人格卡；
  - `lisa_memory_search`：受同意门控制；
  - `lisa_kb_search` / `lisa_kb_read`；
  - `lisa_task_create` / `lisa_task_list`：在 Home 里建任务，经过 Warden；
  - `lisa_ask`：向 Lisa 提问。
- **传输**：
  - 本地 stdio，给 Claude Desktop、Claude Code、Cursor 用；
  - 经 Relay 的 Streamable HTTP 加 OAuth，给 Claude 和 ChatGPT 的远程连接器用；
  - 按客户端分配 scope，全程审计。
- **配方画廊**：
  - 按 "recipe, not meal" 的原则，把 routine、watcher、skill 打成可分享的包；
  - 包里带权限清单，可签名，不含密钥和个人记忆；
  - 安装时展示所需权限，装好的 routine 默认停用。
- **标准兼容**：
  - 兼容 SKILL.md 与 AGENTS.md，支持从 GitHub 导入；
  - 评估从 OpenClaw 迁移：导入 SOUL.md、MEMORY.md 和 skills。这是给在意安全的 OpenClaw 用户留的迁移路径，格式兼容性需要先核实。

### W12. 模型与成本（P1）

**为什么。**
- Grok Bot 的上下文税：每轮 20–25 万 token，3 天烧光 Ultra 的周额度。
- 计费不透明是用户骂得最多的地方：Muse token、Grok Bot 的额度都不公开。
- 高价档在承接算力成本：OpenAI 推出了 $500 的 Pro 档，同时从 10/30 起把 $200 Pro 档的 Codex/Work 额度减半。

**方案。**
- **分层路由**：盯事、分类、摘要走小模型（本地模型优先，云端用 Flash 档）；规划和执行走用户选定的强模型。
- **预算与熔断**：每个任务有预算和硬熔断。创建 routine 时预估成本，比如"约 $0.02/次，约 $0.60/月"。
- **云端计量**：显示剩余百分比，按周期刷新，额度用完就硬停，不偷偷超额。
- **补缺**：给 gateway 补上 Gemini 接口（`src/web/gateway.ts`）。
- **coding 继续走官方 CLI 用订阅**（`run_on_plan`），坚持 [CODING_PLANS](CODING_PLANS.md) 的原则，不提取 token。
- **评估接入 Sign in with ChatGPT**：OpenAI 在 DevDay 推出，用户可以在合作方产品里使用自己的 ChatGPT 额度，首批 16 家合作方就有 OpenClaw。这是"用户自带订阅"的正规通道；先确认合作方计划是否开放申请，以及它的条款。
- **评估**：Meta 开放权重的 Muse Glimmer（30B），作为本地模型选项。先核对许可。

### W13. 工程底座（持续）

- **云**：
  - 启用 Firestore 多实例（`LISA_FIRESTORE`），补跨实例的账号生命周期协调，例如删除账号；
  - Cloud Run 的 CI 部署与灰度发布；
  - Relay 的部署与回滚手册。
- **`src/web/server.ts` 拆分**：目前 4,855 行、约 100 个路由。新增的 tasks、warden、relay 路由各自成模块。同步更新 OpenAPI 契约和 Swift 常量（`contracts/lisa-api-v1.openapi.json`）。
- **可观测性**：任务和运行指标、Relay 指标、错误预算。按 [analytics-plan-2026-08-21](analytics-plan-2026-08-21.md) 建本地账本，出网统计仅在用户 opt-in 后发送，而且只发聚合数据。
- **测试**：
  - Task Engine 的重启与幂等测试；
  - Warden 设覆盖率下限；
  - 注入语料集；
  - Relay 的 E2E 测试；
  - iOS 收件箱的 XCTest。
- **安全节奏**：每个阶段结束时做一次安全评审，并更新 THREAT_MODEL。

### W14. 商业化与增长（持续）

- **定价假设**：
  - LISA 本地版：开源免费，用户自带 key、订阅或本地模型。
  - **LISA Relay**：面向 Mac 用户，每月 $4.99–9.99。包括中继、推送、随处可审批的收件箱、离线排队、加密备份，并附少量云额度。iOS 上这是数字服务，必须走 IAP 自动续期订阅，需要新建 ASC 条目并过审。
  - LISA Cloud：面向无 Mac 用户，沿用 12 小时免费窗口加消耗型额度（$4.99 / $9.99 / $19.99）。计量透明，额度用完就硬停。可以借鉴 Dots 的"聊天免费、干活计量"：对话放宽，agent 执行按工作预算计量，并把消耗可视化。
  - 公开承诺：不抽佣，不投广告，默认不拿用户数据训练。这些要写进条款，和对外表态保持一致，避免 Grok Bot 那种"CEO 承诺与条款冲突"。
- **发布节奏**：
  - v0.29 或 v0.30 时重启对外叙事：Show HN（已有草稿）、Product Hunt、即刻、少数派、V2EX、linux.do；
  - 官网放对比页，演示视频可以用现有的 cloud-screencast 流程录制；
  - 配方画廊作为持续的内容来源。
- **市场**：
  - 滩头：Claude Code 和 Codex 社区；
  - 欧洲的隐私社区：巨头在那里是空白；
  - 中文开发者社区：开源自部署。
- **度量**：star 和下载量只是虚荣指标。以激活率和北极星指标为准（第 7 节）。

### W15. 研究协同（持续）

- **论文主线**：持久身份在全天候运行下的一致性。
- **数据来源**：已经在跑的真实 LISA 纵向部署，加上 Task Engine 的运行日志。
- **消融实验**：
  1. soul 加结构化记忆，对比全量历史，衡量 token、一致性和任务成功率；
  2. Reve 开与关；
  3. Warden 的决定分布。
- **开源评测集**，至少包含：soul 漂移、记忆冲突率、主动消息的准确率、审批负担。
- **复刻 Dots 系统卡里的两项评测**，做成开源、小规模、多模型的版本：
  - 任务中途变更权限或范围，agent 能否停下（Dots 为 91.8%）；
  - 连续任务之间的越界漂移（Dots 从 8.6% 升到 19.7%）。

  第二项本质上就是长程一致性问题，可以直接检验"稳定的自我 + 结构化记忆"能否压低漂移。OpenAI 的评测不开源，这是可发表的空白。
- **投稿**：对齐 COLM 2027 的投稿窗口，具体日期以官方 CFP 为准。

---

## 4. 分阶段路线图

### Phase 0 · 收尾与定位（10/1–10/12）

- 完成在途的送审门槛：iOS 1.2 审核、真实 StoreKit sandbox 到账、Apple 登录撤销密钥。
- 修正官网 "no account of any kind" 的表述，它与云账号矛盾（能力盘点里指出过）。
- 四个快速见效项：
  - heartbeat 的结果进聊天并推送；
  - heartbeat 的 `schedule` 字段真正生效；
  - 云端工具白名单加入有 SSRF 防护的 `web_search` / `web_fetch`，并计入计量；
  - web 端审批"`ask` 即拒绝"改为"等待收件箱"的准备工作（加开关）。
- 写 `POLICY_REACH_OUT.md` 与 `THREAT_MODEL.md` v0。

### Phase 1 · v0.28 "Tasks & Trust"（10/13–11/9）

- **内容**：
  - W1 核心（本地）；
  - W2 v1：策略、授权、收件箱（web / iOS / Island）、审计与 Activity；
  - W3 落地；
  - iOS 的 Tasks 与收件箱；
  - W7 的审批中继。
- **出口标准**：三个端到端场景跑通。
  1. 工作日 8 点：邮件加日程风险 → 卡片 + 推送；
  2. 盯网页空位或价格 → 命中推送；
  3. 派 Claude Code 修 bug → 手机审批 → PR 链接。

### Phase 2 · v0.29 "Reach"（11/10–12/7）

- **内容**：
  - W4：Relay、Home 设置、按租户的 APNs、离线排队；
  - W10：渠道主动化、IM 内审批、任务的 Live Activity、App Intents v1、分享扩展。
- **出口标准**：5G 下的手机不装 Tailscale 也能审批 Home 上的任务；Relay 读不到内容。

### Phase 3 · v0.30 "Hands"（12/8–2027-01-18）

- **内容**：
  - W5：日历、提醒、通讯录；邮件草稿到发送；MCP 的 HTTP 传输和 OAuth；
  - W2 深化：凭据代理、OTP 过滤、注入语料进 CI；
  - W6：本地浏览器 v1；
  - 公开 THREAT_MODEL v1。

### Phase 4 · v0.31 "One Lisa"（2027-01-19–03-01）

- **内容**：
  - W8：指定"家"、导出导入、记忆编辑与 Forget；
  - W9：dream diff 与回滚、状态语义、iOS 语音；
  - W11：MCP server。

### Phase 5 · v1.0 "Always-on, yours"（2027-03-02–04-12）

- **内容**：
  - W7 舰队 2.0；
  - 配方画廊；
  - agent 发件身份（opt-in）；
  - 云端按任务沙箱评估；
  - Relay 订阅上线；
  - 安全评审；
  - 1.0 发布，论文和评测集投稿。

### 砍单顺序

落后时按这个顺序往后推：
1. agent 发件身份
2. 云端沙箱
3. 实时语音
4. 配方画廊
5. OpenClaw 迁移

**永不砍**：Task Engine、Warden 与收件箱、Relay、Reach-out 章程。

---

## 5. 需要改写的既有决策

| 位置 | 现状 | 建议 |
|---|---|---|
| [AUTONOMY_ROADMAP](AUTONOMY_ROADMAP.md) 非目标 | 不主动联系、不推送；扩张需要单独的路线图和 opt-in | 由 W3 的 Reach-out 章程承接（opt-in、预算、红线），非目标一节改为引用该章程 |
| `src/approval.ts` 默认 `auto`；web 端 `ask` 即拒绝 | 没有交互式审批者 | v0.28 起 web 默认 `ask-mutating`，由收件箱审批；CLI 保持不变 |
| 本地 owner 默认 `danger-full-access` | 交互态和自动运行态没有区分 | 自动运行的任务默认 `workspace-write`，交互态保持不变 |
| [ROADMAP_v1.0](ROADMAP_v1.0.md) 的 1.0 定义 | 四支柱各自跨过可信阈值 | 增补：Task Engine、Warden、Relay 是 1.0 的必要条件；Sense 的常驻屏幕和语音采集降为 1.x |
| [PLAN_IDENTITY_v1.0](PLAN_IDENTITY_v1.0.md) 的"两个数据平面" | Mac 和 Cloud 各有一个 Lisa | 改为"一个家 + 中继"：Cloud 是中继，也是无 Mac 用户的家 |
| PITCH 与 README 的主钩 | 内在生活 | 可托付的全天候 agent；灵魂回答"为什么可托付" |
| 官网隐私页 | "no account of any kind" | 改为准确描述：本地版无账号；云版的账号只用于中继、计费和云端 Lisa |

---

## 6. 明确不做

| 不做 | 理由 |
|---|---|
| 每个用户一台云 VM | 成本和信任负担都不对称；执行放在用户自己的 Mac 上。云端沙箱只在 P2 为无 Mac 用户按任务评估 |
| 电话号码、钱包、自主支付 | Cue 的号码要付费、分国家、不收短信，钱包仅限美国；x402 真实交易很少；责任最终都归用户；滥用和监管风险高。支付最多做到"审批卡 + Stripe Link 一次性卡"，而且放在 1.x 之后 |
| 3D 或视频形象、硬件 | 投入高；xAI 已撤下 3D 伴侣；在场感用 Island、Live Activity、状态语义和声音就能满足 |
| 亲密关系机制、面向未成年人 | 中美监管专门针对这一块；与高权限代理放在一起风险最高 |
| 通用购物 agent | Amazon 封锁 Muse 并计划封 Google 和 OpenAI 的 agent；Cloudflare 默认拦截；ACP 已退潮 |
| 对中国超级 App 的 GUI 代操作 | 平台封禁，需走 SAEP 授权；拟人化办法下还有备案和安全评估义务 |
| 几十个 Bot 的名册 | 记忆割裂，上下文税高；LISA 的核心资产是单一稳定人格 |
| 不透明的计费单位 | Grok Bot 和 Cue 的口碑损失主要来自这里 |

---

## 7. 指标体系

- **北极星**：每周成功托付的任务数（按活跃用户计），即用户交给 Lisa 且没有被撤回或判为失败的任务。
- **护栏指标**：
  - 未授权副作用为 0，这是硬线；
  - 主动消息有用率：被采纳、点击或点赞的，占全部主动消息的比例，初始目标 ≥ 60%；
  - 审批负担：每个任务平均需要审批的次数，应当逐步下降；
  - 单用户每日成本；
  - Relay 可用性 ≥ 99.5%。
- **输入指标**：
  - 从出生到完成第一个任务的时间；
  - 审批响应时间；
  - 任务成功率；
  - watcher 命中的精度；
  - 至少有 1 个 routine 的用户的 D30 留存。
- **采集方式**：沿用 [analytics-plan-2026-08-21](analytics-plan-2026-08-21.md) 的本地优先账本，不采集内容；出网只发 opt-in 的聚合数据，与"无遥测"的公开承诺一致。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 单人开发，范围蔓延 | 按阶段设门，砍单顺序预先写死；"先打深再铺宽"仍然适用 |
| 增加写能力和浏览器后出安全事故 | Warden 先于写能力上线；默认询问；注入语料作为 CI 门禁；每个阶段做安全评审 |
| Relay 成为新的攻击面，带来成本 | 保持很薄；E2E 加密；不提供 Warden 之外的执行路径；限流；有成本告警 |
| App Store 审核（5.1.1(i)、5.1.2(i)、4.1、2.1、3.1） | 新功能同步更新 AI 披露与隐私标签；Relay 订阅走 IAP；审核账号覆盖新功能 |
| 巨头下沉本地（Muse Mac、Perplexity PC） | 以开源可审计、不抽佣、可选模型、可携带的自我、coding 外环做差异 |
| OpenClaw 2.0 在开源侧挤压 | 以安全默认、soul、coding 外环、研究背书区隔；提供从 OpenClaw 迁移的路径 |
| 监管：云版进入欧盟或中国 | 欧盟需满足 AI Act 第 50 条与 GDPR；中国大陆不上云版，只做开源自部署；陪伴类模块按地区开启 |
| 算力成本 | 分层路由；watcher 放在本地；按任务预算和熔断 |

---

## 9. 两周可执行清单（Phase 0 起步，PR 粒度）

1. **docs**：`POLICY_REACH_OUT.md`，并在 AUTONOMY_ROADMAP 非目标处加引用。
2. **PR**：heartbeat 的结果经 PushBridge 和 `idle_message` 投递到聊天与推送；`schedule` 字段生效，复用 scheduled-dispatch 的解析器。
3. **PR**：云端工具白名单加入有 SSRF 防护的 `web_search` / `web_fetch`，更新计量与测试。
4. **PR**：`src/tasks/` 骨架，包括模型、存储、状态机、恢复与幂等测试，暂不做 UI。
5. **PR**：`src/warden/` 骨架，包括 ActionRequest、策略、授权、审计和收件箱 API。在开关后面接入 web 端的审批回调，替换 `buildNonInteractiveApprovalCallback` 的拒绝路径。
6. **PR**：iOS 审批收件箱视图和可操作通知类别，放在开关后面。
7. **PR**：web Tasks 视图的只读版（Upcoming 与 Activity）。
8. **docs**：`THREAT_MODEL.md` v0，内容为现有攻击面加上 W2 的计划。
9. **文案草稿**：README、PITCH、官网的新定位，v0.28 发布时再上线。

---

## 附：1.0 目标态与竞品对照

| 能力 | LISA 1.0（目标） | Muse | Grok Bot | Cue | Dots |
|---|---|---|---|---|---|
| 执行位置 | 你的 Mac（Home）；无 Mac 用户用云版 | 每用户一台云 VM | 每用户一台 microVM，所有 Bot 共用 | 云主机（实测共用） | 每个 dot 一台云电脑，可选授权本地电脑 |
| 凭据 | Keychain 加凭据代理，模型只看到句柄 | 凭据代理（替身 token） | token 留在后端 | MCP + OAuth | 安全表单直达浏览器，模型看不到 |
| 审批 | Warden：四档规则 + 作用域授权 + 收件箱（iOS / Island / IM），可选跨家族审查 | Sentinel，原生弹窗 | 审批卡 + Auto Review | 逐笔支付审批 | 四档 Custom Rules + Auto-review + 实时监控 |
| 任务 | Goals / Routine / Watcher，恰好一次投递 | Goals / cron / Upcoming | Routines 加事件触发 | Routines / Automations | 持续目标 + Scheduled |
| 主动性 | 有预算、有旋钮；自发的主动通道只读 | 门槛高，用户可调 | Routine 驱动，无事沉默 | 用户设定的 routine | 空闲时只读研究 |
| 人格 | 一个稳定的自我，可审计的 Dream，可测量的一致性 | 名字、头像、声音、视频形象 | 同事式轻人格 | 职能化 | "bubbly" 形象，无人格设定 |
| 记忆 | 可看、可改、可删、可导出、可携带（MCP） | MEMORY.md 可改，有 Forget | 按 Bot 隔离，上下文税 | 按 agent 隔离，Dream | 与 ChatGPT 共享；单条不可看、不可删 |
| 多 agent | 同一自我的多只手 + 厂商中立的 coding 舰队 | 子代理 | 名册、群聊、Team Bots | 群聊 | 每人一个 dot，团队是远景 |
| 渠道 | iOS / Mac / web + Telegram / Slack / 飞书 / Discord / iMessage + MCP | App、WhatsApp、web、Mac | 桌面、移动、Slack | App 加 agent 自有邮箱和电话 | ChatGPT、Slack、Teams，短信为美国 beta |
| 价格 | 本地免费；Relay 约 $5–10/月；云版额度透明 | 免费 / $20 / $100，计划抽佣 | 捆绑在 $20–300 的套餐里 | 早期免费，实测 $100 / $200 | Pro $100–500 / Business Premium，聊天免费、干活计量 |
| 开源、模型可选 | 是 / 是 | 否 / 否 | 否 / 否 | 否 / 否 | 否 / 否 |

各竞品一列的出处见调研报告第 1、2 节与附录。

---

## 执行记录

按 PR 记录落地情况。"已合并"只表示代码进了 main；发布到 npm / DMG / App Store、部署到 Cloud Run 另行记录。

| PR | 内容 | 状态 |
|---|---|---|
| [#400](https://github.com/oratis/LISA/pull/400) | 竞品调研、升级方案、附录备忘 | 已合并（2026-10-02） |
| [#401](https://github.com/oratis/LISA/pull/401) | Reach-out 章程、威胁模型 v0、AUTONOMY / ROADMAP / IDENTITY 决策改写、官网 iOS 文案更正 | 已合并（2026-10-02） |
| [#406](https://github.com/oratis/LISA/pull/406) | W3 Reach-out 闸门：所有主动消息经 `reachOut()`，来源开关、免打扰、去重、预算 | 已合并（2026-10-02）；随 v0.28.0 发布 |
| [#405](https://github.com/oratis/LISA/pull/405) | W2b 密钥库（`secret://` 句柄）与入站邮件卫生 | 已合并（2026-10-02）；随 v0.28.0 发布。钥匙串后端待真机验证 |
| [#402](https://github.com/oratis/LISA/pull/402) | W2a Warden 核心：确定性决策、范围授权、污点、审计、审批收件箱 | 已合并（2026-10-03）；随 v0.28.0 发布，可选开启（`--approval warden`） |
| [#404](https://github.com/oratis/LISA/pull/404) | W12 云端 `web_search` / `web_fetch`（SSRF 防护、租户限额） | 已合并（2026-10-07）；云端已部署，开关关闭 |
| [#403](https://github.com/oratis/LISA/pull/403) | W1 Task Engine：routine / 一次性任务 / watcher，租约、续跑、账本 | 已合并（2026-10-07）；随 v0.28.0 发布。审批未接线前只允许只读调用；云端任务关闭 |
| [#407](https://github.com/oratis/LISA/pull/407) | W12 按用途路由、单次运行预算、Gemini 网关 | 已合并（2026-10-07）；云端已部署（`lisa-cloud-00033-meq`） |
| [#415](https://github.com/oratis/LISA/pull/415) | 产品定位改为 AI Personal Assistant（README、官网、包描述） | 已合并（2026-10-07）；官网已部署 |
| [#416](https://github.com/oratis/LISA/pull/416) | Gemini 微调模型名保持大小写（#407 返修） | 已合并（2026-10-08） |
| [#417](https://github.com/oratis/LISA/pull/417) | `web_fetch` 恢复 #404 改写丢失的正文，保持线性（#404 返修） | 见 PR |
| [#418](https://github.com/oratis/LISA/pull/418) | 入站邮件再识别三种验证码格式（#405 返修） | 已合并（2026-10-08） |
| v0.28.0 | 发布：GitHub Release、Mac DMG、npm、Homebrew（[发布说明](RELEASE_v0.28.0.md)） | 见发布页 |
