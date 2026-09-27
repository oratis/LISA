# LISA 全功能审查与 personal assistant 执行计划

日期：2026-09-27。基线：main `274f535` / v0.26.1。状态：执行中。

## 目标与当前事实

让 iOS 成为可直接登录的个人助手，并可靠保留云与自己 Mac 两种模式；修复已证实的问题，完成代码、构建、审核材料和发布流程。Apple 最终审核结果由 Apple 决定，提交成功、TestFlight 上传和通过审核是三个不同状态。

现有记录：7 月 4.1(a) 品牌相似、7 月 2.1 登录失败；[#377](https://github.com/oratis/LISA/pull/377) 记录 2026-08-04 的 2.1(b) 内购不可发现。最新版已修复内购入口依赖 quota 的条件，但不能据此认定线上已部署、最新二进制已送审。本次 App Store Connect 浏览器需要登录；Gmail 连接缺读取 scope。未拿到更晚拒审原文前，以这些已核实记录为依据。

2026-09-27 生产只读检查：`/health` 返回 200、cloud edition；`/api/auth/config` 返回 accounts=true、Google 配置、appleWeb=null、stripe=false。健康检查仅证明存活，不证明登录、聊天、内购到账可用。

## 功能盘点

| 范围 | 实现证据 | 检查结论与优化 |
| --- | --- | --- |
| CLI/模型 | `src/cli.ts`、`providers/`、`model/` | 多供应商与本地模型；以类型检查、工具/限额测试验证回归 |
| Web/桌面 | `web/`、`packaging/mac-client/` | 已有聊天/会话 shell；v0.26 内置 Node/backend，不重复建设 |
| iOS 聊天 | `ChatView.swift` | 有历史、工具状态、重试、停止；切换配置却只在消息为空时加载历史，存在旧实例上下文残留 |
| iOS 连接 | `AppState.swift`、`TokenStore.swift` | 模式 picker 只改标签，凭据共用一个 key；优先修复为按模式隔离，并迁移旧配置 |
| 登录/身份 | `web/accounts.ts`、`otp.ts`、`cloudAuth.ts`、`googleAuth.ts` | 中心化云账户已具备，默认域名存在；隐藏默认 URL 编辑降低摩擦。Mac 设备令牌不是云账号 |
| StoreKit/计费 | `billing/`、`CreditsStore.swift`、`StoreView.swift` | 保留 #377 修复；需线上审核账号白名单、沙盒到账与 ASC 商品状态验收 |
| Agent 调度 | `agents/`、`dispatch/`、`RosterView.swift` | 适用于 Mac；云端主动拒绝对应路由，iOS 需清楚展示模式能力，避免空错误页面 |
| 自主性/后台 | `heartbeat/`、`autonomy/`、`web/autonomy-sweep.ts` | 可用机制存在；生产调度与每用户预算需单独核验 |
| 人格/记忆/知识 | `soul/`、`memory/`、`knowledge/` | 有持久存储、检索与反思；跨实例同步尚非现有保证 |
| 邮件/感知/渠道 | `mail/`、`sense/`、`channels/`、`consent/` | 依赖服务连接与同意；云拒绝主机级接口，不能在云 UI 暗示已经连接 Mac 邮箱 |
| 工具/MCP/skills | `tools/`、`mcp/`、`skills/` | cloudSafeSubset 与本地权限分别控制；不能为产品包装移除权限防线 |
| 推送/Widget | `web/push.ts`、iOS Widgets/Shared | 当前主机级推送云端禁止；模式切换必须清除旧快照，设备上 APNs 另验 |
| 安全/租户 | `web/capabilities.ts`、`tenancy.ts`、`tenant-runtime.ts`、`sandbox/` | 服务端边界有测试；声明准确，不等同 Muse 专属 VM |
| 隐私/商店 | `PrivacyInfo.xcprivacy`、网站 privacy、APPSTORE_METADATA | 现有“无收集/只在自己 Mac”与云模式不一致；需按实际聊天/购买/账号处理校正 |
| 发布 | `.github/workflows/`、`deploy/` | GitHub 有 iOS 签名和 npm secrets；tag/上传并非送审，明确分开记录 |

## 本轮执行清单

| ID | 优先级 | 工作 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| A1 | P0 | Mac/Cloud 独立配置与 Keychain、旧版迁移、退出不破坏另一个模式 | 配置往返、重启、清除、迁移测试 | 待执行 |
| A2 | P0 | 配置切换取消旧请求并清除聊天/账号/快照 | 不跨实例显示历史、不向错主机发 token | 待执行 |
| A3 | P0 | 云端隐藏或解释不支持的主机能力 | 无 Mac 可独立登录聊天，Mac agents 仍可到达 | 待执行 |
| A4 | P1 | 个人助手首屏与日常任务草稿入口、默认中心登录 | 一键草稿可编辑，真实发送才执行 | 待执行 |
| A5 | P0 | AI 数据使用说明、商店文案、支持与审核路径 | 内容与云/本地行为一致，无虚假隐私承诺 | 待执行 |
| A6 | P0 | 全库基线、iOS 单测/构建、iPhone/iPad 实测 | 记录命令与真实结果，不把静态审查写成 E2E | 执行中 |
| A7 | P0 | 文档 PR、实施 PR、合并/发布与审核 | PR 链接、制品、部署版本、ASC 状态均可核验 | 待执行 |

## 后续产品工程（不伪报为本轮完成）

| 项目 | 缺口 | 依赖与验收 |
| --- | --- | --- |
| 通用持久任务 | coding roster 不等于个人任务系统 | 任务状态、预算、幂等恢复、成果引用、取消；服务重启后继续同一任务 |
| 跨设备同一助手 | 两个实例的人格与记忆独立 | 明确同步/冲突/删除协议与设备授权；不能把 token 共用当成同步 |
| 云连接器 | 云禁主机邮件/感知接口 | 每用户 OAuth 与读写权限、凭据隔离、审核日志；验证租户越权为拒绝 |
| 云后台通知 | 当前 push 为机器级 | 先设计租户级订阅与 APNs，按预算与重要变化通知 |
| 更强执行隔离 | 共享 Cloud Run 与专属 VM 有差距 | 网络出口、凭据代理、隔离进程/VM 成本评估和红队 |

## 发布门槛与回滚

1. 代码回归与 iOS 构建通过；涉及账号、权限和支付失败不得跳过。
2. 审核环境真实登录、聊天、商品加载与沙盒购买成功；签名、隐私 URL、截图与元数据准确。
3. 代码提交到 PR，CI 通过后合并；发布只用合并后的确定版本，记录 tag 与工作流。
4. Cloud Run 记录原 revision；新 revision 失败回切原流量。npm 已发布版本不可覆盖，修复递增版本。App Store 需 Apple 审核后才能上架。
5. 缺凭据、ASC 必填问卷、审核信息或生产验证时，把具体阻碍记到本文件，不宣称“全部完成”。

## 执行记录

- 已对原工作目录执行 `git pull --ff-only`，保留其未跟踪材料；另建 managed worktree，使用最新 origin/main。
- 已读取官方 Muse/Apple 资料及 LISA 关键模块，文档先于代码提交。
- 已启动后端类型检查与全量测试；结果待回填。
