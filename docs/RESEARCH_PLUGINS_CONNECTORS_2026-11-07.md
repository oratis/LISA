# Grok Bot 与 Manus 插件和连接器提示调研

> 调研日期：2026-11-07。对象为 Grok Bot 与 Manus；用户已确认原请求中的 musa 指 Manus。
> 代码基线：LISA `972b097`，同时参考工作区已有的产品对齐方案。
> 配套文档：[LISA 插件与连接器实现方案](PLAN_PLUGINS_CONNECTORS_2026-11-07.md)。

LISA 应优先完成**任务需要什么应用，就在对话里解释并引导连接，连接成功后继续原任务**的体验。Grok Bot 值得借鉴的是插件目录、连接卡片和故障修复；Manus 值得借鉴的是按任务推荐连接器，以及 Project 对工具的预配置。插件包、账号连接、任务启用和动作许可应分别管理。

## 1 名词与范围

| 名词 | 本文含义 | 对 LISA 的意义 |
|---|---|---|
| Plugin | 可分发的能力包，可以包含技能和连接器配置，也可能携带可执行组件 | 解决安装、版本、依赖、来源与更新 |
| Connector | 对应用或服务的适配，暴露可调用操作 | 解决“能对 GitHub 做什么” |
| Connection | 用户连接的具体账号、组织、站点或实例 | 解决“用哪个账号，权限是否有效” |
| Skill | 可复用的任务流程与操作说明 | 解决“怎样组合工具完成工作” |
| MCP | 工具发现和调用协议 | 连接器的一种实现方式；内置 API 与本机 CLI 也可作为适配器 |

Grok Bot、Grok 普通聊天的 Connectors、Grok Build 的插件目录属于不同产品入口；不能把 Grok Build 的 `.grok-plugin` 格式直接当作 Grok Bot 的格式。Manus 的公开产品资料主要使用 Connectors、Agent Skills、Projects，不能据此声称它有一个与 Cursor 完全等价的通用插件包规范。

## 2 Grok Bot 的连接体验

### 2.1 连接卡与账号状态

用户既可从 Connect apps 搜索应用，也可从聊天中的 Connect 卡进入授权；`@` 可把应用附加到任务。官方明确区分 Added 与已登录，支持重新打开登录流程。连接属于账号；OAuth token 位于 Cursor 连接器后端，不交给 Bot 的电脑。新加入应用的工具，文档描述为从下一条消息可用。[Grok Bot 应用文档](https://docs.x.ai/grok-bot/computer-and-apps)

多账号支持需要逐个适配器确认：当前帮助文档明确说 Gmail 同时仅连接一个邮箱，而 Notion 等部分应用可添加第二个账号。LISA 可以设计多账号数据模型，但不可把所有第三方服务都显示成支持多账号。[Cursor 连接帮助](https://cursor.com/help/grok-bot/connect-apps)

### 2.2 主动提示与恢复

2026-10-26 和 10-27 的官方更新记录给出了直接相关的行为：

- 用户要求的应用未安装时，查目录并链接对应应用；登录网页也可触发对应 connector 推荐。
- Add 可合并安装与进入登录；连接中和已连接有独立状态。
- 无需登录的连接可在同一回复继续；接管登录被连接器解决后结束接管。
- 工具列表更新须处理并发；权限无法通过重新连接获得时应明确解释，不能反复要求重连。
- 登录等待较长时提示仍在登录，而不是直接宣告失败。

这些是官方列出的产品行为，不代表已获知其内部实现。特别是“下一条消息可用”与“无需登录时同一回复续跑”适用条件不同，不宜合并成所有 OAuth 场景都无缝自动恢复。[Grok Bot 更新记录](https://x.ai/changelog/bot)

### 2.3 插件与动作授权

Grok Bot 官方介绍支持插件和自定义 MCP，还描述了把 API 封装为包含 MCP server 与 skills 的插件的流程。Cursor 的插件文档另行定义了可携带 rules、skills、agents、commands、MCP、hooks 的组件体系，以及 root `plugin.json` 的 Agent Plugins 和 `.cursor-plugin/plugin.json` 两种格式。**这是生态与适配参考，不是 Grok Bot 对所有 Cursor 组件和变量兼容性的保证。**[Grok Bot 工作原理](https://docs.x.ai/grok-bot/how-grok-bot-works)、[Cursor 插件文档](https://cursor.com/docs/plugins)

连接卡只负责登录；操作审批卡负责具体动作，安全输入表单负责密钥。Auto Review 使用用户自己的请求作为授权依据，邮件和网页中的内容不算用户请求。这一边界可直接转化为 LISA 的模型工具与服务端职责划分。[Grok Bot 审批文档](https://docs.x.ai/grok-bot/approvals-security-and-privacy)

## 3 Manus 的连接器与推荐

### 3.1 任务中推荐并启用

Manus 专门发布了 Connector Recommendations：根据当前任务需求与连接器描述，从用户的 connector 列表推荐合适的连接；用户确认后启用，需要登录的仍须完成授权，然后继续任务。流程在当前对话里呈现，并覆盖移动端。[Manus 连接器推荐](https://manus.im/blog/manus-recommended-connectors)

这为 LISA 提供的直接设计依据是：**推荐是一项结构化的待处理请求，携带任务上下文与继续执行的位置。** 官方说明没有公布推荐模型、排序规则或内部暂停协议；下面的 LISA 设计属于实现建议。

### 3.2 接入渠道与任务启用

Manus 当前提供目录应用、Custom MCP、Custom API 三种入口。Custom MCP 可用 URL、命令或 JSON 配置；Custom API 保存 key/token 和可选使用说明。Google Workspace 可按服务选择 Read 或 Full。连接器负责接入应用，Skill 负责可复用任务能力。[Manus Connectors](https://www.manus.im/features/connectors)

其公开 API 的 `connector.list` 返回当前用户已安装的连接器，字段包含 ID、名称、描述、分类及 `builtin/byok/mcp` 类型；标准 OAuth 客户端只能看到用户授予它的连接器。API 任务可以携带连接器 ID。这个接口不是全市场搜索接口，也没有提供足以证明“账号健康、工具已加载、当前任务可用”的完整状态。[connector.list](https://open.manus.im/docs/v2/connector.list)、[API 连接器用法](https://open.manus.im/docs/v2/connectors)

### 3.3 Project 与 Skill 的组合

Projects 可以预设连接器，使新任务继承工具配置；团队管理员可推荐必需应用，成员各自连接账号。这给 LISA 的长期设计提供了“共享流程与推荐清单，账号连接保持个人归属”的参考。[Manus Projects Connectors](https://manus.im/blog/projects-connectors)

Agent Skills 支持封装工作流程、脚本与 `SKILL.md`，也支持通过斜杠命令明确调用。它与 MCP 职责互补。LISA 可以让一个“项目周报”插件打包 Skill，并声明需要 GitHub 与日历；安装这个包不意味着自动获得两个账号的权限。[Manus Agent Skills](https://manus.im/blog/manus-skills)

## 4 对照与取舍

| 维度 | Grok Bot | Manus | LISA 建议 |
|---|---|---|---|
| 用户入口 | Connect apps、聊天连接卡、`@` 应用 | Connectors、任务中推荐、Project 预设 | 聊天连接卡为主，设置与输入框提供主动入口 |
| 包与流程 | 插件封装工具与技能；自定义 MCP | Connectors 与 Agent Skills 组合 | 内部统一插件包，对用户展示“连接应用”和“技能” |
| 推荐依据 | 请求的应用、目录匹配、部分登录页 | 当前任务需求和连接器描述 | 明确请求优先，再匹配能力缺口；受控目录校验 |
| 安装与连接 | 官方明确区分 | 连接后还存在任务／Project 启用 | 安装、账号、任务绑定各有状态 |
| 后续执行 | 不同接入路径有不同续跑时机 | 官方推荐流程明确继续任务 | 将恢复条件写成协议并持久化 |
| 动作权限 | 连接卡与审批卡分开 | 启用和 OAuth 仍需确认 | 连接不扩大任务授权；写操作走 Warden |
| 分发范围 | 账号下多个 Bot 可用 | Project 配置与个人账号分离 | 用户／Home 拥有连接，任务绑定账号和能力 |

上表的产品事实来自第 2、3 节；最后一列均为 LISA 的建议。首期应优化连接成功后的任务完成率，而不是追求目录规模。

## 5 用户截图的可观察事实

截图展示了：用户要求查看 Mac 项目与 GitHub；助手说明 GitHub 尚未连接；出现 GitHub 卡片且截图时显示 Connected；随后出现账号已连接消息与“继续查看”的选择卡。由此可确认连接操作被放在原对话中，并有可视状态和后续交互。

截图是一张最终状态画面，**不能证明早先“未连接”文案在发出时错误，也不能证明所有任务在连接后都需要第二次确认**。它还不能说明 OAuth 存储方式、原任务是否持久化、断线后是否恢复。

LISA 应吸收这一卡片入口，并进一步明确：如果用户已经要求只读总结，连接卡说明“连接后继续本次总结”，成功后可继续原范围；选择了另一账号、改变目标、增加写操作或任务已经取消时，再进入相应选择或审批。

## 6 LISA 当前基础与缺口

| 模块 | 已有代码 | 与目标体验的差距 |
|---|---|---|
| 插件包 | [types](../src/plugins/types.ts)、[loader](../src/plugins/loader.ts) 加载 `.lisa-plugin/plugin.json`、技能、命令、agents、hooks、`.mcp.json` | Manifest 仅 name/version/description/author；没有通用目录、连接定义、账号和安装生命周期 |
| MCP | [client](../src/mcp/client.ts)、[config](../src/mcp/config.ts)、[管理工具](../src/tools/mcp.ts) | 只有 stdio；配置全局保存；add/remove 要重启；错误结果主要转成文本；子进程继承环境 |
| 工具注册 | [CLI 组装](../src/cli.ts)、[Agent](../src/agent.ts) | 启动时组装；Agent 内工具映射按调用入口建立，不能只改 UI 就实现中途添加 |
| GitHub | [github](../src/tools/github.ts) 已通过 `gh` 提供 issue、PR、CI、release 操作 | 需要外部登录；没有产品化账号探测、连接卡、仓库／提交活动完整查询 |
| 权限 | [Warden](../src/warden/session.ts)、[API](../src/web/warden-api.ts)、[inbox](../src/warden/inbox.ts) | 存在完整动作摘要和审批；默认不是 Warden；等待者在内存中，重启后旧审批不能放行 |
| 凭据 | [secrets](../src/warden/secrets.ts)、[后端选择](../src/warden/secrets-open.ts) | Keychain／加密存储与引用解析已有；源码检索未发现通用工具执行端消费 `resolveSecretRefs` |
| 后台任务 | [Task 类型](../src/tasks/types.ts)、[runner](../src/tasks/runner.ts)、[wiring](../src/tasks/wiring.ts) | 有 run、租约、副作用记录；等待状态类型不等于连接恢复协议；`setTaskApprovalFactory` 尚无生产调用点 |
| 三端界面 | [Web 客户端](../src/web/assets/client/main.js)、[Mac 容器](../packaging/mac-client/Sources/Lisa/WebContent.swift)、[Pocket](../packaging/ios-companion/Sources/ChatView.swift) | Web 有审批事件；没有统一 connector 卡片事件；Mac 复用 Web，Pocket 需独立渲染 |
| Cloud | [能力边界](../src/web/capabilities.ts)、[Home](../src/paths.ts)、[任务宿主](../src/web/tasks-host.ts) | Cloud 启动不加载宿主插件/MCP，云任务默认关闭；不能通过开放全局配置实现租户连接器 |
| 特定领域 | [社交连接器](../src/sense/social/connectors/plugin.ts) | 可借鉴 manifest、能力探测、批准后由宿主执行；目前是领域专用协议 |

因此，本次增量应接在现有 [产品对齐方案 C01](PLAN_PRODUCT_ALIGNMENT_2026-10-24.md) 下，并显式依赖 B01–B03 的权限与任务恢复工作。下一步开发切分、接口、状态与验收见[实现方案](PLAN_PLUGINS_CONNECTORS_2026-11-07.md)。

## 7 2026-11-08 复核与实施

本轮从 `429ef5b` 的七项本机只读应用和 Linear 远程 MCP 出发。以下产品行为依据公开官方资料，未登录五款竞品实测。

| 产品 | 本轮核对的产品行为 | 对 LISA 本轮范围的影响 |
|---|---|---|
| Cue | 每个 agent 有自己的身份与电脑，多个 agent 可在群聊中分工。[Manus 发布说明中的 Cue](https://manus.im/blog/introducing-manus-2-0) | 标明连接在哪台主机执行。跨 agent 共享凭据需要另行设计。 |
| Grok Bot | 用户能浏览或搜索应用、从聊天卡登录，再将应用附加到任务。[Grok Bot 应用文档](https://docs.x.ai/grok-bot/computer-and-apps) | 把已支持的应用和可执行示例放进聊天输入框菜单，选择后保留草稿供编辑。 |
| Manus | 自定义 MCP 接受服务 URL、命令或 JSON 配置。[Manus Connectors](https://www.manus.im/features/connectors) | 给已有命令型配置补上 HTTPS 入口，Home 与插件使用同一套解析。 |
| Meta Muse | 平台要求对工具说明读写范围、敏感程度和副作用。用户可以按工具选择授权，敏感写操作逐次确认。[Muse Connector Platform](https://platform.muse.ai/docs) | 目录展示已实现的只读任务，自定义 MCP 的工具清单只决定哪些工具可见，具体调用仍沿用所在会话的动作策略。 |
| OpenAI Dot | 插件可用性取决于账号连接、权限和任务执行环境。[Dot 的电脑与应用](https://learn.chatgpt.com/docs/dots/computers-and-apps) | 目录回答支持哪些任务。账号就绪和资源授权继续由原任务的连接卡判定。 |

本轮验证使用 Microsoft Learn 的免登录 HTTPS 端点，通过 LISA 客户端完成协议握手、按名称加载一个工具并执行公开文档检索。浏览目录只读本机定义，原有连接卡即使正在等用户登录也能继续。自定义远程 OAuth、运行中重载，以及跨设备共享连接仍待实现。微软端点只覆盖公开资料场景。[Microsoft Learn MCP](https://learn.microsoft.com/en-us/training/support/mcp)

下一步优先验证一个需要登录的远程 MCP。验收场景是用户在原任务中授权、选择资源并完成读取，再撤销授权并重试同一任务。届时分别记录首次读取、撤销生效和任务恢复的结果，并核对账号切换时旧授权的作用范围。
