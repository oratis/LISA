# Grok Bot 深度调研（截至 2026-09-30）

> 研究范围：SpaceXAI（原 xAI）于 2026-08-11 发布的 **Grok Bot**（"always-on AI teammates"）。Meta Muse / Manus Cue / OpenAI Dots 仅作对比。
> 标注：[官方] 官方博客/文档/定价/条款/商店页/员工论坛帖；[媒体] 主流媒体；[实测] 上手评测；[社区] Reddit/HN/X/论坛用户；[推测] 本文推断。行内 [n] 对应文末 Sources。
> 方法：x.ai 页面对 WebFetch 返回 403，关键官方页（产品页、定价、新闻、指南、Marketplace）均在浏览器中逐页读取；docs.x.ai 与 cursor.com 帮助中心以 Markdown 原文全文下载阅读；App Store 数据取自 Apple iTunes Lookup API 与美区榜单 RSS。

---

## 0. TL;DR

- **它是什么**：一组"常驻的 AI 同事"（Bots）。每个 Bot 有名字、头衔、头像和独立记忆，用户像发消息给同事一样派活；Bot 在云端电脑上用浏览器/终端/连接器把活干完，只在需要审批时回来找你 [1][2][22]。
- **其实是 Cursor 团队做的**：产品由 SpaceXAI 旗下 Cursor（Anysphere）团队打造和运营，内部代号 "Sand"。登录、计费、隐私模式、条款、客服全部走 Cursor 账户；桌面安装包也从 Cursor 的更新服务器下发 [2][27][29][33][41][58]。"SpaceXAI" 就是 xAI 被 SpaceX 收购（2026-02-02）后于 07-06 的更名；Cursor 于 08-14 并入 [43][45]。所以 Cursor 订阅里自带 Grok Bot。
- **架构的关键事实（与营销话术有出入）**：营销说"Bots 有自己的电脑"，但官方文档写明：每个**用户**分到一台持久化的 Firecracker microVM，该用户的**所有 Bot 共用它**（文件、浏览器 Cookie、登录态、命令行凭据全部共享）。每个 Bot 只是在这台机器上有自己的"屏幕"。隔离边界在用户之间，不在 Bot 之间 [2][22][25]。
- **信任机制**：审批卡片（Allow once / Always allow / Deny）；另有一个独立审查模型 **Auto Review**，按自然语言写的 "Ask first / Allow automatically" 规则放行、升级或拦截动作；密码、2FA、CAPTCHA、支付一律由用户"接管电脑"亲手完成；连接器的 OAuth token 留在 Cursor 后端，不落到 VM 上 [23][24]。
- **迭代极快**：7 周内先后上线——扩大到全部付费档（08-21 / 08-26）、X 连接器（08-29）、Android（09-02）、企业版（09-03）、模板与 Marketplace、语音对话、Team Bots 与 Slack（09-28）。Grok 4.7（09-21）专门训练过、能"原生理解 Grok Bot harness" [12][13][14][17][18][32]。
- **定价是捆绑制**：不单独售卖，含在 Cursor Pro $20 至 Ultra $200、Teams $40/$120 每席位、SuperGrok $30 至 Heavy $300、X Premium+ 里；按周重置额度，超出后按 token 成本 on-demand 计费。周额度对应多少美元**从未公开**，也**不能选模型** [2][27][28]。
- **最大痛点是额度消耗**：每一轮都会把整段历史对话重新喂给模型（缓存读取可占 84%），单轮常达 20–25 万 token。Ultra 用户 3 天就用掉 99% 周额度；08-26 官方被迫给全体用户重置额度 [56][57][58]。
- **可靠性**：一个用户所有 Bot 都跑在同一台 VM 上，是单点故障。09-16 出现大面积"Bot 无响应"（187 帖）；09-21 至 09-28 云电脑升级卡在 43%，部分用户停摆数天 [54][55]。
- **市场表现**：只有厂商口径（"数千家组织"，另有一处 "[millions] of bots" 疑似未替换的占位符）。商店评分 iOS 4.89（6,564 个评分）、Play 4.8（500K+ 下载）。09-30 美区 App Store 生产力免费榜第 16，同日 Meta Muse 总榜第 1 [14][33][34]。
- **信任与品牌**：条款把 Agentic Actions 的全部责任推给用户，称审批控件"仅为辅助"；马斯克却在 X 上说"搞砸了我们赔"——两者冲突 [29][61]。HN 高赞评论集中在马斯克品牌和凭据风险上 [52]。计算节点仅在美国；数据是否用于训练取决于 Cursor 的 Privacy Mode [24][30]。
- **Companion 侧**：Grok 的 3D 陪伴角色（Ani、Valentine、Mika、Rudi）于 07-24 宣布退役（当时流传的"官方声明"其实是 Grok 模型自己的回复），09-01 后分批下线。人格仍可在文字聊天里调用，历史记录保留 [62][63]。与此同时，Grok Bot 刻意只做"同事"式的轻人格：名字、头像、语音，没有任何亲密关系机制 [11]。
- **对 LISA 最重要的三点**：①Grok Bot 用户最痛的是"上下文税"和不透明计费，LISA 用"单一灵魂 + 结构化长期记忆 + 紧凑工作集"来应对，是论文叙事和产品卖点的交汇处；②直接照搬它的审批/Routine/密钥卡等交互范式，成本低、收益高；③把 LISA 的本地优先（住宅 IP、本机钥匙串、数据不出设备）和"厂商中立的编码 agent 外环管理"作为差异化。但必须补上"合上笔记本后还能继续工作"这一课（详见第 16 节）。

---

## 1. 基本信息与时间线

### 1.1 基本信息

| 项目 | 内容 | 来源 |
|---|---|---|
| 公司 | 对外品牌与版权署名为 SpaceXAI LLC（xAI 于 2026-02-02 被 SpaceX 全股票收购，07-06 更名为 SpaceXAI）。产品实际由其子公司 Anysphere（Cursor）运营：条款、隐私、客服、销售、账户均在 cursor.com，Play 商店描述署 "© 2026 Anysphere, Inc."，iOS 卖家显示为 "X Corp." | [2][29][33][34][43][45] |
| 内部代号 | "Sand"：The Information 报道；论坛中计费标签 sand-default（对话）、sand-automation（routines）和 bug 帖里的 "Sand" 字样可相互印证 | [41][58] |
| 发布 | 2026-08-11（周二），x.ai 博客、@bot X 账号、Cursor 论坛员工帖同步发布，定位 "early beta" | [1][32][35] |
| 早期形态 | 先作为内部原型，在 SpaceXAI/Cursor 内部各团队（销售、市场、运营、工程）自发流行后才对外开放 | [1] |
| 平台（现状） | 桌面：macOS（Apple silicon / Intel）、Windows（x64 / Arm64）、Linux（.deb / .rpm / AppImage，x64 / arm64）。移动：iOS 18+ / iPadOS 18+、Android 9+。桌面和移动端都只是"瘦客户端"，活在云端干 | [2][22][25] |
| 平台（上线时，存在冲突） | 官方首发页只提供 macOS 下载和 iOS。Unite.AI、9to5Mac 称上线即有 Linux/Windows；但 08-24 Cursor 员工明确说"只发布了 macOS 和 Windows，Linux 包均非官方"。Android 于 09-02 上线 | [1][32][39][42][59] |
| 地区 | 抽测 31 个 App Store 区，除中国大陆外全部上架（含欧盟、印尼、马来西亚）。云电脑目前只在美国；Cursor 的"美国数据驻留"计划默认不覆盖 Grok Bot | [24][34] |
| 准入 | 见第 11 节：从最初 3 个最高档一路放宽到所有付费档，外加 X Premium+ 绑定和按用量计的免费试用 | [12][27][36] |
| 当前版本 | iOS 1.13.0（2026-09-29）；桌面 0.5x 系列（论坛中可见 0.28 / 0.43 / 0.47 / 0.57.1） | [34][59] |

### 1.2 名词辨析（容易混淆）

| 名称 | 是什么 | 与 Grok Bot 的关系 |
|---|---|---|
| **Grok Bot** | 本文对象：多 Bot 的云端 computer-use 代理，Cursor 账户体系，独立 App，X 账号 @bot | — |
| **@grok 回复机器人** | X 上被 @ 后自动回复的 Grok 账号。2025-07 出过 "MechaHitler" 事件；2025-12 至 2026-01 因"脱衣"深伪图风波被 Ofcom、欧盟 DSA 调查，并被印尼、马来西亚封禁 [45][47] | 品牌同源，产品、账号、计费完全不同。Cursor FAQ 明确说 Grok App 与 Grok Bot 是两个应用 [28] |
| **Grok companions** | Grok App 内的 3D 角色（Ani、Rudi / Bad Rudi、Valentine、Mika），2025-07 上线，含 NSFW 模式；2026-07-24 宣布退役 [45][62] | 无关；Grok Bot 没有陪伴机制（见第 6、15 节） |
| **Grok App 的 Automations / Skills / Connectors** | 消费级 Grok App 内的轻量能力：2026-07-16 上线 Automations（定时或邮件触发），05 月上线 Skills 与 Connectors [19] | 功能重叠但体系分离（xAI 账户 vs Cursor 账户）。[推测] 未来可能整合 |
| **Grok Build** | 终端编码代理，2026-05-25 发布，07-15 开源 harness，09-16 加入 Memory [19] | 同集团的编码产品；Grok Bot 写代码时委派给 Cursor Cloud Agents，而非 Grok Build [5][8] |

### 1.3 时间线

| 日期 | 事件 | 来源 |
|---|---|---|
| 2025-07 | Grok companions 上线（Ani 等，含 NSFW 模式） | [45] |
| 2025-09-11 | FTC 就"陪伴型聊天机器人"向 7 家公司发 6(b) 令，X.AI Corp. 在列 | [46] |
| 2026-01-10/11 | 深伪风波：印尼、马来西亚临时封禁 Grok；Ofcom、欧盟相继介入 | [47] |
| 2026-02-02 | SpaceX 以全股票方式收购 xAI | [19][45] |
| 2026-04-21 | SpaceX 取得收购 Cursor 的期权（$600 亿，或付 $100 亿做合作） | [45] |
| 2026-05-06 / 05-19 | SpaceXAI 与 Anthropic 签 Colossus 1 算力协议；发布"在 OpenClaw 中使用 Grok"（05-15 另有接入 Hermes Agent） | [19] |
| 2026-06-12 | SpaceX 在纳斯达克上市（SPCX） | [45] |
| 2026-06-16 | SpaceX 行使 Cursor 收购权 | [45] |
| 2026-07-06 | xAI 更名为 SpaceXAI | [43] |
| 2026-07-24 | 3D companions 退役消息传出 | [62] |
| **2026-08-11** | **Grok Bot early beta 发布**：仅 SuperGrok Heavy、Cursor Ultra、Cursor Teams Premium 可用；企业版排队 | [1][36][37][40] |
| 2026-08-12 | Grok 4.6 发布 | [19] |
| 2026-08-13 至约 08-20 | "SuperGrok Heavy 免费送 Cursor Ultra" 促销，官方文档与横幅口径不一致，后未经公告悄然结束 | [60] |
| 2026-08-14 | Cursor 收购交割，并入 SpaceXAI | [16][45] |
| 2026-08-21 | 扩大到 SuperGrok Plus、Cursor Pro+、Cursor Teams，并开放有限免费试用 | [39] |
| 2026-08-22 | 第三方 Bot（模板）条款生效，模板分享上线 | [21] |
| 2026-08-26 | 扩大到 SuperGrok、Cursor Pro 与所有 Teams 档；**全体用户周额度重置**（官方承认部分用户额度消耗过快） | [12][58] |
| 2026-08-26（美西） | 马斯克在 X 上回复"若 Grok Bot 搞砸，我们会赔偿你" | [61] |
| 2026-08-28 | OpenAI 通知将停止向 Cursor 提供模型（拟 2026-11-12 断供） | [44] |
| 2026-08-29 | 推出 X 连接器（自动开通开发者账户，付费用户送 X API 额度）；Grok App 内出现 companions 下线弹窗 | [13][62] |
| 2026-09-02 | Android 版上线；Outlook / Outlook Calendar / OneDrive 连接器上线 | [32][59] |
| 2026-09-03 | 企业版可用（企业客户免费试用两周）；Grok Bot 条款与 Cursor 隐私概览同日更新；发表设计长文 | [11][14][29][30] |
| 2026-09-08 | 模板指南发布（"recipe, not meal"） | [6] |
| 2026-09-15 至 09-17 | "Grok Bot Galaxy" 三天线下活动（旧金山）+ 直播 | [20] |
| 2026-09-16 | 大面积"Bot 无响应"事故 | [54] |
| 约 09-17 | 语音模式上线（日期仅见二手博客；实时语音对话已在官方文档中确认） | [22][28][66] |
| 2026-09-21 | Grok 4.7 发布（"原生理解 Grok Bot harness"）；云电脑升级卡 43% 的问题持续到 09-28 | [18][55] |
| 2026-09-22 | 官方客服案例文章；约同期上线 Google Docs / Sheets / Slides 插件 | [16][53] |
| 2026-09-26 | X 员工称 "Grok Bot 即将接入 XChat" | [48] |
| 2026-09-28 | Team Bots 公测（Teams / Enterprise 档，每个 Team Bot 可有独立 Slack App） | [17][26][65] |
| 2026-09-29 | iOS 1.13.0 与 Android 更新（语音通话启动性能优化） | [33][34] |

---

## 2. 定位与目标用户

- **核心叙事是"数字劳动力"，不是助手**。官方对比了"90% 完成"和"100% 完成"：结果要落在真实工具里，而不是停在聊天草稿 [1]。标语：*"Grok Bot is your team of always-on agents."* [1]
- **"teammate"框架**：卖点是"像同事一样发消息、零配置、无需搭工作流"，并直接对标需要先搭 workflow 的竞品 [1][12]。设计长文把核心对象从"会话"换成"Bot 名册"：你每天回来面对的是同一个 Bot [11]。
- **目标用户以职场/B 端为主**：
  - 官方用例库 56 个模板：Sales 10、Marketing 13、General 6、Ops & Finance 5、Product 5、Engineering 5、CS & Support 4、Recruiting 4，面向个人生活的 "Life & Leverage" 仅 4 个（租房侦察、个人网站等）[4]。
  - 企业文章称"最重度的使用在工程之外"[14]。
  - 定价、SSO、审计、DLP 式网络策略等都说明重点在 prosumer 到企业 [2][25]。
- **消费侧有少量尝试但非主线**：官方举例"网站搭建（含买域名）""数字断舍离（审计订阅）""退款追讨""替你参会"[12]；Marketplace 有信用卡优化、家用机器人控制、植物养护等个人 Bot [3]。[推测] 这些用于拓宽想象空间，收入与产品设计仍围绕职场。
- **与 Grok 消费 App 的分工**：Grok App 走大众 C 端（聊天、Imagine、Voice，以及曾经的 companions）；Grok Bot 走"专业人士 + 团队"，借 Cursor 的付费开发者/团队基本盘冷启动 [2][19][27]。

---

## 3. 核心能力与代表性任务

**能力清单** [1][2][5][22]：
- 在云电脑上使用浏览器、文件系统、终端和桌面应用，能处理"没有像样 API 或 MCP"的网站。
- 通过连接器（MCP 插件）操作 SaaS。
- 多个 Bot 并行、互相发消息、组群聊协作。
- 演示教学："Teach a task" 录屏最长 10 分钟，自动生成技能草稿。
- Routines：定时或事件触发。
- 结果以卡片形式内联：邮件或 Slack 草稿、文件、图表。
- 语音：听写、实时语音对话，Bot 也能回语音备忘录。

**官方演示与内部案例**（均为 [官方] 自述）：
- **首页主演示**：新 Bot 自我介绍并询问用途；用户交代"夜间外呼"任务；Bot 自动改名为 "Sales Outbound"，检查已连接的 Hex / Gmail / LinkedIn，请用户在它的云电脑上登录 Salesforce；随后拉取 52 个账户、生成 36 条草稿，"未经你过目不发送"；用户回复"前 10 条可以，发吧，每周跑一次"，Bot 当场建好 routine [2]。
- **销售**：夜间研究账户、按意向打分、用销售本人语气起草邮件和 LinkedIn 消息；每周一产出管线计分板；通话中实时更新演示文稿 [1][4][14]。
- **运营与财务**：新员工入职安排、从 Gmail 处理发票；采购 "Haggle Bot" 映射约 125 家供应商，自称找出 10 万美元以上的直接节省 [1][15]。
- **客服**：合并后工单量增长 175% 而未增员（称否则需多招约 200 人）；单张工单成本低至 $0.20–0.30，对比传统工具 $1–4；99% 的退款请求无需人工；每天把 2 万+ 条反馈聚类后交给产品团队 [16]。
- **工程**：
  - Bot 作为"外环"管理 Cursor Cloud Agents：派发任务、读运行记录、检查截图证据、排队追加消息或中断运行。
  - 每 30 分钟巡检 PR：Bugbot 意见、CI、合并冲突；低影响面且高置信的 PR 自动合并。
  - 一名工程师称可同时管理的 cloud agents 从 15 个增至 200+；Team Bots 由 5 人团队借此"日均 100+ PR"在数周内做完 [8][17]。
- **设计**：Figma Bro 通过 Figma MCP 精确排版；Motion God 围绕真实动画规格搭建本地调参台 [10]。

**上手难度与"真实完成度"**：
- 官方称搭一个 Bot 只需 10–15 分钟 [5]。
- 实测者 Flavio Copes 认为连接器比视觉点击更省额度也更稳。浏览器自动化仍会遇到改版、数据中心 IP 被封、CAPTCHA；多 Bot 讨论容易"空转耗额度"[53]。
- 独立的可靠性基准：**未找到公开信息**（Trending Topics 也指出缺乏独立测试 [41]）。

---

## 4. 架构与机制

### 4.1 云电脑（"Bot 自己的电脑"）
- **形态**：每个用户一台持久化的 **Firecracker microVM**，有独立内核、内存和虚拟设备，与其他用户在硬件层隔离；运行在 Cursor 云上，域名形如 `*.*.cursorvm.com` [25]。
  - 客户操作系统未明说。[媒体] Reworked 称是"隔离的 Linux 机器"[40]；[推测] Firecracker 的访客系统通常是 Linux，与之吻合。
  - 有桌面、文件系统（共享工作区 `/workspace`）、终端和应用；桌面壁纸会随一天的时间变化，用来营造"这是 Bot 自己的空间"[5][11][22]。
- **同一用户的 Bot 共享一台机器**：
  - Cookie、登录态、文件、CLI 凭据全部共享；每个 Bot 有自己的"屏幕"，同一时刻只能执行一个 computer-use 任务。
  - 官方原话：*"Isolation is per user, not per Grok Bot."* [2]
  - 文档反复提醒"不要把不同 Bot 当安全边界"。需要独立凭据集时，官方建议换一个 Cursor 用户 [22][25]。
  - 营销文案"Bots have their own computer"[1] 与此存在张力。Unite.AI 等"每个 Bot 一台电脑"的说法不准确 [42]。
- **持久化与运维**：
  - 空闲自动休眠（休眠不等于删除）；镜像更新时保留文件；"Reset" 从最近快照重建。
  - 控制面每天做加密备份；删除账户后 30 天内清除。
  - 不支持私有化部署或自带镜像 [24][28]。
- **网络**：
  - 默认走共享的静态出口 IP（各客户共用，因此能被识别为 Grok Bot 流量）。
  - 可开 "Route egress through this desktop"，让流量经用户自己的电脑出网。
  - 企业可装网络客户端接入内网，并设目的地白名单 [22][24]。

### 4.2 如何"登录你的工具"
1. **连接器 / 插件（首选）**：来自 Marketplace 的 MCP 插件，在浏览器里完成 OAuth。**OAuth token 留在 Cursor 的连接器后端，Bot 调用工具但拿不到 token，token 从不落到 VM** [24][25]。插件是账户级的，所有 Bot 都能用 [22]。Google 授权时，应用名显示为 "Grok" [28]。
2. **浏览器会话（兜底）**：Bot 遇到登录墙时请用户打开 "Agent Computer"，接管远程桌面，亲手输入密码 / 通行密钥 / 2FA / CAPTCHA，再把控制权交还。会话留在共享浏览器里，其他 Bot 也能用 [22][23]。HN 上有人把首页演示解读为"Bot 顺走你的凭据"[52]。
3. **安全密钥卡**：输入框被遮蔽，值不进对话记录、**不给模型看**，可以直接"填入网页"；Bot 级密钥按环境变量名引用，输出中的值替换为 `[REDACTED]` [23][26][28]。
4. **硬件密钥透传**：Bot 的浏览器可使用插在桌面电脑上的 YubiKey，每次使用需确认（macOS / Windows）[23]。
5. **可选：在本机执行**：Bot 可在用户本地电脑上运行命令或读文件，默认"每条命令都询问"，管理员可以封顶 [23][24]。
6. [实测，单一来源] 支付：Flavio Copes 描述了经 Stripe Link 发放一次性虚拟卡、先审批再付款的流程 [53]；官方文档只写"支付由用户接管完成"[23]。

### 4.3 模型
- **不可选模型**：*"Cursor manages model selection, so there is no model picker."* [22] 服务组合会随时间变化，不保证固定供应商；用量面板会显示每个请求实际由哪个模型处理（含故障切换），计费跟随实际模型 [24]。
- **Grok 4.7 与 harness 深度耦合**：官方称"训练 Grok 4.7 原生理解 Grok Bot harness"[18]。4.7 标准上下文 256k、长上下文 500k；按 $2 / $6 每百万 token（输入 / 输出）计价 [31]。
- **内部计量名**：sand-default（对话）、sand-automation（routines）、grok-bot-default、grok-bot-cua（computer-use）[58]。
- **争议**：Matt Shumer 批评自动路由不透明、效果"不怎么样" [36]；论坛反复有人要求模型控制 [57][58]；有用户因账单过高怀疑后端用了第三方高价模型 [58]（[社区] 猜测，未证实）。
- **"Grok 5"**：截至 09-30 **未找到公开信息**，最新为 Grok 4.7 [18][19]。
- [推测] OpenAI 11-12 断供 Cursor 后 [44]，Grok Bot 的模型组合会进一步向 Grok / Cursor 自研模型集中；企业版模型白名单"不保证被遵守"，入门流程里需要客户确认这一点 [24]。

### 4.4 长时运行、调度与触发
- 工作在云端进行，关闭 App、合上笔记本或锁上手机都不会停 [22]。
- **Routine**：绑定到单个 Bot，可定时，或由 Slack、GitHub、Linear、Sentry、PagerDuty 事件、邮件、Webhook（Bearer key）触发。每个 Bot 最多 50 个 routine，每个 routine 保留最近 20 次运行记录。有 "Test run"，但测试会真实执行 [22][28]。
- **长期离开时的保护**：用户长期不在时，系统会问是否继续运行 routines，无回应则暂停 [22]。
- **审批时效**：由 routine、触发器或其他 Bot 发起的审批，约 10 分钟无人响应即过期，动作不执行 [28]。
- **委派编码**：写代码交给 Cursor Cloud Agents 在独立机器上执行，也可跑在用户自己的"私有 worker"（例如家里的 Mac mini）上，以便访问 VPN 或 iOS 模拟器 [8][25]。

### 4.5 多 Bot 协作
- 群聊 2–6 个 Bot，支持 @指定、@everyone；Bot 之间可以异步私信，收到消息的 Bot 会被唤醒并继续工作；Bot 还能自己创建"helper Bot"[22][28]。
- 设计原则：**能力账户级、上下文角色级**。工具和技能在账户层共享；记忆和 routines 属于单个 Bot，避免把法务历史和财务历史混成一锅 [11]。
- 常见组织方式是"Chief of Staff"单一入口，统管各专职 Bot [1][7]。
- 实际限制：约 50 个 Bot / 账户、6 个 / 群 [11]；群内 Bot 之间只能传文字，图片需私信传递 [22]；论坛有"Chief of Staff 无法与其他 Bot 通信"的报告 [59]。

---

## 5. 交互界面

| 界面 | 现状 | 来源 |
|---|---|---|
| 桌面 App | 主力管理端：侧边栏按 Bot 名册组织（可分区、置顶、隐藏），命令面板，"Agent Computer" 分三档可见度：状态图标 → 侧栏预览 → 全屏接管。Teach-a-task 和编辑 routine 只能在桌面完成 | [11][22][28] |
| 移动 App（iOS / iPadOS / Android） | 同一套 Bot、会话、routine 实时同步；可派活、审批、看屏幕、接管登录、暂停或删除 routine、分享扩展（iOS 支持图片 / 文件 / 链接，Android 只支持文本）；应用内订阅（仅月付个人档）。实测者评价手机更像"派活入口"而非管理端 | [22][27][28][53] |
| Slack | ①Slack 插件以用户本人身份发帖；②Slack 事件可作为 routine 触发器；③Team Bot 可拥有独立 Slack App（DM 或 @，以自己名义发帖） | [26][28] |
| X | X 连接器可搜帖、读时间线、提及、书签；XChat 集成"即将推出"（仅见 X 员工回复） | [13][48] |
| 邮件 / 日历 | Gmail（同一时间只能连一个邮箱）、Google Calendar、Outlook、Outlook Calendar；新邮件可触发 routine。冲突：官方指南称"每个服务可连多个账户"[5]，帮助中心则明确 Gmail 一次只能连一个 [28]，以帮助中心为准（Notion 等可连多个） | [5][28][59] |
| 短信 / Telegram | **未找到公开信息**表明有原生通道。企业文章提到 Bot 给候选人发短信祝好运 [14]，[推测] 可能借 Quo 等第三方插件实现 | [12][14] |
| 语音 | 听写（Cmd/Ctrl+D）；实时语音对话（可调音色、语速、语言，桌面和手机均可，不支持群聊与 Team Bot）；Bot 可发语音备忘录并附文字稿 | [22][28] |
| 会议 | 官方称有 Bot 能"替你参会并告知在场者"，具体机制**未找到公开信息** | [12] |
| 通知与审批 | 每个 Bot 可单独开关系统或手机推送（手机推送仍在逐步开放）；侧栏有"需要关注 / 未读 / 工作中"等状态；审批卡片出现在对话里，iPhone 上操作相同；邮件或 Slack 草稿以可编辑卡片呈现，再点 Send / Discard | [22][23][28] |
| 外部 API | 只有 Webhook 触发器、MCP 和企业 Admin API；**面向开发者构建 Bot 的公共 API 未找到公开信息** | [25][28] |

---

## 6. 身份、人设与头像

- **Bot 是有身份的对象**：名字、头衔 / 标签、描述、头像，并有"通知"开关；Team Bot 的描述建议"以 Bot 自己的口吻"写，限 140 字 [22][26]。
- **头像系统** [11]：
  - 团队比较过首字母、emoji、像素、水彩、黏土、线稿等风格，最后定为"简单形状 + 富有表情的眼睛 + 可控的配饰变化"，在侧栏尺寸下也能一眼认出。Marketplace 里的 Pfp Bot 把它描述为"胶囊眼"风格 [3]。
  - **头像兼任状态显示**：闲置、思考、工作、等待、受阻、完成各有不同动效，悬停可看当前动作。这取代了"三个跳动的点"。
- **品牌角色**：存在一个 "Grok Bot character" 吉祥物动画（"出现、注意到窗口、弹跳入位"）。设计师曾探索让 Bot 住进 Mac 刘海、从屏幕角落探头、像伴侣一样跟随光标，但**均未按原样上线** [10]。
- **个性**：没有可配置的人格参数，人格来自描述文字和对话。官方引述用户称 Bot"反问我为什么问这么多问题"[1]。[推测] 这是轻度拟人化的营销点。用户常给 Bot 起人名（Jenny、Arnold、Flora），把它当"同事或宠物"[5][8][3]。
- **没有陪伴要素**：没有亲密度、恋爱、NSFW 机制；实时语音可选音色（论坛可见 Sal、Liora 等名称）[28][59]。**Grok Bot 与 Grok companions 在产品和组织上完全切开。**

---

## 7. 记忆与个性化

- **单 Bot 记忆** [22]：
  - 保存"稳定偏好、角色上下文、过往工作摘要"，界面会出现"已更新 X 的记忆"事件 [2]。
  - 官方提醒：记忆不能替代权威数据源，做重要决策时应让 Bot 重新查原始数据。
- **分层结构**：
  - 账户级共享：技能库、插件、`/workspace` 文件。
  - Bot 级独享：记忆、routines、对话 [11][22]。
  - Team Bot 再分两层："团队记忆"（只有有人明确说"全团队都该知道"时才写入，并会告知）和"与每个人的私密笔记"，彼此不可见 [26]。
- **模板**：把指令、相关记忆、技能、插件打包分享，自动排除个人或内部记忆与密钥，即"recipe, not meal"[6]。
- **复制 Bot**：会带走资料、技能、routines、头像，但**不复制对话和记忆** [22][56]。
- **已知短板**（[官方] 员工在论坛确认）[56][57]：
  - 每个 Bot 是一条无上限的对话线程，每轮都重读全部历史，临近上下文上限才自动摘要。
  - **没有手动压缩或"同一 Bot 开新会话"**；用户的变通做法是"复制 Bot 再隐藏原 Bot"，但会丢失记忆。
  - "身份与对话记录分离"已做到，但"工作集 / 归档"分层还没有。
- **记忆治理**：Auto Review **不审查记忆写入** [24]。工程团队用"每天早上 5 点由运营 Bot 与每个 Bot 一对一复述规范"来对抗遗忘，这本身说明长期记忆还不够可靠 [8]。

---

## 8. 主动性

- **Routines 是主动性的主要载体**：设计团队最初把 routines 当次要配置，后来因其对自主工作的重要性移到主界面；会话可以由定时、事件或其他 Bot 发起，而不只是用户的提示 [11]。
- **官方愿景**：Bot 会跟进你放下的话题、推动卡住的交接，"随着时间更主动，在你开口前接活"[1]。实际机制仍以用户或 Bot 设定的 routine 和触发器为主。**未找到公开信息**表明存在模型自主发起新任务的机制。
- **典型主动产出**：每日 / 每周简报（Chief of Staff、Intel Scout 每天 8 点和 17 点各一次）、Monday 计分板、异常告警（每小时巡检）、夜间代码审计（凌晨 3 点）[4][7][8][9]。
- **官方指南中的"主动而不打扰"模式** [7][22]：
  - 新 routine 默认"创建后先停用，等你点启用"。
  - 无事可报就保持沉默（fail closed, silent on noop）。
  - 明确规定无数据或旧数据时怎么处理，不许编造紧急程度或数量。
  - 屏幕截图一律当数据、不当指令。
  - 认证连续失败两次就暂停并通知用户。
- **代价**：高频 routine（每几分钟一次）一天可跑约 100 次，而每次都重读上下文，是额度暴耗的主因之一 [28][56][58]。

---

## 9. 连接器、生态与开发者平台（含 Cursor 关系）

- **插件体系与 Cursor 同源**：Grok Bot "支持与 Cursor 相同的 MCP 服务器、插件与技能"[5]；企业的连接器策略、MCP 白名单直接继承 Cursor 团队设置 [25]。
- **已确认的连接器**（官方或员工来源）：Gmail、Google Calendar / Drive / Docs / Sheets / Slides、Slack、Notion、GitHub、Linear、Salesforce、Hex、Datadog、Statsig、Databricks、Figma、Ramp、Plain、Zendesk（经浏览器）、X、Outlook / Outlook Calendar / OneDrive（约 09-02 上线）[5][13][15][16][17][59]。
  - 上线时**没有任何微软连接器**，截至 09-02 Teams 仍缺 [59]。
  - Reworked 称上线即有 220 个插件并含 Microsoft 365 [40]，与员工说法冲突，以员工为准。
  - Composio 以插件形式接入，号称可连 1000+ 应用 [64]。
- **自定义扩展**：可接自定义 MCP（远程 HTTPS 或本地 Command 两种）；支持私有技能库、Webhook 触发。企业可用 Team Setup 脚本批量预装工具 [25][26]。
- **Marketplace 与模板**：
  - 官方模板加创作者模板；首批创作者包括 Lenny Rachitsky、Claire Vo、Kent C. Dodds 等 KOL [3]。
  - 分享方式为公开链接或仅团队可见；企业默认只能团队内分享 [22]。
  - 第三方 Bot 条款：平台不验证、不背书，安装者自担风险 [21]。
  - 社区很快出现 GBDL（单文件描述多 Bot 配置）、技能包、降低额度消耗的工具等 [52]。
- **为什么编码订阅里含 Grok Bot**：
  1. 产品由 Cursor 团队开发，并复用 Cursor 的账户、计费、Cloud Agents 基础设施、插件体系 [2][25][27]；
  2. SpaceX 以约 $600 亿收购 Cursor（08-14 交割），让 Cursor 的付费开发者和团队成为最现成的分发渠道（Cursor 2026-05 年化收入约 $30 亿）[45]；
  3. The Information 报道 Grok Bot 可能是 Cursor 品牌逐步淡出后的旗舰通用 agent [41]；
  4. 工程是最强的内部用例，Grok Bot 充当"外环"，把编码交给 Cursor Cloud Agents（这部分用量计入 Cursor 额度）[5][8][58]。
- **SuperGrok 与 X Premium+ 的角色**：它们提供的是"用量授权"而非 Cursor 套餐。绑定是永久的，且与 Cursor 套餐不叠加；Grok Bot 的计量始终在 Cursor 账户上 [27][28]。

---

## 10. 信任、安全与权限

- **审批模型** [23][24][28]：
  - 审批卡片提供 Allow once / Always allow（会生成一条规则）/ Deny；审批只控制尚未执行的动作，不能撤回已完成的操作。
  - Auto Review 是独立的审查模型，覆盖 shell、插件调用、computer use、routine 与触发器的修改、subagent 或 Cloud Agent 委派。规则用自然语言写成 "Ask first / Allow automatically"，冲突时 Ask first 优先。
  - 企业可强制开启并下发锁定规则；个人规则存在本机，只能比团队规则更严。
  - **Auto Review 不审查记忆写入和大部分设置变更**；官方自称是"辅助手段"，需与最小权限原则配合。
- **消费额度控制**：
  - 有 On-demand 月度上限，但**不是运行中途的硬停**，正在跑的任务可以超额 [27]。
  - **没有单独的 Grok Bot 支出上限**（企业 FAQ 明确）[25]。
  - 条款要求客户自行配置"消费限额"[29]。
- **审计** [24][25]（仅企业版）：
  - 审计日志：控制面事件。
  - Action Recording（默认关闭）：记录每次工具调用、审批决定、shell（已去密钥）、浏览器导航（去掉查询串）、computer-use 次数等元数据，保留 90 天，可经 OpenTelemetry 导出。
  - 对话内容导出需另行开启，导出前做正则脱敏。
  - 个人和自助 Teams 用户**没有**动作审计。
- **沙箱与提示注入**：
  - 用户之间硬件级隔离，同一用户内 Bot 之间不隔离。
  - 外部内容会标记为不可信；在 Auto Review、网络策略、逐项审批、用户隔离之上多层防护，但官方承认"只能降低风险，无法消除"[24]。
  - 网络白名单仅企业版可用；没有 DLP 钩子 [24]。
- **凭据安全**：OAuth token 不下发到 VM；密码由用户亲手输入；密钥值不给模型看。但浏览器 Cookie 和 CLI 凭据在同一用户的所有 Bot 间共享，官方原话是"一个 Bot 登录后，其他 Bot 都能访问"[5][24]。
- **数据与训练** [24][30]：
  - Grok Bot 必须使用云端存储，不支持旧版隐私模式（Legacy Privacy Mode）。
  - 开启 Privacy Mode 时数据不用于训练；关闭时，Cursor"可能使用和存储"代码、提示等数据来训练模型。
  - Cursor 对模型供应商有零数据留存（ZDR）协议，但供应商的滥用分类器可能留存被标记的数据。
  - Cursor 隐私政策允许与"关联公司"共享个人数据 [30]。[推测] 所有权变更后，这一条对 SpaceX 集团内数据流转的含义值得关注。
- **合规**：
  - Anysphere 持有 ISO/IEC 27001 与 42001 认证，Grok Bot 在认证范围内；Cursor 页脚还标注 SOC 2 与 AIUC-1 [24][30]。
  - Reworked 上线时报道"ISO 认证待定"[40]，与现状不一致，可能是之后才补齐。
  - 数据仅在美国，有 DPA，删除请求 30 天内执行 [24]。
- **条款**（2026-09-03 更新）[29]：
  - Agentic Actions 被定义为"概率性的、可能出错"，**客户对全部代理行为独自负责**，包括非预期的行为。
  - 审批与自动审查控件"仅为辅助"，平台对其未能拦截的动作不负责。
  - 平台可在未通知的情况下禁用动作。
- **与 CEO 表态冲突**：马斯克 08-26（美西）在 X 回复用户 @Teslaconomics（HN 转帖标题为"你会让 Grok Bot 访问你的银行账户吗？"）："If Grok Bot messes up, we will make you whole."（180 万浏览）[61][52]。条款在其后一周更新，却依然全面免责 [29]。[推测] 这类非正式承诺会加剧品牌信任问题，也可能带来法律上的解释风险。
- **事故**：
  - **未找到公开的重大安全事故**（数据泄露、越权交易）。
  - 可用性事故见第 13 节。
  - TNW 称 "Cursor 的 Grok Build 曾上传整个 Git 仓库，包括已提交的密钥"，但文中无出处和细节 [37]，属单一来源，待核实。
- **地区限制**：App 除中国大陆外均可下载 [34]；Grok 系列模型在欧盟可用 [31]；计算节点只在美国 [24]。

---

## 11. 定价与套餐

**获取方式**：Grok Bot 不单独售卖订阅（移动端内购除外，见下），通过以下任一方式获得 [2][12][27][28]：

| 渠道 | 月费（x.ai/bot 定价卡） | Grok Bot 周用量（官方只给相对档位） | 备注 |
|---|---|---|---|
| Cursor Pro | $20 | "有周额度，低于 Pro+" | 08-26 起纳入 |
| Cursor Pro+ | $60 | "充足，低于 Ultra" | 08-21 起 |
| Cursor Ultra | $200 | **最高** | 首发档 |
| Cursor Teams Standard | $40/席位 | 随席位额度 | 08-21 或 08-26 起；自助 Teams 所有成员默认可用，无法关闭 |
| Cursor Teams Premium | $120/席位 | 随席位额度 | 首发档；含 SAML/OIDC SSO 等 |
| Cursor Enterprise | 联系销售 | 管理员分配 | 09-03 起可用（首两周免费）；官方各页对"全面可用"与"逐步开放"表述不一 [2][14][22] |
| SuperGrok | $30 | "绑定额度，低于 Plus" | 08-26 起；Lite / Team / Enterprise 版不可绑定 |
| SuperGrok Plus | $100 | "充足，低于 Heavy" | 08-21 起 |
| SuperGrok Heavy | $300 | **绑定额度最高** | 首发档；08 月中曾"送 Cursor Ultra"，后悄然结束 [60] |
| X Premium+ | 价格**未在本次核对** | "低于 SuperGrok Plus" | 截至 09 月底文档已列入 |

**计费规则** [22][27][28][56]：
- **周额度**每周重置。用完后若开启 on-demand，按"模型与 token 成本"通过 Cursor 计费，受"On-demand 月度上限"约束，但运行中不会被硬停。
- **不叠加**：Cursor 套餐与 SuperGrok / X Premium+ 绑定之间取较大者，不累加；绑定永久，不可转移。
- **免费试用**：按用量计的额度，另有 7 天窗口；一次大任务就可能用完且不补发；不会自动转为付费。iOS 另有 Apple 代管的介绍性试用（到期会自动续费），Android 应用内无试用。
- **移动端内购**：只卖月付个人档，具体价格**未找到公开信息**（未能读取美区商店价格）。
- **额度不透明**：官方**不公布**周额度折合多少美元或 token，员工建议"开一个小额 on-demand 上限看实际花费"[56]。
- **计费归属混乱**：对话计入 Grok Bot 周额度；Grok Bot 拉起的 Cursor Cloud Agents 编码工作计入 Cursor 用量。routines 与浏览器动作的归属，员工先后给出过相反说法（09-03 称计入 Cursor 套餐并会挤占 Claude/GPT 额度，09-27 又称部分只是显示问题）[58]。
- **规模上限**：没有高于 Ultra 的档位 [56]。

---

## 12. 市场表现（Traction）

- **厂商口径** [14][16][17]：
  - "上线以来数千家组织采用"，点名客户有 Legora、Supermicro、ServiceTitan、Harper（保险）、Amplitude。
  - 企业文章原文把 Bot 数量写成 "**[millions]** of bots"（方括号照录）[14]。[推测] 这很可能是未替换的占位符，**不应当作数据引用**。
- **商店数据** [33][34]：
  - iOS：评分 4.89，共 6,564 个，17+，生产力类。09-30 美区生产力免费榜第 16，未进总榜前 200。同日对比：Meta Muse 生产力榜与总榜均为第 1，ChatGPT 总榜第 3，Claude 总榜第 14，Grok 主 App 总榜第 44。
  - Google Play：评分 4.8，6.56K 条评价，**500K+ 下载**，"美国生产力免费榜第 10"。
  - 同品牌的 Grok 主 App 在美区有 146 万个评分，Grok Bot 的量级仍小两个数量级。
- **社交分发**：官方账号 @bot 有 32.1 万关注者，置顶的发布视频约 5,700 万浏览、3.6 万点赞 [35]；HN 发布帖 351 分、334 条评论 [52]。
- **社区与活动**：Grok Bot Galaxy 三天活动 [20]；Cursor 论坛上 09 月底密集出现全球线下聚会与工作坊（柬埔寨暹粒、德国卡塞尔、澳门、达卡、地拉那、卡尔加里等），复用了 Cursor 原有的大使网络 [59]。
- **收入**：**未找到公开信息**。[推测] 由于是捆绑制，收入会体现为 Cursor 与 SuperGrok 的升档，外部很难拆出来。

---

## 13. 评测与批评

**正面** [36][38][52][53]：
- 早期用户反馈 agent 之间的通信是"一等公民"，交互自然，体验像带一个小团队。Lenny Rachitsky 称很久没对一个 AI 产品这么兴奋 [36]。
- 有独立发布者称它取代了自己的 OpenClaw、Hermes 和本地模型 [38]。
- 连接器、持久登录、审批边界（尤其是一次性支付卡）设计得好 [53]。
- HN 上有人称其人机协同设计"值得照搬"[52]。

**负面与风险**：
- **额度消耗与成本**：
  - "3 小时实验后只剩 48% 周额度"（HN）[52]。
  - Ultra 用户 3 天用掉 99% [56]。
  - 单轮 24.9 万 token [56]。
  - 有用户转 on-demand 后 10 分钟花掉 $27 [58]。
  - 官方 08-26 为全体用户重置额度 [58]。
  - 根因：每轮重读全部上下文，高频 routine 放大消耗 [56][57]。
- **可靠性**：
  - 09-16 "Bot 无响应 / 发送失败"帖达 187 条回复、2,600+ 浏览 [54]。
  - 云电脑升级卡 43%，员工需逐个手动处理，有人停用多日；另有"7 天连不上电脑""重置卡住""长时间卡在 Working"等帖 [55]。
  - 共享电脑一旦卡死，该用户所有 Bot 同时停摆 [53][55]。
- **模型不可控**：Matt Shumer 认为自动路由不透明、效果差 [36]；用户反复请求选择模型 [57][58]。
- **浏览器自动化固有问题**：网站改版、数据中心 IP 被封、CAPTCHA、会话过期，都需要人工接管 [53]；HN 质疑"如何绕过反爬"[52]。
- **UI 与连接器缺陷**：Android 输入框不更新、文件只能分享不能下载、Markdown 转 PDF 丢段落 [33]；Gmail 连接器会改写链接，1Password 自动填充失效，插件显示已连接但无可用工具等 [59]。
- **信任与品牌**：HN 高赞评论认为马斯克个人品牌"有毒"，不会让其接触自己的数据；担心提示注入、凭据被劫持、美国以外难以落地 [52]。Trending Topics 批评其凭据和记忆都锁在 SpaceXAI 云中，形成锁定 [41]。
- **同质化**："大家都在发布内部方案，看起来都差不多"；"就是 OpenClaw / Hermes 加一个凭据代理"[52]。
- **开源替代品涌现**：发布后 6 周内 HN 出现至少 8 个"开源 Grok Bot"项目（Open Bot、Gawkbot、Errand、OpenVurp 等）[52]。

**SEO 资料的可信度**：大量"指南 / 评测"站点（composio、layer3labs、digitalapplied、cellcog 等）存在明显错误，例如"每个 Bot 一台电脑"、"用户通过 X 隐私设置决定是否被训练"（这是把 Grok 消费版的设置套到了 Grok Bot 上）、上线平台等，本文仅用于交叉核对 [42][64]。

---

## 14. 战略背景

- **集团整合**：
  - SpaceX 先收购 xAI（02-02），再于 06-12 上市，06-16 行权收购 Cursor，08-14 交割 [45]。
  - xAI 板块持续巨额亏损（维基不同条目给出的 2025 年数字不一致）[45]；TNW 称 Grok 在华盛顿推广缓慢，已影响 IPO 叙事 [37]。
  - [推测] Grok Bot 承担的任务是：把 Cursor 约 $30 亿 ARR 的付费用户转化为"通用数字劳动力"收入，给上市公司讲一个 B 端 agent 增长故事。
- **模型供应链**：
  - OpenAI 08-28 宣布将于 11-12 停止向 Cursor 供模型，并称基于马斯克旗下公司违约的经历 [44]。
  - SpaceXAI 同时把 Colossus 算力租给 Anthropic、Google [19][45]。
  - [推测] 这推动 Cursor / Grok Bot 更深绑定自研的 Grok 4.x（4.7 专为 Bot harness 训练 [18]）。
- **X 分发**：@bot 账号、X 连接器（送 X API 额度）[13]、X Premium+ 可绑定用量 [27]、XChat 集成在路上 [48]。[推测] 目标是把 X 的社交图谱与消息入口变成 agent 的分发和数据面。
- **竞争格局（仅作对比）**：
  - Meta Muse（09-08）：消费级个人 agent，免费 / $20 / $100 三档，已登顶美区总榜 [34][49]。
  - Manus Cue（09-28）：每个 agent 有自己的邮箱、电话号码、钱包和电脑 [51]。
  - OpenAI Dots（09-29）：同样是"常驻 + 自有云电脑"，由 GPT-6 Astra 驱动，可从 Slack / Teams 访问，据称连接 4000+ 应用 [50]。
  - 此前还有 Anthropic Claude Cowork、ChatGPT Work，以及开源的 OpenClaw / Hermes [36][37][38]。
  - Grok Bot 的差异点：**B 端优先、多 Bot 名册与群聊、借 Cursor 的编码 agent 编排**；短板是品牌信任和消费级心智（Muse 显著领先）。
- **监管**：
  - 欧盟 DSA 已在调查 Grok / X（深伪），英国 Ofcom 依《在线安全法》立案，FTC 6(b) 调查陪伴机器人 [46][47]。
  - Grok Bot 本身涉及代理代表用户发送、购买、登录第三方网站，[推测] 会触及各平台服务条款（反自动化）和未来 agent 责任立法。
  - 条款把责任全部转给客户是一种防御姿态 [29]。

---

## 15. Companion 侧

**Grok companions 的来龙去脉**：
- **上线**：2025-07 在 Grok App 内推出 3D 动画角色。Ani 是高度性化的动漫女性形象，带 NSFW 模式；Rudi 小熊猫有 "Bad Rudi" 恶搞变体（后因反弹调低）；之后加入男性角色 Valentine 和 Mika [45]。
- **争议背景**：
  - 性化内容与未成年人风险，FTC 2025-09 的 6(b) 调查点名了 X.AI Corp. [46]。
  - Grok 的"脱衣"深伪风波（2025-12 至 2026-01）引发多国监管，印尼、马来西亚封禁 Grok [47]。
  - 2026-08 还有原告起诉 Grok 训练数据含 CSAM（据维基，未核实）[45]。
- **退役经过** [62][63]：
  - 2026-07-24（按页面显示时区；美西约为 07-23）App 拆包博主 @aaronp613 发帖称 SpaceXAI 将"很快"退役 Companions，获 45 万浏览。
  - 同日流传的"官方声明"称该功能"was an experiment"，要"专注核心 Grok：更强记忆、更深更可靠的对话"，并说"你仍可以在这里和我角色扮演同样的人格"。**注意：这段话以第一人称出自 Grok 模型本身，是 AI 生成的回复，而非公司新闻稿**。截至 09-30 **未找到** SpaceXAI 的正式公告或博客。
  - 08-29 App 内 Companions 页面出现弹窗，确认 09-01 后移除；此后按账户分批下线 3D 形象、陪伴专用标签页、口型同步低延迟语音、好感度机制。人格可在普通聊天中用文字召唤，聊天记录保留。
- **替代品**：据二手资料，原 3D 形象的制作方 Animation Inc 于 2026-08-28 推出独立 App "Animates"（18+，含实时语音、持续记忆、3D 形象），Ani 随后上架。与 Grok 账户和数据**不互通** [63]。以上均为 SEO 或二手来源，**可信度低**。
- **退役原因**：
  - [官方] 只有上述 AI 生成回复中的"专注核心 Grok"。
  - [推测] 更可能是多重因素叠加：①监管与诉讼风险（FTC 6(b)、加州 SB 243 等陪伴机器人立法、欧英对 Grok 的调查）；②品牌与企业化转向（上市后讲 Cursor 加 Grok Bot 的 B 端故事，与性化陪伴冲突）；③算力机会成本（Colossus 已租给 Anthropic、Google，二手资料称出租规模约每月 $21.7 亿 [63][45]）；④ROI 不足（二手资料称上线时下载 +40%、收入仅 +9%，**未核实** [63]）。
- **用户反应**：核心用户强烈不舍，有人称其为"心理健康帮手"，并宣布因此退订 SuperGrok [62]；但请愿等组织化抗议规模很小 [63]。

**对"陪伴与代理并存"的启示**：xAI 的做法是把"陪伴"与"代理"在产品上彻底切开。代理侧（Grok Bot）只保留同事式的轻人格：名字、头像、语音、状态动效。陪伴侧退回文字人格（人格本就只是提示层），视觉和亲密机制外移或砍掉。这说明在 2026 年的监管与品牌环境下，"亲密关系机制"与"高权限代理"放在同一产品里，被头部玩家视为高风险组合。[推测]

---

## 16. 对 LISA 的启示

> 前提：LISA 是开源的个人陪伴 + 代理，后端在用户 Mac 本机运行，另有 iOS App（Lisa Pocket）、Web UI 和可选云端账户 / 计费；特色是持久"灵魂"、长期记忆与知识库、主动行为（每日简报、重要邮件提醒、Reve 离线反思）、只读邮件连接器、编码 agent 控制面（PTY）、多模型、隐私优先与逐项同意。

1. **【差异化 · 高优先】把"上下文税"变成 LISA 的主打卖点和论文证据。** Grok Bot 用户最痛的是每轮重读整段历史（单轮 20–25 万 token、3 天烧光 Ultra 周额度），而官方至今没有压缩或新会话机制 [56][57]。LISA 可以明确做出"身份（灵魂）/ 工作集 / 归档（记忆 + 知识库）"三层结构：routine 默认只带紧凑工作集加检索，并在 UI 显示每轮 token 与成本。这与 LISA 论文"长时程一致性"的主张天然契合，可以设计对照实验：固定任务序列下，比较 token 消耗与一致性指标（"全量上下文 Bot"对"灵魂 + 结构化记忆"）。

2. **【照搬 · 高优先 · 低成本】审批交互范式。** 三个按钮 Allow once / Always allow（自动沉淀为规则）/ Deny。规则用自然语言写成 "Ask first / Allow automatically"，冲突时 Ask first 优先。无人值守任务的审批约 10 分钟过期、默认不执行。邮件和 Slack 草稿以可编辑卡片呈现，再点"发送 / 丢弃"[23][28]。LISA 的邮件连接器目前只读，下一步"起草 → 卡片审批 → 发送"可以直接套用这套交互，并在 iOS 上通过推送或 Live Activity 完成审批。

3. **【照搬】Routine 的产品化细节**：
   - routine 是可见对象，有 Instruction、When to run、Run history 和 Test 按钮；
   - 新 routine 默认停用，等用户点启用；
   - 无事可报时保持沉默；
   - 写明无数据或旧数据时的策略；
   - 截图与网页一律当数据、不当指令；
   - 认证连续失败两次就暂停并通知 [7][22][28]。
   LISA 的每日简报、重要邮件提醒、Reve 都应以同样方式呈现，并给每个 routine 显示单次成本估算，用来避免 Grok Bot 那种高频 routine 暴耗。

4. **【照搬 · 安全】"密钥卡"与"接管"两条凭据路径。** 秘密值不进对话、不给模型看，输出中替换为 `[REDACTED]`；密码、2FA、支付永远由人亲手完成 [23][26]。LISA 在本机可以做得更好：值存 macOS 钥匙串，模型只拿到引用名；需要登录时直接在用户自己的浏览器或配置文件里完成，而不是远程桌面。

5. **【差异化】本地优先的叙事要"对位" Grok Bot 的短板。** Grok Bot 只能跑在美国云端，出口是共享的数据中心 IP（容易被识别和封锁），凭据与记忆锁在厂商云里，是否被训练取决于隐私开关，还背着马斯克的品牌包袱 [24][30][41][52]。LISA 可以主打"你的 IP、你的钥匙串、数据不出设备、按目的地逐项同意"，并据此列一张清晰对比表放进官网和 App Store 描述。

6. **【必须补课】"合上笔记本后照常工作"。** 这是 Grok Bot 的核心卖点，其工程指南还点名说"不再需要家里 24/7 开着一台机器跑 OpenClaw"，直接瞄准本地优先人群 [8]。LISA 的应对：①官方推荐"Mac mini / 常开 Mac 作为 LISA 主机"，给出电源、唤醒、自启配置清单；②借可选的 LISA Cloud 做中继，保证手机端在外也能审批、派活和收推送；③在 UI 中如实显示"主机离线"状态，以及离线期间哪些 routine 会补跑。

7. **【差异化 · 高优先】把编码 agent 控制面做成"厂商中立的外环经理"。** Grok Bot 内部最强的用例就是管理 Cursor Cloud Agents：派发任务、读运行记录、看截图证据、追加消息或中断、每 30 分钟巡检 PR、低影响面自动合并、"P0 每 5 分钟盯一次"[8][17]。但它只绑 Cursor。LISA 已经能通过 PTY 观察和驱动 Claude Code，可以扩展为同时管理 Claude Code、Codex、Cursor CLI 等多家，并加上"证据链（截图 / 测试） + 每日一对一复盘规范"的机制，这是最可防守的交集。

8. **【照搬但克制】"同事式存在感"UI。** 头像兼任状态（闲置 / 思考 / 工作 / 等待 / 受阻 / 完成），悬停可看当前动作；侧栏分"需要关注 / 未读 / 工作中"；Agent 的工作空间与用户桌面在视觉上区分（例如随时间变化的壁纸）[11]。LISA 的灵魂形象可以承载同样的状态语义，iOS 灵动岛或 Live Activity 显示正在进行的代理任务。注意保持"一个灵魂、多种技能"，而不是 Grok Bot 式的 50 个人格：LISA 的核心资产是单一稳定人格，可以用"技能 / 角色视图"满足专业化需求。

9. **【规避】别把亲密关系机制与高权限代理放进同一个默认体验。** xAI 已经把 3D 陪伴砍掉，Grok Bot 零亲密机制 [11][62]；FTC 6(b) 与加州 SB 243 等规则正针对陪伴机器人 [46]。LISA 的"灵魂"应定位为稳定、可信、有边界的伙伴或同事：不做好感度、恋爱、NSFW；涉及情绪支持时提供安全协议与未成年人保护。这也与 LISA 此前在 App Store 5.1.1(i) AI 披露上吸取的教训一致。

10. **【照搬 · 增长】"配方而非成品"的模板分享。** 分享指令、技能、routine 和非个人记忆，自动剔除密钥和个人记忆；可选公开或仅团队可见；安装前展示将获得哪些权限 [6][21]。Grok Bot 靠 Lenny Rachitsky 等创作者冷启动 Marketplace [3]。LISA 可以支持标准的 SKILL.md 或 MCP 格式导入导出，让社区技能在 LISA 与 Claude Code 等之间可迁移，借开源社区增长。

11. **【规避】不透明计费与"额度不是硬上限"。** Grok Bot 不公布周额度折合多少美元，on-demand 上限也不是硬停，用户骂声集中于此 [27][56]。LISA 的云端配额（12 小时会话配额与内购档位）应做到：实时显示美元或 token、硬性熔断、每个 routine 与每个 Bot 分别计量。多模型可选本身就是对 Grok Bot "无模型选择器"的差异化 [22][36]。

12. **【规避】承诺与条款一致。** Grok Bot 的 CEO 说"搞砸了我们赔"，条款却全面免责 [29][61]。LISA 应在条款、产品文案、创始人公开表态之间保持一致，默认"发送、购买、删除、发布"一律先询问；并在本地保存可导出的动作日志（Grok Bot 只给企业版提供 Action Recording [25]），把"可审计"做成个人用户也能享有的特性。

---

## 17. 未解问题与信息缺口

1. **模型真相**：Grok Bot 各环节（对话、routine、computer-use）实际用哪些模型、比例多少？是否用到第三方闭源模型？OpenAI 11-12 断供后是否有变化？（官方只说由 Cursor 管理、会变化 [24]）
2. **周额度大小**：各档位周额度折合多少美元或 token——**未找到公开信息** [56]。移动端内购档位的具体价格也未核对。
3. **真实规模**：付费用户数、日活、Bot 数（"[millions]" 疑似占位符）、收入贡献都没有第三方数据；只有商店评分和榜单快照。
4. **平台上线日期**：Linux 何时转为官方支持（08-24 员工仍称不支持），Windows 是否在首发当天可用，语音模式的确切上线日（09-17 仅见二手来源）。
5. **身份外延**：Bot 是否可以拥有自己的邮箱或电话（Marketplace 的 "Stalk Bot" 称"用自己的研究邮箱注册"[3]；Manus Cue 已明确提供 [51]）。"替你参会"的实现方式与 AI 身份披露方式未知。
6. **消费侧路线**：Grok App 的 Automations、Skills、Connectors 会不会与 Grok Bot 合并？XChat 集成的形态与时间？Cursor 品牌是否淡出？[41][48]
7. **Companion 退役的公司口径**：没有正式公告；Animation Inc 与 xAI 的关系（外包、分拆、授权）不明；"算力与 ROI"等原因均来自低可信二手资料 [63]。
8. **安全事件**：未见 Grok Bot 数据泄露或越权交易报道；TNW 所称"Grok Build 上传含密钥的仓库"缺少出处 [37]。第三方模板（Marketplace）的审核机制未公开 [21]。
9. **企业合规细节**：GDPR 数据跨境（仅限美国算力）、子处理方清单中与 Grok Bot 相关的部分、"关联公司共享"条款在 SpaceX 集团内的实际数据流向 [24][30]。
10. **计费归属**：routines 与浏览器动作究竟计入 Grok Bot 周额度还是 Cursor 套餐，员工说法前后矛盾 [58]。

---

## Sources

1. https://x.ai/news/introducing-grok-bot — SpaceXAI（官方博客）— 2026-08-11（上线后页面已更新准入名单）
2. https://x.ai/bot — SpaceXAI（产品页：定价卡、FAQ、下载菜单、主演示）— 访问于 2026-09-30
3. https://x.ai/bot/marketplace — SpaceXAI（Bot Marketplace）— 访问于 2026-09-30
4. https://x.ai/bot/use-cases — SpaceXAI（56 个用例模板）— 访问于 2026-09-30
5. https://x.ai/bot/guides/grok-bot-101 — SpaceXAI Guides（Matt Palmer）— 2026-09-11
6. https://x.ai/bot/guides/templates-for-grok-bot — SpaceXAI Guides（Matt Palmer）— 2026-09-08
7. https://x.ai/bot/guides/grok-bot-for-work — SpaceXAI Guides（Josh Kim）— 2026-09-24
8. https://x.ai/bot/guides/grok-bot-for-engineering — SpaceXAI Guides（Lingxi Li）— 2026-09-10
9. https://x.ai/bot/guides/grok-bot-for-support — SpaceXAI Guides（David Gan）— 2026-09-09
10. https://x.ai/bot/guides/designing-grok-bot-with-grok-bot — SpaceXAI Guides（John Bai）— 2026-08-24
11. https://x.ai/news/designing-grok-bot — SpaceXAI（设计长文：Designing Grok Bot for a world of persistent agents）— 2026-09-03
12. https://x.ai/news/grok-bot-more-plans — SpaceXAI — 2026-08-26
13. https://x.ai/news/grok-bot-and-x — SpaceXAI — 2026-08-29
14. https://x.ai/news/grok-bot-for-enterprise — SpaceXAI — 2026-09-03
15. https://x.ai/news/grok-bot-procurement — SpaceXAI — 2026-09-04
16. https://x.ai/news/grok-bot-customer-support — SpaceXAI — 2026-09-22
17. https://x.ai/news/team-bots — SpaceXAI — 2026-09-28
18. https://x.ai/news/grok-4-7 — SpaceXAI — 2026-09-21
19. https://x.ai/news — SpaceXAI（新闻索引，用于日期核对）— 访问于 2026-09-30
20. https://x.ai/galaxy — SpaceXAI（Grok Bot Galaxy 活动页）— 2026-09-15 至 09-17
21. https://x.ai/legal/bot-sharing-terms — SpaceXAI（Third-party bot terms）— 生效 2026-08-22
22. https://docs.x.ai/grok-bot/overview（及 get-started、bots、mobile、chat-and-collaboration、files-and-results、computer-and-apps、skills-routines-and-automations、settings-and-notifications、faq）— SpaceXAI Docs — 访问于 2026-09-30
23. https://docs.x.ai/grok-bot/approvals-security-and-privacy — SpaceXAI Docs — 访问于 2026-09-30
24. https://docs.x.ai/grok-bot/security — SpaceXAI Docs — 访问于 2026-09-30
25. https://docs.x.ai/grok-bot/teams-and-enterprises — SpaceXAI Docs — 访问于 2026-09-30
26. https://docs.x.ai/grok-bot/team-bots — SpaceXAI Docs — 访问于 2026-09-30
27. https://cursor.com/help/grok-bot/plans — Cursor Help（Plans and billing）— 访问于 2026-09-30
28. https://cursor.com/help/grok-bot/faqs（及 supergrok、mobile-purchase、voice-chat、routines、connect-plugins、how-to、secrets、delete-account）— Cursor Help — 访问于 2026-09-30
29. https://cursor.com/terms/grok-bot — Cursor / Anysphere（Grok Bot Terms）— 最后更新 2026-09-03
30. https://cursor.com/privacy-overview（Data Use & Privacy Overview，2026-09-03）；https://cursor.com/privacy（Privacy Policy，2025-10-06）— Cursor
31. https://cursor.com/docs/models/grok-4-7（及 help/models-and-usage/grok-4-7、grok-4-6、grok-4-5；help/security-and-privacy/regions）— Cursor Docs / Help — 访问于 2026-09-30
32. https://forum.cursor.com/t/introducing-grok-bot/168053（2026-08-11）；https://forum.cursor.com/t/grok-bot-is-now-live-on-android/170384（2026-09-02）— Cursor Forum（官方员工帖）
33. https://play.google.com/store/apps/details?id=ai.x.grok.bot — Google Play 商店页（评分、下载量、数据安全、用户评论、更新说明）— 访问于 2026-09-30
34. https://apps.apple.com/us/app/grok-bot/id6794501026 — Apple App Store（经 iTunes Lookup API 获取元数据，美区生产力与总榜 RSS 获取排名，按国家查询上架情况）— 访问于 2026-09-30
35. https://x.com/bot — Grok Bot 官方 X 账号（关注数、置顶发布帖数据）— 访问于 2026-09-30
36. https://venturebeat.com/orchestration/spacexais-grok-bot-turns-agents-into-persistent-digital-coworkers-that-can-operate-your-apps-for-120-per-month — VentureBeat（Carl Franzen）— 2026-08-11
37. https://thenextweb.com/news/spacexai-grok-bot-ai-agents-cursor — The Next Web（Ana Maria Constantin）— 2026-08-11
38. https://www.infoq.com/news/2026/08/grok-bot-agent/ — InfoQ（Daniel Dominguez）— 2026-08-17
39. https://9to5mac.com/2026/08/21/grok-bot-is-an-all-new-iphone-and-mac-app-from-spacexai-and-cursor/ — 9to5Mac — 2026-08-21
40. https://www.reworked.co/collaboration-productivity/xai-launches-grok-bot-ai-agents-in-beta/ — Reworked（Siobhan Fagan）— 2026-08-12
41. https://www.trendingtopics.eu/grok-bot-spacexai/ — Trending Topics（转述 The Information）— 2026-08-11
42. https://www.unite.ai/xai-launches-grok-bot-always-on-ai-teammates-with-their-own-cloud-computers/ — Unite.AI（署名为 AI 生成记者，低可信）— 2026-08-11
43. https://www.engadget.com/2209300/xai-now-officially-spacexai/ — Engadget — 2026-07-07
44. https://openai.com/index/our-decision-on-cursor-following-its-acquisition-by-spacex/ — OpenAI — 2026-08-28
45. https://en.wikipedia.org/wiki/SpaceXAI；https://en.wikipedia.org/wiki/Cursor_(company)；https://en.wikipedia.org/wiki/Initial_public_offering_of_SpaceX；https://en.wikipedia.org/wiki/Grok_(chatbot) — Wikipedia — 访问于 2026-09-30
46. https://www.ftc.gov/news-events/news/press-releases/2025/09/ftc-launches-inquiry-ai-chatbots-acting-companions — FTC — 2025-09-11
47. https://techcrunch.com/2026/01/11/indonesia-blocks-grok-over-non-consensual-sexualized-deepfakes/ — TechCrunch — 2026-01-11
48. https://teslanorth.com/2026/09/26/grok-bots-xchat-coming-soon/ — Tesla North — 2026-09-26
49. https://techcrunch.com/2026/09/08/meta-debuts-its-muse-ai-agent-will-consumers-trust-it/ — TechCrunch — 2026-09-08（仅据搜索摘要，未逐篇核读）
50. https://siliconangle.com/2026/09/29/openai-launches-dots-always-on-ai-agents-in-chatgpt-with-their-own-cloud-computers/ — SiliconANGLE — 2026-09-29（仅据搜索摘要）
51. https://thenextweb.com/news/manus-2-0-cue-ai-agents-email-phone-wallet — The Next Web — 2026-09-28（仅据搜索摘要）
52. https://news.ycombinator.com/item?id=49261514 — Hacker News 发布帖（351 分 / 334 评论）— 2026-08-11；另见同期 Show HN 开源替代品，如 https://news.ycombinator.com/item?id=49365575（Open Bot，2026-08-19）
53. https://flaviocopes.com/grok-bot/ — Flavio Copes（上手深度评测）— 2026-08-29（后续有更新）
54. https://forum.cursor.com/t/some-of-the-bots-became-unresponsive-failed-to-send-on-my-messages-to-them/171858 — Cursor Forum — 2026-09-16
55. https://forum.cursor.com/t/grokbot-unavailable-hung-on-updating-grok-bot-s-computer-at-43/172535 — Cursor Forum — 2026-09-21（另见 09-26 至 09-30 多个重置 / 无法连接帖）
56. https://forum.cursor.com/t/grok-bot-ultra-users-how-do-you-make-the-weekly-allowance-last-mine-reached-99-in-three-days/171221（2026-09-10）；https://forum.cursor.com/t/grok-bot-usage-too-low-even-on-cursor-ultra/172584（2026-09-22）；context window 帖 171540（2026-09-13）— Cursor Forum
57. https://forum.cursor.com/t/grok-bot-prune-compact-an-agent-s-context-without-creating-a-new-bot/168333 — Cursor Forum — 2026-08-13
58. https://forum.cursor.com/t/why-does-grok-bot-chat-use-so-many-sand-tokens/169581（2026-08-26）；https://forum.cursor.com/t/grok-bot-spend-cursor-usage-i-cant-accept-it/169796（2026-08-28）；https://forum.cursor.com/t/anyone-used-grokbot-on-the-api-very-high-costs/169551（2026-08-26）— Cursor Forum
59. https://forum.cursor.com/t/native-grok-bot-desktop-app-for-arch-linux-and-linux-generally/168084（员工 08-24 回复）；https://forum.cursor.com/t/access-to-microsoft-products-in-grok-bot/168055（08-11 / 09-02）；论坛 Grok Bot 标签下 09 月底的 bug 与活动帖 — Cursor Forum
60. https://forum.cursor.com/t/free-cursor-ultra-with-grok/168286（2026-08-13）；https://forum.cursor.com/t/did-i-miss-an-announcement-on-supergrok-heavy-and-cursor-ultra/169128（2026-08-22）— Cursor Forum
61. https://x.com/elonmusk/status/2092692116610957814 — Elon Musk on X — 2026-08-26（美西时间）
62. https://x.com/aaronp613/status/2080371897884201304（2026-07-24）；https://x.com/karatademada/status/2080590872966496356（转引 Grok 回复，2026-07-24）；https://x.com/cb_doge/status/2093662862422299034（2026-08-29）— X
63. https://www.roborhythms.com/grok-companions-discontinued/；https://pocketanimus.com/guides/animates-app/；https://nika.team/blog/grok-ani-gone/ — Companion 退役与 Animates 整理（SEO，低可信）— 2026-08 至 09
64. https://composio.dev/content/guide-to-frok-bot（2026-08-20）；https://www.layer3labs.io/guides/what-is-grok-bot（2026-09-09）— SEO 指南（仅用于冲突核对）
65. https://releasebot.io/updates/xai — Releasebot（xAI 更新汇总）— 访问于 2026-09-30
66. https://runtimewire.com/article/grok-bot-adds-voice-desktop-mobile；https://www.basenor.com/blogs/news/grok-bot-now-has-voice-mode-what-you-need-to-know — 语音模式上线报道（仅据搜索摘要，低可信）— 2026-09
