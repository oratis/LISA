# Cue (cue.im, by Manus) 深度调研（截至 2026-09-30）

> **方法与边界**：WebSearch/WebFetch，加上用内置浏览器只读访问官方页面：cue.im 首页及其前端资源（含约 260 条官方示例任务和 FAQ）、反馈页、Manus 博客、帮助中心、Terms、Privacy、Trust Center、定价页、Google Play 页面与数据安全页。全程未登录，未使用邀请码，未下载或安装应用，未提交任何表单。
> **标签**：[官方] 官方材料 / [媒体] 主流媒体 / [实测] 上手评测 / [社区] 论坛、HN、X、商店评论 / [推测] 本文推断。
> **注意**：产品上线仅两天，实测大多只有一个来源。凡有冲突都已标出。Sohu 上一篇"无订阅、无隐藏收费"的稿件明显是 AI 生成的营销稿，与多方实测矛盾，本文不采用。

---

## 0. TL;DR

1. **是什么**：Cue 是 Manus 于 **2026-09-28** 与 Manus 2.0 同日发布的独立 App，面向消费者，定位"personal agents"。官网标题为 "Your Personal Agents, With Their Own Identity"，目前是邀请制早期访问 [官方][1][3]。
2. **核心差异是身份层**：每个 agent 可以拥有自己的邮箱（实测域名 `@bot.cue.im`）、电话号码、钱包（"its own card"）和一台云电脑，能接用户转来的电话，用自己的地址收发邮件，用户下线后继续干活 [官方][1][3][实测][32]。Muse、Grok Bot 的思路则是"以你的身份行事" [实测][30]。
3. **身份层落地比宣传克制**：
   - 电话号码是**付费附加项**。美国号实测 **$9.99/月**，通话另计用量，**不支持短信**。官方 X 帖承认只在 "select countries" 提供，部分地区仅语音 [实测][31][媒体][26][社区][41][42]。
   - 钱包实测是 **Link（Stripe）**，**每笔支出都要用户批准**，并且**目前仅限美国** [实测][31]。
   - 一篇实测称同一账户下的多个 agent **共用一台电脑**，与"每个 agent 一台电脑"的官方说法冲突 [实测][32]。
4. **架构**：Cue 与 Manus 共用基础设施。新 agent harness **Cascade** 宣称 token 少 23.2%、耗时少 28.2%、成本低 32%，但官方自己注明只是 "In one tested configuration"，没有公开测试方法 [官方][3][媒体][19]。底层模型未披露。Trust Center 的子处理方列出 OpenAI、GCP（含基础模型）、Azure AI Foundry [官方][9]。媒体称 Manus 2025-12 曾表示基于 Claude 与 Qwen [媒体][19]。
5. **功能面**：
   - 按角色建多个 agent，每个有独立对话和记忆，可拉入同一**群聊**接力协作。
   - **Routines/Automations** 可按时间或事件触发。
   - **"Memory and Dream"** 长期记忆，机制未披露。
   - **Skills**：可对话创建、上传或从 GitHub 导入。
   - **Apps 连接器**：Gmail、Slack、Notion、Trip.com、Oura、MyFitnessPal 等。
   - **扫码建商家 agent**（QR → service agent）。
   来源：[官方][1][5][实测][31]。
6. **目标用户**：以美国（尤其湾区）家庭与个人的"生活行政"为主，涵盖订位、就医预约、家政、出行、账单与报销、盯票盯号源，并兼顾小企业和职场场景。官方示例里大量是**盯守—抢占**类任务，例如 DMV 空位、营地放号、降价、补货 [官方][1]。
7. **定价**：早期免费。实测套餐页显示：
   - Plus 限时免费，一位测评者称之后 $20/月；
   - **Pro $100/月、Max $200/月**，按周重置额度。
   这套订阅与 Manus 的 $20/$40/$200 积分套餐看起来是分开计费的 [实测][30][31][32][官方][10]。
8. **牵引力（极早期）**：Google Play 两天内 4.6 分/515 条评分，下载数显示 "0+"，疑似展示延迟。@CueAgents 首发视频约 160 万次播放。Cue 本身没有官方用户数。母公司 Manus 2025-12 ARR 超过 1 亿美元，目前正以 40 亿美元估值洽谈 5 亿美元融资 [官方][5][13][16][媒体][18]。
9. **早期实测评价**：做调研和汇总类任务不错，也确实能在后台持续运行。但网页表单操作脆弱（验证码要人填），远程桌面卡顿，权限范围和任务进度不透明，还出现过"身份错位"（已连 Gmail 仍用自己的邮箱发信）。部分安卓机型闪退 [实测][32][39][社区][5]。
10. **信任与安全**：
    - 条款把责任压给用户："Agent actions may be attributed to you by third parties"。公司可插入标识或披露，也可拦截通信 [官方][7]。
    - 9/24 Salt Labs 披露：Manus 可被**一封邮件里的提示注入**打到远程代码执行，进而窃取已连接应用的令牌。Manus 未回复，漏洞最终经 Meta 漏洞赏金渠道修复 [媒体][29]。Cue 让每个 agent 都有公开收件箱，这类入站攻击面随之放大 [推测]。
    - 数据存放在美国和新加坡 [官方][9]。
    - 中国管辖风险依然存在：NDRC 以"实质重于形式"叫停 Meta 收购；8 月为合规强制删除了部分用户数据 [媒体][48][官方][14]。
11. **战略**：Computerworld 把 Cue 称为 "Meta's ex launches agent rival to Meta's Muse" [媒体][21]。Cue 是 Manus 脱离 Meta 后重返消费级 agent 的主力产品。与此同时，Manus 在组建中国市场团队，并与国产模型厂商洽谈合作 [媒体][17][40]。
12. **对 LISA**：身份层和 "Memory/Dream" 正在变成行业标配词汇。LISA 不该去拼电话和钱包基础设施，更应在**本地优先、soul 连续性、可审计的记忆与 Reve、入站内容安全、默认披露 AI 身份的受控代理身份**上做出差异（详见 §16）。

---

## 1. 基本信息与时间线

### 1.1 基本信息

| 维度 | 内容 | 来源 |
|---|---|---|
| 产品 | Cue，应用商店名 "Cue by Manus"，独立的 personal agents App。Manus 侧边栏另有 "Agents (Cue!)" 入口，扫码可下载 | [官方][3][4][5] |
| 公司 | Butterfly Effect Pte. Ltd.，新加坡注册，Manus 母公司；Terms 适用新加坡法律；Cue 客服邮箱 support@cue.im | [官方][5][7] |
| 关键人物 | 肖弘（创始人兼 CEO），发布当天以 "We're back." 复出发声；张涛（联合创始人/CPO） | [媒体][34][官方][47] |
| 发布方式 | 2026-09-28（周一）线上发布，渠道为官方博客、X 帖和创始人即刻长文；未见线下发布会。个别二手稿把日期写成 9/29，属时区或转述误差 | [官方][3][媒体][17][20][40] |
| 平台 | **官方说法**：web、桌面、移动全覆盖，iOS 待 App Store 审核。**9/30 官网实况**：macOS、Windows 下载按钮均可用，可下载 Android，iOS 显示 "Coming soon"。**9/29 实测指南**：仅 Android 与 Apple Silicon Mac 可用，Intel Mac 和 Windows 暂不支持，web 入口未见实测确认。结论是平台支持在快速变化 | [官方][1][3][实测][31] |
| 地区 | 没有官方地区列表。钱包"目前仅限美国"；电话号码仅 "select countries"，部分地区仅语音；官网示例高度美国化（San Jose、Palo Alto、SFUSD、加州 DMV） | [实测][31][媒体][26][官方][1] |
| 准入门槛 | 早期访问，凭邀请码免费。公开码 MEETCUE 先到先得，实测称共 1,000 次，兑换后得 1 个月 Cue Plus；获邀者可再分享邀请码。登录方式有 Google、Microsoft、Apple、邮箱 | [官方][3][实测][31] |
| 与 Manus 的关系 | 官方称 "built on the same infrastructure as Manus"；共用 Terms 与隐私政策；电话号码可在 Manus App 内购买并同步到 Cue 账户；订阅疑似分开计费 | [官方][3][7][社区][41][5] |
| 产品血缘 | **Mail Manus**：转发邮件即可触发任务，地址形如 `@mail.manus.ai`，有"已批准发件人"白名单。**Manus Agents**：2026-02 起可在 Telegram 内使用 Manus。**Scheduled Tasks → Automations** | [官方][12][11][3] |

### 1.2 时间线

| 日期 | 事件 | 来源 |
|---|---|---|
| 2025-03 | Manus 通用 agent 爆红，据报道一周内候补名单达 200 万人 | [媒体][29] |
| 2025-12-17 | Manus 宣布 ARR 超 1 亿美元（上线 8 个月），收入 run-rate 超 1.25 亿美元 | [官方][13] |
| 2025-12-29 | Meta 宣布以约 20 亿美元收购 Manus | [官方][15][媒体][38] |
| 2026-02-16 | 推出 "Manus Agents"，可在 Telegram 内使用 Manus | [官方][11] |
| 2026-03 | Manus 桌面端上线 | [媒体][20] |
| 2026-04-27 | 中国 NDRC 依据外商投资安全审查叫停交易，要求恢复原状 | [媒体][48][52] |
| 2026-04-29/30 | Stripe 推出 "Link wallet for agents"（一次性卡、SPT、逐笔批准） | [官方][45][媒体][46] |
| 2026-06-11 | 据虎嗅，Meta 完成运营拆分并停止双方数据共享 | [媒体][38] |
| 2026-07 | 创始团队与腾讯、红杉中国等原股东按原估值回购股权；据 Tech星球，Benchmark 退出 | [媒体][39][17] |
| 2026-08-11 | Manus 宣布回归独立运营；部分用户在 2025-12-29 之后产生的数据于 8/23–24 删除 | [官方][14][15] |
| 2026-08 ~ 09-01 | 恢复独立运营。财联社称 9/1，Computerworld 称 8 月，**两说冲突** | [媒体][36][21] |
| 2026-09-08 | Meta 发布 Muse（虎嗅称 9/10，与多数来源不一致） | [媒体][53][38] |
| 2026-09-17/18 | 报道称 Manus 洽谈以 40 亿美元估值融资 5 亿美元 | [媒体][18] |
| 2026-09-24 | Salt Labs 披露 Manus 邮件提示注入导致 RCE | [媒体][29] |
| **2026-09-28** | **Manus 2.0 + Cue 发布**；Terms 与 Privacy 同日更新 | [官方][3][7][8] |
| 2026-09-29 | OpenAI 在 DevDay 发布 Dots；Cue 安卓版 9/30 更新（Bug 修复） | [媒体][50][官方][5] |

---

## 2. 定位与目标用户

- **官方口号**有两句。一是 "Your Personal Agents, With Their Own Identity"；二是 "Give it a cue, and it gets to work." [官方][1][3]。
- **Google Play 描述**的标题是 "GET TASKS DONE, NOT JUST CHAT"，并强调：
  - 经许可可以通信、使用工具；
  - 下线后继续工作；
  - 需要决策时把事情带回给用户 [官方][5]。
- **创始人叙事**：肖弘在即刻把 Cue 形容为一个有独立手机号、邮箱、支付、电脑和足够智能的"东西"，"也许可以称之为『人』" [媒体][40]。
- **目标人群**，根据约 260 条官方示例归纳 [官方][1]：
  - (a) 美国家庭：孩子就医、学校事务、老人出行、家政维修；
  - (b) 个人财务：通过 Plaid 或 Robinhood 查账、查订阅、做报销；
  - (c) 差旅和出游；
  - (d) 职场与小企业：HubSpot、Google Ads、Meta 广告、Slack 周报。
  - 示例的地理背景集中在湾区 [推测：首发市场是美国]。
- **与同类的定位差**：
  - Muse 以用户身份行事，Meta 明确不给 agent 独立账户；
  - Grok Bot 登录用户已有的工具，偏工作；
  - Cue 给 agent 自有基础设施，偏"有真实世界摩擦"的琐事（DMV、订房、机场停车）[实测][30]。
- 中文媒体称之为"全天候智能体" [媒体][34]，主打个人生活场景 [媒体][36]。

---

## 3. 核心能力与代表性任务

**官方能力清单**，来自 Google Play [官方][5]：
- 打电话、接电话、发消息，并总结对话；
- 收发邮件、跟进，把确认信息写进日历；
- 比较机票、酒店、餐厅、活动和本地服务；
- 规划行程并监控价格；
- 预约医疗、家政和活动；
- 经批准后下单。

**官方示例库**：cue.im 前端内置约 260 条示例，分 6 类，按类型归纳如下 [官方][1]。

| 模式 | 代表示例（意译） |
|---|---|
| 盯守—抢占（最具特色） | 每天查附近三家 DMV 是否有更早的考试空位，有就改约并写进日历；Recreation.gov 放出 Whitney 许可就立刻订下，"用 Link 付、我在手机上确认"；Costco 宝可梦卡盒补货立刻通知 |
| 电话代理 | 用户飞行期间代接电话，落地后先报航司和酒店的事，其余按紧急程度排序；诊所回电确认 MRI 时代为接听并问清空腹要求；把 agent 号码写在简历或 Craigslist 上代接招聘和买家来电 |
| 邮件代理（用自己的地址） | 给餐厅发邮件询问儿童椅和无障碍；用日语给京都旅馆发邮件并翻译回复；用葡萄牙语向里斯本房东追讨押金 |
| 代付 | Taskrabbit 请人装 IKEA 衣柜并"记在我的 Link 上"；交罚单、交过路费、交 HOA 费；承包商发票经用户确认后支付 |
| 财务与健康数据 | 用 Plaid 查重复扣款或遗忘的订阅；每周一对照日历上的发薪日和 Gmail 里的账单预警现金流；每天早上 8 点读 COROS 或 Oura 数据建议训练 |
| 工作 | 每周一汇总 Google Ads；Meta 广告 CTR 异常时推送到 Slack；HubSpot 续约风险名单 |

**官方演示**：
- 群聊里一个 agent 找纽约发布会场地，一个出候选名单，一个写 deck；
- 餐厅扫码后代为点餐或排队占位；
- 官网配图是多个 agent 在群聊里规划京都行程 [官方][1][3]。

**实测结果**：

| 来源 | 任务 | 耗时 | 结果 |
|---|---|---|---|
| AI范儿 [32] | 用 agent 自有邮箱注册 Notion | ~16 分钟 | 成功。人工介入 3 次：开通邮箱、授权 **AgentMail** 连接器、接管浏览器输入验证码（agent 读得到验证码，但填不进网页） |
| AI范儿 [32] | 汇总 3 家 AI 公司近 30 天动态并导出 Excel | ~5 分钟 | 成功；关掉 App 后仍在云端继续完成 |
| AI范儿 [32] | 3 个 agent 群聊选题（调研→核查→编辑→撰稿） | <10 分钟 | 完成，但调研员重发了整套候选，有冗余 |
| Paul Klay [30] | 巴塞罗那二手摩托车筛选 | 2–3 分钟 | 结果好、噪声少 |
| 53AI [33] | 把发票转发到 agent 邮箱后整理清单 | ~2 分钟 | 成功 |
| 小墨同学 [31] | 开通美国号码 | — | 能打电话，**不能收短信**（订阅页也写明不支持） |
| Tech星球引述用户 [39] | 代写邮件 | — | 已连 Gmail，agent 却优先用自己的邮箱发信，用户觉得"怪" |

---

## 4. 架构与机制

### 4.1 与 Manus 2.0 / Cascade 的关系
- Cue "built on the same infrastructure as Manus" [官方][3]。
- **Cascade** 是 Manus 自研 agent harness 的最新迭代。项目从轻量起步，只在需要时调入专门能力。官方给出的数字是 token 少 23.2%、耗时少 28.2%、成本低 32%，但只是 "In one tested configuration"，与 Manus 自己的旧系统对比 [官方][3]。
- 多家媒体指出测试方法未披露，结果也未经独立验证 [媒体][19][24][28]。
- Gartner 分析师认为，编排层正在变成企业部署中的主要差异点 [媒体][21]。
- **关于"约 32%"**：原始线索里的"agent 成本降约 32%"确属官方数字，但指的是 Manus 2.0 整体的 harness（Cascade），不是 Cue 专属的数据 [官方][3]。

### 4.2 模型
- **官方**：Cue 用什么模型未披露。Trust Center 称 Manus 是 LLM-agnostic，按用例选模型，并与所有模型供应商签约禁止拿用户数据训练 [官方][9]。
- **子处理方**：列出 GCP（云与基础模型）、Azure AI Foundry、OpenAI（基础模型）[官方][9]。
- **历史口径**：Implicator 称 Manus 2025-12 表示基于 Claude 与阿里 Qwen，不自训基座 [媒体][19]。2026-02 时模型分档为 Manus 1.6 Max/Lite [官方][11]。
- **社区认知**：一位 Play 用户评论称 Cue 用的是"免费的中国模型"，此说未经核实 [社区][5]。
- **推测**：国内版正在与国产模型厂商合作 [媒体][17]，海外 Cue 的模型组合有可能按地区分化。

### 4.3 每个 agent 的"电脑"
- **官方**：agent 在专属工作区里使用所需的应用和工具，用户下线后继续工作 [官方][1]。
- **实测（冲突）**：AI范儿称 agent 各有邮箱和电话，"但电脑确实共用一台"。配置为 Intel Xeon 云主机，4 物理核/8 逻辑核、16GB 内存、40GB 硬盘，Ubuntu 系统，带 root 权限。作者对比称 Muse 只有 2 核、8GB 内存、100GB 硬盘 [实测][32]。
- **界面**：右侧有"电脑"面板，可进入远程桌面观察执行过程，但实测普遍反映卡顿 [实测][31][32]。
- **Manus 侧的 Cloud Computer**：另行付费，价格未公开，是常驻环境，适合全天候自动化和游戏服务器 [官方][3][媒体][19]。
- **沙箱数据保留期存在冲突**：隐私政策写免费 7 天、付费 14 天；Trust Center FAQ 写免费 7 天、付费 21 天 [官方][8][9]。

### 4.4 后台运行与触发
- 官方说法是 "keeps working after you log off" [官方][1]。实测证实：关掉 App 后任务仍在云端完成 [实测][32]。
- **Routines/Automations** 可按时间表触发，也可响应支持的事件或条件。由用户决定什么启动自动化、agent 能做什么、哪些操作要批准 [官方][5]。
- Manus 2.0 的 Automations 触发源包括新邮件、广告表现变化、日历事件、Slack 消息、Notion 更新 [官方][3]。

### 4.5 多 agent 群聊
- 群聊有共同目标，agent 之间交接工作，用户定方向并做最终决定（"You set the direction and make the final call."）[官方][3]。实测显示 agent 之间可以自行传递上下文 [实测][33]。
- 群聊入口在左上角 "+" 菜单的"创建群聊"，与"创建 Agent"并列 [实测][31]。
- 扫码可以把**商家 agent** 加进用户的对话 [实测][30][官方][5]。
- **未找到公开信息**：
  - agent 间用什么协议（是否 A2A 或 MCP 之类）；
  - 其他真人能否加入群聊；
  - 群聊内记忆是否共享。

### 4.6 Skills 与 Apps
- **Skills**：可对话创建、上传，或从 GitHub 导入 [实测][31]。
- **Apps（连接器）**：Gmail、Google Calendar 等，可搜索添加 [实测][31]。Manus 的连接器基于 MCP 与 OAuth 2.0，官方称不存储经连接器读取的数据 [官方][9]。

---

## 5. Agent 身份（重点）

| 组件 | 官方说法 | 实测 / 社区发现 | 供应商 | 未知项 |
|---|---|---|---|---|
| **邮箱** | 用自己的地址收发邮件 [官方][1][3] | 地址形如 `@bot.cue.im`；要先在设置里"开通邮箱"；任务中弹出 **AgentMail** 连接器卡片（"管理收件箱、邮件、会话和草稿"），需用 Google 登录授权 [实测][32] | 未官方披露。推测收件箱可能基于 AgentMail（YC 公司，一次 API 调用给 agent 开收件箱）[54]，但 AI范儿作者也说"没找到官方说法"；Trust Center 子处理方未列 AgentMail [推测][32][9] | 入站过滤、发件人白名单（Mail Manus 有，Cue 不详）；反垃圾与发信信誉 |
| **电话号码** | 用自己的号码打电话、接电话、发消息；可接用户转来的电话并留摘要 [官方][1][3]。Play 注明 "Depending on availability" [官方][5] | 官方 X 帖称仅 "select countries"、部分 "voice-only" [媒体][26]。美国号 **$9.99/月**（早先 $0.99），**通话计入用量**，**不支持短信** [实测][31]。社区称英国 +44 号码在 iOS 版 Manus App 首月 $0.99、web 与桌面 $9.99，续费价有争议；加拿大号码缺货；一个账户可开多个号；收不到 Telegram 验证码 [社区][41][42] | 未披露。Trust Center 只列 **Twilio 用于"SMS notifications"**，没有单独的语音或号码供应商 [官方][9] | 覆盖国家清单；是否录音；通话开场是否披露 AI 身份；号码类型（VoIP 还是实体号，社区自称"实体号"，未核实） |
| **钱包** | "pays with its own card"，在用户设定的预算内付款 [官方][1][3] | 钱包页是 **Link** 相关设置，写明**每笔支出需批准**、**当前仅限美国** [实测][31]。官方示例多次出现"用 Link 付，我在手机上确认/点一下批准" [官方][1] | **Stripe Link（wallet for agents）**，推测置信度高。该产品通过 OAuth 授权 agent，给出一次性卡或 Shared Payment Token；agent 拿不到原始卡号；当前逐笔批准，限额与免审是"计划中"功能 [官方][45][媒体][46]。Manus 此前已是 Stripe 与 Link 的大客户 [官方][47] | agent 本身无独立 KYC，资金实际来自用户的 Link [推测]；未见稳定币或 x402；预算上限如何配置不详 |
| **电脑** | 专属工作区 [官方][1] | 多 agent 共用一台 4C8T/16GB/40GB 的 Ubuntu 云主机，带 root [实测][32] | GCP、AWS、Azure（Manus 云基础设施）[官方][9] | 每个 agent 的隔离粒度 |
| **对外呈现与 AI 披露** | 未披露 | 可设 agent 名字和头像 [实测][32] | — | 邮件署名、来电显示名、是否主动说明"我是 AI"均**未找到公开信息** |

**法律归属（Terms，2026-09-28 版）** [官方][7]：
- §2.7：用户授权公司在其所选权限内代为操作。"Agent actions may be attributed to you by third parties"。撤销权限不能逆转已完成的动作。禁止绕过认证、访问控制或限流。
- §2.12：用户指示或批准 agent 购物时，即授权其提交订单和支付指令。交易发生在用户与卖家之间。公司可拒绝、暂停交易或要求再次确认。
- §2.13：发送通信时，收件人、内容和各类同意由用户负责；禁止非法冒充、欺骗、骚扰和未经请求的通信。"We may include technical or legally required identifiers and disclosures"，公司也可拦截或暂停通信。录音和转写由用户负责告知并取得同意。
- §2.8：公司可能提供 SMS/MMS 消息项目（条款很薄）。

**评论**：官方宣传的"独立身份"在法律上并不独立。一切后果归于用户，资金也来自用户自己的 Link；"身份"更接近**代理人的专用联系方式**，好处是能充当用户的隐私屏障。官方示例就有把 agent 号码写在简历和 Craigslist 上代接来电的用法 [推测][1][7]。

---

## 6. 交互界面

- **客户端**：Android（`ai.manus.agents`）、Mac（Apple Silicon）、Windows（9/30 官网按钮已可用）、web（官方说法）；iOS 在审 [官方][1][3][5][实测][31]。
- **界面布局**：左侧是 agent 与对话列表，中间是聊天区，右侧可打开"电脑"面板。"+" 菜单下可创建 Agent 或群聊。每个 agent 的设置项包括邮箱、电话、钱包、电脑、技能、应用 [实测][31]。另有 "See how people use Cue" 标签页，可浏览热门 agent 和他人用法 [实测][30]。
- **沟通渠道**：
  - 用户侧：App 内聊天加推送通知（"notify you"）[官方][5]；
  - agent 侧：用自己的电话和邮箱对外沟通 [官方][1]；
  - 示例中也常把 Slack 当作推送渠道，如"急事立刻发我 Slack" [官方][1]。
  - 未见 Cue 接入 WhatsApp、iMessage 或 Telegram；Manus 自身在 2 月接入过 Telegram [官方][11]。
- **审批体验**：官方说法是 agent 在需要决策时把事情带回给用户；支付走 Link 的手机批准 [官方][1][5][实测][31]。
- **语音**：电话代接是核心场景。但 Play 评论反映"音频工具不好用"，还有人说"电话功能消失了" [社区][5]。

---

## 7. 人设与形象

- **品牌形象**：吉祥物是 "Cue!"，周围环绕"四个彩色 agent 角色"（官网 og:image 的描述）[官方][1]。
- **每个 agent 的个性化**：可设名字和头像，实测示例名为"小扎 2 号"；主要按职责和角色来塑造 agent [实测][31][32][官方][5]。
- **未找到公开信息**：可调的性格参数、可选声音或音色、长期人格一致性机制。
- **模板**：官方主推三类助理，即邮件、财务、调研 [实测][30]。示例中有"Chief of Staff agent" [官方][1]。
- **对比**：Muse 主打给 AI 定制外观、名字和服饰 [媒体][39]；Dots 是"bubbly"的气泡形象 [媒体][50]。**Cue 走职能化路线**，人设较弱 [推测]。

---

## 8. 记忆与个性化

- **记忆机制**：每个 agent 有独立记忆。**"Memory and Dream"** 负责记住偏好、过往决定、项目目标、出行需求和长期背景，用户回来时可接着做 [官方][5]。反馈页也把 "Memory and dream" 单列为一类问题 [官方][2]。
- **Dream 的具体机制**：离线整理、合并还是遗忘，均**未找到公开信息**。
  - 同类参照：Anthropic Managed Agents 有 **Dreams**（research preview），它读取记忆库和历史会话，产出去重、更新后的新记忆库，且不改动原库 [官方][51]。
  - 推测"做梦式记忆整理"正在成为行业通用词 [推测]。
- **个性化数据源**：连接器（Gmail、Plaid、Oura、COROS、MyFitnessPal）[官方][1][5]。
  - 隐私政策（9/28 版）新增 **"通过 Manus Agents 收集的健康数据"**，列明 HealthKit 的活动、心肺、睡眠等类别，承诺基于同意使用、不存 iCloud [官方][8]。
  - 推测 "Manus Agents" 就是 Cue 的法务或内部名，安卓包名 `ai.manus.agents` 可作佐证 [推测]。
- **Play 数据安全声明**：收集健康与健身、通讯录、邮件与消息、语音录音、日历、文件、购买记录等；与第三方共享设备 ID 和用户 ID [官方][6]。
- **未找到公开信息**：记忆可视化、编辑和删除的界面；群聊中跨 agent 是否共享记忆。

---

## 9. 主动性

- 主动性以**用户定义的 routine 为主**：晨报、定时汇总、条件触发，例如降价、放号、股价波动超过 5%、广告预算超标 [官方][1][5]。
- **电话分拣**：代接电话后按紧急程度即时推送，其余次日再报 [官方][1]。
- agent 需要决策时会主动回到用户这里 [官方][5]。
- **未找到**不依赖用户设定、由 agent 自发发起的行为（例如无指令地主动提醒）。

---

## 10. 连接器、生态与开发者

- **官网展示的连接器**：Trip.com、Oura、Gmail、MyFitnessPal，以及 "More apps" [官方][1]。
- **示例中出现的服务**：Slack、Notion、Google Drive/Sheets/Calendar、Plaid、Robinhood、HubSpot、Crunchbase、COROS、Todoist、Airtable、GitHub、Google Ads、Meta 广告等。Instacart、Amazon、Taskrabbit、Recreation.gov 等可能是通过浏览器操作完成的 [官方][1][推测]。
- **Manus 连接器体系**：MCP 加 OAuth [官方][9]。7–8 月新增了 Supabase（7/24）、ElevenLabs（8/3，含语音生成和声音克隆）等连接器，出处为 releasebot 对 Manus 博客的汇总，见 [4] 附注 [媒体]。ElevenLabs 是否用于 Cue 通话：未找到公开信息。
- **Skills**：支持从 GitHub 导入 [实测][31]。
- **商家侧**：在"受支持的"咖啡馆和餐厅扫码即可创建服务 agent，可问菜单、订位、下单，支付由用户确认 [官方][5]。**合作商家名单和商家接入文档：未找到公开信息**。有评论认为这是让商家不做 App 就能接入的巧妙入口 [实测][30]。
- **开发者平台**：Manus 有 API 业务，隐私政策中提到 "Manus API customers" [官方][8]。但 **Cue 的 API、SDK、agent 间协议和商家 SDK：未找到公开信息**。

---

## 11. 信任、安全与权限

**权限与审批** [官方][1][5][实测][31]：
- 用户为每个 agent 设定可用工具、可访问信息和需审批的动作；
- 钱包逐笔批准；
- 实测抱怨"授权范围和任务进度不够透明"，例如 Google 登录究竟授予了什么权限看不到。

**隐私与数据** [官方][8][9]：
- Terms 与 Privacy 均于 9/28 更新，适用范围扩展到 connected-account、communication and automation features。
- 支付由 Stripe 和 RevenueCat 处理。第三方 AI 供应商未具名，官方称不授权其拿用户数据训练，除非明确披露并取得同意 [官方][7][8]。
- 数据存储在美国和新加坡，跨境传输使用 SCC。认证有 ISO 27001、ISO 27701、SOC 2 Type II，承诺 72 小时内通报泄露 [官方][9]。
- 本文抓取时，隐私政策页（/privacy 与 /en/privacy）渲染出来的都是日文译本，属站点小问题（本文抓取观察）。

**子处理方缺口** [官方][9][推测]：Trust Center（9/30）列出的只有 GCP、Azure AI Foundry、AWS、Cloudflare、Intercom、OpenAI、RevenueCat、Stripe（billing）、Twilio（SMS notifications）。**没有列出 Cue 号码与通话、agent 收件箱、钱包对应的供应商**，披露明显落后于产品。

**安全事件** [媒体][29]：
- Salt Labs 向测试用户发送夹带指令的邮件。明文指令会被拦下，但用 JSFuck 混淆后可以执行，而且安全警告在载荷执行**之后**才弹出。
- 研究者由此拿到反向 shell，窃取了已连接的 Gmail、Dropbox、GitHub 令牌。
- Manus 未回复；漏洞经 Meta 漏洞赏金渠道确认并修复。
- Salt Labs 的观点是：不能只靠护栏，必须做纵深防御。
- 推测：Cue 让每个 agent 都有公开邮箱和号码，还能扫码与陌生商家 agent 对话，入站注入面显著扩大 [推测]。

**中国关联与数据治理**：
- NDRC 以"实质重于形式"为由（团队、算法、数据、算力都与中国相关）叫停交易，说明离岸重组无法隔离中国的监管管辖 [媒体][48]。
- 8 月，Manus 为"满足特定司法辖区监管要求"，删除了部分用户在 2025-12-29 之后产生的账户、订阅、任务、产物和连接器授权 [官方][14][15]。
- Manus 同时在筹备中国产品、洽谈国产模型 [媒体][17][40]；据报道腾讯成为最大外部股东 [媒体][19]。
- IDC 分析师建议企业核查：提示词、中间状态、日志、备份和连接器凭证分别存放在哪里，以及工作流能否迁出平台 [媒体][21]。
- **未找到**美国监管机构针对 Cue 的公开行动 [未找到公开信息]。

**滥用风险与缓解**：
- **风险**：agent 有了号码、邮箱和卡，就可能被用于批量注册账号（实测就是让 agent 用自己的邮箱注册 Notion）、群发或骚扰、冒充、刷验证码 [实测][32][推测]。
- **已观察到的缓解措施**：
  - 邀请制；
  - 号码收费且按国家限量；
  - 部分地区仅语音（美国号不收短信，客观上阻断接码滥用）；
  - 钱包逐笔批准、仅限美国；
  - 条款禁止冒充和未经请求的通信，公司保留插入披露和拦截通信的权利。
  来源：[实测][31][媒体][26][官方][7]。
- **法规背景**：FCC 2024-02-08 裁定，AI 生成语音属于 TCPA 所称的 "artificial" 语音。因此 AI 语音外呼同样受 TCPA 对人工/预录语音的限制，例如营销类 robocall 需要事先书面同意 [官方][49]。国内报道也提到"拟人化"监管红线和越权边界问题 [媒体][36]。
- **分析师观点**：Gartner 的说法是"自治跑在治理前面"，建议把这类系统当作半可信的自动化，配强隔离、审批闸门和遥测 [媒体][21]。Runtime Wire 指出，官方没有解释逐笔批准、身份使用限制和事后审计怎么做 [媒体][24]。

---

## 12. 定价与包装

| 项目 | 价格 / 规则 | 来源与可信度 |
|---|---|---|
| 早期访问 | 凭邀请码免费；MEETCUE 共 1,000 次，兑换得 **1 个月 Cue Plus** | [官方][3][实测][31]，单一来源 |
| Cue Plus | 套餐页显示"免费·限时"；Paul Klay 称之后 **$20/月** | [实测][30][31]，价格为单一来源 |
| Cue Pro | **$100/月**（月付；另有年付选项） | [实测][31][32]，两个来源一致 |
| Cue Max | **$200/月** | [实测][31] |
| 用量 | **周额度**，每周重置 | [实测][32] |
| 电话号码 | 美国号 **$9.99/月**（曾为 $0.99），通话另计用量；英国号在 iOS 版 Manus App 标 $0.99，web 与桌面 $9.99，续费价有争议 | [实测][31][社区][41][42] |
| 钱包 / Link | 未披露费用 | 未找到公开信息 |
| 官方口径 | Cue 早期访问后的价格未公布 | [媒体][19][24] |
| Manus 本体 | $20/月（4,000 积分）、$40/月（8,000）、$200/月（40,000），另有每日 300 刷新积分；Team 从 $20/席起；年付省 17%。36Kr 称 2.0 后免费用户送 1,500 积分，未核实 | [官方][10][媒体][35] |
| Cloud Computer（Manus） | 可购买，价格未公开 | [官方][3][媒体][19] |
| 计费关系 | Cue 订阅看起来与 Manus 分开。Play 有用户希望"能和 Manus 共用订阅"；Terms 写明一项服务不会带来"separately purchased"订阅的权益；号码则两边同步 | [社区][5][官方][7][社区][41]，[推测] |

- **包装特点**："订阅 + 周额度 + 号码附加费 + 通话用量"四层叠加，结构复杂 [推测]。
- 社区对 iOS 与 web 价差表示强烈不满，有人认为是"炒作引流" [社区][42]。

---

## 13. 牵引力

**Cue 本身（非常早期）**：
- Google Play：9/30 显示 4.6 分、515 条评分，下载数显示 "0+"，疑似新应用的展示延迟 [官方][5]。
- @CueAgents 9 月开号，约 8.7K 粉丝，置顶首发视频约 160 万次播放 [官方][16]。
- 公开邀请码上限 1,000 次 [实测][31]。
- 官方没有注册数或候补名单数字 [未找到公开信息]。

**母公司 Manus**：
- 2025-12：ARR 超 1 亿美元，run-rate 超 1.25 亿美元；1.5 版后月增长超过 20%；累计处理 147T tokens，创建超过 8,000 万台虚拟电脑；105 名员工 [官方][13]。
- 财联社：年化收入 2025-08 为 9,000 万美元，2025-12 为 1.25 亿美元 [媒体][36]。
- Stripe 案例：付费上线 4 个月 run-rate 达 9,000 万美元，超过 50% 的交易经 Link 完成 [官方][47]。
- 融资：洽谈以 40 亿美元估值融资 5 亿美元，潜在投资方有 IDG、博裕、宁德时代，以及老股东腾讯、红杉中国（HSG）、真格 [媒体][18]。
- 风险信号：Tech星球称 Manus 月访问量在 2025-03 达到 2,376 万的峰值后一路下滑 [媒体][39]。

**竞品参照**：
- Muse 上线 13 天下载约 260 万次，美国移动端 DAU 64.2 万 [媒体][39]；截至 9/24 累计下载超过 340 万次 [媒体][35]。
- Cue 在规模上显然不在一个量级 [推测]。

---

## 14. 评测与批评

**正面**：
- 调研、汇总类任务交付快、质量好 [实测][30][32]。
- 能在后台持续跑 [实测][32]。
- 与 Muse 相比"完成度更高"，可以直接看远程桌面，机器配置也更高 [实测][32]。
- 扫码建商家 agent 被认为是新颖的入口 [实测][30]。

**负面**：
- **网页操作脆弱**：验证码要人工接管 [实测][32]。
- **远程桌面卡顿**；**权限和进度不透明** [实测][32]。
- **身份错位**：已连 Gmail 却用 agent 自己的邮箱发信 [实测][39]。
- **电话能力缩水**：美国号不收短信，号码另收费 [实测][31]。
- 安卓崩溃（vivo、iQOO 机型）、卡在登录页、无法输入邀请码、响应慢 [社区][5]。

**社区情绪**：
- linux.do 围绕 $0.99 与 $9.99 的价差，出现"炒作/引流"和"Manus 已经凉了"等声音 [社区][42]。
- HN（8 月）：积分制"贵且不可预测"，担心提示注入，质量上不如 Claude Cowork 或 ChatGPT Work，但也有用户说它比其他工具更少需要盯着 [社区][43][44]。

**媒体质疑**：
- Cascade 数字无法验证 [媒体][19][28]。
- 审批和身份的约束机制没讲清 [媒体][24]。
- Agent 赛道已经挤满对手；国内的生活需求被微信、支付宝、美团锁定，留给独立 agent 的空间是个问号 [媒体][35]。
- C 端付费意愿弱，大厂生态壁垒高 [媒体][39]。

---

## 15. 战略背景

- **"Meta 的前任"叙事**：Meta 约 20 亿美元的收购被北京叫停后，Manus 被迫回归独立。发布时间点距 Muse 约 20 天，被普遍解读为正面对打 [媒体][21][38]。
- **理念分野**：虎嗅概括为 Meta 强调 agent "无处不在"，Manus 强调 agent "独立存在" [媒体][38]。
- **中国与美国两头的位置**：
  - 一面用美国化的 Cue 争夺海外 C 端；
  - 一面组建国内团队、接入国产模型；
  - 融资方以中国资本为主，可能谋求港股上市 [媒体][17][18][40]。
  - 推测：这种"双栈"会持续引发海外用户对数据治理的疑虑，也可能导致产品按地区分叉 [推测]。
- **支付轨道趋同**：Muse 用 Stripe Link 一次性卡 [实测][30]，Cue 的钱包实测也是 Link [实测][31]。Stripe 正在成为 agent 支付的公共底座 [推测][45]。
- **同期竞品**（其他研究者详述，此处仅作对比）：

| | Cue（Manus） | Muse（Meta） | Dots（OpenAI） | Grok Bot（xAI） |
|---|---|---|---|---|
| 发布 | 2026-09-28 | 2026-09-08 [53] | 2026-09-29，DevDay [50] | 2026-08-11 |
| 身份模型 | agent 自有邮箱、号码、钱包（Link）、电脑 [3][31] | 以用户身份行事，Link 一次性卡，无独立账户 [30] | 可为专精 Dot 配置身份、凭证和工具 [50]；自有云电脑 [55] | 登录用户已有工具；云电脑带浏览器、文件系统、终端 [30][31] |
| 渠道 | App、桌面、web，外加 agent 自有电话和邮箱 | App、WhatsApp、web [53] | ChatGPT/Codex、Slack/Teams，短信即将支持 [50] | 偏工作场景 |
| 可用性 / 价格 | 邀请制，早期免费；Pro $100、Max $200（实测） | 美国；免费层 + 订阅 [30] | ChatGPT Pro、Business Premium [50] | 经 Cursor Ultra（$200/月）等渠道 [30] |

- **同日其他发布**：Wabi 2.0（多人 messenger 加 agent）、Wajo 的 Fo（打电话、发邮件、订位，AI 被拒时转给人工操作员）[媒体][27]。
- **国内参照**：WorkBuddy、豆包、千问已打通下单和打车；易观 6 月统计，17 款桌面办公 agent 合计约 6,000 万次访问 [媒体][35][36]。

---

## 16. 对 LISA 的启示

1. **做"受控代理身份"，别做全套身份基础设施。**
   - Cue 证明了"agent 自有联系方式"有明确用例：隐私屏障、代接、以 agent 名义询价或报名。
   - 但它的电话要付费、分国家、部分仅语音，且法律责任仍全归用户 [实测][31][官方][7]。
   - **建议**：LISA 先上线**一个经用户同意的 agent 发件地址**，例如用 Cloudflare Email Routing/Sending 或 AgentMail 为每个用户开 `lisa-<user>@…`，只用于报名、询价、订位这类低风险外联。用户自己的 Gmail 保持只读，延续现有的 mail connector 设计。
   - 电话至少推迟到"入站代接与摘要"阶段；外呼暂不做。
2. **每次外发都显式确认"用谁的身份"。**
   - 这是针对 Cue 身份错位的直接教训 [实测][39]。
   - 在 Lisa Pocket 的审批卡片上固定显示三件事：发件身份（你/LISA）、收件人、正文预览。
   - 个人往来默认用用户身份（草稿交由用户发出）；agent 身份只用于标注为"agent 事务"的场景。
3. **默认披露 AI 身份，把它做成卖点。**
   - Cue 条款只说公司"可能"插入披露 [官方][7]，官网未说明来电或邮件时会自报 AI。
   - LISA 可以强制做到：外发邮件带页脚，例如"由 LISA（为 X 服务的 AI 助手）代发"；未来的通话首句先自报身份。
   - 这既契合隐私优先和 App Store 5.1.1 的合规积累，也能规避 TCPA 等 AI 语音风险 [官方][49]。
4. **入站内容一律按不可信数据处理，写成公开威胁模型。**
   - Salt Labs 用一封邮件就打穿了 Manus [媒体][29]；Cue 给每个 agent 开公开收件箱，风险更大。
   - **具体做法**：
     - 读邮件的上下文不持有 shell 或支付类工具（双模型/隔离总结器）；
     - 连接器令牌放在 agent 沙箱之外；
     - agent 收件箱按 Mail Manus 的做法设白名单；
     - 发布一页 "your mail can't command LISA" 的安全说明，并配回归测试（混淆指令用例集）。
5. **把 Reve 做成"可审计的 Dream"，占住差异化。**
   - "Memory and Dream"（Cue）和 Dreams（Anthropic research preview）说明"做梦式记忆整理"正在变成通用卖点 [官方][5][51]。
   - LISA 的差异应放在**可见、可逆**上：每晚 Reve 生成一份 diff，说明合并了什么、遗忘了什么、为什么；用户可以一键回滚。
   - 这直接服务于论文主线（长程一致性、soul 稳定性），可把"Reve 前后的一致性指标"做成公开评测。
6. **"一个 soul，多只手"对比 Cue 的"一群职能 agent"。**
   - Cue 的每个 agent 各自记忆、弱人设，靠群聊拼接 [官方][5][推测]。
   - LISA 可以让同一个 soul 调度多个 worker：研究 worker、Claude Code 会话（已有 PTY 控制面）、邮件或盯守 worker。UI 上借用 Cue 的"群聊"形式展示分工，记忆和人格保持单一连续。
   - 这也可以作为论文里 "role-agent swarm vs single soul" 的对照实验。
7. **新增"盯守—抢占"（Watcher）原语，跑在本地 Mac 上。**
   - Cue 官方示例里价值最高的一类就是盯 DMV 空位、营地放号、降价、补货 [官方][1]。
   - LISA 已有 digest 和重要邮件提醒，可以抽象出统一的 Watcher：条件 + 检查频率 + 命中动作（默认只通知，下单需审批）。
   - 在用户 Mac 本地运行，不消耗云端额度；以此回应 Cue 周额度和积分焦虑引起的吐槽 [实测][32][社区][44]。
8. **支付先做审批 UX，暂不接钱。**
   - Cue 和 Muse 都落在 Stripe Link 上，逐笔批准，Cue 仅限美国 [实测][31][30][官方][45]。
   - LISA 可以先在 Lisa Pocket 建统一的**审批队列**（推送 + Face ID，覆盖发信、预约、付款），支付后续直接接 Link wallet for agents：OAuth 加一次性卡，不碰卡号。
   - 这样与现有的 consent-gated 架构和 IAP 计费保持解耦。
9. **本地"自有电脑"可以是一项差异功能。**
   - Cue 的"电脑"是共享云主机，远程桌面卡顿 [实测][32]。
   - LISA 可以在用户 Mac 上给 agent 一个隔离工作区，比如独立 macOS 用户、容器或 Virtualization.framework 虚拟机。
   - 同样是"agent 有自己的电脑"，但数据不出本机、零额外成本，是隐私叙事的强证据 [推测]。
10. **用"数据主权与可移植性"对冲信任问题，同时审视自己的模型路由。**
    - Manus 曾因监管强制删除用户数据，并长期背着中国管辖的疑虑 [官方][14][媒体][48]。LISA 的开源、本地优先、BYO key 是天然的反叙事。
    - LISA 云端生产曾跑智谱 GLM（v0.27.1 起已切到 Gemini 2.5 Flash，见 [RELEASE_v0.27.1](../../RELEASE_v0.27.1.md)）。模型供应商的管辖地同样是用户会问的信任问题。
    - **建议**：云版保持逐目的地披露与同意（已上线），并允许用户按地区或偏好选择供应商；提供一键导出记忆与知识库，承诺"永不强制删除"。
11. **学它的获客素材，别学它的定价迷宫。**
    - 可借鉴：Cue 官网按场景分类的约 260 条"可直接复制的任务"，以及 "See how people use Cue" 画廊 [官方][1][实测][30]。LISA 开源社区可以沉淀 recipe、skill 画廊。
    - 技能格式对齐 GitHub 导入与 SKILL.md 生态 [实测][31]，与 dsh harness 对齐工作衔接。
    - 要避开：iOS 与 web 价格不一致、层层附加费；Cue 为此在社区被骂"引流" [社区][42]。LISA 的 12 小时 $5 会话额度和 IAP 应在各端一致，并在执行前预估花费。

---

## 17. 开放问题与信息缺口

- **电话**：号码、语音、短信的供应商（子处理方只列 Twilio 用于 SMS 通知）；可用国家清单；号码类型；是否录音；来电或外呼时是否披露 AI；通话怎么计费。
- **邮箱**：`@bot.cue.im` 是否基于 AgentMail；入站过滤和白名单机制；发信信誉与反滥用策略。
- **钱包**：官方未点名 Link 或 Stripe；预算上限怎么配置、与逐笔批准的关系；非美国何时开放；有无独立 KYC、稳定币或 x402。
- **电脑**：每 agent 一台（官方）还是账户内共用（实测），存在冲突；隔离粒度；数据保留期（7/14 还是 7/21 天）同样冲突。
- **模型**：Cue 和 Manus 2.0 实际用的模型组合；是否按地区使用不同模型（包括国产模型）。
- **Dream**：具体机制，用户能否查看、编辑、删除记忆。
- **群聊**：agent 间协议；真人能否加入；商家 agent 的接入计划、合作商家名单、开发者 API。
- **定价**：早期访问结束后的正式价格；Plus 的定价（$20 仅有单一来源）；周额度的具体数值；号码续费价（$0.99 还是 $9.99）的最终口径。
- **牵引力**：注册数、候补人数、留存；Play 下载数显示 "0+" 的原因。
- **平台**：iOS 何时过审；Windows 与 web 的实际可用时间（官网和实测不一致）。
- **治理**：Cue 数据是否与中国区产品隔离；子处理方清单何时更新以覆盖 Cue；有无美国监管机构或议员关注（未找到）。
- **可信度提示**：本文大量细节依赖 9/29–9/30 的少数实测（小墨同学、AI范儿、Paul Klay）和社区帖。产品正在快速迭代，价格与平台信息可能已经变化。

---

## Sources

1. https://cue.im — Cue by Manus 官网（首页、FAQ、前端 bundle 内约 260 条示例任务）— Butterfly Effect Pte. Ltd. — 访问于 2026-09-30
2. https://cue.im/feedback — Cue 反馈页（问题分类含 Phone/Wallet/Email/Group chat/Memory and dream/Payment and subscription）— Cue — 访问于 2026-09-30
3. https://manus.im/blog/introducing-manus-2-0 — "Introducing Manus 2.0" — Manus 官方博客 — 2026-09-28
4. https://help.manus.im/en/articles/17190150-what-is-new-in-manus-2-0 — "What is new in Manus 2.0?" — Manus 帮助中心 — 2026-09-28（另参 https://releasebot.io/updates/manus 的更新汇总）
5. https://play.google.com/store/apps/details?id=ai.manus.agents — "Cue by Manus"（描述、评分、用户评论）— Google Play / Butterfly Effect — 更新于 2026-09-30
6. https://play.google.com/store/apps/datasafety?id=ai.manus.agents — Cue 数据安全声明 — Google Play — 访问于 2026-09-30
7. https://manus.im/en/terms — Terms of Use（§2.7/2.8/2.12/2.13/4.3/5.4/12.1）— Butterfly Effect — 最后更新 2026-09-28
8. https://manus.im/privacy — Privacy Policy（抓取时渲染为日文译本）— Butterfly Effect — 最后更新 2026-09-28
9. https://trust.manus.im/subprocessors 与 https://trust.manus.im/faq — Manus Trust Center（子处理方、数据存储地、认证）— Manus — 访问于 2026-09-30
10. https://manus.im/pricing — Manus Plans & Pricing — Manus — 访问于 2026-09-30
11. https://manus.im/blog/manus-agents-telegram — "Introducing Manus in Your Chat" — Manus 官方博客 — 2026-02-16
12. https://manus.im/docs/features/mail-manus — Mail Manus 文档 — Manus — 访问于 2026-09-30
13. https://manus.im/blog/manus-100m-arr — Manus $100M ARR 更新 — Manus 官方博客 — 2025-12-17
14. https://manus.im/blog/a-note-to-our-users — "A Note to Our Users" — Manus 官方博客 — 2026-08-11
15. https://help.manus.im/en/articles/16147831-service-change-overview-what-s-happening-and-am-i-affected — Service Change Overview — Manus 帮助中心 — 2026-08
16. https://x.com/CueAgents — Cue Agents 官方 X 账号 — X — 访问于 2026-09-30
17. https://finance.yahoo.com/technology/ai/articles/manus-expands-ai-tools-renewed-175746537.html — "Manus Expands AI Tools in Renewed Push Into Agent Market" — Bloomberg（Micah Barkley，Yahoo 转载）— 2026-09-28
18. https://techcrunch.com/2026/09/18/manus-seeks-4b-valuation-in-new-500m-fundraise-as-it-resumes-independent-ops/ — TechCrunch（Ram Iyer）— 2026-09-18
19. https://www.implicator.ai/manus-cue-agents-phone-numbers-wallets/ — Implicator.ai（Marcus Schuler）— 2026-09-28
20. https://thenextweb.com/news/manus-2-0-cue-ai-agents-email-phone-wallet — The Next Web（Ana Maria Constantin）— 2026-09-29
21. https://www.computerworld.com/article/4228305/metas-ex-launches-agent-rival-to-metas-muse-2.html — Computerworld（Gyana Swain）— 2026-09-29
22. https://gigazine.net/gsc_news/en/20260929-manus-2-0 — GIGAZINE — 2026-09-29
23. https://www.briefs.co/news/manus-rolls-out-manus-2-0-and-cue-app-pushing-personal-ai-ag/ — Briefs（Kalbir Talwar）— 2026-09-28
24. https://runtimewire.com/article/manus-cue-personal-agents-launch — Runtime Wire（Ryan Merket）— 2026-09-28
25. https://www.testingcatalog.com/manus-2-0-launches-with-studio-cloud-computer-and-cue/ — TestingCatalog — 2026-09-29
26. https://cellcog.ai/blog/manus-2-0/ — CellCog 博客（竞品方撰写，引用 Manus 9/28 X 帖："select countries…voice-only support in some"）— 2026-09-28
27. https://www.theneuron.ai/digest/everything-that-happened-in-ai-today-monday-september-28-2026/ — The Neuron — 2026-09-28
28. https://fourweekmba.com/ai-manus-2-agent-identity-layer-cascade/ — FourWeekMBA（Gennaro Cuofano）— 2026-09-29
29. https://www.darkreading.com/application-security/prompt-injection-bug-agentic-ai-app-manus — Dark Reading（Nate Nelson）— 2026-09-24
30. https://x.com/PaulKlayVC/article/2104738896860856589 — "introducing Cue: the Grok Bot & Muse killer (full guide)" — Paul Klay（X 长文，获早期访问的实测）— 2026-09-29
31. https://x.com/xiaomovps/article/2104773463403872409 — 《Manus 新品 Cue 上手指南》— 小墨同学（X 长文，Mac 中文界面实测）— 2026-09-29
32. https://www.163.com/dy/article/L8101OTU0556703U.html — 《Muse 之后又来新选手？Manus 新产品 Cue 的第一轮实测》— AI范儿（网易号）— 2026-09-29
33. https://www.53ai.com/news/LargeLanguageModel/2026092997654.html — 《Manus 团队新产品发布，Cue 一手体验！》— 53AI（杨芳贤）— 2026-09-29
34. https://www.36kr.com/p/4003960773972097 — 《Manus回来了，更新2.0并发布全天候智能体Cue》— 36氪/机器之心 — 2026-09-29
35. https://www.36kr.com/p/4004527155171460 — 《Manus 回来了，可Agent 的战场已经挤满对手》— 36氪（李炤锋）— 2026-09-29
36. https://m.cls.cn/detail/2495046 — 《Manus 2.0携Cue归来，AI Agent混战再添变量？》— 财联社/科创板日报 — 2026-09-29
37. https://news.pedaily.cn/202609/569758.shtml — 《Manus 2.0回来了，给AI配手机号和钱包…》— 投资界（转量子位）— 2026-09-29
38. https://www.163.com/dy/article/L825C9AE051188EA.html — 《Manus续了一命》— 虎嗅（黄天媛，网易转载）— 2026-09-30
39. https://www.163.com/dy/article/L8325EF305319LDA.html — 《Manus 归来，能靠Cue赢回Agent战场吗？》— Tech星球（华卫，网易转载）— 2026-09-30
40. https://www.sina.cn/weibo/detail/5348481842807682.html — 肖弘即刻长文转载（Cue 定义、国内版筹备）— 新浪 — 2026-09-29
41. https://linux.do/t/topic/2966520 — 「Cue 电话号码」— LINUX DO 社区 — 2026-09-29
42. https://linux.do/t/topic/2966294 — 「Manus号码$0.99上车即下车，次月$9.9？」— LINUX DO 社区 — 2026-09-29
43. https://news.ycombinator.com/item?id=49258764 — "Manus will return to operating as an independent company" — Hacker News — 2026-08-11
44. https://news.ycombinator.com/item?id=49260310 — "Does anyone here use Manus actively?" — Hacker News — 2026-08
45. https://stripe.com/blog/giving-agents-the-ability-to-pay — "Giving agents the ability to pay" — Stripe 官方博客 — 2026-04-29
46. https://techcrunch.com/2026/04/30/stripe-link-digital-wallet-ai-agents-shopping/ — TechCrunch（Stripe Link for agents）— 2026-04-30
47. https://stripe.com/customers/manus — Stripe 客户案例：Manus — Stripe — 日期未标（约 2025）
48. https://www.morganlewis.com/pubs/2026/05/the-manus-decision-chinas-first-ai-security-review-block-and-implications-for-cross-border-ai-investment — Morgan Lewis — 2026-05
49. https://docs.fcc.gov/public/attachments/DOC-400393A1.pdf — "FCC Makes AI-Generated Voices in Robocalls Illegal" — FCC — 2024-02-08
50. https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/ — TechCrunch（OpenAI Dots）— 2026-09-29
51. https://platform.claude.com/docs/en/managed-agents/dreams — "Dreams"（research preview）— Anthropic Claude Platform Docs — 2026
52. https://techcrunch.com/2026/04/27/china-vetoes-metas-2b-manus-deal-after-months-long-probe/ — TechCrunch（标题与日期据检索结果，未全文抓取）— 2026-04-27
53. https://www.axios.com/2026/09/08/meta-debuts-muse-personal-ai-agent — Axios（Muse 发布，标题与日期据检索结果，未全文抓取）— 2026-09-08
54. https://www.agentmail.to/ — AgentMail 官网，"Email Inboxes for AI Agents"（YC 公司；产品描述据检索摘要）— AgentMail — 访问于 2026-09-30
55. https://siliconangle.com/2026/09/29/openai-launches-dots-always-on-ai-agents-in-chatgpt-with-their-own-cloud-computers/ — SiliconANGLE（Dots 自有云电脑；标题据检索结果，未全文抓取）— 2026-09-29
