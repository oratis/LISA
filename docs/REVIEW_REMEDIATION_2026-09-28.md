# Lisa Pocket 拒审修复与送审核对

> 后续状态：10 月 5 日 Apple 再次拒绝旧包 1790567703；本次修复与新构建 1791346539 的真实状态见 [2026-10-07 审查与送审记录](REVIEW_2026-10-07.md)。下文保留原日期的历史证据。

日期：2026-09-28。本文补充 [执行记录](EXECUTION_PERSONAL_ASSISTANT_2026-09-27.md)，将本次实际拒审与历史问题区分。

**当前状态：已正式重新提交。** 北京时间 2026-09-28 12:25:57，Apple 接受 iOS **1.2 (1790567703)** 与三个内购项目；版本、review submission 和三个 IAP 均读回 **WAITING_FOR_REVIEW**。保留审核通过后自动发布（**AFTER_APPROVAL**）。这是进入审核队列的回执，尚未获批或在商店上架。

> 后续主动自检发现的账号生命周期与内购反馈修复见 [全面自检](REVIEW_SELF_AUDIT_2026-09-28.md)。本文的已提交 build 仍为上一轮构建，不能据此认定后续代码已送审。

## 核实的拒审原因

已通过登录后的 App Store Connect 读取提交 `1f0010d4-7318-44c7-b292-90ac1d8eb248` 的反馈：9 月 9 日提交、9 月 11 日审核（后台显示北京时间 9 月 12 日），设备 iPhone 17 Pro Max，被审核的构建为 **1.2 (1788854713)**。当前版本后来绑定的新构建不能被误认为本次被拒的构建。

Apple 引用 **5.1.1(i)、5.1.2(i)**：在向第三方 AI 发送个人信息前，明确说明数据种类、接收者并取得同意；隐私政策还需说明收集方式、用途，并确认受托第三方提供同等保护。仅链接条款或隐私政策不足。三个消耗型 IAP 因关联 App 被拒而退回，反馈没有指出独立的支付故障。

## 已实施的修复

- 聊天发送前显示当前服务器实际 AI 接收方及消息、相关历史、记忆、工具结果；取消保留草稿。
- 增加 18+ 自我确认；未确认时允许发送按钮不可用。同意只保存在本次应用会话，绑定服务器、账号凭据和接收方。切换连接、账号或提供商后重新询问。
- Settings 中增加 Withdraw AI consent；撤回使已授权状态失效并停止当前聊天请求。撤回代际标识同时阻止尚未完成的提供商查询恢复发送；Retry 也走同意检查。已送出的信息不能召回，独立 Mac 自动任务须在对应服务器管理。
- 英文和中文隐私页明确 Google Gemini、付费 API、第三方同等保护、有限保留、账号删除、运行日志和成年人使用要求。按用户授权复用的 Google API key 所属项目已用官方 API 验证 `billingEnabled: true`；不在文档、日志或仓库记录密钥。
- ASC 已发布七类隐私标签：邮箱、用户 ID、购买历史、电子邮件或短信、其他用户内容、其他使用数据、其他诊断数据。均与账号关联、用于 App 功能、不追踪；两类用户内容另用于个性化回复。应用 manifest 同步。
- ASC 年龄分级已保存 18+ 覆盖；旧 OS 由 Apple 映射为 17+。开放式写作可能涉及的偶发非露骨成人主题、冲突和生活建议已在问卷中披露，没有声明儿童、社交、广告或赌博功能。

## 验证与当前状态

- 最终源码 `316c35ff4697758a5c263211ebfe2304820958ea` 在专用 iPhone 17 Pro Max / iOS 26.5、iPad Pro 13-inch (M5) / iPadOS 26.5 上各通过 **68 XCTest，0 failures**。覆盖接收方/账号/服务器变更、18+ 前置条件和撤回时请求代际失效。
- 原生人工操作验证：首次 Cloud 入口、Apple/Google 按钮、审核账号密码登录、头像、历史恢复、真实流式回复、取消保留草稿、撤回后再次询问，以及 iPad 的 Cloud → My Mac → Cloud 返回原账号。没有把按钮显示写成 Apple/Google OAuth 交互登录已完成。
- [PR #395](https://github.com/oratis/LISA/pull/395) 已合并为 `b2749410d8ca3b2bba1c6f42c989114511033b0d`；[CI 36375530351](https://github.com/oratis/LISA/actions/runs/36375530351) 的 iOS、Node 22/24、coverage、audit、E2E、website 和独立 docs 检查通过。未改变的 macOS 按路径规则跳过。
- [签名上传 36375556510](https://github.com/oratis/LISA/actions/runs/36375556510) 成功；Apple 已将 **1.2 (1790567703)**、build ID `9e5063be-503d-4a9e-a730-a0e15580aea0` 处理为 **VALID**，并已绑定版本 1.2。保留 **AFTER_APPROVAL** 自动发布设置。较早的 1790567511 为中间构建，不是当前选择。
- 中英文 Astro 构建、预发布浏览器排版及正式域名核对通过。网站生产 100% 流量为 `lisa-web-00017-qip`，隐私页日期 2026-09-28；前一版本 `lisa-web-00015-ron` 可作回滚参考。临时 canary 标签已移除。
- 新的 en-US 商店素材为 iPhone 1290×2796、iPad 2064×2752，各五张，均来自相应原生模拟器。旧素材先备份，替换后核对 Apple 的 COMPLETE 状态、顺序与尺寸。截图原件、字体许可证、渲染配置、SHA-256 manifest、旧素材及后台证据保留在本机 `tmp/appstore-2026-09-28`，不含密码或访问令牌，不提交 Git。
- ASC 描述和审核说明已同步成年人要求、实际 AI 接收方、事前同意与撤回路径。七项隐私类别已发布，18+ 已保存。

## 正式重新提交与发行范围

- 用户在收到具体地区建议和沙盒验收缺口说明后，明确回复“同意你的意见，直接操作”。据此将发行范围从 175 个地区调整为 **168**，排除 **CHN（中国大陆）、HKG（香港）、MAC（澳门）、RUS（俄罗斯）、BLR（白俄罗斯）、MMR（缅甸）、AFG（阿富汗）**，并关闭自动新增地区。Apple API 读回上述七项 `available: false`、其他 168 项为 true，`availableInNewTerritories: false`；后台显示“168 个可用 / 7 个国家和地区未供应”。Apple 提示地区变更最长需 24 小时生效。
- 原 App 与三个随 App 退回的 IAP 标记为 resolved 后，通过官方 API 正式重新提交原 review submission `1f0010d4-7318-44c7-b292-90ac1d8eb248`。Apple 返回 `submittedDate: 2026-09-28T04:25:57.945Z`、`state: WAITING_FOR_REVIEW`。
- 随后读回 iOS 版本 `9865f871-42af-4453-894f-63fe41e464ea` 为 **WAITING_FOR_REVIEW**，选中 build `9e5063be-503d-4a9e-a730-a0e15580aea0` / **1790567703** 仍为 **VALID**，`releaseType: AFTER_APPROVAL`。Starter Credits、Plus Credits、Max Credits 三个 IAP 也均为 **WAITING_FOR_REVIEW**；登录后台的[提交详情](https://appstoreconnect.apple.com/apps/6784690058/distribution/reviewsubmissions/details/1f0010d4-7318-44c7-b292-90ac1d8eb248)显示四个项目“等待审核”。
- 本机 `tmp/appstore-2026-09-28/evidence/` 留存 `availability-168.png`、`asc-waiting-for-review.png` 与不含凭据的 `submission-final.json`。没有改变 Apple 芯片 Mac / Vision Pro 的供应选项、分发方式、价格或现有审核账号。

## 验收边界与后续工作

- 未绑定本地 StoreKit 测试配置的临时签名模拟器访问商品时显示可重试的加载失败。因此**没有完成真实 App Store sandbox 购买及服务器到账验收**；本地 StoreKit fixture 或后端 receipt 单测均不能替代。审核账号 sandbox allowlist 已存在，三个商品因关联 App 被拒而退回的审核项已随 App 重新提交。无购买成功、收费或到账的虚构记录。
- 用户已知晓真实 StoreKit sandbox 验收缺口并批准继续送审；此次送审不改变该项未完成的事实。Apple 后续审核结果仍待返回，不能将队列状态解释为支付验收成功或审核通过。若恢复上述七个市场，须先验证可覆盖目标地区的提供商；现有 GLM 凭据余额不足，不能作为已验证替代方案。
- 推送真机验收、实际 Apple/Google OAuth 登录及更完整的云任务/连接器等后续产品工程，仍按[计划](PLAN_PERSONAL_ASSISTANT_2026-09-27.md)区分，不声称所有能力都已实现。

## 政策依据

- [Apple Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)：5.1.1/5.1.2，同意、隐私披露和撤回。
- [Apple App Privacy](https://developer.apple.com/app-store/app-privacy-details/)：收集类别、用途、关联和追踪定义。
- [Gemini API 条款](https://ai.google.dev/gemini-api/terms)：2026-03-23 生效版本，18+、已启用计费项目的付费处理规则。
- [Google 数据处理附录](https://business.safety.google/processorterms/)：受托处理、保密、安全和适用删除义务。没有声称任意用户自托管提供商都受 LISA 的托管协议覆盖。
- [Gemini 支持地区](https://ai.google.dev/gemini-api/docs/available-regions)：与 ASC 原 175 个已选地区逐项核对后，经用户明确批准排除七个地区并关闭自动新增。
