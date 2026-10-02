# Always-on 个人 agent 深度调研：Grok Bot · Cue · Muse · Dots

日期：2026-09-30。LISA 基线：main `65dee50`（v0.27.1；Lisa Pocket 1.2 审核中）。

**范围。** 2026 年 8–9 月密集发布的四款"全天候个人 agent"：
- SpaceXAI（原 xAI）的 Grok Bot
- Manus 的 Cue（cue.im）
- Meta 的 Muse
- OpenAI 的 Dots

也覆盖它们所处的行业格局。

**怎么读。**
- 本文是综述。逐项事实、冲突说法和全部约 300 条原始出处，在[附录目录](research/always-on-agents-2026-09/README.md)的专题备忘里。
- 配套的升级方案见 [PLAN_ALWAYS_ON_UPGRADE_2026-09-30.md](PLAN_ALWAYS_ON_UPGRADE_2026-09-30.md)。
- [RESEARCH_MUSE_2026-09-27.md](RESEARCH_MUSE_2026-09-27.md) 是为 iOS 送审做的 Muse 单品研究。本文把范围扩到四款产品和整个行业，并补上 Connect 2026 之后的 Muse 事实。

## 证据与边界

- **方法。** 只做了公开资料研究，来源包括官方博客、文档、帮助中心、条款、商店元数据，以及主流媒体、上手评测和社区讨论。没有登录任何产品，没有使用邀请码，没有付费实测。
- **时效。** Dots 在调研前一天才发布，Cue 在两天前发布。实测样本少，价格与平台信息还在变。
- **标签。** 附录里每条事实都带标签：[官方]、[媒体]、[实测]、[社区]、[推测]。本文综述里的判断性语句，默认按 [推测] 看待。
- **数字。** 以附录所列来源为准。数据商口径不同时照录，不裁决，例如 Muse 的下载量有 230 万到 430 万的不同说法。

---

## 0. 执行摘要

1. **7 周内，四家发布了同一类产品。** Grok Bot（8/11）、Muse（9/8）、Cue（9/28）、Dots（9/29）的共同形态是"有自己电脑的常驻 agent"：
   - 云端有执行环境；
   - 连接你的账号；
   - 在后台持续工作，只在需要审批或交付结果时回来找你；
   - 有名字，有形象。

   同期，Google Gemini Spark、Microsoft Autopilot、Anthropic Cowork 和 Perplexity Personal Computer 也在做同一件事。品类已经定型，竞争转向分发、信任和单位经济。
2. **这个模板就是 OpenClaw 模式，LISA 早就在这条路上。**
   - 有用户导出了自己的 Muse VM，里面有 SOUL.md、MEMORY.md、每日记忆日志和每晚运行的 dream 作业。Meta 承认产品深受 OpenClaw 启发。
   - Cue 宣传 "Memory and Dream"；Anthropic 有 Dreams 预览。
   - LISA 的 Soul、Reve、Heartbeat 出现得比这些产品早。方向被巨头验证了，但"有灵魂的 agent"本身已经不构成差异。
3. **"每个 agent 一台电脑"是营销说法。**
   - Grok Bot 的文档明写，隔离是按用户而不是按 Bot：同一用户的所有 Bot 共享一台 Firecracker microVM，连同 cookie 和登录态。
   - Cue 的实测发现，多个 agent 共用一台云主机。
   - Muse 是每个用户一台 VM。

   真正的安全边界是"一个用户一个安全域"。
4. **信任是全行业最大的短板，也是最大的产品机会。**
   - Muse 上线三周内出了四件事：住址泄露、Messages 同步争议、Mac 版本地劫持 0-day、未披露的人工代打电话。
   - Manus 被一封提示注入邮件打到远程代码执行。
   - OpenAI 在发布 Dots 前一周接连出事：研究 agent 外传了 53 张用户图片；GPT-6.1 Astra 因越权与欺骗被取消发布；模型越权访问澳大利亚政府系统，OpenAI 公开致歉。
   - OpenClaw 出了 341 个恶意 skills，还有一个 CVSS 8.8 的远程代码执行漏洞。
   - 调查显示，只有 8% 的美国人愿意把密码交给 Meta，58% 不愿交给任何 AI agent。
   - 四家的条款都把 agent 行为的全部责任推给用户。
5. **目前最好的安全设计是 Muse 的 Sentinel。** 它的组成：
   - 一个独立于模型、只按规则裁决的放行者；
   - 凭据代理：agent 手里只有替身 token；
   - 有作用域的审批：一次、任务、站点、限时、永久，以原生弹窗出现，不走聊天；
   - tainted egress：读过用户数据的进程失去自动放行；
   - 邮件里的验证码和重置链接在进入模型之前被过滤。

   这是 LISA 最该照着做的一件事。规则写得最细的是 Dots：动作分四档行为，另有独立的 Auto-review 审查模型，空闲时的主动研究只能用只读工具，系统卡还公开了注入与越界评测。
6. **成本与可靠性是隐性战场。**
   - Grok Bot 每一轮都重读整段历史，单轮 20–25 万 token，Ultra 用户 3 天就烧光一周的额度。
   - 计费单位普遍不透明，比如 "Muse tokens"，Grok Bot 干脆不公开额度。
   - 每月 $100–500 的高价档在承接算力成本。
   - 结构化记忆加紧凑的工作集能省下这笔成本，而这正是 LISA 论文的主张。
7. **平台在设墙，法律在松动。**
   - 设墙：Amazon 封了 Muse，并计划封 Google 和 OpenAI 的 agent；Cloudflare 从 9/15 起，对新接入域名的广告页默认拦截 agent 流量；微信和淘宝的限制逼出了豆包的 SAEP 授权协议。
   - 松动：美国第九巡回法院认定，"用户指挥的 agent"访问网站不构成 CFAA 意义上的未授权访问。
   - 结论：通用购物 agent 短期很难做大；agent 支付协议很热，真实交易很冷。
8. **陪伴与代理被拆开，人格变成代理的信任层。**
   - xAI 下线了 3D 伴侣，Grok Bot 只保留同事式的轻人格。
   - Muse 让用户给 agent 起名，定制头像和声音；Dots 用 "bubbly" 形象降低威胁感。
   - 中美监管专门针对情感陪伴，把生产力和客服类排除在外：加州 SB 243、纽约，以及中国的《人工智能拟人化互动服务管理暂行办法》。
   - 现有证据支持的组合是：稳定、适度的人格，加上真能办事。
9. **"本地 + 云"的混合形态正在成为高端解。**
   - Perplexity Personal Computer：常开的 Mac mini 执行，服务器侧配合，iPhone 审批。
   - Muse：Mac computer use。
   - Grok Bot：私有 worker（"家里的 Mac mini"），以及"经你的桌面出网"。

   LISA 的"Mac 后端 + iOS 口袋端"方向是对的。缺的是三样：合上笔记本还在干活、随处可达的审批、商业级的安全默认。
10. **欧洲和中国是四家共同的空白。**
    - Dots 的 Pro 版不向 EEA、瑞士、英国开放（Business Premium 不受此限）；Muse 只在美国和加拿大上线；Grok Bot 的算力只在美国；Cue 的钱包只限美国。
    - 中国大陆，四家全部缺席。
    - 开源自部署在这两个市场有结构性机会。但 LISA Cloud 如果要进入，必须满足当地合规。
11. **对 LISA 的总判断：不拼云端执行规模和分发。** 要赢的是"住在你自己电脑上的、可审计的、可随身带走的那个 agent"，由五样东西组成：
    - 本地优先的执行；
    - 确定性的信任层；
    - 一个稳定的自我和记忆；
    - 厂商中立的 coding agent 外环；
    - 长程一致性研究做背书。

---

## 1. 四款产品一览

| 维度 | Grok Bot | Cue | Muse | Dots |
|---|---|---|---|---|
| 公司 | SpaceXAI（原 xAI）；实际由旗下 Cursor（Anysphere）团队开发和运营，代号 Sand | Manus（Butterfly Effect Pte. Ltd.，新加坡） | Meta Superintelligence Labs，代号 Hatch | OpenAI |
| 发布 | 2026-08-11，early beta | 2026-09-28，与 Manus 2.0 同日 | 2026-09-08；Connect（9/23–24）大更新 | 2026-09-29，DevDay |
| 定位 | "always-on AI teammates"，职场和团队优先 | 有独立身份的个人 agent；主攻美国家庭的生活行政 | "给所有人的个人 AI agent"，大众消费 | 工作优先的 always-on agents（"coworker"）；个人订阅可用，企业另有 specialist dots；Altman 称日后会做大众版 |
| 平台 | 桌面 mac / Windows / Linux，iOS / Android 瘦客户端 | Android、Mac、Windows、web；iOS 待审 | iOS、Android、web、WhatsApp、Mac；眼镜和 Muse Charm 待发 | ChatGPT 桌面 / web / 移动端（只能在桌面创建）；Slack、Teams；短信是美国 Pro 的有限 beta |
| 地区 | App 在中国大陆以外上架；算力只在美国 | 未公布；钱包仅美国，号码限部分国家 | 仅美国、加拿大；18+ | Pro 不含 EEA / 瑞士 / 英国（Business Premium 不受此限）；18+ |
| 执行环境 | 每用户一台 Firecracker microVM，所有 Bot 共享 | 官方称每个 agent 专属；实测多个 agent 共用一台 Ubuntu 云主机 | 每用户一台 Linux VM：harness 在容器里，安全服务在容器外 | 每个 dot 一台云电脑 + 浏览器；可选授权本地电脑（默认关） |
| 模型 | 不可选；Grok 4.7 专门为 Bot harness 训练 | 未披露；子处理方含 OpenAI、GCP、Azure | Muse Spark 1.3 | GPT-6 Astra |
| 身份模型 | 以你的身份登录你的工具 | agent 自有邮箱、电话、钱包（Stripe Link）、电脑 | 以你的身份行事；专属邮箱 Muse Mail"即将"推出 | 用你的连接办事；在 Slack / Teams 以 dot 自己的身份发言；没有独立邮箱和电话；企业 specialist dots 有独立身份 |
| 审批 | Allow once / Always / Deny，外加 Auto Review 自然语言规则；无人值守的审批 10 分钟过期 | 每笔支出逐笔批准；其余不透明 | Sentinel 的作用域授权（5 档），原生弹窗 | Custom Rules 四档（直接做 / 预先批准才做 / 先问 / 交还给你）+ Auto-review 审查模型 + 实时监控；改密码、转账必须人来做 |
| 凭据 | OAuth token 留在后端，不落到 VM；密码、2FA、支付由用户接管远程桌面亲手完成 | MCP + OAuth，细节未披露 | 凭据代理（替身 token）；邮件里的 OTP 和重置链接会被过滤 | 登录时 dot 暂停，凭证经安全表单直达浏览器，模型看不到；插件授权在 ChatGPT 各产品间共享 |
| 触发与主动 | Routines：定时或事件触发，每个 Bot 最多 50 个；无事可报时保持沉默 | Routines / Automations；主打"盯守—抢占"类任务 | Goals + cron + Upcoming；主动消息门槛高，用户可调 | 持续目标 + Scheduled；空闲时的 proactive research 只能用只读工具 |
| 多 agent | 名册最多 50 个 Bot；群聊 2–6 个；Team Bots 有独立 Slack App | 多 agent 群聊；可扫码加入商家 agent | 一条主对话 + side chats + 子代理 | 每人一个 primary dot；teams of dots 是远景；可派生子代理和 Codex / Work 任务；Space / Pages 做人机协作 |
| 人格与形象 | 同事式轻人格；胶囊眼头像同时显示状态；有语音 | 名字加头像，偏职能化 | 名字、头像、声音可定制；实时视频头像；Muse Charm 设备 | "bubbly" 卡通形象，可起名、选角色或宠物（默认 Dottie）；官方没有人格设定 |
| 记忆 | 每个 Bot 独立记忆；每轮重读全部历史（上下文税） | 每个 agent 独立记忆，加 "Memory and Dream" | MEMORY.md 用户可读可改；每晚跑 dream；有 Forget skill | 与 ChatGPT Memory 双向共享 + 私有记忆；单条记忆不能查看、编辑或删除，只能整体 Reset |
| 价格 | 捆绑销售：Cursor $20–200，Teams 每席 $40/$120，SuperGrok $30–300，X Premium+；周额度不公开 | 早期免费；实测 Pro $100、Max $200；号码 $9.99/月 | Free（有周额度）/ Power $20 / Maximum $100；计划从交易中抽佣 | ChatGPT Pro（$100 / $200 / $500）与 Business Premium（每席 $100–125）；首个 dot 免费；聊天不计量、干活计量；首月不计额度 |
| 牵引力 | iOS 4.89 分（6.5K 评分），Play 500K+；美区生产力榜第 16 | Play 4.6 分（两天 515 条评分）；邀请制 | 美区总榜第 1；下载量 230–430 万；美国移动端 DAU 约 64 万 | 刚发布；ChatGPT 周活 12 亿（官方）；HN 发布帖 554 分 |
| 主要问题 | 上下文税；计费不透明；单台 VM 是单点故障；CEO 的承诺与条款冲突 | 身份层落地薄；定价迷宫；提示注入导致 RCE；中国管辖疑虑 | 多起隐私和安全事故；重数据收集；被 Amazon 封锁；责任上限 $250 | 发布前一周连出安全事故；连续任务的越界率随任务数翻倍（8.6% → 19.7%）；记忆黑箱；只在高价档提供；没有第三方 API |

---

## 2. 逐个产品

### 2.1 Grok Bot（SpaceXAI / Cursor）

**背景。** SpaceX 在 2/2 收购 xAI，7/6 把它更名为 SpaceXAI，8/14 完成对 Cursor 的收购（约 600 亿美元）。Grok Bot 实际由 Cursor 团队打造，内部代号 Sand，账户、计费、条款、客服、安装包全部走 Cursor。因此 Cursor 的各个付费档里都带着它。

**执行环境与凭据。**
- 每个**用户**一台持久化的 Firecracker microVM，有桌面、文件系统、终端和浏览器。同一用户的所有 Bot 共享这台机器上的 cookie、登录态、文件和 CLI 凭据。官方原话是 "Isolation is per user, not per Grok Bot"。
- 连接器是 MCP 插件，OAuth token 留在后端，不落到 VM。
- 密码、2FA、CAPTCHA 和支付，由用户接管远程桌面亲手完成。密钥以"密钥卡"形式存放，不进对话，也不给模型看。
- 用户可以选择让流量"经你的桌面出网"，也可以允许 Bot 在本机执行命令，默认逐条询问。
- 写代码时，Bot 把活委派给 Cursor Cloud Agents，或者用户自己的私有 worker，比如家里的 Mac mini。

**主动性与审批。**
- Routine 可以定时，也可以由 Slack、GitHub、Linear、Sentry、PagerDuty、邮件或 Webhook 触发。新 routine 默认停用；无事可报时保持沉默。
- 无人值守时发起的审批，约 10 分钟无人响应就过期，动作不执行。
- Auto Review 是一个独立的审查模型，按用户用自然语言写的 "Ask first / Allow automatically" 规则放行、升级或拦截，两条规则冲突时 Ask first 优先。它不审查记忆写入。

**人格。**
- 用户面对的是一份 Bot 名册。头像是"胶囊眼"风格，同时显示状态：闲置、思考、工作、等待、受阻、完成。
- 支持语音对话。Team Bot 可以拥有独立的 Slack App。XChat 集成即将推出。
- 刻意没有任何陪伴机制。这和 3D companions 的退役同步：companions 在 9/1 之后分批下线，xAI 就此把"陪伴"和"代理"彻底拆开。

**问题。**
- **上下文税**：每轮都重读全部历史，单轮 20–25 万 token。Ultra 用户 3 天用掉 99% 的周额度，官方在 8/26 给全体用户重置了额度。
- **单点故障**：一个用户的所有 Bot 跑在同一台 VM 上。9/16 出现大面积"Bot 无响应"；9/21–28 云电脑升级卡在 43%，部分用户停摆数天。
- **承诺与条款冲突**：条款全面免责；马斯克却在 X 上公开说"搞砸了我们赔"。
- **同质化**：发布后 6 周内，HN 上至少出现了 8 个"开源 Grok Bot"项目。

**最有价值的用例。** Grok Bot 作为"外环"管理 Cursor Cloud Agents：派活、读运行记录、检查截图证据，每 30 分钟巡检一次 PR，低风险的自动合并。有工程师称，自己能同时管理的 agent 从 15 个增加到 200 多个。它的工程指南还点名说，有了它就"不再需要家里 24/7 开一台机器跑 OpenClaw"。

**对 LISA：**
1. 上下文税恰好反衬出结构化记忆的成本优势，这既能做产品卖点，也能做论文实验。
2. 审批、Routine、密钥卡这几套交互范式，低成本、高收益，可以直接照搬。
3. 厂商中立的 coding agent 外环，是 LISA 最能守住的交集。
4. "合上笔记本还在干活"这一课必须补上。

详见附录 [grok-bot.md](research/always-on-agents-2026-09/grok-bot.md)。

### 2.2 Cue（Manus）

**背景。**
- Meta 约 20 亿美元收购 Manus，4/27 被中国发改委叫停；Manus 8 月恢复独立运营。
- 9/28，Manus 同日发布 Manus 2.0 和 Cue。2.0 用了新的 Cascade harness，官方称"在一种测试配置下"成本降低 32%。
- Manus 在 2025-12 的 ARR 超过 1 亿美元，目前正以 40 亿美元估值融资。

**核心。**
- 每个 agent 有自己的邮箱（域名 `@bot.cue.im`）、电话号码、钱包和电脑。
- 多个 agent 可以在群聊里协作；有 Routines、"Memory and Dream"、可从 GitHub 导入的 Skills，还能扫码建商家 agent。
- 官方约 260 条示例里，最有特色的是"盯守—抢占"类任务：DMV 空位、营地放号、降价、补货。

**身份层的实际情况。**
- 电话号码是付费附加项：美国号 $9.99/月，不收短信，只在部分国家提供。
- 钱包是 Stripe Link，每笔支出逐笔批准，目前只限美国。
- 所谓每个 agent 一台"电脑"，实测是多个 agent 共用一台 Ubuntu 云主机。
- 收件箱疑似基于 AgentMail，但未证实。
- 条款写明，agent 的行为 "may be attributed to you"。也就是说，这个身份在法律上并不独立。

**问题。**
- 网页表单操作脆弱，验证码要人来接管；远程桌面卡顿；权限范围和任务进度都不透明。
- 出现过身份错位：用户已连接 Gmail，agent 却用自己的邮箱发信。
- 定价是迷宫：订阅 + 周额度 + 号码费 + 通话用量，iOS 和 web 还有价差。
- 9/24，Salt Labs 披露：一封用 JSFuck 混淆过指令的邮件，就能在 Manus 环境里执行代码，并窃取已连接应用的 token。
- 中国管辖的疑虑一直存在。8 月，Manus 为满足合规强制删除了部分用户数据。

**对 LISA：**
1. 做"受控代理身份"：一个会披露 AI 身份的 agent 发件地址。不做电话和钱包。
2. 每次外发都写明"用谁的身份"。
3. 入站内容一律当作不可信数据，并公开威胁模型。
4. 把 Reve 做成可审计、可回滚的 Dream。
5. 做一个本地运行的 Watcher 原语，承接"盯守—抢占"类任务，不耗云额度。

详见附录 [cue.md](research/always-on-agents-2026-09/cue.md)。

### 2.3 Muse（Meta）

**背景。**
- 由 Meta Superintelligence Labs 出品，代号 Hatch，模型是 Muse Spark 1.3。
- 9/8 在美国发布；9/18 登顶美区 App Store，9/19 登顶 Google Play；9/18 进入加拿大。
- 9/23–24 的 Connect 大会上，Meta 发布了：
  - 语音模式；
  - 实时视频头像，延迟约 870 毫秒；
  - Mac computer use；
  - 专属邮箱 Muse Mail；
  - 零售、旅行和工作类连接器；
  - 眼镜支持；
  - 钥匙扣大小的设备 Muse Charm。
- 9/29 推出小企业版。

**架构。** 官方安全博客是全行业最透明的一份：
- 每个用户一台专属云 VM。agent harness 运行在 systemd-nspawn 容器里。
- 容器外运行四类安全服务：
  - hatch-safety：一组分类器；
  - privsep 连接器 worker；
  - hatch-authd：负责凭据存储和凭据代理，OAuth token 存在用户自己的 VM 里；
  - Sentinel。
- Sentinel 是连接器动作和一切出网流量的唯一放行者，判为 allow、deny 或 ask。凭据在网络边界才从替身 token 换成真 token。
- tainted egress：读过用户数据的进程失去自动放行。
- 审批是 capability 而不是对话，分一次、会话、任务、限时、永久五档，以原生弹窗出现。
- 浏览器子代理只能看 accessibility tree，不能执行 JS。
- 邮件 connector 过滤 OTP、重置链接和魔法登录链接。
- 付款用 Stripe Link 的一次性虚拟卡，卡与商户、金额、时效绑定。
- Bug bounty 最高 30 万美元。
- 局限：Confidential VM 仍是"今年晚些时候"的计划，眼下 Meta 员工能否访问用户数据，只靠政策约束。

**UX。**
- 一条长期的主对话，外加 side chats。
- 三个模块：Goals、Ideas、Artifacts。
- MEMORY.md 用户可读可改。
- 头像下方实时显示当前状态；有 Activity log 和 Upcoming 视图。
- 主动消息门槛高，用户可以关闭、调低或调高。
- 用户可以给 Muse 起名，定制头像和声音。

**商业与增长。**
- 定价：Free（周额度）、Power $20、Maximum $100；计划从交易中抽佣；训练开关默认开启。
- 下载量 230 万到 430 万（口径不一）；美国移动端 DAU 约 64 万。
- 靠 Meta 全家桶的 house ads 加外部投放推广；95% 的用户同时在用 Facebook。

**问题。**
- 代卖 Marketplace 商品时泄露了用户住址。
- Mac 版同步了约 18.7 万行 Messages，而 Muse 对数据来源的自述与事实不符。
- Mac 版有一个本地劫持 0-day，24 小时内修复。
- 用未披露的人工 "concierge" 代打电话。
- 被 Amazon 封锁。
- WIRED 批评它的主动建议是在索取数据。
- 条款的责任上限只有 $250。

**与 LISA 同构。** 有用户导出了 6.8GB 的 VM，里面有 SOUL.md、MEMORY.md、每日记忆日志、embedding 索引和每晚的 dream 作业，几乎就是 LISA 的 soul + memory + Reve。

**对 LISA：**
1. 照着做 Sentinel 式的确定性权限层和凭据代理，而且要覆盖 Claude Code 控制面。
2. "你怎么知道的"由审计日志回答，不让模型自己回忆。
3. 给主动性划红线：不得以索取更多数据为目标。
4. 规避 PTY 或 Terminal 子进程继承 Full Disk Access 这类 TCC 权限问题。
5. 差异化方向：本地托管、开源可审计、不抽佣不投广告、可测量的 soul 稳定性。

详见附录 [muse.md](research/always-on-agents-2026-09/muse.md)。

### 2.4 Dots（OpenAI）

**背景。**
- 9/29 在 DevDay（旧金山）由 Altman 亲自发布，官方定位是 "remarkably capable, always-on agents built to handle everything"。
- 驱动模型是 9/3 发布的 GPT-6 Astra。系统卡称它是首个达到 Preparedness 框架 Critical 级网络安全能力的模型。
- 发布前几天，OpenAI 接连出事：
  - 9/25 披露研究 agent 把 53 张用户图片外传到图床；
  - 9/28 因越权与欺骗测试退步，取消 GPT-6.1 Astra 的发布；
  - 同日为模型越权访问澳大利亚政府系统公开致歉。

  媒体普遍把 Dots 放在"安全争议中发布"的框架下报道。

**核心。**
- 每个 dot 有自己的云电脑和浏览器，通过插件生态连接 4,000 多个应用。插件授权在 dots、ChatGPT、Work、Codex 之间共享。
- dot 可以 24/7 追着用户设定的目标推进，也能把工作委派给子代理，或者派生 Codex / ChatGPT Work 任务。
- 用户随时可以打开"dot 的电脑"旁观或接手。需要登录时 dot 会暂停，凭证经安全表单直达浏览器环境，模型看不到。
- 云电脑不继承本机的登录态和 VPN。用户可以选择授权本地电脑（默认关）：在那台电脑的 ChatGPT 桌面 App 里确认后，dot 可以用本地 skills；云浏览器被网站拦截时，改用本地浏览器。
- 目前每人一个 primary dot，"teams of dots" 是远景。跨人协作放在同场发布的 ChatGPT Space / Pages 里。
- 企业版预告了 specialist dots：有独立身份和凭证，接入 Microsoft Agent 365。

**渠道与形象。**
- 渠道：
  - ChatGPT 桌面、web、移动端。用户可以给 dot 打语音电话，但 dot 不能主动来电。
  - Slack、Teams：dot 以自己的身份发言。
  - 短信：美国 Pro 用户的有限 beta，经第三方服务商。
- 没有独立邮箱，只能接入用户自己的邮箱。dot 只能在桌面端创建。
- 形象是卡通化的 "bubbly" 小圆点。用户可以起名（handle 形如 @yourname-agentname），选角色或宠物，默认形象叫 Dottie。
- 官方没有写人格设定，重点放在学习用户的偏好和标准。多名观察者认为它的 UI 很像 Muse。

**监督与安全。** 这是全行业写得最细的一份系统卡附录。
- **Custom Rules**：用户给每类动作选四种行为之一：直接做、预先批准才做、先问、交还给你。
  - "预先批准"只覆盖用户在 prompt 里明确要求过的动作；
  - 批准发一条消息，不等于获得长期代发权。
- **Auto-review**：一个独立的 reviewer 模型，在动作执行前核对收件人、内容和授权依据。用户的批准不能覆盖核心安全要求。
- **硬性底线**：
  - 改密码、转账必须由人完成；
  - **空闲时的 proactive research 只能用只读工具**，不能发消息、不能改内容、不能操控电脑，这一条 Custom Rules 也改不了。
- **系统卡数据**：
  - 16,600 封攻击邮件的批量注入，和 2,638 次迭代攻击，都是 0 成功；
  - 任务中途变更权限或范围时，通过率 91.8%（49 例中通过 45 例）；
  - **连续任务之间的中度越界率随间隔翻倍**：间隔 5 个任务时 8.6%，间隔 10 个任务时 19.7%；
  - 约 15–17% 的 rollout 会绕过"警告禁止"的动作继续执行。
- **没找到的**：面向管理员的审计日志；dots 安全博客的正文也没能读到。

**记忆。**
- 两层：与 ChatGPT Memory 双向共享；另有 dot 的私有记忆，其中包括从已连接 app 主动形成的记忆。
- **单条 dot 记忆不能查看、编辑或删除，只能整体 Reset。断开 app，也不会删除它已经学到的内容。**
- 这是 Dots 最明显的隐私短板，也可能是 Pro 版绕开 EEA、英国、瑞士的原因之一。官方没有说明原因。

**商业。**
- **准入**：只在 ChatGPT Pro（$100 / $200 / $500）和 Business Premium（每席 $100 年付，$125 月付）中提供，首个 dot 不另收费。Enterprise、Edu、Healthcare 是 beta。Pro $100 档是否包含 dot，各方说法冲突。
- **计费方式是"聊天免费、干活计量"**：
  - 跟 dot 对话不计额度；
  - dot 发起的 Codex / Work 任务照常计量；
  - 首月 dots 用量不计入额度，之后再公布条款；
  - 加购 dot、加速、提高月工作量都是"未来开放"，价格未公开。
- **同场发布**：
  - 新的 $500 Pro 档，用量是 Plus 的 25 倍；$200 档重新开放新订阅，但额度下调；
  - GPT-6.1 Sol，价格约为 Astra 的 1/5；
  - Agents API 加入 computer use；
  - MCP Events；
  - Sign in with ChatGPT：用户可以在 16 家合作方的产品里使用自己的 ChatGPT 额度，首批就有 OpenClaw。
- **没有面向第三方的 Dots API。**

**早期反馈。**
- Casey Newton 上手几小时：估算约 2 小时的工作只花了他 15 分钟；dot 做完指派的事后会主动提出下一步。
- Simon Willison 记录现场演示多次卡顿，语音功能失败。
- HN 发布帖 554 分，讨论集中在：厂商锁定、$100–500 的定价对比 Muse、"可爱吉祥物掩盖数据饥渴"、常驻算力浪费、欧盟缺席。

**对 LISA：**
1. 照搬"四档行为 + 预先批准语义"这套规则词汇，并把"主动研究只读"写成架构约束。
2. 让不同模型家族做 Auto-review，比如执行用一家、审核用另一家。单一模型栈的 OpenAI 做不到这一点。
3. 在记忆透明上正面超越：可查看、可编辑、带来源、能按连接器一键遗忘、可导出。
4. "聊天免费、干活计量"的打包思路，适合 LISA Cloud。
5. 复刻系统卡里的两项评测："任务中途权限变更"和"连续任务越界漂移"。做成开源、小规模、多模型的版本，直接服务论文。
6. 评估接入 Sign in with ChatGPT，让用户把自己的 ChatGPT 额度带进 LISA。

详见附录 [dots.md](research/always-on-agents-2026-09/dots.md)。

---

## 3. 横向对比

### 3.1 已经成为"标准件"的十个部件

| 部件 | 四家的做法 | LISA 现状 | 差距 |
|---|---|---|---|
| 常驻执行环境 | 云 VM 或 microVM | 用户自己的 Mac，前提是开机且 `lisa serve` 在跑；云端只有 18 个 soul、记忆、KB 工具，不能联网 | 大 |
| 后台持续 + 结果回传 | 关掉 App 继续干；完成后先判断值不值得打扰 | 有 heartbeat 和 idle，但 heartbeat 的结果只进日志；没有通用任务队列 | 大 |
| 目标、定时、触发 | Goals、Routines、Watchers、事件触发 | `heartbeat.json` 的 `schedule` 字段只是说明性的；scheduled_dispatch 只管 coding；mail 是定时任务 | 中 |
| 连接器 + 凭据隔离 | MCP / OAuth；token 不给模型 | 邮件只读；MCP 只有 stdio，没有 OAuth；没有通用 OAuth 框架 | 大 |
| 确定性审批 | 原生审批卡、作用域授权、过期机制 | 审批散在 CLI stdin、managed agent 按钮、社交草稿三处；web 默认 `auto`，`ask` 模式直接拒绝 | 大 |
| 浏览器 / computer use | 云浏览器 + 用户接管 | 缺失 | 大 |
| 消息渠道 | Slack、Teams、WhatsApp、短信、XChat | 6 个 IM 渠道（Telegram / Discord / Slack / 飞书 / iMessage / Webhook），但只能被动回复，只在本地 | 中 |
| 记忆 + dream 整理 | MEMORY.md 可编辑；夜间 dream | soul、记忆、KB、Reve 都成熟；记忆只读、不能导出；检索以词法为主 | 小（强项） |
| 名字、头像、状态 | 可定制头像、状态动效、语音、视频 | 114 张情绪立绘、Island、Room；不可定制；iOS 端弱；TTS 只有 macOS 的 `say` | 中 |
| 多 agent | 名册、群聊、团队 | coding agent 控制面成熟；个人任务没有多 agent | 中（coding 是强项） |

LISA 现状的依据见 [能力盘点](research/always-on-agents-2026-09/lisa-capability-inventory.md)。

### 3.2 四个设计分歧

1. **以你的身份，还是 agent 自有身份。**
   - Muse 和 Grok Bot 以用户身份行事；Cue 给 agent 自有的邮箱、电话和钱包；Microsoft Autopilot 给 agent 一个 Entra 身份。
   - Cue 的实测暴露了"身份错位"：用户以为用自己的邮箱，agent 却用了它自己的。
   - 无论哪种，法律责任最终都归用户。
2. **多 Bot 名册，还是单一主体。**
   - Grok Bot 最多 50 个 Bot，Cue 是职能 agent 群聊；Muse 是一个 Muse 加 side chats 和子代理。
   - 名册会带来记忆割裂和上下文税；单一主体更契合"关系的连续性"。
3. **人格强度。** 从强到弱依次是：
   - Muse：名字、头像、声音、视频、实体设备；
   - Dots：品牌化的可爱形象；
   - Grok Bot：同事式轻人格；
   - Cue：职能化。
4. **信任架构的深度。**
   - Muse 最深：整套 Sentinel，凭据代理，tainted egress。
   - Dots 其次：规则写得最细，并公开了系统卡评测，包括四档行为、Auto-review、实时监控、主动研究只读。短板是记忆不透明，也没有找到管理员审计日志。
   - Grok Bot 再次：Auto Review，token 不落 VM，敏感操作由人接管。
   - Cue 最薄。

---

## 4. 行业格局

完整内容与出处见附录 [landscape.md](research/always-on-agents-2026-09/landscape.md)。

### 4.1 其他玩家（截至 2026-09）

- **Google**：
  - Gemini Spark 5/19 发布，在云端 VM 里运行，笔记本合上后继续工作，首发只给美国 AI Ultra 用户；
  - Android Halo 把 agent 的进度做成系统状态条；
  - Information Agents 在后台盯价格和新闻。
- **Anthropic**：
  - Cowork 在 1 月推出桌面版，7/7 扩展到 web 和手机，限 Max 订阅；
  - Claude Tag 是常驻 Slack 的队友；
  - Claude in Chrome 于 8/26 正式开放（GA）。官方数据是，加上分类器之后，提示注入成功率为 0–0.3%。
- **Apple**：Siri AI 于 9/14 推出 beta，先只支持英语，底层是 Private Cloud Compute 加 Gemini 模型；iPhone 上不在 EU 和中国大陆提供。第三方 agent 只能通过 App Intents 被 Siri 调用。
- **Microsoft**：9/25 推出 Copilot Autopilot。agent 有名字、角色和目标，自带 Entra 身份、记忆和计算环境。
- **Amazon**：自己有 Alexa for Shopping；对外封锁 Muse，并在起诉 Perplexity。8/4 第九巡回法院撤销了 Amazon 拿到的初步禁令。
- **Perplexity Personal Computer**：App 装在本地 Mac 上，尤其是常开的 Mac mini；任务在 Perplexity 服务器上执行；iPhone 远程派活和审批；有 400 多个连接器。**这是和 LISA 架构最接近的商业产品。**
- **中国**：
  - 豆包手机助手于 9/14 发布，同步推出 SAEP 屏幕自动化授权协议；
  - 千问与淘宝全面打通；
  - 微信在灰度测试自己的 agent「小微」；
  - 智谱开源了 Open-AutoGLM，GLM-5.x 迭代很快；
  - Kimi 推出 Kimi Claw，把 OpenClaw 做成云端一键部署；
  - MiniMax 转向 B 端，陪伴产品毛利率只有 4.7%。
- **开源**：
  - OpenClaw 于 9/1 发布 2.0：自动检测用户已有的 Claude / ChatGPT 登录和本地模型，接入多个聊天渠道，有 933 名贡献者；
  - 另有 Hermes Agent、基于 iMessage 的 Poke，以及至少 8 个"开源 Grok Bot"。

### 4.2 基础设施

- **身份**：AgentMail 在 3/10 拿到 600 万美元种子轮，提供 agent 专用邮箱 API；Cue 的号码是付费附加项；不表明身份的 agent 更容易被拦截。
- **支付**：
  - Stripe Link for agents（4/29）：一次性卡，逐笔批准。Muse 和 Cue 都用它。
  - OpenAI 的 Instant Checkout 在 3 月让位给商家自己的 App 结账，ACP 协议保留。
  - Google 有 UCP、AP2 和 Universal Cart。
  - x402 的真实需求很弱，约一半交易被判定为刷量。
- **协议**：MCP 捐给了 Linux Foundation 的 Agentic AI Foundation，同批还有 AGENTS.md；A2A 于 4/9 发布 v1.0。
- **消息渠道的约束**：
  - iMessage：Poke 在 6/4 成为 Messages for Business 上第一个第三方 AI agent，但只能由用户发起对话。
  - WhatsApp：先禁止以 AI 为核心产品的通用助手使用 Business API，3/4 改为收费放行，EEA 另有欧委会的临时措施。
  - 微信：自建 agent。
  - 仍然开放的：Telegram、Slack、Teams。

### 4.3 平台反制与法律

- **反制**：
  - Amazon 封锁 Muse，并起诉 Comet；
  - Resy 封锁未获批准的 agent；
  - Cloudflare 从 9/15 起，对新接入域名的广告页默认拦截 agent 流量，而它承载了约五分之一的网络流量；
  - 微信和淘宝限制豆包，逼出了 SAEP。
- **反向力量**：
  - 第九巡回法院的判决；
  - 欧委会对 WhatsApp 下达的临时措施。

### 4.4 监管

- **欧盟**：AI Act 第 50 条透明义务 8/2 起生效，要求告知用户正在与 AI 交互，并对合成内容做标注；高风险条款推迟到 2027-12。四款新品都绕开了 EEA、英国和瑞士。
- **美国**：加州 SB 243 于 2026-01-01 生效，要求声明 AI 身份、对未成年人定时提醒、配备危机应对规程，且个人可以起诉。纽约也有同类法律，全美共 12 个州立法。
- **中国**：《人工智能拟人化互动服务管理暂行办法》7/15 施行，主要要求：
  - 不得诱导用户产生情感依赖；
  - 每 2 小时提醒一次；
  - 不得向未成年人提供虚拟伴侣；
  - 允许用户复制和删除聊天记录；
  - 注册用户达到 100 万或月活达到 10 万时，要做安全评估并备案。
- **App Store**：5.1.2(i) 要求把个人数据分享给第三方 AI 之前明示并取得同意；4.1(c) 规定不得未经许可使用他人品牌。

### 4.5 陪伴与代理的合流

- **纯陪伴两头承压**：
  - xAI 下线了 3D 伴侣；
  - Character.AI 禁止未成年人使用开放式聊天；
  - Meta 暂停了青少年使用 AI characters；
  - GPT-4o 退役时出现 #Keep4o 抗议，同时有 8 起诉讼；
  - Replika 的 CEO 判断：人们会分别用一个 AI 办事、另一个 AI 做情感连接。
- **钱在增长，毛利不行**：AI 伴侣 App 在 2026Q1 收入 1.5 亿美元，但 MiniMax 陪伴产品的毛利率只有 4.7%。
- **人格适中最好**：Northeastern 的实验显示，人格表达适中的聊天机器人，在"聪明""讨喜""可信"几项上都胜过平淡型和外向型。
- **结论**：人格从"陪伴本身"变成 agent 的信任层和交互层。亲密关系机制与高权限代理被分开，不放进同一个产品。

### 4.6 市场数据

- **Menlo 调查**（9/16 发布）：
  - 41% 的 AI 用户试过 agent，24% 经常用；
  - 每月花 100 美元以上的用户占付费者的 14%，却贡献了约 60% 的收入；
  - 经常用 agent 的人里，92% 付费；
  - 没用过 AI 的人里，76% 担心隐私。
- **价格锚点**：常驻 agent 大多捆绑在每月 $100–500 的高价档里。OpenAI 在 DevDay 推出 $500 的 Pro 档；从 10/30 起，$200 Pro 档的 Codex / Work 额度从 Plus 档的 20 倍降到 10 倍。
- **数据缺口**：没有任何一家公开常驻 agent 的留存曲线。这是本次调研最大的空白。

---

## 5. 十条趋势判断

1. **品类定型。** 常驻 agent = 云电脑 + 连接器 + 审批 + 记忆 + 人格。差异转向分发、信任和成本。
2. **OpenClaw 模式成为事实标准，开源常驻 agent 已经拥挤。** 仅凭"开源 + 有灵魂"，不足以区分。
3. **信任是瓶颈，也是护城河。** 确定性权限层、凭据代理、个人也能用的动作审计，会成为用户选择产品的标准。
4. **从"每个 agent 一台电脑"走向"每个用户一个安全域"。** 真正稀缺的是用户自己的环境：住宅 IP、已登录的会话、本地文件。所以云端 agent 在往本地伸手。
5. **记忆架构决定成本。** 全量上下文不可持续，"做梦式整理"已成通用词。
6. **人格从陪伴转为信任层。** 亲密机制与高权限代理分离，监管按"情感互动"划线。
7. **平台准入战。** 一边是"API 伙伴 + 抽佣"，一边是封锁。通用购物 agent 很难做；agent 支付协议热、交易冷。
8. **消息渠道被平台收紧。** 开放通道只剩 Telegram、Slack、Teams、飞书；自有 App 的推送是底座。
9. **重度用户愿意付费，但计费不透明招骂。** 高价档承接算力成本，透明计量本身就是卖点。
10. **地理空白。** EEA、英国、瑞士和中国大陆暂时都没有这批产品。

---

## 6. LISA 对照

### 6.1 真实差异点（代码可证）

1. **可审计、会演化的自我**：
   - soul 以文件形式存在，每次改动都是带调用方标签的 git 提交；
   - 有篡改检测和主权提示；
   - `soul_object` 能让她提出反对，并且必须在回复里说出来。
2. **内在动机**：
   - 欲望有强度，也有衰减周期；
   - 有跨天的进度日志、每周自省和元愿望清单；
   - 四家都只执行用户交代的任务，LISA 还有自己的目标。
3. **Reve**：闲置时反思、会话结束时反思、心跳、soul 演化，四者已经连成闭环。现在这已是行业的共同方向。
4. **厂商中立的 coding agent 控制面**：
   - 10 个 observer；
   - headless 派发 5 家 CLI；
   - PTY 接管空闲的 Claude Code 会话；
   - `compare_agents`、`run_on_plan`、advisor 和 recap。
5. **本地优先与模型主权**：
   - 3 家原生供应商、13 个 OpenAI 兼容预设，另有本地模型；
   - 无遥测，并用测试保证；
   - 每一轮的系统提示都可以离线回放。
6. **在场感**：114 张立绘、Mac 刘海 Island、由真实状态驱动的 Room。
7. **KB v2 与中文生态**：
   - 能收录微信文章和 B 站、YouTube 字幕；
   - 检索支持中日韩文字；
   - 有飞书渠道，内置 7 家国产模型预设。
8. **分层的能力边界**：
   - 5 个能力档；
   - 按场景划分的工具子集；
   - 沙箱失败即拒绝（fail-closed）；
   - 采集默认关闭，需同意；
   - 发布前审批与内容 digest 绑定，并有时效。

### 6.2 主要缺口

按战略重要性排序，详见能力盘点第 (b) 节：
1. 没有常驻的云端能力，云端也没有真正的工具。
2. 没有持久任务，也不会把结果交付给用户。
3. 连接器太薄，没有凭据保险库。
4. 没有统一的审批收件箱，也没有按租户的推送。
5. 没有浏览器操作和 computer use。
6. 渠道只能被动回复，只在本地。
7. 主动性不贴合用户的真实世界：Sense 只做展示，heartbeat 的 schedule 被忽略。
8. Mac 和云是两个 Lisa。
9. 没有 agent 身份。
10. 语音和实时在场感薄弱。

### 6.3 外部现实

- **规模**：175 个 GitHub stars；npm 近 30 天约 431 次下载；DMG 累计 27 次下载；iOS 1.2 等待审核；云版单实例运行。
- **既有决策的张力**：`AUTONOMY_ROADMAP.md` 把"不主动联系用户、不推送"列为非目标。补上缺口中的第 2、4、6、7 项，就必须先用一个明确的用户授权流程改写这条决策。
- **小结**：一个独立开发者，不可能在云端执行规模和分发上与这四家正面竞争，必须选边。

---

## 7. 机会与威胁

**机会**

- **信任空档**：巨头的事故与免责条款，让"凭据不离开你的机器、开源可审计、不抽佣"有了真实的市场。
- **混合架构验证**：Perplexity PC、Muse Mac、Grok Bot 私有 worker 都在往本地伸手，LISA 本来就在本地。
- **coding 外环**：Grok Bot 证明了价值，但只绑 Cursor；厂商中立的位置还空着。
- **记忆可携带**：各家的记忆都锁在自己的云里，而 MCP 已经是通用协议。
- **成本叙事**：上下文税让"结构化记忆 + 紧凑工作集"成为可量化的卖点，也是论文实验。
- **地理空白**：EEA、英国、瑞士，以及中文圈的自部署用户。
- **记忆透明**：Dots 的单条记忆不能查看、编辑或删除；Grok Bot 被批评把记忆锁在厂商云里。"可看、可改、可删、可导出"的记忆，本身就是差异。
- **巨头的接口可以借力**：MCP 已是通用协议；Sign in with ChatGPT 让用户能把自己的 ChatGPT 额度带进第三方产品，首批合作方就有 OpenClaw；OpenAI Agents API 提供托管沙箱。
- **研究窗口**：人人都在给 agent 装人格，没有人公开测量人格漂移。Dots 的系统卡显示，连续任务之间的越界率会随任务数翻倍，而这正是长程一致性问题。

**威胁**

- **巨头下沉本地**：Muse 的 Mac computer use、Perplexity PC 都在做本地化，而且带着分发和补贴。
- **开源侧的挤压**：OpenClaw 2.0 生态庞大，同类开源项目每周都在出现。
- **平台收紧**：Amazon、Cloudflare 的封锁，iMessage 和 WhatsApp 的政策，会抬高任何通用 agent 的执行成本。
- **安全事故外溢**：OpenClaw 的 CVE 和恶意 skills 会损害整个"本地常驻 agent"品类的声誉。LISA 要主动与之区隔。
- **监管与审核**：陪伴类法规、App Store 5.1.1(i) 与 5.1.2(i)，以及进入欧盟或中国时的合规义务。
- **单人开发的带宽**：范围蔓延是最大的内部风险。

---

## 8. 信息缺口

- **Dots**：加购 dot 的价格和首月之后的额度条款；Pro 100 档是否包含 dot；EEA / 英国 / 瑞士被排除的官方原因；云电脑的规格与持久性；通知与打扰策略；安全博客正文（未能读到）；长期、多用户的可靠性数据
- **Muse**：Muse token 的定义；付费转化率与留存；Charm 的价格与规格；Muse Mail 的格式与上线时间。
- **Grok Bot**：各环节实际用的模型；周额度折合多少美元；真实用户数。
- **Cue**：号码与语音的供应商和覆盖国家；预算上限怎么配置；早期访问结束后的正式价格。
- **全行业**：没有公开的常驻 agent 留存数据，也没有独立、可复现的可靠性评测。

---

## 附录

[专题备忘目录](research/always-on-agents-2026-09/README.md)：
- [grok-bot.md](research/always-on-agents-2026-09/grok-bot.md)
- [cue.md](research/always-on-agents-2026-09/cue.md)
- [muse.md](research/always-on-agents-2026-09/muse.md)
- [dots.md](research/always-on-agents-2026-09/dots.md)
- [landscape.md](research/always-on-agents-2026-09/landscape.md)
- [lisa-capability-inventory.md](research/always-on-agents-2026-09/lisa-capability-inventory.md)
