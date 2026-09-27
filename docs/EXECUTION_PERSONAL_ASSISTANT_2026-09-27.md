# Personal assistant 执行与发布记录

日期：2026-09-27；原生修复及构建状态更新至 2026-09-28（北京时间）。此次调研对象为 Meta Muse；依据公开官方材料，未声称拿到其闭源代码或完成登录后的实机体验。

## 代码与交付

- [调研及计划 PR #387](https://github.com/oratis/LISA/pull/387)：已合并。见 [Muse 调研](RESEARCH_MUSE_2026-09-27.md) 和 [功能审查/执行计划](PLAN_PERSONAL_ASSISTANT_2026-09-27.md)。
- [实施 PR #388](https://github.com/oratis/LISA/pull/388)：全部 PR 检查通过后合并。提交 `f4022e07d6650e09cab2a9877bdce049e6799803`，tag `v0.27.0`。
- [模型恢复 PR #391](https://github.com/oratis/LISA/pull/391)：接入经授权复用的 Google 凭据，补齐 Gemini 计费、免费额度和工具调用。
- 云登录优先的 onboarding、个人助手任务草稿入口、独立 Cloud/Mac Keychain 配置、旧配置迁移与失败恢复、切换清理私有状态、发送前 AI 接收方同意、购买账号绑定和隐私/支持页面已实现。
- 云与 Mac 仍是独立实例，不自动同步历史或记忆；云端不开放主机级 agents、邮件、推送接口。通用持久任务、云连接器和跨设备同步仍是计划中的后续工程，未宣称实现。

## 验证证据

| 检查 | 结果 |
| --- | --- |
| 后端全量测试 | 2058 tests，2057 pass / 0 fail / 1 skip（含模型恢复回归） |
| 类型与契约 | 服务端、客户端 typecheck，生成 API contract 检查和 build 通过 |
| Lint / 格式 | 0 errors；69 条原有 warnings；format:check 与 diff --check 通过 |
| 依赖与打包 | 根项目生产依赖 audit 为 0；npm pack 预检 1211 文件，未发现密钥/证书文件；网站安装报告的 10 个开发依赖告警未在此轮消除 |
| iPhone | iPhone 17 / iOS 26.4 模拟器，65 XCTest，0 failures（含 SSE、历史解码及图片请求） |
| iPad | iPad Air 11-inch (M4) / iOS 26.5 模拟器，65 XCTest，0 failures（一次系统 preflight 拒绝后重跑通过） |
| PR CI | [36327123042](https://github.com/oratis/LISA/actions/runs/36327123042)：Node 22/24、覆盖率、audit、浏览器 E2E、网站、iOS 均通过 |
| 扩展 CI | [36327302675](https://github.com/oratis/LISA/actions/runs/36327302675)：相同提交全部平台通过，含 Mac 编译 |
| iOS 签名 | archive/export/upload 成功，Apple 处理状态 VALID |

没有把 XCTest 写成真机 UI E2E。已通过 Xcode 27 的 Device Hub 找到原生模拟器界面，纠正早先“无法连接 Simulator”的判断。原生 iPhone 已验证云入口、审核账号登录、取消 AI 同意保留草稿、Google Gemini 披露及真实写作回复。真机 APNs、Apple/Google 交互登录和真实 StoreKit 沙盒购买仍缺验收证据。

## 生产部署与回滚

项目 `oratis-491316`，region `us-central1`。

| 服务 | 当前 100% revision | 原 revision（回滚目标） |
| --- | --- | --- |
| Cloud | `lisa-cloud-00027-qal` | `lisa-cloud-00024-ruh` |
| 网站 | `lisa-web-00015-ron` | `lisa-web-00012-c49` |

后端镜像 digest：`sha256:c96722cacc0393d478954a67a183ef60cbebf86a5ff09b62614838e029419899`，源代码提交 `ea2df31`；[Cloud Build](https://console.cloud.google.com/cloud-build/builds/86987513-a347-477b-8bf5-86606da5e8d3?project=oratis-491316) 成功。后续只追加文档。保留持久卷和单实例限制，继续使用仅针对审核账户的 sandbox IAP allowlist，仍验证 Apple 签名并限制额度。

AI 接收方现在是 Google Gemini。经用户明确授权，将 Cuddler 已有 Google AI 凭据存入 LISA 的 Secret Manager `lisa-gemini-api-key`，revision 固定引用 version 1；仅为 LISA 现有运行服务账号授予该 secret 的访问权。Cuddler 项目未修改。两边共享上游额度，轮换时需分别更新各自的 secret。仓库、日志和文档不包含密钥值。

灰度及切流后的生产验证：审核账号登录、账户、额度和 `/api/auth/config` 均通过；真实 SSE 聊天与 `kb_list` 的调用/结果/回答流程均正常结束，无 error；追加计算测试返回 43，写作测试返回完整句子。免费额度产生扣费，审核账号付费余额保持不变。零付费余额的新账号可用性另由额度回归测试覆盖，没有把它写成实际新账号端到端验证。App 使用的 `https://cloud.meetlisa.ai` 域名也完成登录、计算和写作复验。正式流量 100% 指向 `lisa-cloud-00027-qal`，临时灰度 tag 已移除；旧 revision 保留用于回滚，但回滚会恢复尚无额度的 GLM 配置。

[英文支持](https://meetlisa.ai/support/)、[英文隐私](https://meetlisa.ai/privacy/)、[中文支持](https://meetlisa.ai/zh-CN/support/)、[中文隐私](https://meetlisa.ai/zh-CN/privacy/) 在前轮部署后均 HTTP 200，英文页面已浏览器检查。模型恢复发布未改网站和 iOS 二进制；后续原生验收又发现并修复下述 iOS 问题。

回滚使用 Cloud Run update-traffic 指向表中原 revision；不用删除用户持久卷或覆盖历史版本。npm 版本不可原地覆盖，后续修复需要递增版本。

## App Store 实际状态及阻碍

- App `6784690058` / bundle `ai.meetlisa.main`，当前选中 iOS **1.2 (1790524731)**。
- 新 build `24b838e9-c610-46ff-af18-027e9a7add54` 已 VALID，并通过官方 API 绑定到版本 `9865f871-42af-4453-894f-63fe41e464ea`，替换旧 build `1790520396`。读回确认当前 **PREPARE_FOR_SUBMISSION**，releaseType 为 **AFTER_APPROVAL**；没有提交审核，也没有宣称已获批。
- 官方 API 已更新英文描述、推广语、关键词、副标题、支持链接、隐私链接和审核说明；保留原审核账号/联系方式，未把密码或 token 提交到 Git。
- 最新已知历史提交为 2026-09-09，四个审核项（app 和三个 IAP）曾被拒绝。浏览器尚未登录，无法核对该次拒审正文；不能把 7/8 月历史拒审原因当成 9 月原因。

**模型服务阻碍已解除。** 早先 GLM 的真实对话返回上游 429「余额不足或无可用资源包」，而 Cuddler 的 GLM 凭据与它相同。Cuddler 的 Google 凭据实际可用，生产已切换至 Gemini 2.5 Flash。首次工具灰度又暴露 AUTO 模式的 `MALFORMED_FUNCTION_CALL` / 空回复，改用官方 VALIDATED 模式后工具往返通过；无效调用现在明确报错，不伪装成成功。HTTP 200 的 SSE 握手仍不作为聊天成功的充分证据。

模型恢复代码的 [CI](https://github.com/oratis/LISA/actions/runs/36329518601) 全部适用检查通过：Node 22/24、coverage、audit、浏览器 E2E；未改动的 iOS/Mac/网站按路径规则跳过。

**剩余送审工作：** 获得已登录 ASC 会话，核对最新拒审原文；核准 App Privacy 和年龄分级答案，替换为实际新版 iPhone/iPad 截图；验证 StoreKit 商品加载及沙盒到账；完成这些后解决待处理审核项并提交。隐私 manifest、TestFlight 上传、绑定 build 和审核通过是不同状态。

## 发布渠道

- [GitHub Release v0.27.0](https://github.com/oratis/LISA/releases/tag/v0.27.0) 已发布源码、Mac/Linux 运行包、DMG 和校验文件。下载正式 Mac 运行包后 SHA-256 校验通过，执行 CLI 返回 `0.27.0`。
- GitHub / npm：[发布流水线](https://github.com/oratis/LISA/actions/runs/36327573505) 成功。npm 于 14:57 UTC 接受 `@oratis/lisa@0.27.0` 与签名 provenance；版本与 tarball 最终均 HTTP 200；npm shasum 为 `12e965897b17e0ab3205ef5d5a305d034ac76ae3`。
- Mac app/DMG：[发布流水线](https://github.com/oratis/LISA/actions/runs/36327573488) 成功，两次 notarization 均 Accepted，staple 和签名验证通过。
- Homebrew 首次运行因 npm tarball 尚未同步而失败，已补上有上限的下载重试（最多 12 次重试，重试总时限 600 秒），仍只计算真实 npm tarball 的 SHA-256，不用 GitHub 的另一个 tarball 代替。[重试后的 Homebrew 工作流](https://github.com/oratis/LISA/actions/runs/36328169164) 已成功，远端 formula 已更新为 0.27.0。

[v0.27.1](https://github.com/oratis/LISA/releases/tag/v0.27.1) 已完成 [GitHub/npm 发布](https://github.com/oratis/LISA/actions/runs/36329974413)、[Mac 签名与公证](https://github.com/oratis/LISA/actions/runs/36329974348) 和 [Homebrew 更新](https://github.com/oratis/LISA/actions/runs/36330320301)。Mac DMG 已作为 release asset 上传。npm tarball 在发布同步后 HTTP 200，shasum 为 `c69b021ba153e69ca336938f8ea7ad7d3df0a4e1`；Homebrew 首次因 tarball 未同步失败，确认可下载后重跑成功。App Store 实际送审仍未完成，不能把代码发布当成商店已通过审核。

## 原生验收发现与修复

[PR #392](https://github.com/oratis/LISA/pull/392) 已合并，commit `37bd8684e9b03e58f08c94e7c6950793561b895f`。[CI](https://github.com/oratis/LISA/actions/runs/36331388546) 的 Node 22/24、coverage、audit、浏览器 E2E、iOS 及独立 docs 检查全部通过；未变更的 Mac/网站按路径规则跳过。最终本地 iPhone/iPad 均为 65 项测试通过；原生界面验收与单测分开记录。

1. 首次点击 Cloud 时，布尔 sheet 捕获了初始 Mac 模式。改为按 ConnectionMode item 呈现，实际 iPhone 已确认显示 Cloud 登录表单。
2. Google 登录配置请求附着在 lazy Form 尾部空 Section，初始页面未发起请求。改为附着在可见账号 Section；按钮显示及交互登录仍待继续验收。
3. `URLSession.AsyncBytes.lines` 丢弃空行，而 SSE 用空行分隔事件；服务端有回复时原生 App 仍显示没有回复。改为按字节增量解析，覆盖 LF、CRLF、CR、多行 data、中文 UTF-8、心跳及未完成帧。修复后 iPhone 真实云聊天返回了完整的两句邀请文案。
4. 生产历史 API 返回字符串或 Anthropic content blocks，旧 iOS 只接受字符串，解码失败后整个历史页为空。新增兼容解码，显示 text 和工具名称，跳过工具结果与 thinking 等内部块。生产 API 只检查了消息结构，没有把聊天内容或凭据提交到仓库。

5. 原生头像使用带 token 查询参数的 URL，而服务端静态资源处理把查询串视为文件名，图片显示占位图。改为通过 Authorization 请求头加载，凭据不再进入图片 URL；生产相同路径使用请求头认证返回 HTTP 200 / image/png。

以上修复使用有临时签名的模拟器构建；未签名模拟器会缺 Keychain entitlement，不能据此修改正式安全存储。截图已采集原始 onboarding、登录、Home 和 AI 同意页面；后续原生操作被 Mac 锁屏阻止，已请求手动解锁。需要继续完成当前二进制的 iPhone/iPad 截图、Google 按钮与历史恢复验收、StoreKit 沙盒验收，然后再正式送审。

[签名与上传工作流](https://github.com/oratis/LISA/actions/runs/36331498667) 在已验证提交 `a4c7bc4` 上生成 1.2 (1790524731)，archive/export/upload 全部成功。其源码树与 PR #392 合并后的 main 一致。Apple 处理为 VALID 后才绑定新版；没有给测试人员发送邀请。

剩余工作需要已解锁的 Mac 和已登录的 App Store Connect：核对 2026-09-09 拒审正文及隐私/年龄分级；继续原生 Google 登录、历史恢复、头像和 Cloud/Mac 切换验收；采集新版 iPhone/iPad 截图；确认三个仍为 REJECTED 的内购商品能加载并完成真实沙盒到账，处理审核项后正式提交。已有四张原始 iPhone 截图保存于本地，标记为未完成素材，没有上传为最终截图。临时审核登录文件与 UI 操作内存中的密码副本已清理，现有 ASC 审核账号不变。
