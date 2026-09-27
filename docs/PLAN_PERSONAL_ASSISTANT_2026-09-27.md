# LISA 全功能审查与 personal assistant 执行计划

日期：2026-09-27。基线：main `274f535` / v0.26.1。状态：本轮代码与生产部署已完成；商店送审被真实验收问题阻塞。最终证据见 [执行与发布记录](EXECUTION_PERSONAL_ASSISTANT_2026-09-27.md)。

## 目标与当前事实

让 iOS 成为可直接登录的个人助手，并可靠保留云与自己 Mac 两种模式；修复已证实的问题，完成代码、构建、审核材料和发布流程。Apple 最终审核结果由 Apple 决定，提交成功、TestFlight 上传和通过审核是三个不同状态。

现有记录：7 月 4.1(a) 品牌相似、7 月 2.1 登录失败；[#377](https://github.com/oratis/LISA/pull/377) 记录 2026-08-04 的 2.1(b) 内购不可发现。最新版已修复内购入口依赖 quota 的条件，但不能据此认定线上已部署、最新二进制已送审。本次通过本机 API 凭据确认：App 6784690058，iOS 1.2 为 REJECTED；最新 review submission 为 2026-09-09 的 `1f0010d4-7318-44c7-b292-90ac1d8eb248`，状态 UNRESOLVED_ISSUES，三个 IAP 也为 REJECTED。浏览器仍需登录才能核对最新拒审原文及隐私问卷；Gmail 连接缺读取 scope。不得把历史拒审原因当成这次原因。

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
| A1 | P0 | Mac/Cloud 独立配置与 Keychain、旧版迁移、退出不破坏另一个模式 | 配置往返、重启、清除、迁移测试 | 已实现并发布 |
| A2 | P0 | 配置切换取消旧请求并清除聊天/账号/快照 | 不跨实例显示历史、不向错主机发 token | 已实现并发布 |
| A3 | P0 | 云端隐藏或解释不支持的主机能力 | 无 Mac 可独立登录聊天，Mac agents 仍可到达 | 已实现并发布 |
| A4 | P1 | 个人助手首屏与日常任务草稿入口、默认中心登录 | 一键草稿可编辑，真实发送才执行 | 已实现并发布 |
| A5 | P0 | AI 数据使用说明、商店文案、支持与审核路径 | 内容与云/本地行为一致，无虚假隐私承诺 | 已实现并发布 |
| A6 | P0 | 全库基线、iOS 单测/构建、iPhone/iPad 实测 | 记录命令与真实结果，不把静态审查写成 E2E | 后端通过，iPhone/iPad 各 59 项单测通过；原生 UI/真机验收未完成 |
| A7 | P0 | 文档 PR、实施 PR、合并/发布与审核 | PR 链接、制品、部署版本、ASC 状态均可核验 | PR 已合并、代码已发布；送审阻塞 |

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
- 已完成后端类型检查与全量测试，见下方结果。

- 文档 PR #387 已通过 CI 并合并。
- 后端当前 2053 项：2052 pass / 0 fail / 1 skip；类型检查、客户端类型检查、API contract 和 build 已通过。基线唯一失败为测试误用真实 Codex，现已隔离 PATH。
- iPhone 和 iPad 最终各通过 59 项 XCTest，覆盖 Keychain 失败后切换模式、重启和恢复的回归。模拟器逻辑测试不等于原生 UI、真机 APNs 或 StoreKit 沙盒端到端验证；当前 UI 工具不能连接 Simulator。
- 审核账号真实 login、auth/me、billing/quota、island/ping 均 200，未在 Git 中保存凭据。灰度 revision `lisa-cloud-00024-ruh` 已配置限定审核账号的 IAP sandbox allowlist；未验证真实 StoreKit 购买。
- 新增 AI 接收方披露接口与 iOS 发送前同意；自定义 endpoint 只显示 hostname，不返回 URL 内凭据。新增 StoreKit appAccountToken 绑定和跨账号拒绝测试。
- 当前尚未声明真机 APNs、Apple/Google 交互登录、真实沙盒购买成功或审核通过；需要后续实际证据。

### 2026-09-27 灰度与送审阻碍

- 云灰度的 `/health`、登录、额度和 `/api/auth/config` 均通过；披露接收方为 Zhipu (GLM)。原生产 `lisa-cloud-00023-lb7` 和新灰度的真实 `/chat` 均返回 SSE error：上游 429「余额不足或无可用资源包」。HTTP 200 的 SSE 握手不等于聊天成功。这是已验证的上游服务阻碍，必须恢复可用额度并重新验收对话才能送审；不能用用户购买 LISA credits 解决运营方模型账号欠费。
- 网站灰度 `lisa-web-00015-ron` 的中英文 privacy/support 四个页面均 HTTP 200；浏览器确认英文内容。生产原 revision 为 `lisa-web-00012-c49`，保留回滚目标。
- App Store 英文 description、promotional text、keywords、support URL 和 subtitle 已通过官方 API 更新。审核密码仍仅保留在 ASC 和本机临时文件。
- 最终二进制 1.2 (1790520396) 已获 Apple VALID 并绑定到版本，状态为 PREPARE_FOR_SUBMISSION，尚未提交审核。必须补核最新拒审原文、ASC 隐私答案/年龄分级、当前截图和真实沙盒购买。浏览器当前未登录，不能把隐私 manifest 当成已更新商店隐私问卷。
