# Personal assistant 执行与发布记录

日期：2026-09-27。此次调研对象为 Meta Muse；依据公开官方材料，未声称拿到其闭源代码或完成登录后的实机体验。

## 代码与交付

- [调研及计划 PR #387](https://github.com/oratis/LISA/pull/387)：已合并。见 [Muse 调研](RESEARCH_MUSE_2026-09-27.md) 和 [功能审查/执行计划](PLAN_PERSONAL_ASSISTANT_2026-09-27.md)。
- [实施 PR #388](https://github.com/oratis/LISA/pull/388)：全部 PR 检查通过后合并。提交 `f4022e07d6650e09cab2a9877bdce049e6799803`，tag `v0.27.0`。
- 云登录优先的 onboarding、个人助手任务草稿入口、独立 Cloud/Mac Keychain 配置、旧配置迁移与失败恢复、切换清理私有状态、发送前 AI 接收方同意、购买账号绑定和隐私/支持页面已实现。
- 云与 Mac 仍是独立实例，不自动同步历史或记忆；云端不开放主机级 agents、邮件、推送接口。通用持久任务、云连接器和跨设备同步仍是计划中的后续工程，未宣称实现。

## 验证证据

| 检查 | 结果 |
| --- | --- |
| 后端全量测试 | 2053 tests，2052 pass / 0 fail / 1 skip |
| 类型与契约 | 服务端、客户端 typecheck，生成 API contract 检查和 build 通过 |
| Lint / 格式 | 0 errors；69 条原有 warnings；format:check 与 diff --check 通过 |
| 依赖与打包 | 根项目生产依赖 audit 为 0；npm pack 预检 1211 文件，未发现密钥/证书文件；网站安装报告的 10 个开发依赖告警未在此轮消除 |
| iPhone | iPhone 17 / iOS 26.4 模拟器，59 XCTest，0 failures |
| iPad | iPad Air 11-inch (M4) / iOS 26.5 模拟器，59 XCTest，0 failures |
| PR CI | [36327123042](https://github.com/oratis/LISA/actions/runs/36327123042)：Node 22/24、覆盖率、audit、浏览器 E2E、网站、iOS 均通过 |
| 扩展 CI | [36327302675](https://github.com/oratis/LISA/actions/runs/36327302675)：相同提交全部平台通过，含 Mac 编译 |
| iOS 签名 | archive/export/upload 成功，Apple 处理状态 VALID |

没有把 XCTest 写成真机 UI E2E。当前原生 UI 工具不能连接 Simulator；真机 APNs、Apple/Google 交互登录、真实 StoreKit 沙盒购买及新截图仍缺验收证据。

## 生产部署与回滚

项目 `oratis-491316`，region `us-central1`。

| 服务 | 当前 100% revision | 原 revision（回滚目标） |
| --- | --- | --- |
| Cloud | `lisa-cloud-00024-ruh` | `lisa-cloud-00023-lb7` |
| 网站 | `lisa-web-00015-ron` | `lisa-web-00012-c49` |

后端镜像 digest：`sha256:7b97c7d3cf36ed3e67f9c0352e86755e2ffa18f3a7ac3fc2f8b4ad95dfdeefad`。镜像构建后追加的源代码变更只涉及 iOS 和文档，服务端内容一致。保留原环境、持久卷和单实例限制，增补只针对审核账户的 sandbox IAP allowlist，仍验证 Apple 签名并限制额度。

发布后 `/health`、`/api/auth/config`、审核账户密码登录复验通过；AI 接收方为 Zhipu (GLM)。[英文支持](https://meetlisa.ai/support/)、[英文隐私](https://meetlisa.ai/privacy/)、[中文支持](https://meetlisa.ai/zh-CN/support/)、[中文隐私](https://meetlisa.ai/zh-CN/privacy/) 均 HTTP 200，英文页面已浏览器检查。

回滚使用 Cloud Run update-traffic 指向表中原 revision；不用删除用户持久卷或覆盖历史版本。npm 版本不可原地覆盖，后续修复需要递增版本。

## App Store 实际状态及阻碍

- App `6784690058` / bundle `ai.meetlisa.main`，iOS **1.2 (1790520396)**。
- Build `e1cadc89-88f2-4ca6-8bac-ebeb6e9e1efe` 已 VALID，并绑定到版本 `9865f871-42af-4453-894f-63fe41e464ea`。当前 **PREPARE_FOR_SUBMISSION**，没有点击提交审核，也没有宣称已获批。
- 官方 API 已更新英文描述、推广语、关键词、副标题、支持链接、隐私链接和审核说明；保留原审核账号/联系方式，未把密码或 token 提交到 Git。
- 最新已知历史提交为 2026-09-09，四个审核项（app 和三个 IAP）曾被拒绝。浏览器尚未登录，无法核对该次拒审正文；不能把 7/8 月历史拒审原因当成 9 月原因。

**真实阻碍：模型服务不可用。** 原生产和灰度真实对话均返回 SSE error：上游 429「余额不足或无可用资源包」。HTTP 200 只是 SSE 握手，不能据此认定聊天成功。新增代码已发布，但没有修复运营方 GLM 账号额度。需要为现有账号恢复额度，或提供经授权的可用模型服务配置，再测试真实对话。购买 LISA credits 不能解决运营方模型账号的额度问题。

**剩余送审工作：** 获得已登录 ASC 会话，核对最新拒审原文；核准 App Privacy 和年龄分级答案，替换为实际新版 iPhone/iPad 截图；验证 StoreKit 商品加载及沙盒到账；完成这些后解决待处理审核项并提交。隐私 manifest、TestFlight 上传、绑定 build 和审核通过是不同状态。

## 发布渠道

- [GitHub Release v0.27.0](https://github.com/oratis/LISA/releases/tag/v0.27.0) 已发布源码、Mac/Linux 运行包、DMG 和校验文件。下载正式 Mac 运行包后 SHA-256 校验通过，执行 CLI 返回 `0.27.0`。
- GitHub / npm：[发布流水线](https://github.com/oratis/LISA/actions/runs/36327573505) 成功。npm 于 14:57 UTC 接受 `@oratis/lisa@0.27.0` 与签名 provenance；版本与 tarball 最终均 HTTP 200；npm shasum 为 `12e965897b17e0ab3205ef5d5a305d034ac76ae3`。
- Mac app/DMG：[发布流水线](https://github.com/oratis/LISA/actions/runs/36327573488) 成功，两次 notarization 均 Accepted，staple 和签名验证通过。
- Homebrew 首次运行因 npm tarball 尚未同步而失败，已补上有上限的下载重试（最多 12 次重试，重试总时限 600 秒），仍只计算真实 npm tarball 的 SHA-256，不用 GitHub 的另一个 tarball 代替。[重试后的 Homebrew 工作流](https://github.com/oratis/LISA/actions/runs/36328169164) 已成功，远端 formula 已更新为 0.27.0。

代码分发、生产后端/网站和审核材料准备已完成；恢复云模型额度及实际 App Store 送审仍未完成，不能把此次代码发布当成个人助手已全面可用或商店已通过审核。
