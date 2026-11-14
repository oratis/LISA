# 从 T3 Code 引入可追溯的编程任务

2026-11-11 · 评审后修订。第一期拆成两个切片。1A 是执行机上的任务经过、游标补读和桌面界面，已在远程 Mac 首版（#471）之上实现并通过三机联测，随 [PR #473](https://github.com/oratis/LISA/pull/473) 评审。1B 让获授权的 Pocket 查看指定任务，2026-11-14 的实现覆盖当前连接的 Mac，随本次 PR 评审。目标不变：用户在桌面派工后，即使控制端中途离线，回来也能看到哪台 Mac 做了什么、哪一步在等人，以及当前可以采取什么操作。

[评审结论](#评审结论) · [1A 的约定与验收](#1a-执行机时间线与桌面任务经过) · [1B 的实现范围](#1b-让已配对的-pocket-查看指定任务)

## 对照依据

本次查阅了 T3 Code 的服务端、适配器接口、MCP 工具与使用文档。LISA 主分支基线为 `5803049`，Fleet 的对照基线取自仍在评审的 PR #471。评审逐条核对了全部固定版本的外部引用，以及文中对 LISA 代码的每项描述，更正见[评审结论](#评审结论)。原稿把 Pocket Room 待办列为基线，它来自尚未发布的工作树，无法复核，初版因此把它列作 1B 的前置条件；11 月 14 日的实施采用现有 Agents 入口，范围见下文。本文记录源码比较、1A 在开发机上的验收，以及后续切片的拟议验收场景。租用真机、生产中继和真实模型推理仍属 #471 的发布门槛。[T3 Code 固定版本](https://github.com/pingdotgg/t3code/tree/e89abadaee70e0d73fb19a5ce40a686b1a92310e) · [LISA 主分支基线](https://github.com/oratis/LISA/tree/580304920c92e840b29168fd97db28e0861a4a9e) · [Fleet PR #471](https://github.com/oratis/LISA/pull/471) · [时间线 PR #473](https://github.com/oratis/LISA/pull/473)

| T3 Code 的能力 | LISA 的起点和可引入的增量 |
|---|---|
| Web、桌面和手机通过已认证的连接操作工作机上的 coding agent。工作机持有文件、Git、凭据和执行进程，客户端不代入自己的凭据。 | LISA 已有 Mac 配对、Pocket 会话列表和多 agent 观察器。可在现有入口按主机展示每个会话实际支持的操作。[T3 运行架构](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/docs/internals/overview.md) · [LISA 远程连接](REMOTE_CONNECTIONS.md) · [会话类型](../src/integrations/types.ts) |
| 指令收据、事件、状态投影和待执行动作在同一个事务里提交。重连的客户端按序号补读。游标领先于服务端，或落后超过 128 条事件、1 MiB 时，服务端改发当前快照。事件日志只保留约一天，持久的真相是状态投影。 | Fleet 首版有 SQLite 收据、任务状态和最近一轮结果，没有逐条经过。主分支的跨 agent 活动日志是限长的内存记录。1A 采用同样的分工：任务行是持久状态，任务经过是有界日志，落后太多的读者拿到当前状态和缺口说明。[T3 事件提交](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/apps/server/src/orchestration-v2/EventSink.ts) · [T3 重连补读](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/apps/server/src/orchestration-v2/ThreadStream.ts) · [T3 事件留存](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/apps/server/src/orchestration-v2/ProjectionMaintenance.ts) · [Fleet 账本](https://github.com/oratis/LISA/blob/d5d939b98d69291387e0684cf2e07474cb863703/src/remote/fleet/host-service.ts) · [LISA 活动日志](../src/orchestrator/journal.ts) |
| 用户能查看一轮、一次提交或整个分支的 diff。检查点用临时索引把工作区写成提交对象，存入私有 Git 引用。从某条消息回退时对话回到该处。文件恢复只对独立 worktree 的线程提供，并要求 provider 支持回退。 | LISA 可为并行 agent 建独立 worktree，也能审查工作区和 PR。增加每轮前后基线，才能回答「刚才这一轮改了什么」。[T3 按轮审查](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/docs/user/source-control.md) · [T3 回退](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/docs/user/composer.md) · [T3 快照实现](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/apps/server/src/vcs/GitVcsDriver.ts) · [LISA 并行对比](../src/tools/compare_agents.ts) · [LISA diff](../src/tools/review_diff.ts) |
| 运行中可以追加下一轮指令，部分 provider 支持当轮调整方向。切换 provider 时按预算挑选带角色的原始消息和执行结果移交，默认上限 16,000 token，不生成摘要。 | LISA 可以先区分「排在下一轮」和「本轮已收到」，再用用户选定的请求、结果和改动引用支持跨 agent 复核。[T3 消息与排队](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/docs/user/composer.md) · [T3 上下文交接](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/docs/user/portable-handoffs.md) |

## 评审结论

外部引用涉及的 10 个文件在固定版本上全部存在。下表列出需要更正或补充的地方，以及本次修订的处理。

| 评审发现 | 处理 |
|---|---|
| 三处 T3 表述与源码不符。快照回退和留存期不在 `EventSink.ts`。回退对工作区和对话两端的影响写在消息输入文档。`tools.ts#L225-L253` 跨了两个工具，`t3_project_list` 在另一个文件，`t3_thread_read` 的送达标记只对 T3 内部的调用者生效。 | 已更正对照表和连接器一节，补上对应的固定版本链接。 |
| 原第一期把成熟度不同的三件事放在一起。执行机记录和桌面界面只依赖 #471。Pocket 查看还需要新的授权类型、多主机目录和一次 iOS 发版。 | 拆成 1A 和 1B，各自验收。 |
| #471 用七条独立的 UPDATE 改写任务状态，其中两条在任务正在取消时不生效。原稿只写了「一起提交」。 | 事件与状态更新同一事务，更新没有生效就不写事件。 |
| #471 只保留最近一轮结果。「结果待核实」是读取时按后端实例推算的，没有落盘。审批结束时适配器不报告原因。原稿的验收却需要两轮结果、旧审批的处理结果和一条待核实记录。 | 每轮结果摘要写入事件。审批结束带原因。新后端启动时为失联任务追加一条待核实。 |
| 原稿提到游标过期，却没有给留存上限。#471 的账本也从不清理，收据满 50,000 条后拒绝取消以外的新操作。 | 每个任务保留最近 500 条事件，单条有字数上限，读取时报告缺口。收据与任务行的清理列入后续。 |
| 经中继的每次请求都要新建连接并握手。原稿没有估算逐任务轮询的成本。 | 任务列表带上最新序号，序号前进才读时间线。快照和事件一次返回。 |
| #471 的观察权限目前只能看到工作区列表，因为任务按发起设备过滤。普通配对的 Pocket 访问不了 Agent Host 路径，Pocket 也只保存一台 Mac。 | 写成 1B 的前置条件和路由约定。 |
| 实施时发现 #471 的沙箱规则让 agent 读不到授权工作区和自己的临时目录。本机的 Claude Code 2.1.318 因此启动即退出，旧版 CLI 上获准的 Read 会向模型返回权限错误。 | 已在 PR #473 修复并加回归断言，建议在 #471 合并前带上。 |

## 第一期 · Fleet 时间线

### 1A 执行机时间线与桌面任务经过

**例子。** 桌面把修改任务交给一台 Mac mini。agent 请求写一个文件时，mini 与中继的连接断开。恢复后用户批准，追加一轮，随后取消。任务卡下方的任务经过按顺序列出第 1 轮的指令开头、等待审批的工具和文件、审批结果、第 1 轮结果、第 2 轮、取消来自谁和结束状态，卡片上有最后更新时间。刷新页面后读到的是同一份记录。

1. **由执行机记录事件。** 在 #471 的 SQLite 账本增加事件表，每个任务的序号从 1 连续递增。状态更新和描述它的事件在同一事务提交，更新没有生效就不写事件。重复操作沿用原收据，不产生第二条事件。事件只保存显示所需的摘要：指令开头 500 字、审批的工具和工作区内的相对路径、每轮结果末尾 4,000 字。完整工具参数仍只在待处理的审批上，经现有的授权详情读取。
2. **用游标读一项任务。** `GET /api/agent-host/v1/runs/{id}/events?after=<序号>&limit=<条数>` 一次返回任务的当前快照和游标之后的事件，每页最多 100 条。客户端按账号、主机和任务保存最后序号，按序号去重。请求的历史已被清理时，响应标明缺口并从最早留存处继续。游标领先于账本说明账本被换过，客户端丢弃本地副本重读。每次读取都重新检查设备和工作区授权。首版沿用轮询。
3. **控制每次读取的成本。** 任务列表里的每个任务带上最新序号和最后更新时间。控制页仍按原节奏轮询列表，只在选中任务的序号前进时才读时间线，空闲时不增加中继请求。
4. **留存与兼容。** 执行机为每个任务保留最近 500 条事件。能力声明增加 `run-events`，控制页连到没有此能力的执行机时隐藏任务经过。时间线之前的任务补一条基线事件，界面说明更早的经过没有记录。OpenAPI 契约、远程路由白名单和数据清单随实现一起更新。

| 事件 | 写入时机 | 内容 |
|---|---|---|
| `turn_started` | 启动任务时与任务行同一事务；追加的指令送达之后 | 轮次，指令开头 |
| `approval_requested` | agent 请求 Read、Edit 或 Write | 审批 ID、工具、目标路径、过期时间 |
| `approval_resolved` | 审批结束 | 审批 ID。结果为允许、拒绝、超时、agent 撤回、批准时已失效或任务停止 |
| `tool_blocked` | 工作区策略直接拒绝一次工具调用 | 工具和目标。每轮最多记 20 条，总数写入本轮结束事件 |
| `turn_completed`、`turn_failed` | 本轮返回结果 | 轮次、结果摘要、是否截断 |
| `cancel_requested` | 任务转为正在取消 | 来自控制端、执行机所有者、一小时时限或后端退出 |
| `run_ended` | 进程退出 | 终态，失败时带原因 |
| `outcome_unknown` | 新后端启动时发现上一实例留下的活动任务 | 每次失联只记一条。不改任务状态，不重新执行 |
| `owner_released` | 所有者确认旧进程已退出并释放执行位 | 无 |
| `history_started` | 账本里早于时间线的任务 | 当时可核实的状态 |

`tool_blocked` 是评审时加的。#471 对越界路径、隐藏文件和未授权工具直接拒绝，用户只能看到 agent 说写不进去，看不到原因。

以下场景于 2026-11-11 在开发机通过，环境为 macOS 27.2、Claude Code 2.1.318、Chrome 和确定性的本地 Messages 服务。全库 Node 测试 4,123 项通过，1 项因本机无法启动 node-pty 跳过。[实现](https://github.com/oratis/LISA/blob/974942a60151e09255ede485b440856c87f76688/src/remote/fleet/host-service.ts) · [时间线测试](https://github.com/oratis/LISA/blob/974942a60151e09255ede485b440856c87f76688/src/remote/fleet/timeline.test.ts) · [三机联测](https://github.com/oratis/LISA/blob/974942a60151e09255ede485b440856c87f76688/src/remote/fleet/fleet.test.ts)

| 验收场景 | 通过条件与结果 |
|---|---|
| 任务启动后回包丢失，客户端使用同一操作 ID 重试 | 主机只启动一个任务，时间线只记一次启动，收据和执行结果分别可查。联测中每个指令都发两遍，每条事件只出现一次。 |
| 控制端在等待审批时断线，之后处理审批并继续第二轮 | 重连后从断线前的游标一次读回其间的经过，顺序正确。经加密中继验证。 |
| 另一台同名 Mac、另一个设备，或执行机撤销授权 | A 的事件不会归给 B。撤权或收回工作区后读取被拒绝。 |
| 游标超出留存，或领先于账本 | 前者返回当前快照并标明缺口。后者从最早留存处重读。 |
| 执行机在 agent 活动期间重启 | 追加一条结果待核实，之前的历史保留，重试原操作不会再次启动。所有者释放执行位后留下记录。以第二个后端实例打开同一账本验证。 |
| 账本里已有时间线之前的任务 | 从可核实的状态开始，只有一条基线事件。 |
| 原版 Claude Code 在沙箱内运行 | 审批、编辑、读取、追加和取消全部完成，获准的 Read 把文件内容交给了模型。 |

### 1B 让已配对的 Pocket 查看指定任务

**例子。** 所有者在 mini 上把一个任务的查看权给自己的 Pocket。手机离线期间，agent 请求一次文件编辑，用户在桌面批准并追加一轮。手机重连后从任务列表进入同一任务，看见两轮结果、已处理的审批和最后更新时间，页面上没有可提交的审批动作。

2026-11-14 实施范围：#471、1A 和后续修复 #498 已合入。Pocket 本期继续使用当前选择的一台 Mac，界面显示其名称；多 Mac 保存和 Room 待办仍是后续工作。新入口位于 Agents 页的 Shared Fleet tasks，需随新版 Pocket 发布，旧版无此入口。

执行机所有者在「远程 Mac → 配置这台 Mac 作为执行机 → Pocket 只读查看」为已安全配对的设备分享任务或撤销查看。列表包含最近 50 个任务以及仍有分享记录的历史任务，已结束的任务也能分享。

- **授权。** 由执行机所有者在 mini 的本机页面，对指定任务和一台已完成 v2 配对的设备授予查看权。授权存入账本，绑定任务、执行机、设备和本次配对的标识，可单独撤销。撤销配对时一并失效；同一设备重新配对也不会恢复旧授权。
- **路由。** 转发器目前会关闭普通配对设备访问 `/api/agent-host/` 的通道。v2 Pocket 仅新增 `/api/agent-host/v1/view/runs` 和 `/api/agent-host/v1/view/runs/{id}/events?after=N&limit=100` 两个 GET；未分享的任务不出现在列表，直接读取返回 404。其他 Agent Host 路径及所有写操作维持拒绝。每页重新核验配对与任务授权。
- **摘要。** 查看者得到状态、轮次、审批的工具与结果、每轮结果摘要和最后更新时间。待处理审批的完整工具输入、审批 ID 和指令开头不下发。
- **补读。** Pocket 前台每 4 秒读取，回到前台立即同步；断线保留最后收到的数据并标记，恢复后从最后已合并的序号逐页补读。按序号去重，处理 500 条保留上限、缺口和账本重置；切换账号/Mac 清空状态，撤权关闭详情。数据只保存在内存，不写手机磁盘。
- **审批。** 首版只有发起任务的控制端有决定权。Pocket 打开已处理的审批通知时显示处理结果，仍待处理时显示工具、目标和应在哪台设备上处理。让 Pocket 参与审批需要另一种带决定权的授权，并在提交时重新核验主机、任务、当前请求 ID 及有效期，不在 1B 范围内。

| 验收场景 | 通过条件 |
|---|---|
| 已获查看授权的手机离线，桌面处理一次审批并继续第二轮 | 手机重连后按序看到两轮经过。旧审批显示处理结果，手机上没有可提交的审批动作。 |
| 换到另一台同名 Mac，或执行机撤销手机的查看权 | 页面不会把 A 的事件或审批归给 B。撤权后的新读取被拒绝，客户端关闭对应详情。 |
| 未获授权的 Pocket、v1 配对的设备，以及查看者访问其他 Agent Host 路径 | 全部被拒绝。查看者读不到工具输入和审批 ID。 |

[Fleet 授权与路由](https://github.com/oratis/LISA/blob/d5d939b98d69291387e0684cf2e07474cb863703/src/remote/fleet/types.ts) · [转发器](https://github.com/oratis/LISA/blob/d5d939b98d69291387e0684cf2e07474cb863703/src/remote/host.ts) · [Pocket 连接配置](../packaging/ios-companion/Sources/ConnectionProfiles.swift) · [现有 Pocket 会话入口](../packaging/ios-companion/Sources/RosterView.swift)

## 后续优先级

**第二期 · 按轮审查改动。** 先在 LISA 创建的独立 Git worktree 试点。由执行机进程在每轮开始和结束时取快照，不经过 agent。参照 T3 的做法，用临时索引把工作区写成提交对象，存入任务私有的 Git 引用，不改动用户的索引和工作树。在任务卡列出新增、修改、删除的文件，并按需显示有界 diff。快照遵守 `.gitignore`，被忽略的文件不在其中，界面要说明。私有引用随任务记录一起清理。验收覆盖未跟踪的新文件、轮内已提交的修改和任务开始前已有的改动。Fleet 的沙箱不让 agent 读写 `.git`，轮内提交和上游合并只会来自同时操作的人，无法可靠归属的变化标为「工作区同时变化」。不是 Git 仓库的工作区没有快照。1A 的时间线已按轮记录获准的 Edit 和 Write 及其目标，可以先据此列出本轮获准改动的文件，并注明获准不等于改动成功。回退另行设计，实施前须同时验证 provider 回退能力、工作区当前基线和用户后续编辑。[T3 检查点](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/apps/server/src/checkpointing/CheckpointStore.ts) · [T3 快照实现](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/apps/server/src/vcs/GitVcsDriver.ts)

**第三期 · 按主机声明能力，支持跨 agent 交接。** 先接 Claude 和 Codex。由目标主机结合适配器、会话状态和设备权限，分别报告可观察、可追加、可取消、可审批、可恢复。T3 的能力声明按轮次、线程和审批分项列出，没有单一的总开关。#471 的能力接口目前只报告是否可控制和不可用原因，1A 加了特性列表，第三期在它上面分项声明。Web 与 Pocket 据此显示操作，服务端执行时重新检查。验收时同一台机器并排展示一个外部观察会话和一个受管会话，各自只提供可兑现的操作。随后验证「Claude 实现，Codex 复核」：用户可预览接收方、原始要求、改动和验证结果，确认后才发送。历史审批随原请求结束，新 agent 的动作按自己的权限处理。[T3 适配器接口](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/packages/provider-core/src/server/ProviderAdapter.ts) · [T3 能力声明](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/packages/contracts/src/orchestrationV2.ts#L260-L397) · [LISA 审批设计](DESIGN_WARDEN.md)

## 两个可独立试验的入口

- **已有 T3 用户的只读连接器。** 用户通过 OAuth 授权，在 Lisa 中选择项目，询问哪些线程仍在进行。试点只接 `t3_project_list` 和 `t3_thread_list`，两者都声明为只读并支持游标翻页。`t3_thread_list` 另有 `allProjects` 参数，LISA 固定传用户选中的项目。`t3_thread_read` 声明为非只读，LISA 的只读 MCP 客户端会拒绝它。它的送达标记只对 T3 内部带线程身份的调用者生效，外部连接读取不会产生副作用，但列表元数据已足以验证首版需求。验收覆盖翻页、授权撤销和项目切换。[T3 外部接入](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/docs/user/outside-agents.md) · [线程工具声明](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/apps/server/src/mcp/toolkits/orchestrator/tools.ts#L225-L252) · [项目工具声明](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/apps/server/src/mcp/toolkits/project/tools.ts#L52-L66) · [送达标记的条件](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/apps/server/src/mcp/OrchestratorMcpService.ts#L3114-L3148) · [LISA 只读检查](../src/mcp/readonly-http.ts)
- **给截图附件附上窗口上下文。** 延用 Mac 主动截图和聊天草稿，允许用户预览窗口名并选附可访问性文字或控件位置。例如，请 Lisa 解读一张设置窗口的报错时，用户可先核对将发给模型的内容。验收覆盖窗口提供文字、用户关闭文字、系统未授予辅助功能权限三种情况，后两种仍能使用已有截图流程。[T3 SnapShot](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/docs/user/snap-shot.md) · [LISA 截图入口](../src/vision/capture.ts)
