# LISA 当前基线与产品差距

日期：2026-10-24。同步方式：git pull --ff-only origin main。研究开始时 HEAD 与 origin/main 均为 **4115c1a01637ed96bebdc558964d923e0261ed72**，package.json 为 0.28.1。现有未跟踪文件未纳入研究修改。

研究过程中共享工作区又出现 **9ab8663／972b097** 的 Pocket 上架文档、诊断和依赖更新，所在分支为 codex/pocket-live-status-oct24；这些变更保留，未回退或覆盖。本研究的产品代码比较固定在上述 4115c1a，发布状态额外引用该工作区最新的 [Pocket 复核](../../REVIEW_POCKET_LIVE_2026-10-24.md)，不将其他任务的生产验证计为本轮执行。

本表是源码和文档核对，不是生产探测或三端真机验收。“源码有”与“用户可用”分开；生产开关及 App Store 状态仅引用已有记录，需上线前再核验。最新复核记录确认 Pocket 1.2 美区上架、正式客户端密码登录与聊天协议可用；它也明确真机 UI、第三方交互登录和内购仍需分别验收。10 月 8 日源码视觉更新不等于商店包包含这些更新。

## 1. 界面与入口

| 对象 | 当前证据 | 判断 |
| --- | --- | --- |
| Web 主壳 | [lisa-html.ts](../../../src/web/lisa-html.ts)，导航为 Chat / Dashboard / Control / Rêve / Room / Sense / Memory / Knowledge / Settings；300px 侧栏、主区、320px 辅栏 | 功能按内部模块分组，缺少 Today、通用 Tasks 与成果入口 |
| Web 视觉 | [main.css](../../../src/web/assets/client/main.css)、[DESIGN_TOKENS](../../DESIGN_TOKENS.md)，Nebula／Calm；正文约 12–13px，手机侧栏叠在主区上方 | 已有主题、对比度和响应式基础；需要重排层级和阅读密度，不必重建主题系统 |
| Soft Ink | [soft-ink.ts](../../../src/web/soft-ink.ts)、[v0.28.1 说明](../../RELEASE_v0.28.1.md) | 24 个核心表情及复用映射、插画、贴纸已经落地；这轮延续已有品牌 |
| iOS / iPadOS | [App.swift](../../../packaging/ios-companion/Sources/App.swift)：Home / Chat / My Mac / Settings；[HomeView](../../../packaging/ios-companion/Sources/HomeView.swift)：连接卡、starters、mood、desire、agent、recap、mind | 已有日常任务起点，不应再批评成纯 agent 控制台；但仍没有通用任务列表和成果库 |
| iOS 网络与状态 | [LisaClient](../../../packaging/ios-companion/Sources/LisaClient.swift)、[AppState](../../../packaging/ios-companion/Sources/AppState.swift)、[ConnectionProfiles](../../../packaging/ios-companion/Sources/ConnectionProfiles.swift) | Cloud／Mac 分别保存配置；不能通过改导航假装一份会话和记忆已统一 |
| Mac 主窗口 | [MainWindow](../../../packaging/mac-client/Sources/Lisa/MainWindow.swift)、[WebContent](../../../packaging/mac-client/Sources/Lisa/WebContent.swift) | AppKit 外壳承载 WKWebView；Web 改善可复用，但不等于原生审批已实现 |
| Mac 常驻入口 | [MenuBarController](../../../packaging/mac-client/Sources/Lisa/MenuBarController.swift)、[IslandContent](../../../packaging/mac-client/Sources/Lisa/Island/IslandContent.swift) | 主要聚合 agent 状态、mood、desire；应扩为任务与待决策优先 |
| 官网 | [AssistantHome](../../../website/src/components/AssistantHome.astro)、[AssistantCloud](../../../website/src/components/AssistantCloud.astro) | 已采用 AI Personal Assistant 定位并说明 Cloud／Mac 独立；需要与后续真实场景联动，不先扩大能力承诺 |

## 2. 能力成熟度

| 能力 | 已有实现／证据 | 尚缺与风险 | 建议工作包 |
| --- | --- | --- | --- |
| 持久任务 | [types](../../../src/tasks/types.ts)、[runner](../../../src/tasks/runner.ts)、[tasks-api](../../../src/web/tasks-api.ts)：oneoff / routine / watcher / goal，租约、续跑、取消、预算 | 不能说“没有 Task Engine”；真正缺 UI、完整目标编排、任务与聊天的稳定关联 | A01–A04、B03 |
| 任务协议 | [OpenAPI](../../../contracts/lisa-api-v1.openapi.json)、[生成 Swift 契约](../../../packaging/ios-companion/Sources/APIContract.generated.swift)已有 tasks、runs、approvals 和事件 | 需要接入客户端而非重复发明接口；新增字段保持兼容，不能手改生成文件 | A01、A03 |
| Watcher / Routine | [watchers](../../../src/tasks/watchers.ts)、[schedule](../../../src/tasks/schedule.ts)、[lifecycle](../../../src/tasks/lifecycle.ts) | Web／RSS／mail 轮询与固定调度已有；没有因此获得任意 SaaS webhook。任务开关与自治总开关共同影响运行 | A02、B03、C01 |
| 后台副作用 | [policy](../../../src/tasks/policy.ts)、[wiring](../../../src/tasks/wiring.ts) | 有 approval factory 接缝，但本次源码搜索未见生产调用 setTaskApprovalFactory；未接线时拒绝非验证只读调用 | B03 |
| Warden | [warden-api](../../../src/web/warden-api.ts)、[main.js 审批组件](../../../src/web/assets/client/main.js)、[设计限制](../../DESIGN_WARDEN.md) | 已有 Web 卡与收件列表，不能写成完全没有审批；默认 opt-in，只接 Web chat，in-process pending，重启后旧审批失效 | A02、B01–B03 |
| 手机审批权限 | wardenTrust 允许本机 loopback owner 或登录用户 session；配对设备／共享 token 不能据此答复审批 | iOS 加按钮会被拒绝；需要明确的原生签名审批协议、设备撤销、重放保护 | B01、B02 |
| Warden 信任根 | [DESIGN_WARDEN](../../DESIGN_WARDEN.md) | 本机任意非受限进程仍可触及审批入口；launchd 工作目录可能为根目录；不能把当前 Warden 宣称为完整隔离 | B01，默认启用的门槛 |
| 凭据 | [secrets](../../../src/warden/secrets.ts)、[secrets-keychain](../../../src/warden/secrets-keychain.ts) | secret:// 存储底座已有；发布说明称尚未被其他模块消费，不是完整 connector 凭据代理 | C01 |
| 成果 | TaskRun.artifacts 与 TaskArtifact 已有 text / link / file；[delivery](../../../src/tasks/delivery.ts)可放入对话卡 | 有结果表示接缝，但无统一成果索引、版本、受控文件预览和三端编辑闭环；不能将本地路径直接当手机可下载文件 | A04、B04 |
| 记忆／知识／Soul | [memory](../../../src/memory)、[kb](../../../src/kb)、[soul](../../../src/soul)与现有 Web inspect | 有丰富底座，用户级来源解释和跨端修改仍需设计；“一个 Home”是目标，当前 Cloud／Mac 仍独立 | B05、C03 |
| 主动触达 | [reachout](../../../src/reachout)、[POLICY_REACH_OUT](../../POLICY_REACH_OUT.md) | 已有免打扰、去重、来源、反馈；应复用而不是新建通知系统。租户级 push 和远程到达性另有前置 | A02、B02 |
| 云能力 | [capabilities](../../../src/web/capabilities.ts)、[tasks-api](../../../src/web/tasks-api.ts)、[v0.28.1](../../RELEASE_v0.28.1.md) | 云 web tools／tasks 有服务端开关；发布记录为生产关闭，当前生产未探测。云拒绝宿主控制／mail／pair／push 等路由 | A01、C02 |
| 云扩容 | [Task Engine 已知限制](../../DESIGN_TASK_ENGINE.md) | 当前文件租约／共享卷方案存在多实例限制，不能靠 UI 宣称可靠全天候云调度 | C02 |
| 语音与附件 | [Web client](../../../src/web/assets/client/main.js)、[voice](../../../src/voice)、[iOS ChatView](../../../packaging/ios-companion/Sources/ChatView.swift) | Web 已有录音转写／dictation 和附件；本次未见 iOS ChatView 同等级语音链路，实时双工通话不是现成功能 | A03、C04 |
| Coding 外环 | [dispatch_agent](../../../src/tools/dispatch_agent.ts)、[dispatch-ledger](../../../src/integrations/dispatch-ledger.ts)、[agent-roster](../../../src/web/agent-roster.ts)、[RosterView](../../../packaging/ios-companion/Sources/RosterView.swift) | 保留多厂商执行器能力；需从“进程名册”转成“某个用户任务由谁执行” | A01、C05 |
| 桌面感知 | [sense](../../../src/sense)、[consent](../../../src/consent) | 已有按需感知／权限框架，不能把观察能力当成通用 computer use | C04 |
| 通用浏览器执行 | 本次核查的 Web tools、Sense 和 Mac 壳均不足以证明完整通用操作闭环 | 属于后续 Hands；需要受控执行、查看／接管、认证与失败恢复 | C04 |

## 3. 当前必须保留的行为

- Cloud 的 capability profile 和服务端拒绝策略是边界；前端隐藏不是权限控制。
- 不扩大配对设备令牌权限来赶 iOS 审批进度。
- 任务与 run 分开，停止本次与停用未来运行分开；任务历史不被会话删除误删。
- 未接审批链的无人值守运行保持只读；失败重试沿用原 run 和副作用账本。
- 不给估算式花费熔断器冠以保证最大账单的说法。
- Account UID 由认证上下文决定；事件、结果、缓存和新索引不能跨租户。
- 保留现有 Cloud／Mac 配置和历史。统一 Home 之前，持续展示当前连接位置。
- Soft Ink 的识别性、既有暗／浅主题、减少动态效果和可访问性基础继续使用。

## 4. 证据范围

已有相关测试：tasks/runner、tasks/cloud、tasks/outbox、warden/inbox、warden/policy、web/warden-server、web/tasks-server、web/capabilities、web/soft-ink、E2E layout/main-shell，以及 iOS AccountLifecycleTests。本次只阅读和建立映射，没有运行这些产品测试；文档变更验收与未来功能验收分开。

开发前还应读取 [.codex/INVARIANTS.md](../../../.codex/INVARIANTS.md)。新方案不得破坏其权限、租户、计费、Soul 与协议约束。
