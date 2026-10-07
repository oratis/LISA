# Lisa Pocket 送审前全面自检

> 后续状态：10 月 5 日 Apple 再次拒绝旧包 1790567703；本次修复与新构建 1791346539 的真实状态见 [2026-10-07 审查与送审记录](REVIEW_2026-10-07.md)。下文保留原日期的历史证据。

日期：2026-09-28。基线为 `8a5a8f2`（PR #397）。目标是减少本次审核的实际失败点；测试通过不等于 Apple 已批准。

本轮开始时，App Store Connect 的 1.2 (1790567703)、review submission 与三个内购均为 **WAITING_FOR_REVIEW**，发行方式为 **AFTER_APPROVAL**。该构建包含上一轮 AI 告知整改，**尚未包含本文新增修复**。最新发布和送审证据记录在本文末尾。

## 审核依据与范围

实际最近拒审为 5.1.1(i) / 5.1.2(i)：第三方 AI 的数据范围、接收者、事前同意和同等隐私保护。历史还出现过品牌、登录及内购入口问题。本轮从首次启动、云端登录、Mac 连接、AI 同意、聊天、账号生命周期、StoreKit、隐私披露及后台送审资料逐项核查。

依据：

- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Offering account deletion in your app](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
- [TN3194: Handling account deletions and revoking tokens for Sign in with Apple](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple)
- [Revoke tokens](https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens)
- [用户停止使用 Apple 登录的官方说明](https://support.apple.com/en-us/102571)

## 本轮发现并修复的问题

| 风险 | 原有行为 | 修复和证据 |
| --- | --- | --- |
| 删除后旧登录会话复活 | Apple / Google 的 uid 由第三方 subject 决定；删除再注册可回到相同 uid 与 sessionVersion | 新账户使用随机 uid，独立保存 subject；现有账号原地兼容迁移。回归覆盖删除再注册后旧 token 不能恢复、旧 Apple 账号迁移 |
| Apple 授权未撤销 | iOS 只上传 identity token；删除 Lisa 数据时无法调用 Apple revoke | iOS 同时上传 authorization code；后端验证 Apple 返回的身份与 nonce，AES-GCM 加密保存账号和 client ID 绑定的 refresh token；删除前调用 revoke。私钥需独立配置，禁止使用 ASC 上传密钥代替 |
| 早期 Apple 账号没有授权令牌 | 服务端缺少历史 token，不能承诺自动撤销 | 按 TN3194 仍删除 Lisa 数据，并返回明确的手动解除关联说明；原生 App 显示 Apple 官方入口，不伪称已完成自动撤销 |
| 删除失败却显示成功 | 文件清理异常曾被忽略，先删除账号会丢失重试凭据 | 清理或 Apple revoke 失败返回 503，保留账号以便重试；客户端仅在成功后退出。真实 HTTP 测试覆盖两种失败及重试 |
| 删除后并发写回数据 | 正在运行的聊天、初始化、后台云任务可能晚于删除完成 | 禁止新增该账号请求，终止活动响应并等待处理器结束；后台 sweep 参与同一等待机制并重新确认账号仍存在；超过等待上限报告失败而非假成功；只关闭该租户 SSE |
| 读取页面即开始 AI 推理 | 任意账号请求曾触发 soul 初始化，包括 Settings / 历史 / 删除 | 延迟到用户实际发送聊天消息后执行；读取账号信息的 HTTP 测试确认没有模型请求及新增 soul 数据 |
| Apple 外部撤销后仍保留原生登录 | App 未检查系统授权状态 | 启动、回到前台和 credentialRevokedNotification 时检查；撤销只清除对应 Cloud 连接，不影响 Mac 或切换后的账号 |
| 内购失败反馈不完整 | 无法验证的交易及恢复失败可能无提示，恢复可重复发起 | 明确提示验证失败、恢复失败；购买与恢复共享 busy 保护；未到账交易不 finish，可再次投递；恢复文案说明消耗型余额保存在 Lisa 账号，不重复生成额度 |

Apple 授权令牌不会出现在 `/api/auth/me`、日志或文档。使用现有持久会话 secret 进行独立用途的密钥派生，AES-GCM 的附加认证数据绑定 uid / client ID，复制到其他账号或 App ID 会失败。新密钥仅应启用 Lisa Pocket 的 Sign in with Apple。

生产仍使用单实例文件账户存储。删除等待机制按这一部署边界实现；切换为多实例前需增加跨实例生命周期协调，不能仅放开 Cloud Run 实例数。

## 验证矩阵

| 项目 | 本轮结果 | 验证边界 |
| --- | --- | --- |
| 后端全量测试 | 2072 项：2071 passed、1 skipped、0 failed | 包括实际 HTTP 账号删除、Apple JWT/code 交换身份一致性、加密、重注册、tenant SSE、sweep 删除协调 |
| TypeScript / 浏览器类型 / API 契约 | 通过 | API 契约检查与主构建通过 |
| ESLint | 0 errors、70 warnings | 未将仓库既有 warning 写成零警告 |
| iPhone 原生测试 | 71 XCTest，0 failures | iPhone 17 Pro Max / iOS 26.5 专用模拟器 |
| iPad 原生测试 | 71 XCTest，0 failures | iPad Pro 13-inch (M5) / iPadOS 26.5 专用模拟器 |
| 新增原生生命周期测试 | 3 项通过 | Apple code 请求体、删除返回 follow-up、失败响应保留重试能力 |
| 隐私页 | 中英文 Astro 构建通过 | 补充授权令牌加密保存、删除撤销及早期账号说明 |
| 内购商品 | 模拟器界面显示 Starter / Plus / Max 与 $4.99 / $9.99 / $19.99 | 开发 scheme 带 StoreKit fixture，仅记为界面验证；ASC 商品配置与 review screenshot COMPLETE 已核实，真实商店加载仍需 TestFlight |
| 恢复购买取消 | Apple 账号提示出现；取消后明确提示失败，按钮恢复 | 未输入 Apple 密码，未发生真实付款 |
| 审核账号 | 已登录，账户、免费额度及 $20 余额可见 | 保留审核账号，未删除其数据 |
| Cloud ↔ Mac | 专用模拟器连接隔离的本机服务；真实 Gemini 回复 21+22=43；切回 Cloud 后原账号及历史恢复 | 本地目录不含用户原有资料；本地测试消息未混入 Cloud 历史 |
| AI 同意与撤回 | 前轮已人工验证；本轮原生单测继续覆盖 | 取消保留草稿、18+、接收方/连接变化、撤回与发送竞态 |
| 真机 Apple / Google OAuth | 尚未完成交互验收 | 按钮显示、协议测试不能替代真实身份提供商登录 |
| 真机 Sandbox 内购到账 | 尚未完成 | 商品可见、收据测试不能替代 Apple sandbox 付款 → 服务端到账 → 重投不重复充值 |

## 送审资料复核

- 版本、bundle ID、内购 product ID 一致；三项为 consumable，随 App 一起等待审核。
- 审核入口无需 Mac、邮箱验证码或先购买：Continue with LISA Cloud → Use a password instead，使用 ASC 保管的专用审核凭据。
- 截图仍是当前原生界面，iPhone / iPad 各五张；没有使用网页冒充原生 App。
- AI 告知明确 Google Gemini、消息、相关历史、记忆及工具结果；云端使用已验证开启计费的 Gemini 项目。
- 隐私标签、manifest、英文/中文政策覆盖账号、用户内容、购买、使用及诊断信息，声明不追踪；18+ 问卷已保存。
- 发行范围维持已批准的 168 个地区，关闭自动新增地区；不在本轮改变售价或扩大发行范围。
- 已通过 ASC API 把三个 IAP 的历史审核备注统一改为准确的登录、购买入口、余额检查和消耗型恢复说明，移除未复验的支付完成声称；逐项读回相同文本，状态仍为 WAITING_FOR_REVIEW。
- 审核通过后自动发布可以保留；正式批准结果由 Apple 决定。

## 待完成的上线条件

1. **配置 Lisa 专用 Apple 登录密钥。** Apple Developer 页面已准备好 `Lisa SignIn Revocation`，仅关联 `ai.meetlisa.main`，尚未点击 Register。已向用户询问是否创建并存入 LISA 的 Google Secret Manager。创建凭据属于浏览器工具明确要求操作时确认的事项，不视为测试通过即可跳过。
2. **真机验收。** 已发现配对的 iPhone，尚未获准安装本轮测试构建。需要实际 Apple 登录与 sandbox 内购到账；用户自行处理 Apple 登录或购买确认。
3. **更换审核构建。** 代码与服务已发布，签名上传已成功。待 Apple 处理 VALID 并完成前述密钥与验收后，更换当前等待审核的包。不能把旧 build 的 WAITING_FOR_REVIEW 状态当成本轮修复已送审。

密钥、审核密码、会话 token 均不进入 Git。模拟器证据保存在本机 `tmp/review-self-audit-2026-09-28`。该目录不是公共文档链接目标。

## 发布及最终复核记录

- [PR #398](https://github.com/oratis/LISA/pull/398) 已合并，merge commit `c78f781d79154e08cd63aa8e19a23026e93b6dde`；实际验证与签名构建源码为 `fb2f74d14d5923278076055518eb8fb85b83c458`，与该合并结果的代码相同。
- [CI 36382412417](https://github.com/oratis/LISA/actions/runs/36382412417) 全部必跑项通过：iOS、Node 22/24、coverage、audit、E2E、website；独立 docs workflow 通过，未改动的 macOS 按路径规则跳过。
- Cloud Run 后端 **lisa-cloud-00030-lut**、网站 **lisa-web-00020-hev** 各承接 100% 流量。临时验证 tag 已移除；上一个后端 **lisa-cloud-00027-qal**、网站 **lisa-web-00017-qip** 保留作为回滚目标。
- 后端先在零流量地址，再在 `https://cloud.meetlisa.ai` 完成健康、实际审核账号登录、账号验证、额度、Google Gemini 接收方和真实 SSE 计算回复的检查；无 error 帧且收到 done。`https://meetlisa.ai/privacy`、中文隐私页及 support 均 HTTP 200，并读回新增条款。
- 发布后比较 Cloud Run 配置：环境变量、持久卷和运行服务账号均保持一致，min=max=1；**Apple revocation 私钥仍未配置**，不是已完成自动撤销的生产验收。
- [签名上传 36382628920](https://github.com/oratis/LISA/actions/runs/36382628920) 于北京时间 13:39:39 成功上传 **1.2 (1790573792)**。Apple 随后处理为 **VALID**，build ID `7bc17d8f-1573-494f-a77f-a40415063e3e`；尚未把它替换进审核队列。当前仍是 **1790567703 / WAITING_FOR_REVIEW**，保留 AFTER_APPROVAL。
- 完整验证证据在本机自检目录，未包含密码、私钥、session token 或原始收据。
