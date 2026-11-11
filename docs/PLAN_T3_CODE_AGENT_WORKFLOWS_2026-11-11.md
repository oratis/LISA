# 从 T3 Code 引入可追溯的编程任务

2026-11-11 · 待评审方案。建议在远程 Mac 首版合入后，先交付 Fleet 任务时间线和 Pocket 待办入口。用户在桌面派工后，即使手机中途离线，回来也能看到哪台 Mac 做了什么、哪一步在等人，以及当前可以采取什么操作。

## 对照依据

本次查阅了 T3 Code 的服务端、适配器接口、MCP 工具与使用文档。LISA 主分支基线为 `5803049`。Fleet 的对照基线取自仍在评审的 PR #471，Pocket Room 待办取自在研工作树。本文记录源码比较和拟议验收场景，两端实机联调留在实施阶段。[T3 Code 固定版本](https://github.com/pingdotgg/t3code/tree/e89abadaee70e0d73fb19a5ce40a686b1a92310e) · [LISA 主分支基线](https://github.com/oratis/LISA/tree/580304920c92e840b29168fd97db28e0861a4a9e) · [Fleet PR #471](https://github.com/oratis/LISA/pull/471)

| T3 Code 的能力 | LISA 的起点和可引入的增量 |
|---|---|
| Web、桌面和手机操作工作机上的 Claude Code、Codex、OpenCode 等。工作机持有文件、Git、凭据和执行进程。 | LISA 已有 Mac 配对、Pocket 会话列表和多 agent 观察器。可在现有入口按主机展示每个会话实际支持的操作。[T3 运行架构](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/docs/internals/overview.md) · [LISA 远程连接](REMOTE_CONNECTIONS.md) · [会话类型](../src/integrations/types.ts) |
| 指令收据、状态、事件和待执行动作一起提交。客户端按游标补读，历史已清理时取当前快照。 | Fleet 首版有 SQLite 收据、任务状态和最近一轮结果。主分支的跨 agent 活动日志是限长的内存记录。远程任务缺少能在重连后逐条读取的经过。[T3 事件提交](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/apps/server/src/orchestration-v2/EventSink.ts) · [Fleet 账本](https://github.com/oratis/LISA/blob/d5d939b98d69291387e0684cf2e07474cb863703/src/remote/fleet/host-service.ts) · [LISA 活动日志](../src/orchestrator/journal.ts) |
| 用户能查看一轮、一次提交或整个分支的 diff。回退涉及工作区和 provider 会话两端。 | LISA 可为并行 agent 建独立 worktree，也能审查工作区和 PR。增加每轮前后基线，才能回答“刚才这一轮改了什么”。[T3 按轮审查](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/docs/user/source-control.md) · [LISA 并行对比](../src/tools/compare_agents.ts) · [LISA diff](../src/tools/review_diff.ts) |
| 运行中可以追加下一轮指令，部分 provider 支持当轮调整方向。切换 provider 时能按预算移交带角色的历史和执行结果。 | LISA 可以先区分“排在下一轮”和“本轮已收到”，再用用户选定的请求、结果和改动引用支持跨 agent 复核。[T3 消息与排队](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/docs/user/composer.md) · [T3 上下文交接](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/docs/user/portable-handoffs.md) |

## 第一期 · Fleet 时间线与 Pocket 待办

**例子。** 桌面把修改任务交给一台 Mac mini。手机离线期间，agent 请求一次文件编辑，用户在桌面批准并追加一轮。手机重连后，从待办或任务列表进入同一任务，看见两轮结果、已处理的审批和最后更新时间。如果此时出现新的审批，页面给出它对应的工具、目标和有权处理的设备。

1. **由执行机记录事件。** 扩展 #471 的 SQLite 账本，为每个 run 分配单调递增序号，把轮次开始、需要审批、审批结束、本轮结束、失败、取消和结果待核实写成结构化事件。每次状态变更与对应事件一起提交。重复操作沿用原收据。进程归属无法确认时记录“待核实”，恢复连接只补读历史。事件只保存显示所需的摘要和引用，完整工具参数仍走现有授权详情接口。
2. **用游标读一项任务。** 在 Agent Host 协议增加按 run 和序号分页的读取能力。客户端保存主机、工作区、run 和最后序号，重复事件按序号去重。首次打开或游标过期时取带序号的当前快照，再读后续事件。旧任务从可核实的当前状态开始，早期历史缺失要在界面说明。首版可沿用轮询；每次读取都检查当前授权。
3. **把待办指向正确的设备和请求。** #471 当前按发起设备与已授权工作区过滤任务。优先在桌面完成时间线，再由执行机所有者把指定任务的查看权授予已配对 Pocket。只读授权仅返回任务摘要。需要处理的请求继续由有决定权的设备操作。审批时重新核验主机、任务、当前请求 ID 及有效期；打开已经处理的通知时显示处理结果。[Fleet 授权与路由](https://github.com/oratis/LISA/blob/d5d939b98d69291387e0684cf2e07474cb863703/src/remote/fleet/types.ts) · [现有 Pocket 会话入口](../packaging/ios-companion/Sources/RosterView.swift)

| 验收场景 | 通过条件 |
|---|---|
| 任务启动后回包丢失，客户端使用同一操作 ID 重试 | 主机只启动一个任务。时间线只记一次启动，并能分别看到收据与实际执行结果。 |
| 已获查看授权的手机离线，桌面处理一次审批并继续第二轮 | 手机重连后按序看到两轮经过。旧审批显示处理结果，只读手机看不到可提交的审批动作。 |
| 换到另一台同名 Mac，或执行机撤销手机授权 | 页面不会把 A 的事件或审批归给 B。撤权后的新读取被拒绝，客户端关闭对应详情。 |
| 游标超出留存期，或执行机在 agent 活动期间重启 | 前者用快照接续并标明缺失历史；后者显示结果待核实，重新打开页面不会触发第二次执行。 |

## 后续优先级

**第二期 · 按轮审查改动。** 先在 LISA 创建的独立 Git worktree 试点。记录每轮开始、结束时的基线，用任务私有 Git 引用保存快照，在任务卡列出新增、修改、删除的文件，并按需显示有界 diff。验收覆盖未跟踪的新文件、轮内已提交的修改和任务开始前已有的改动。若有人同时编辑或引入上游合并，无法可靠归属的变化标为“工作区同时变化”。回退另行设计，实施前须同时验证 provider 回退能力、工作区当前基线和用户后续编辑。[T3 检查点](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/apps/server/src/checkpointing/CheckpointStore.ts)

**第三期 · 按主机声明能力，支持跨 agent 交接。** 先接 Claude 和 Codex。由目标主机结合适配器、会话状态和设备权限，分别报告可观察、可追加、可取消、可审批、可恢复。Web 与 Pocket 据此显示操作，服务端执行时重新检查。验收时同一台机器并排展示一个外部观察会话和一个受管会话，各自只提供可兑现的操作。随后验证“Claude 实现，Codex 复核”：用户可预览接收方、原始要求、改动和验证结果，确认后才发送。历史审批随原请求结束，新 agent 的动作按自己的权限处理。[T3 适配器接口](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/packages/provider-core/src/server/ProviderAdapter.ts) · [LISA 审批设计](DESIGN_WARDEN.md)

## 两个可独立试验的入口

- **已有 T3 用户的只读连接器。** 用户通过 OAuth 授权，在 Lisa 中选择项目，询问哪些线程仍在进行。试点只接 `t3_project_list` 和限定项目的 `t3_thread_list`，验收覆盖翻页、授权撤销和项目切换。T3 的 `t3_thread_read` 在读到子任务最终结果时可能将其标为已送达，工具声明为非只读。LISA 的只读 MCP 客户端会拒绝这项工具；列表元数据足以验证首版需求。[T3 外部接入](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/docs/user/outside-agents.md) · [T3 工具声明](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/apps/server/src/mcp/toolkits/orchestrator/tools.ts#L225-L253) · [LISA 只读检查](../src/mcp/readonly-http.ts)
- **给截图附件附上窗口上下文。** 延用 Mac 主动截图和聊天草稿，允许用户预览窗口名并选附可访问性文字或控件位置。例如，请 Lisa 解读一张设置窗口的报错时，用户可先核对将发给模型的内容。验收覆盖窗口提供文字、用户关闭文字、系统未授予辅助功能权限三种情况，后两种仍能使用已有截图流程。[T3 SnapShot](https://github.com/pingdotgg/t3code/blob/e89abadaee70e0d73fb19a5ce40a686b1a92310e/docs/user/snap-shot.md) · [LISA 截图入口](../src/vision/capture.ts)
