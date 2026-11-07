# 竞品分项：界面如何承载能力

日期：2026-10-24。证据标签与来源 ID 见 [来源登记](sources.md)。下文“对 LISA 的判断”均为建议，不是竞品事实。没有登录后实测。

## 1. Manus / Manus Studio

### 定位与端的职责

[官] Manus 2.0 将桌面产品升级为 Studio，围绕项目组织文档、表格、PDF、演示、网站、代码、游戏和视频；Cloud Computer 承载需要持续在线的项目。Web、桌面和移动均有产品入口。本地 Computer Use 与手机远程控制也在公告范围内。[M01](https://manus.im/blog/introducing-manus-2-0)

| 表面 | 公开证据支持的职责 | 不应外推 |
| --- | --- | --- |
| Web | 项目、任务、自动化和在线成果；Plan Mode 可从命令入口开启 | 不等于所有桌面编辑器均有 Web 功能等价 |
| Mac | Studio 创作工作区；本地文件与工具；经授权的 Computer Use | 云任务可继续，不代表关机后还能操作本机 |
| 移动 App | 下达和跟进任务、Plan Mode、远程控制入口 | 没有实测复杂成果编辑和全部项目管理是否等价桌面 |

### 工作流与界面

- [官] Project 把指令、参考资料、Skills、连接器建议和任务放在一起。共享项目上下文与共享某个任务是不同授权；导入 Drive 文件也不等于持续同步。[M03](https://www.manus.im/features/projects)
- [官] Plan Mode 手动启用，先生成可编辑的计划，确认后执行；移动端走加号入口，Web 走命令入口。[M07](https://manus.im/blog/manus-plan-mode)
- [官／视] 自动化提供时间、事件和复杂条件三个起点；有试运行、运行历史、审批和停用。Updates 包括没有满足条件的运行，便于区别“没发生事”和“执行失败”。[M02](https://manus.im/blog/introducing-automations)
- [官] Browser Operator 把工作放进有任务名称的标签组，支持监看和接管；本地目录授权与工具能力通过 My Computer 承载。[M04](https://manus.im/blog/manus-browser-operator)、[M05](https://help.manus.im/en/articles/14178443-what-is-the-my-computer-feature-capable-of)
- [官] Wide Research 面向可分拆的研究工作，由系统判断触发；Skills 把验证过的流程变成可复用资源。并行本身不保证引用正确或结果完整。[M06](https://help.manus.im/en/articles/11960169-what-is-wide-research)、[M08](https://www.manus.im/blog/manus-skills)

### 值得学与不照搬

**对 LISA 的判断：** 学项目上下文、任务详情、试运行、结果预览与局部修改。把“研究十个来源并生成比较表”做成可交付任务，胜过继续增加零散工具按钮。首期不做视频时间线、游戏引擎、付费云电脑和网站托管；这些超出当前团队的核心闭环。

视觉上，M02 的公开图示以少量并列入口解释触发方式。LISA 可采用这种渐进展开方式，但应将用户问题写成“什么时候做／发现什么才做”，而非让用户先学习触发器术语。

## 2. OpenAI Dot

### 定位与端的职责

[官] Dot 是持续跟进责任的协调者，可把工作交给 Work 或 Codex。自身有云电脑，可在用户设备关机时处理云工作。个人形象与名字是入口，任务与权限是可检查对象。[D01](https://learn.chatgpt.com/docs/dots)

| 表面 | 当前官方说明 | 对 LISA 的启示 |
| --- | --- | --- |
| 移动 App | 可以创建 Dot、连接插件、文字与通话；可以跨设备继续 | 手机应是完整的委派／决策入口，而不只是桌面状态显示器 |
| 桌面 App | 可连接本地电脑，查看活动与任务 | “连接电脑”应解释运行条件和可访问范围 |
| 桌面 Web | 可以创建、沟通及查看云端工作 | 登录后应立即进入任务场景，不复刻安装控制台 |
| 移动 Web | 官方明确不支持 Dot | LISA 无需照搬这一限制；可用响应式 Web 补 Android 早期覆盖 |

依据：[D02](https://learn.chatgpt.com/docs/dots/getting-started)、[D03](https://learn.chatgpt.com/docs/dots/channels)、[D05](https://learn.chatgpt.com/docs/dots/computers-and-apps)。

### 工作流与界面

- [官] 主对话可不断追加优先级，同时后台任务继续；任务有自己的对话与上下文，不是每个子任务都自动获得全部历史。固定重复工作仍要明确保存的时间、时区和通知条件。[D04](https://learn.chatgpt.com/docs/dots/tasks-and-memory)
- [官] Activity 用于检查工作，Scheduled 用于调度。暂停主 Dot、停止子任务、取消未来调度是不同动作。自动审查与自定义规则也不是同一层控制。[D06](https://learn.chatgpt.com/docs/dots/controls)
- [官] 本地接入、插件授权、消息渠道分别管理。浏览器查看与 Take over 分开；本地与云浏览器不共享登录态。[D05](https://learn.chatgpt.com/docs/dots/computers-and-apps)
- [官] 通话结束不停止已委派任务；跨消息渠道可以使用相关上下文，但可见聊天不简单镜像，读到信息也不自动获得向另一受众披露的权限。[D03](https://learn.chatgpt.com/docs/dots/channels)
- [视] D01 的公开示意在桌面和手机使用同一头像、短消息气泡与输入区。此处是说明文档演示，不能由此认定实际产品只包含这些控件。

### 值得学与不照搬

**对 LISA 的判断：** 学“一个长期合作对象，多个可追踪的工作单元”。保留连续关系，同时用可见任务卡隔离不同工作；任务在哪里运行、等待谁、需要什么权限必须明确。给“停止当前运行”和“停用以后运行”独立控件，避免一个含糊的暂停按钮。

不照搬高端套餐资格、闭源模型绑定或不可解释的记忆。LISA 可以用逐条来源、修改历史和导出把自己的记忆体系做成差异。不要把 Dot 的自动审查模型直接等同于 LISA 的确定性 Warden。

## 3. Meta Muse

### 定位与端的职责

[官] Muse 面向个人生活中的任务与长期目标。当前有 iOS、Android、Web 和 Mac 入口；Mac 下载说明强调本地文件、应用和浏览器标签页。日本于 10 月 23 日开放 iOS、Android、Web；不能据此推断所有功能已全球可用。[U04](https://ai.meta.com/muse)、[U05](https://ai.meta.com/muse/download/)、[U06](https://about.fb.com/ja/news/2026/10/muse-personal-ai-agent-launches-in-japan/)

### 工作流与界面

[官／视] 设计文章把主对话、可分开的 side chats、Goals、活动记录、可编辑记忆和 Artifacts 串在一起。头像下显示工作状态，活动列表展示具体事情；Goals 图将短期事项与长期目标区分。审批用独立的接受／拒绝控件，成果采用适合任务的形式；Ideas 用于帮助用户找到用途。后台通知以有意义的变化或需要输入为条件。[U02](https://introducing.muse.ai/)

[官] 安全架构把执行环境、凭据和 Sentinel 权限裁决分开。客户端的确定性审批有独立意义，不能只靠模型说“我会先问你”。这属于官方架构说明，本次没有审计 VM 或验证隔离强度。[U03](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)

[官] Muse Wonder 的 10 月公告将其进入 Muse 的状态描述为即将、订阅用户优先；模型发布不等于 Muse 所有账号已使用该模型。[U07](https://about.fb.com/news/2026/10/introducing-muse-wonder-models/)

### 值得学与不照搬

**对 LISA 的判断：** 学低门槛生活语言、少而有用的主动建议、头像与真实状态相连、目标和产出的独立视图。Soft Ink 已经是资产，应该进入任务等待、空态、完成和回访场景，而不是再做一次换皮。

LISA 不应首期扩展购物、支付、电话、实时视频角色或硬件。更不应将“用户自己的 Mac”写成“数据从不离开机器”：远程模型和连接器本来就有数据出站。重点应是说明哪些内容去哪里、为什么、能否撤销。

## 4. 补充参照

| 产品 | 已读证据 | 可借鉴 | 本轮取舍 |
| --- | --- | --- | --- |
| Cue | [X01／Manus 公告](https://manus.im/blog/introducing-manus-2-0) 将其作为独立 personal agents 产品，包含身份、联系方式、钱包、电脑和协作 | 关系入口与具体工作单元分离，持续责任可被命名 | 不与 Manus Studio 混为一物；不引入 agent 钱包和多人格名册；当前 iOS 完整开放状态待验 |
| Claude Cowork | [X02](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) 强调成品、云会话、原位改稿；[X03](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork) 区分新云调度与旧本地调度 | 在成果上修改；同一任务跨端续接；迁移时明确旧任务留在哪里 | 不将“聊天／工作”做成每次发消息前必选模式；不强制迁移旧本地任务 |
| Claude Dispatch | [X04](https://support.claude.com/en/articles/13947068-assign-tasks-from-anywhere-in-claude-cowork) 描述手机派给桌面的任务与成品取回，桌面必须在线 | 手机委派、桌面执行、手机拿结果 | 单连续线程对多项目会拥挤；LISA 保留关联任务详情 |
| Perplexity Personal Computer | [X05](https://www.perplexity.ai/personal-computer) 描述快捷入口、Mac App／文件／浏览器、语音、iPhone 远程 | 将桌面常驻能力压缩为随时可唤起的小入口；解释主机在线条件 | 不把“24/7”作为无需常开设备的保证，也不在首期默认采集屏幕 |

## 5. 按同一任务比较，避免只数功能

以下是从官方设计推导的**测试脚本**，不是本次完成的竞品测试。

| 场景 | Manus 应重点验证 | Dot 应重点验证 | Muse 应重点验证 | LISA 对齐目标 |
| --- | --- | --- | --- | --- |
| 整理一周资料形成简报 | 引用、项目资料、可编辑交付物 | 责任到委派任务的可追溯性 | 从主聊天进入资料与结果 | 有来源、有文件、有继续改稿入口 |
| 每周追踪一个网页 | 试运行、无变化记录、历史上下文 | 明确保存调度及通知目的地 | 目标进度与低打扰 | 本地 watcher 完整 UI、时区、去重、停用 |
| 手机上审阅一份外发草稿 | 账号与收件人、最终正文 | 自动审查与用户决策边界 | 原生审批是否与操作绑定 | 不能只写“同意”；绑定具体快照与审批者 |
| 手机请 Mac 整理目录 | 文件权限、主机断线、接管 | 任务原始环境、连接不等于迁移 | Mac 权限与手机可见状态 | 离线排队、预览变更、结果取回 |
| 更改已经记住的偏好 | 项目指令与已启动任务差异 | 对话上下文与私有笔记差异 | 可编辑记忆的范围 | 来源、版本、撤销及后续生效说明 |
| 取消后确认不再运行 | 单次运行与调度的分别停止 | 主任务、子任务、调度三个层级 | 长期目标与后台任务 | 明确停止范围，已发生动作如实保留 |

同一脚本应使用合成材料、同一完成标准、记录 App 版本和账号资格；中途需要人工操作也计入成功路径。不能以演示视频速度或营销图中的已完成状态代替结果质量。
