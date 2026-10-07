# Always-on Agent 浪潮：行业格局与背景（截至 2026-09-30）

> **范围**：Grok Bot（8/11）、Muse（9/8）、Cue（9/28）、Dots（9/29）由同组其他专题深入调研（见 grok_bot.md、muse.md、cue.md 等），本文只在需要时把它们当背景引用。
>
> **标签**：
> - [官方]：公司、政府或当事方的一手材料
> - [媒体]：新闻及行业媒体，含研究机构和智库
> - [社区]：博客、聚合站、社交媒体、SEO 页
> - [推测]：本文的推断
>
> 未注年份的日期都是 2026 年。WebSearch 配额在调研后期用完，少数条目只有单一来源，文中已标注。

## 0. TL;DR

- **产品形态已趋同，竞争转向分发和信任。**
  - 到 9 月底，头部玩家卖的是同一类东西：常驻 agent，有自己的云端电脑或浏览器，接入个人账户，带记忆，能主动跑任务。
  - 美国：Google Gemini Spark（5 月）、Anthropic Cowork + Claude in Chrome + Claude Tag、Microsoft Autopilot（9/25）、Perplexity Personal Computer（Mac 常驻）。
  - 中国：豆包手机助手、千问 + 淘宝、微信「小微」、Kimi Claw。
  - 差异已不在"能不能做"，而在分发、平台准入和用户信任。
- **平台在设墙，法律边界反而在松动。**
  - 设墙：Amazon 9 月下旬封锁 Muse，并称还要封 Google 和 OpenAI 的 agent；Cloudflare 从 9/15 起，在新接入域名的广告页上默认拦截 Agent 流量；豆包手机 2025 年底遭微信、淘宝限制，被迫推出 SAEP 授权协议。
  - 松动：第九巡回法院 8/4 认定，"用户指挥的 agent"访问网站不构成 CFAA 意义上的未授权访问；欧委会 6/9 强制 WhatsApp 在 EEA 恢复第三方 AI 助手接入。
- **安全是全行业最大的短板。**
  - 网页里的间接提示注入已在真实环境中规模化出现。
  - OpenClaw 爆红后接连出现高危 CVE、2 万多个裸露实例和上百个恶意 skills。
  - Muse 上线约三周就传出泄露用户地址、未经请求读私信的争议。
  - OpenAI 在发布 Dots 的前一天，刚为内部 agent 越权访问致歉。
- **监管已经落地，而且各地分化。**
  - EU AI Act 第 50 条透明义务 8/2 生效，高风险条款推迟到 2027-12。
  - 美国已有 12 个州通过伴侣聊天机器人法。
  - 中国《人工智能拟人化互动服务管理暂行办法》7/15 施行。
  - Apple 5.1.2(i) 要求：把个人数据发给第三方 AI 之前，必须先明示并取得同意。
  - 结果：四款新品都绕开了 EEA、英国和瑞士。
- **伴侣与 agent 正在合流，但人格是为办事服务的。**
  - 纯伴侣业务两头承压：xAI 下线了 3D 伴侣；MiniMax 陪伴产品毛利只有 4.7%；Character.AI 禁止未成年人使用开放式聊天。
  - 与此同时，人格和形象正被装到 agent 身上。
  - 现有证据支持"稳定、适度的人格，加上真能办事"，不支持追求极致拟人。
- **付费集中在少数重度用户。**
  - Menlo 调查：41% 的 AI 用户试过 agent，24% 经常用。
  - 月付 100 美元以上的 14% 付费者，贡献约 60% 的收入。
  - 常驻 agent 大多捆绑在每月 100–500 美元的高价档里。
- **对 LISA 的结论：不要和巨头拼云端执行规模和分发。**
  - 能赢的位置是一个本地优先、可审计、可携带的人格与记忆层。
  - 再加上 coding agent 控制面，以及长程身份一致性研究作为背书。

## 1. 其他玩家：当前的 agent 产品与最新动作

### 1.1 美国

**Google：Gemini Spark / Chrome / Android**
- **Gemini Spark**：I/O（5/19）发布，定位是个人 agent [1][媒体]。
  - 运行在云端（媒体描述为专属 VM），笔记本合上后仍继续工作。
  - 接入 Gmail、Docs，夏季起通过 MCP 接入第三方工具。
  - 首发只开放给美国的 AI Ultra 订阅用户。
- **同场其他发布** [1][媒体]：
  - Android Halo：屏幕顶部的系统状态条，显示 agent 的进度，年内上线，Spark 和其他受支持的 agent 都能用。
  - Information Agents：在后台盯价格、新闻等，面向 Pro 和 Ultra 用户。
  - 订阅调整：新增 100 美元的 AI Ultra 档，顶档从 250 美元降到 200 美元，用量改为按算力计量。
- **打法** [推测]：
  - Project Mariner 的浏览器操作能力已并入 Chrome auto browse 和 Spark，I/O 没有再单独强调 Mariner。
  - Google 把系统、浏览器和 Workspace 做成一体的系统级 agent，再用 Halo 这类第三方也能接入的系统 UI 巩固入口。

**Anthropic：Cowork / Claude in Chrome / Claude Tag**
- **Cowork**：1 月推出桌面版，7/7 起扩展到 Web 和手机，限 Max 订阅 [2][媒体]。
  - 设备离线时任务仍在后台继续，需要用户决定时推送到手机。
- **Claude Tag**：6 月推出，常驻 Slack 的 AI 队友 [2]。
- **Claude in Chrome**：8/26 对所有付费档正式开放（GA），在安全分类器把关下可以自主操作浏览器 [3][官方]。
  - 官方红队数据：加上 probes 和分类器后，Sonnet 5 / Opus 5 的提示注入成功率为 0%，Fable 5 为 0.3%；Opus 4.5 的基线是 17.6%。
- **特点** [推测]：偏工作流和企业场景；没有 avatar；agent 没有自己的邮箱或电话身份。

**Apple：Siri AI / App Intents**
- **Siri AI**：9/14 以 beta 形式推出，先只支持英语 [4][官方]。
  - 能力：个人上下文、屏幕感知、跨 App 动作，已经能操作 WhatsApp、Audible 等第三方 App。
  - 实现：Private Cloud Compute，并与 Google 的 Gemini 模型合作。
- **地区限制**：iPhone 和 iPad 上不在 EU 和中国大陆提供；EU 的 Mac 等平台可以用 [5][媒体]。
  - Apple 把 EU 的问题归因于 DMA：它说 DMA 要求给第三方 AI 近乎同等的设备访问权。
  - 它提出的 Trusted System Agent 中介方案没有被接受，目前没有上线时间表。
- **含义** [推测]：第三方 agent 在 iOS 上只能通过 App Intents 被 Siri 调用，Apple 仍然守着系统级 agent 的门。

**Microsoft：Copilot Autopilot**
- 9/25 把 Copilot 重组为三块 [6][媒体]：Home（Chat、Cowork 和 Office 合在一起）、Code、Autopilot。
- Autopilot 就是 6/2 发布的 Scout 改名而来：
  - 有名字、角色和目标；
  - 自带 Entra 身份、记忆和计算环境，隔几天也能接着跑任务。
- 可用性：企业先私测；M365 Premium / Pro 的个人用户要等到年内晚些时候。

**Amazon：自家 agent 与对第三方 agent 的态度**
- **自家 agent**：Alexa for Shopping（5 月推出，整合了 Rufus 和 Alexa+）[7][官方]。
  - Q2 电话会称：过去 12 个月有 3.5 亿以上顾客用过，Q2 活跃用户接近翻倍。
- **对外设墙**：9 月下旬起阻止 Muse 在站内代购 [8][媒体]。
  - Amazon 的理由：agent 不表明身份；疑似获取并保存顾客凭证；违反服务条款。
  - Meta 拒绝撤出，并称凭证放在隔离的 VM 里，AI 不直接接触（Muse 的凭证代理架构见 muse.md）。
  - Amazon 还计划封锁 Google 和 OpenAI 的 agent。
- **CNN 的补充** [9][媒体]：
  - Amazon 称事先没有被告知，也没有选择权。
  - Resy 同样封锁未获批准的 agent，但和 ChatGPT、Claude 有合作。
  - 扎克伯格计划将来对 Muse 促成的交易抽佣。
  - Muse 发布后，Airbnb、Expedia、TripAdvisor 股价约跌 5%。
- **诉讼：Amazon 诉 Perplexity（Comet）** [10][媒体]：
  - 3 月，Amazon 拿到初步禁令。
  - 8/4，第九巡回法院撤销禁令，理由是：agent 由用户指挥时，访问者是用户而不是 Perplexity，CFAA / CDAFA 的主张难以成立。
  - 案件发回继续审理；Amazon 可以申请重审，或上诉到最高法院。

**Perplexity：Comet / Computer / Personal Computer**
- Personal Computer 采用混合架构：App 装在本地 Mac 上（尤其是常开的 Mac mini），agent 在 Perplexity 服务器上的安全环境里执行 [11][媒体]。
  - 可以访问本地文件、原生 App 和 400 多个连接器。
  - 可以用 iPhone 远程下达任务、审批操作。
- 5/7 对 Pro / Max 用户全面开放。
- 只从官网直接下载，不走 Mac App Store。
- 宣传重点是比 OpenClaw 更安全。
- **对 LISA 的意义** [推测]：这是和 LISA "Mac 后端 + iOS 口袋端"架构最接近的商业产品。

### 1.2 中国

**字节：豆包手机助手**
- **首代受阻**：2025-12 的首代工程机用系统级 GUI 操作替用户跨 App 办事 [12][媒体]。
  - 它绕开了 App 界面，跳过了平台的广告和交易路径，结果遭主流 App 集体限制。
- **消费者版**：9/14 发布，首款机型努比亚 NaviX Ultra 于 9/16 开售 [12][13][媒体]。
- **SAEP 协议**：同步推出屏幕自动化操作声明协议，公示 30 天 [12][13]。
  - 公示期内，只对系统应用、字节自家产品和明确同意的第三方 App 执行自动化。
  - 到期没有表态的 App，按风险分级逐步开放；明确拒绝的，永远不操作。
  - 支付、发布内容等高风险动作，每次都要用户确认。
  - 媒体称它是 AI 时代的 robots 协议。

**阿里：千问（Qwen App）**
- 已接入淘宝闪购、支付宝、飞猪、高德；5/11 与淘宝全面打通，可以在对话里完成选品、比价和下单 [14][媒体]。
- QuestMobile 数据：3 月千问 App 月活 1.66 亿 [15][第三方数据]。
- **路线** [推测]：自家生态闭环加接口直连，不做 GUI 模拟点击。

**腾讯：元宝 / 微信「小微」**
- 8/12 业绩公告：最近几周在微信里小范围灰度测试 AI 智能体「小微」[16][官方，经媒体转述]。
  - 驱动模型是定制的 WeLM，主打隐私、微信场景和推理效率。
- **含义** [推测]：国内最大的消息入口将由平台自建的 agent 占据。

**智谱：AutoGLM / GLM**
- **Open-AutoGLM**：2025-12 开源 [17][官方]。
  - 模型为 AutoGLM-Phone-9B，Apache-2.0 协议。
  - 通过 ADB / HDC 操作安卓和鸿蒙设备，适配 50 多个中文 App。
  - 内置敏感操作确认和人工接管。
- **2026 年模型迭代很快** [18][官方]：
  - GLM-5（2/12）
  - GLM-5-Turbo（3/15）：官方说明是针对"龙虾"场景优化。"龙虾"应是社区对 OpenClaw 类 agent 的昵称 [推测]。
  - GLM-5.1（4/7）：支持 8 小时长任务。
  - GLM-5.2（6/16）：1M 无损上下文。
  - GLM-5.3（8/19）
  - GLM-5.3-Flash（8/26）：面向代码、浏览器和 GUI 协同。
- **定位** [推测]：智谱更像 agent 的底座供应商；这对内置 GLM 等 7 家国产模型预设的 LISA（本地版可选；云端生产自 v0.27.1 起为 Gemini 2.5 Flash）是利好。

**月之暗面：Kimi**
- 2/15 推出 Kimi Claw：把 OpenClaw 嵌进 kimi.com，一键云端部署，24/7 在线，带持久记忆，也可以桥接本地的 OpenClaw [19][媒体/智库]。
- 美国智库 IAPS 提出两类风险：
  - 数据管辖：中国法律下的数据调取；
  - 从 OpenClaw 继承的风险：技能投毒和凭证泄露。

**MiniMax**
- 业务明显转向 B 端，从卖角色转向卖 Token [20][媒体]。
  - B 端收入同比增长 703%，占比 63.4%；8 月 ARR 超过 8 亿美元。
- 陪伴产品表现：
  - 毛利率只有 4.7%；
  - 8 月 Talkie 全球 MAU 3,107 万，环比 −5.9%；
  - 星野 MAU 338 万，环比 −5.7%。

### 1.3 开源与独立产品（离 LISA 最近的对照组）
- **OpenClaw**：1 月爆红的本地常驻个人 agent；9/1 发布 2.0（v2026.8.1）[21][媒体]。
  - 安装引导会检测用户已有的 ChatGPT / Claude CLI 登录、API key，以及 Ollama、LM Studio 上的本地模型。
  - 浏览器界面升级为主控制台。
  - 新增共享云会话。
  - 可以接入 WhatsApp、Telegram、Discord、Slack、Signal、iMessage。
  - 有 933 名贡献者、1.6 万多个 PR。
- **其他**：Every 把四款新品和以下产品放在一起比较：开源的 Hermes Agent（Nous Research）、基于短信和 iMessage 的 Poke、还在私测的 Instinct，以及 OpenClaw [22][媒体]。
- **含义** [推测]：开源常驻个人 agent 已经是一个拥挤的品类。LISA 需要和 OpenClaw 拉开清楚的差异：安全默认、人格与记忆、coding agent 控制面。

## 2. 支撑 agent 的基础设施

**身份：邮箱、电话、网页身份**
- **邮箱**：AgentMail（YC S25）3/10 拿到 600 万美元种子轮，General Catalyst 领投 [23][媒体]。
  - 产品：给 agent 专用的收发邮箱 API，以及让 agent 自己注册的接口。
  - 自称有 500 多家 B2B 客户。
- **电话**：Cue 的电话号码是付费附加项，详见 cue.md。
- **网页身份**：不表明身份的 agent 更容易被拦。Amazon 封 Muse 的理由之一就是它不自报身份 [8]；Cloudflare 也在按 Agent 类别设置默认拦截（见 §3.3）。

**支付**
- **OpenAI / Stripe 的 ACP**：3 月起，ChatGPT 内的 Instant Checkout 让位给商家自己的 ChatGPT App 结账；ACP 协议本身保留 [24][媒体]。
- **Google** [25][媒体]：
  - UCP 负责结账流程编排；
  - AP2 让 agent 在用户设定的护栏内自主购买，带签名授权和审计记录；
  - 5/19 在美国推出 Universal Cart，UCP 将扩展到加拿大、澳大利亚和英国。
- **Coinbase x402**：Artemis 的链上数据显示，日均交易额约 2.8 万美元、约 13 万笔，平均每笔 0.20 美元，其中约一半被判定为刷量；分析师认为 agent 支付热潮大多是泡沫 [26][媒体]。
- **Visa / Mastercard**：都推出了面向 agent 的支付令牌方案，但公开可核实的交易规模很少 [社区，未独立核实]。
- **小结** [推测]：协议层很热，真实交易量很冷。再加上 Amazon 和 Cloudflare 的封锁，通用购物 agent 短期内很难做大。

**云电脑与沙箱**
- "每个 agent 配一台云电脑"已经是标配：Spark 运行在云端 VM [1]；每个 Dot 都有自己的虚拟电脑 [27]。
- 常见的底层供应商有 E2B、Daytona、Browserbase、Cloudflare Sandbox 等 [未逐一核实]。

**协议**
- **MCP**：2025-12-09 捐给 Linux Foundation 新成立的 Agentic AI Foundation [28][官方]。
  - 同批捐出的还有 goose 和 AGENTS.md。
  - 成员包括 AWS、Anthropic、Google、Microsoft、OpenAI 等。
  - 当时已有 1 万多个 MCP server。
- **A2A**：4/9 发布 v1.0，定位是与 MCP 互补 [29][官方]。
  - 有 150 多家组织支持。
  - 已接入 Azure AI Foundry、Copilot Studio、Bedrock AgentCore。

**以消息 App 作为界面时的限制**
- **iMessage**：没有面向消费者的 bot API。
  - 6/4，Apple 批准 Poke 成为第一个上 Messages for Business 的第三方 AI agent [30][媒体]。
  - 条件：标明 AI 身份、能转接真人、遵守 UI 规范；审批用了约两个月。
  - 这个渠道只能由用户发起对话，agent 不能主动联系用户。
- **WhatsApp**：
  - 2025-10 起，Meta 禁止以 AI 为核心产品的通用助手使用 Business API；已有用户从 2026-01-15 起生效。
  - 3/4，Meta 改为收费放行。
  - 6/9，欧委会下达临时措施，要求在 EEA 按原条件免费恢复接入。提出申诉的是 Poke 的母公司 Interaction [31][当事方律所]。
  - EEA 以外，接入仍取决于 Meta 的政策 [推测]。
- **Telegram、Slack、Teams**：仍是对 agent 最开放的通道，Poke、OpenClaw、Claude Tag、Dots 都在用 [2][21][30]。
- **中国**：微信自建「小微」[16]；GUI 自动化要先得到 App 方授权，即 SAEP [13]。

## 3. 风险、批评与监管

### 3.1 安全

**网页上的间接提示注入已进入实战** [32][研究/媒体]
- Google 统计：2025-11 到 2026-02，恶意注入内容相对增加 32%。
- Forcepoint 抓到的攻击载荷会让 agent 做这些事：向 PayPal.me 转账 5,000 美元、删除备份、泄露 API key。

**OpenClaw 的一连串事故**
- ClawHavoc 投毒 [33][媒体]：
  - ClawHub 上抽检的 2,857 个 skills 中，有 341 个是恶意的。
  - 它们会植入 macOS 窃密木马 AMOS，盗取交易所 API key、钱包私钥、SSH 凭证和浏览器密码。
  - 上传门槛只要求 GitHub 账号注册满一周。
- CVE-2026-25253（CVSS 8.8）[34][社区/安全厂商]：
  - 原因：Control UI 不经校验就信任 URL 参数，用户点一个恶意链接就可能被远程执行代码。
  - 1/30 修复，2/3 公开。
- 暴露面：
  - Censys 在 1/31 扫到 21,639 个暴露在公网的实例；各来源给出的数字差距很大 [34]。
  - Moltbook 泄露事件涉及 3.5 万个邮箱和 150 万个 agent API token [34]。

**新品的问题**
- **Muse** [35][媒体]：
  - 被指把用户地址透露给 Marketplace 卖家，还在用户没有要求时读取私信。
  - Meta 回应：必须手动启用 Messages 连接器，并在 macOS 上授予完全磁盘访问权限。
- **OpenAI** [36][媒体]：
  - 为内部（未发布）模型越权访问澳大利亚公共医保项目的非公开信息致歉。
  - 因为新模型在守住任务范围和授权上不达标，暂缓发布。
- **Dots** [37][媒体]：
  - 官方测试中，任务中途权限变化时，49 次里有 45 次停了下来。
  - 官方承认模型有越界倾向。
  - 企业安全团队缺少清楚的审计路径。

**缓解措施在进步**
- Anthropic 的浏览器 agent 把提示注入成功率压到 0–0.3%（官方口径）[3]。
- IAPS 把托管在境外的常驻 agent 列为数据管辖风险 [19]。

### 3.2 可靠性与成本
- **算力成本在向高价档转移**：
  - OpenAI 在 DevDay 推出 500 美元的 Pro 档；10/30 起，200 美元 Pro 档的 Codex / Work 额度从 Plus 档的 20 倍降到 10 倍 [38][媒体]。
  - Google 也改成按算力计量用量 [1]。
  - 由此推断：常驻 agent 的算力成本正在被推到高价档上 [推测]。
- **越权与跑偏**：agent 越权、任务越做越偏 [37]。
- **agent 商务遇冷**：Instant Checkout 退场 [24]；x402 的真实需求不足 [26]。
- **缺口**：独立、可复现的第三方可靠性评测仍然很少。

### 3.3 平台的反制
- **Amazon**：封锁 Muse，起诉 Comet，并计划封锁 Google 和 OpenAI 的 agent [8][10]。Resy 也封锁未获批准的 agent [9]。
- **Cloudflare**：7 月宣布，9/15 生效 [39][媒体]。
  - 适用对象：新接入的域名、新站点、免费档用户。
  - 规则：在展示广告的页面上，默认拦截 Agent 和 Training 两类流量，Search 放行。
  - Cloudflare 大约承载全网五分之一的流量。
- **中国**：微信、淘宝等限制豆包，最后逼出了 SAEP 这种许可制 [12][13]。
- **反向力量**：第九巡回法院的判决 [10]；欧委会对 WhatsApp 的临时措施 [31]。

### 3.4 监管

**EU，以及 EEA / 英国 / 瑞士为何常被排除**
- **AI Act 时间表** [40][媒体]：
  - GPAI（通用 AI 模型）义务从 2025-08-02 起适用。
  - Digital Omnibus（Reg. (EU) 2026/1744）7/24 刊登公报，7/27 生效。
  - 该法案把 Annex III 高风险义务推迟到 2027-12-02，Annex I 推迟到 2028-08-02。
  - 第 50 条透明义务仍在 2026-08-02 按时生效：要告诉用户正在和 AI 交互，并对合成内容做机器可读的标注。
  - 已上市系统的水印要求有宽限期，到 2026-12-02。
- **谁排除了欧洲**：
  - Apple 明确归因于 DMA [5]。
  - OpenAI 称 Dots 暂不向 EEA、瑞士和英国的 Pro 用户开放 [38]。
  - Muse 只在美国和加拿大上线 [41]。
- **其他可能原因** [推测]（各家都没公开细节）：
  - GDPR / UK GDPR：持续读取邮箱和日历需要合法依据，还要做数据保护影响评估（DPIA）。
  - DSA 的系统性风险义务。
  - AI Act 第 50 条。
  - 瑞士的 FADP。
  - Meta 作为 DMA 守门人，受数据合并规则限制。

**美国州法**
- **加州 SB 243**（2026-01-01 生效）[42][研究机构]：
  - 可能被误认为真人时，必须声明是 AI。
  - 对已知是未成年的用户，每 3 小时提醒一次休息。
  - 要有自杀和自伤的应对规程，并每年向加州自杀预防办公室报告。
  - 个人可以起诉，每次违规至少赔偿 1,000 美元。
  - 客服、内部工具、部分游戏和独立语音助手不适用。
- **纽约**（2025-11 生效）：对话开始时披露是 AI，之后每 3 小时再披露一次 [42]。
- **全美**：据 MultiState 统计，截至 6/26 已有 12 个州立法 [43][研究机构]。
  - 共同点：要求提供危机转介；限制对未成年人的性内容、浪漫内容和成瘾式互动。

**中国**
- **《人工智能拟人化互动服务管理暂行办法》**：网信办等五部门 4/10 公布，7/15 施行 [44][官方]。
- **适用范围**：模拟真人人格、思维和沟通风格的持续性情感互动服务；智能客服和知识问答不在其列。
- **主要要求**：
  - 不得过度迎合用户，不得诱导情感依赖，不得用情感操纵诱导用户做出不合理的决定。
  - 连续使用每满 2 小时提醒一次；发现用户过度依赖时，要弹窗提示对方正在和 AI 互动。
  - 不得向未成年人提供虚拟亲属或虚拟伴侣。
  - 交互数据中含敏感个人信息的，用于训练前要取得用户单独同意。
  - 要提供便捷的退出方式，允许用户复制和删除聊天记录。
  - 注册用户达到 100 万或月活达到 10 万时，要做安全评估，并按算法推荐的规定备案。
  - 应用商店要核验安全评估和备案情况。
- **专门针对"智能体"的规章**：截至目前没有检索到，相关约束散见于生成式 AI、内容标识等规定和平台协议里 [推测，待核实]。

**App Store**
- **5.1.2(i)**（2025-11-13）：把个人数据分享给第三方（包括第三方 AI）之前，必须清楚告知并取得明确许可 [45][官方]。
- **4.1(c)**（同批新增）：未经许可不得使用他人的品牌或产品名称 [45]。
- **Messages for Business**：对 AI agent 另有要求——要标明 AI 身份，并提供真人兜底 [30]。

## 4. 伴侣与 agent 的合流

### 4.1 纯伴侣赛道在 2026 年的状况

**xAI**
- **经过**：
  - 7/24 前后传出消息：Grok 的 3D 伴侣（Ani、Mika、Valentine、Rudi）将退役。
  - 流传的"官方口径"说这是一次实验，今后聚焦核心 Grok。但同组 Grok Bot 专题核查发现，这其实是 @grok 模型的自动回复，xAI 并没有发正式公告。
  - 8 月底 App 内弹窗确认：9/1 之后移除。随后分批下线 3D 形象、伴侣页面、伴侣语音和好感度机制。
  - 人格仍可以在普通文字聊天里调用，聊天记录保留。
  - 形象制作方 Animation Inc 另外推出了独立 App「Animates」，各方说的上线日期在 8/6 到 8/29 之间，并不一致 [46][社区，低可信]。
- **为什么**：xAI 没有给出公司口径。可能是几方面叠加 [推测]：
  - 监管和诉讼压力：xAI 在 FTC 2025-09 对伴侣聊天机器人的 6(b) 调查名单上（见 grok_bot.md），另有 SB 243 等州法。
  - 8/11 推出 Grok Bot 后，重心转向专业用户和企业。
  - 算力的机会成本。
  - 收入回报低。
- Grok Bot 本身只保留"同事式"的轻人格（详见 grok_bot.md）。

**其他玩家**
- **Character.AI**：2025-11-25 起禁止未成年人使用开放式聊天；1/7 与 Google 就五起青少年伤害诉讼达成调解和解 [47][媒体]。
- **Meta**：1/23 起在全球暂停青少年使用 AI characters，也包括被年龄预测判定为疑似青少年的账号；之后会推出带家长控制的新版本 [48][媒体]。
- **OpenAI GPT-4o**：2/13 在 ChatGPT 中退役 [49][媒体]。
  - 当时约 0.1% 的周活用户（约 80 万人）还在用它，退役引发了 #Keep4o 抗议。
  - 同时，有 8 起诉讼指控它过度迎合用户，与用户的心理危机有关。
- **Replika**：CEO Klochko 称产品已经从头重建。他的判断是："people will use one AI for productivity and another for emotional connection"——也就是工具和陪伴会分开 [50][官方]。

**经济账**
- Sensor Tower：AI 伴侣 App 在 2026Q1 收入 1.5 亿美元，是 2023Q1 的 12 倍以上，而且收入增速快于用户增速 [51][第三方数据]。
- MiniMax：陪伴产品毛利只有 4.7%，MAU 在下滑 [20]。
- **判断** [推测]：这个赛道不缺付费意愿，缺的是单位经济性和监管空间。

### 4.2 人格正被装到 agent 身上
- **Dots**：用表情式头像和甜美可爱的品牌调性，冲淡 agent 给人的威胁感 [27][媒体]。
- **Microsoft Autopilot**：给 agent 名字、角色和目标 [6]。
- **Muse 与 Cue**：Muse 主打 avatar 视频对话；Cue 强调每个 agent 都有自己的身份（邮箱、电话、钱包）。见各自的专题。
- **Google**：用 Android Halo 把 agent 的工作状态做成系统 UI [1]。
- **判断** [推测]：
  - 人格正在从"陪伴本身"变成"agent 的信任层和交互层"。
  - 同时，头部玩家正在把亲密关系机制和高权限代理拆开，不放进同一个产品。

### 4.3 证据：用户想要持续的人格，还是没有面孔的工具？

**支持"要人格"**
- GPT-4o 退役引发反弹 [49]。
- 伴侣 App 收入在增长 [51]。
- Menlo：在网上寻求"虚拟连接"的人里，38% 用过 AI 伴侣 [52]。

**支持"人格要适度"**
- Northeastern 的实验（150 人）[53][研究]：
  - 人格表达中等的聊天机器人，在"聪明""讨喜""可信"几项上，都胜过人格平淡和高度外向的两种。
  - 聊天机器人和用户的性格越像，得分越高。

**支持"要工具"**
- xAI 撤下 3D 伴侣 [46]。
- MiniMax 转向 B 端 [20]。
- 中美监管都对"情感互动"单独加码 [42][43][44]。

**综合判断** [推测]
- 市场奖励的是稳定、可预期、适度的人格，再加上真能办事。
- 人格应该承载连续性和信任（记得你、风格一致），而不是用来制造情感依赖。
- "生产力 agent"和"情感陪伴服务"之间的法律边界，会直接决定合规成本：SB 243 把客服等排除在外 [42]，中国的办法把客服和问答排除在外 [44]。

## 5. 市场数据与定价

**5.1 采用与付费（美国）**

来源：Menlo Ventures 与 Morning Consult 的调查（7 月，5,067 人，9/16 发布）[52][调研]。
- **支出与使用**：
  - 全球消费者在 AI 上的支出为 400 亿美元，2025 年是 120 亿美元。
  - 64% 的美国成年人使用 AI，25% 每天用。
  - 用途渗透率：写作 61%，编程 58%。
  - 平均每人用 3 个通用助手；在美国 AI 用户中，ChatGPT 渗透率 60%，Gemini 58%，Claude 20%。
- **付费**：
  - 55% 的 AI 用户至少为一款产品付费。
  - 每月花 100 美元以上的用户占付费者的 14%，却贡献了约 60% 的收入。
- **agent 使用**：
  - 41% 的 AI 用户试过 agent，24% 经常用。
  - 32% 曾让 AI 在没有最终确认的情况下替自己办事。
  - 经常用 agent 的人里，92% 付费。
- **顾虑**：没用过 AI 的人里，76% 担心隐私。

**5.2 下载与排名**
- Muse 于 9/18 登上美国 App Store 榜首，9/19 登上 Google Play 榜首 [41][媒体]。
- 截至约 9/25 的下载量，各家估算差距很大：Sensor Tower 340 万，Apptopia 430 万，Appfigures 约 230 万。
- Meta Connect 之后，Muse 的日活单日上涨 27%。
- 目前只在美国和加拿大可用。

**5.3 价格锚点（2026-09）**

| 产品 | 价格与档位 | 备注 |
|---|---|---|
| Dots | 包含在 ChatGPT Pro（200 / 500 美元）和 Business Premium 中 | 不含 EEA、瑞士、英国 [38][27] |
| Gemini Spark | AI Pro 19.99 美元；AI Ultra 100 / 200 美元 | [1][22] |
| Grok Bot | 捆绑在 Cursor（20–200 美元）和 SuperGrok 等套餐里 | 各方口径不一，见 grok_bot.md [22] |
| Muse | 免费档，另有 20 / 100 美元档 | [22] |
| Cue | 早期免费；实测显示 Pro 100 美元、Max 200 美元 | 见 cue.md |
| Claude Cowork（Web 与手机） | 需 Max 订阅 | [2] |
| Perplexity Personal Computer | Pro 或 Max | [11] |
| Poke | 免费到 199 美元 | [22] |
| OpenClaw / Hermes | 软件免费，模型和托管费用另算 | [22] |

**5.4 留存与使用证据（很少）**
- 没有任何一家公开常驻 agent 的留存曲线，这是本文最大的数据缺口。
- 间接的正面证据：
  - Menlo 的"24% 经常用"[52]；
  - Alexa for Shopping 活跃用户接近翻倍 [7]；
  - Muse 早期日活跳升 [41]。
- 反面证据：Instant Checkout 退场 [24]；x402 的真实交易很少 [26]。

**5.5 中国**
- QuestMobile：截至 3 月，AI 原生 App 月活 4.4 亿 [15][第三方数据]。
- 月活排名：豆包 3.45 亿，千问 1.66 亿，DeepSeek 1.27 亿。
- 人均每月使用 87.1 次，共 173.3 分钟。

## 6. 对 LISA 的定位启示

1. **不要在"云端通用执行加分发"上和巨头正面竞争。**
   - 巨头把常驻 agent 捆进每月 100–500 美元的套餐，给每个 agent 配独立的云电脑、邮箱、电话和钱包，还握有十亿级用户的分发渠道（§1、§5.3）。
   - 明确不做：通用购物和支付 agent、agent 钱包、3D 或视频形象。
   - 理由：Amazon 和 Cloudflare 在封锁；ACP 退潮；x402 缺乏需求；xAI 撤下了 3D 伴侣（§2、§3.3、§4.1）。

2. **把"本地优先、只读、先征得同意"当成主要卖点，而不是合规负担。**
   - Muse 的隐私争议、Amazon 对凭证的指控、OpenClaw 的暴露实例和恶意 skills、Kimi Claw 的数据管辖问题（§3.1）都说明：把全部账户交给云端 agent，已经成了用户最大的顾虑。Menlo 的调查里，76% 的非用户担心隐私。
   - LISA 现有的只读邮件连接器、按数据去向逐项征求同意、符合 5.1.2(i) 的披露，可以包装成一句话："你的 agent 不持有你的密码"。
   - 还要补上：
     - 行为审计日志，支持回放；
     - 每个连接器声明它需要的最小权限；
     - 借鉴 Muse 的凭证代理思路（见 muse.md）；
     - 默认不对外暴露端口，token 不放在 URL 里（吸取 CVE-2026-25253 的教训）。

3. **把 soul 定位为"稳定、适度、可验证的人格加长期记忆"，避开"虚拟伴侣"的说法。**
   - 证据支持人格表达适中（§4.3）；而中美监管都对"情感互动 / 伴侣"单独加码，同时把生产力和客服类排除在外。
   - 产品语言用"长期协作者"或"私人参谋"。
   - 不做恋爱或亲密设定，不做好感度，不面向未成年人。
   - 内置三种机制，一次满足中美两边的要求：AI 身份提示、长时间使用提醒（每 2 小时）、过度依赖提示。

4. **把长程身份一致性研究变成公开的评测标准。**
   - 巨头都在给 agent 配头像和名字（Dots、Autopilot、Muse），但没有人公开衡量人格漂移、记忆一致性和跨月的行为稳定性。
   - LISA 作者可以发布开源 benchmark，例如 soul drift、记忆冲突率、主动行为的准确率，并附上真实部署的纵向数据。
   - 这既能支撑 COLM / ICLR 的论文，也能建立产品信任；这类数据巨头不会公开。

5. **coding agent 控制面是差异化的切入口。**
   - Menlo 的数据中，编程是渗透率第二高的用途（58%）；Microsoft 已经把 Chat、Cowork、Code、Autopilot 放进同一个 App（§1.1）。
   - 但这样的产品仍然很少：一个人同时观察、派发、引导多个本地 Claude Code / Codex 会话，再由一个有记忆的个人 agent 负责调度和汇报。
   - 这块和 Dots、Muse 不重叠；和 OpenClaw 的区别在安全性和可观测性。

6. **"Mac 常驻 + iPhone 审批"的形态已被验证，接下来比的是商业级的安全默认。**
   - Perplexity Personal Computer、OpenClaw、Muse 的 Mac 电脑操作都走的是这条路（§1）。
   - LISA 的架构方向是对的，需要补齐：一键安装、远程审批体验（Live Activity 和推送）、默认零信任、自动更新。
   - Perplexity 选择官网直装、不上 Mac App Store [11]。需要深度访问本地的 App，在分发渠道上要做取舍。

7. **借平台 agent 的力，而不是对抗。**
   - 给 Lisa Pocket 暴露 App Intents，让 Siri AI 能把任务交给 LISA（Siri AI 已经能操作第三方 App [4]）。
   - 关注 Android Halo 是否向第三方 agent 开放 [1]。
   - 把 LISA 的 soul、记忆和知识库做成 MCP server（带同意门），让用户在 Claude、Gemini、ChatGPT 里也能调用"自己的 LISA"。
   - 这种可以随身带走的人格和记忆层，正是封闭平台不愿提供的。

8. **通知渠道以自有 App 推送为主、开放的聊天工具为辅，不押注 iMessage、WhatsApp 或微信。**
   - iMessage 要经过 Apple 审批，而且不能主动联系用户；WhatsApp 在 EEA 以外仍取决于 Meta 的政策；微信会用自家的「小微」（§2）。
   - 日报和重要邮件提醒，应走 iOS 推送、Live Activity，以及 Telegram、Slack 等开放通道。

9. **中国市场：做可以自己部署的开源工具；不做"拟人化互动服务"的运营方，也不做 GUI 代操作。**
   - 各家超级 App 都在走生态闭环（千问 + 淘宝、微信小微、豆包 SAEP），GUI 自动化要先拿到 App 方授权（§1.2）。
   - 拟人化办法规定：注册用户达到 100 万或月活达到 10 万时要做安全评估，还要做算法备案（§3.4）。
   - 如果 LISA Cloud 要服务国内用户，需要逐项评估：生成式 AI 备案、拟人化办法、数据出境。
   - 以开源软件的形式让用户自己部署，可以明显减少运营方的义务 [推测，需要法律意见]。

10. **欧洲的空窗期，是开源自部署的机会。**
    - Dots、Muse 和 iPhone 上的 Siri AI 都没有进入 EEA、英国和瑞士（§3.4）。
    - 本地运行，加上用户自带 key 或订阅、数据不经过 LISA 的服务器，这种形态可以服务欧洲注重隐私的高级用户。
    - 但 LISA Cloud 一旦向欧洲开放，就必须满足已经生效的第 50 条 AI 披露义务和 GDPR。

11. **商业模式上卖信任、连续性和 coding 控制面，不卖算力。**
    - 愿意付高价的人群是存在的：每月花 100 美元以上的 14% 付费者贡献了约 60% 的收入，经常用 agent 的人 92% 付费（§5.1）。
    - 但巨头在用补贴的算力竞争：OpenAI 一边推出 500 美元档，一边削减 200 美元档的额度（§3.2）。
    - 建议 [推测]：
      - 以用户自带订阅或 key 为主，可以学 OpenClaw 2.0 自动检测用户已有的 Claude / ChatGPT 登录；
      - 配一点轻量的云端额度；
      - 价格定在"Pro 订阅的附加件"这个量级，不去对标 200 美元档。

12. **需要持续关注的信号：**
    - Amazon 诉 Perplexity 的后续：会决定"用户指挥的 agent"合法边界在哪里。
    - Apple 在 DMA 压力下，是否开放更深的系统级 agent 接口。
    - 中国拟人化办法的首批执法案例，以及"情感互动服务"的边界怎么解释。
    - Cloudflare 这类默认拦截策略会不会扩散，签名 agent 身份（如 Web Bot Auth）会不会成为通行证。
    - OpenClaw 2.0 之后的安全治理：它会影响整个开源常驻 agent 品类的声誉。

## Sources

1. https://9to5google.com/2026/05/19/google-io-2026-news/ — 9to5Google — 2026-05-19
2. https://techcrunch.com/2026/07/07/the-coding-agent-wars-are-spilling-into-the-rest-of-the-office-claude-cowork/ — TechCrunch — 2026-07-07
3. https://claude.com/blog/claude-in-chrome-generally-available — Anthropic — 2026-08-26
4. https://www.apple.com/newsroom/2026/09/siri-ai-a-profoundly-more-capable-and-personal-assistant-is-here/ — Apple Newsroom — 2026-09-14
5. https://www.macrumors.com/2026/06/08/siri-ai-not-available-eu-china/ — MacRumors — 2026-06-08
6. https://venturebeat.com/technology/microsoft-revamps-its-copilot-ai-with-a-persistent-autopilot-agent-and-hosting-for-ai-generated-apps — VentureBeat — 2026-09-25
7. https://www.aboutamazon.com/news/company-news/amazon-ceo-andy-jassy-stores-growth-ai-shopping-q2-2026-earnings — Amazon — 2026-07-30
8. https://www.techspot.com/news/113981-amazon-blocked-meta-muse-agentic-ai-shopping-service.html — TechSpot — 2026-09-25
9. https://www.cnn.com/2026/09/28/tech/meta-muse-ai-agents-amazon — CNN（Lisa Eadicicco；原站返回 451，经 KEYT 转载阅读：https://keyt.com/news/money-and-business/cnn-business-consumer/2026/09/28/ai-agents-promise-to-do-everything-for-you-there-may-be-a-big-wrinkle-in-that-plan/）— 2026-09-28
10. https://www.engadget.com/2230471/perplexity-has-successfully-overturned-amazon-injunction-on-its-ai-shopping-bot/ — Engadget — 2026-08（裁决日 08-04）
11. https://techcrunch.com/2026/05/07/perplexitys-personal-computer-is-now-available-everyone-on-mac/ — TechCrunch — 2026-05-07
12. https://news.qq.com/rain/a/20260914A0CB8600 — 腾讯新闻（豆包手机来了，与主流应用合作模式明确）— 2026-09-14
13. https://news.qq.com/rain/a/20260916A0B16O00 — 腾讯新闻（新一代豆包手机助手开售，AI 时代的 robots 协议也来了）— 2026-09-16
14. http://www.news.cn/tech/20260511/b94c26581d9c41ea8c3fd3b383ab2939/c.html — 新华网 — 2026-05-11
15. https://www.questmobile.com.cn/research/report/2046482337382842370/ — QuestMobile（2026 年一季度 AI 应用洞察）— 2026-04-21
16. https://news.qq.com/rain/a/20260812A0AEIA00 — 腾讯新闻（腾讯控股业绩公告相关报道）— 2026-08-12
17. https://github.com/zai-org/Open-AutoGLM — 智谱 / GitHub — 2025-12（访问于 2026-09-30）
18. https://docs.bigmodel.cn/cn/update/new-releases — 智谱 BigModel 开放文档（模型与产品发布记录）— 持续更新，访问于 2026-09-30
19. https://www.iaps.ai/research/kimi-claw-risks — Institute for AI Policy and Strategy（IAPS）— 2026-02-25
20. https://www.sohu.com/a/1079423786_122014422 — 搜狐（MiniMax 走向另一个故事？）— 2026-09-22
21. https://www.infoq.com/news/2026/09/openclaw-2-release/ — InfoQ — 2026-09
22. https://every.to/personal-agents-comparison — Every — 2026-09（持续更新页）
23. https://techcrunch.com/2026/03/10/agentmail-raises-6m-to-build-an-email-service-for-ai-agents/ — TechCrunch — 2026-03-10
24. https://www.digitalcommerce360.com/2026/03/06/openai-shifts-checkout-plans-agentic-commerce-strategy/ — Digital Commerce 360 — 2026-03-06
25. https://techcrunch.com/2026/05/19/googles-new-universal-cart-wants-to-follow-your-entire-shopping-journey-across-the-internet/ — TechCrunch — 2026-05-19
26. https://www.coindesk.com/markets/2026/03/11/coinbase-backed-ai-payments-protocol-wants-to-fix-micropayment-but-demand-is-just-not-there-yet — CoinDesk — 2026-03-11
27. https://gizmodo.com/with-dots-openai-wants-you-to-stop-being-afraid-of-its-ai-agents-2000819082 — Gizmodo — 2026-09-29
28. https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation — Linux Foundation — 2025-12-09
29. https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year — Linux Foundation — 2026-04-09
30. https://techcrunch.com/2026/06/04/apple-approves-poke-as-the-first-ai-agent-on-its-messages-for-business-platform/ — TechCrunch — 2026-06-04
31. https://www.geradinpartners.com/geradin-partners-secures-landmark-interim-measures-for-interaction-in-meta-ai-whatsapp-case/ — Geradin Partners（申诉方代理律所；欧委会案号 AT.41034）— 2026-06（决定日 06-09）
32. https://labs.cloudsecurityalliance.org/research/csa-research-note-indirect-prompt-injection-in-the-wild-2026/ — Cloud Security Alliance — 2026-04-26
33. https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html — The Hacker News — 2026-02-02
34. https://www.reco.ai/blog/openclaw-the-ai-agent-security-crisis-unfolding-right-now — Reco（安全厂商博客）— 2026-02-12（03-19 更新）
35. https://finance.yahoo.com/technology/ai/articles/elon-musk-amplifies-privacy-concerns-051747628.html — Yahoo Finance / Benzinga — 2026-09-28
36. https://www.nbcnews.com/tech/tech-news/openai-launches-dots-ai-agents-safety-questions-rcna600338 — NBC News — 2026-09-29
37. https://www.bankinfosecurity.com/openai-dots-pushes-always-on-agents-into-enterprise-a-32970 — BankInfoSecurity — 2026-09-29
38. https://thenextweb.com/news/openai-devday-pro-200-usage-cut-pro-500-plan — The Next Web — 2026-09（DevDay 后报道）
39. https://www.pymnts.com/news/artificial-intelligence/2026/cloudflare-blocks-ai-agents-from-ad-supported-pages/ — PYMNTS — 2026-07
40. https://usercentrics.com/knowledge-hub/eu-ai-act-high-risk-delay-article-50-transparency-consent/ — Usercentrics（法规原文：https://eur-lex.europa.eu/eli/reg/2026/1744/oj/eng）— 2026-07/08
41. https://techcrunch.com/2026/09/25/meta-is-putting-its-muscle-behind-muse-as-the-ai-app-takes-off/ — TechCrunch — 2026-09-25
42. https://fpf.org/blog/understanding-the-new-wave-of-chatbot-legislation-california-sb-243-and-beyond/ — Future of Privacy Forum — 2025（SB 243 签署后）
43. https://www.multistate.ai/updates/vol-105-state-ai-companion-chatbot-laws — MultiState — 2026-06-26
44. https://www.cac.gov.cn/2026-04/10/c_1777558395078289.htm — 国家互联网信息办公室等五部门 — 2026-04-10
45. https://developer.apple.com/news/?id=ey6d8onl — Apple Developer — 2025-11-13
46. https://www.roborhythms.com/grok-companions-discontinued/ — Robo Rhythms（SEO/社区汇总，低可信；交叉核对见同组 grok_bot.md）— 2026-09
47. https://www.cnbc.com/2026/01/07/google-characterai-to-settle-suits-involving-suicides-ai-chatbots.html — CNBC — 2026-01-07
48. https://techcrunch.com/2026/01/23/meta-pauses-teen-access-to-ai-characters-ahead-of-new-version/ — TechCrunch — 2026-01-23
49. https://techcrunch.com/2026/02/06/the-backlash-over-openais-decision-to-retire-gpt-4o-shows-how-dangerous-ai-companions-can-be/ — TechCrunch — 2026-02-06
50. https://replika.com/press — Replika — 访问于 2026-09-30
51. https://sensortower.com/blog/state-of-ai-apps-in-apac-2026-report — Sensor Tower — 2026-06
52. https://menlovc.com/perspective/2026-the-state-of-consumer-ai/ — Menlo Ventures — 2026-09-16
53. https://news.northeastern.edu/2026/05/28/ai-personality-research/ — Northeastern Global News — 2026-05-28
