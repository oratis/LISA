# DeepSeek Harness（dsh）源码与架构调研

> 更新：2026-08-13 · 状态：调研完成
>
> **引入说明（2026-08-14）**：本文原产于另一个项目（逗逗AI 2.0）的 `docs/research/deepseek-harness.md`，
> 原样引入本仓作为外部 harness 的一手调研底本。§1–§4、§6 是与产品无关的客观调研，可直接引用；
> **§5 是源项目的结论，不是 LISA 的结论**，其中的相对链接指向源仓库、在本仓不可解析，已改为纯文本。
> LISA 侧的对照分析、取舍与排期见 [PLAN_HARNESS_ALIGNMENT_v1.0.md](./PLAN_HARNESS_ALIGNMENT_v1.0.md)。

## TL;DR

- **DeepSeek 亲自下场做 harness 层**：2026-08-13 开源 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`），MIT 协议、TypeScript、Developer Preview。开源当天 GitHub 星标 26,995、fork 1,974（抓取时点数据）——这是 agent 框架层近期最大的一次事件，直接改变了「多模型 hub」类产品的竞争前提。
- **核心主张是「一切皆插件」**：底座是 Cordis 元框架，模型适配器、工具注册表、会话日志、甚至 agent loop 本身都是插件，没有需要打补丁的特权内核。扩展方式是「把插件挂在别的插件旁边」，所有注册都是可撤销的副作用。
- **工程体量极大**：packages/ 下 219 个 workspace 包、约 52 万行 TS/TSX、2,355 个 md 文档（中英成对）、684 篇 Agent Note（其中 506 篇已实现）、PR 编号已到 #2521。内部研发从 2026-06-11 起算，约两个月做到这个规模——本身就是「AI 造 AI 工具」的样本。
- **面向模型的能力已经很完整**：24 个工具包、52 个模型可见工具，含 bash/PTY 终端、fs 读写编辑、glob/grep、LSP、web 搜索抓取、todo、plan mode、goal（跨轮次目标）、subagent（6 种后端）、workflow（模型写脚本编排子代理）、ralph（全新 agent 循环）、schedule、session 检索、jobs 后台任务、skill、MCP。
- **兼容主流生态是明确策略**：读 Claude Code 与 Codex 的 `hooks.json`、读 `AGENTS.md`/`CLAUDE.md` 指令链、用 `SKILL.md` 技能格式、MCP 工具沿用 `mcp__<server>__<tool>` 命名，甚至能把 **Claude Code CLI 和 Codex CLI 当作 subagent 后端挂进来**。
- **表层（surface）只有三类**：Web UI（本地 React 应用，默认 `127.0.0.1:3080`）、headless 一次性运行、程序化接口（ACP server / TypeScript SDK / Python SDK）。**没有 TUI、没有桌面壳、没有移动端、没有任何实时语音能力**——游戏陪玩方向从这个仓库拿不到东西。
- **对逗逗 2.0 的判断**：不建议整仓 fork（Developer Preview + 明确的破坏性变更声明 + 219 包的维护面），但**架构范式、能力清单、权限沙箱方案、模型接入方案（对应 D05）可以大量借鉴**，并且 dsh 的 SDK / ACP / subagent seam 提供了「把 dsh 当成办公模式的一个后端引擎」这条低成本路径。

## 一、基本事实

| 项 | 值 |
| --- | --- |
| 仓库 | `deepseek-ai/deepseek-harness`，描述 "DeepSeek Harness: Everything is a Plugin." |
| 许可 | MIT（Copyright (c) 2026 DeepSeek） |
| 语言 / 运行时 | TypeScript（ESM only），Node `^22.19.0 \|\| >=24`，pnpm 11 workspaces |
| 状态 | Developer Preview，README 明示「THERE WILL BE COMPATIBILITY-BREAKING CHANGES」 |
| 版本 | 仓库 master `0.1.0-rc.5`；npm `@deepseek-ai/dsh` 最新 `0.1.0-rc.6` |
| npm 首发 | 2026-08-10（`0.0.1-rc.1`），2026-08-13 公开发布到 npm public |
| GitHub 创建 | 2026-08-13T11:56:32Z |
| 关注度 | star 26,995 / fork 1,974 / watch 91（2026-08-13 抓取，实时变动） |
| 官网 | https://deepseek.com/harness |
| 社区 | GitHub Discussions、Discord、企微群 + 微信公众号（中文社区单独运营）；插件用 `dsh-plugin` topic 发现 |
| 上手 | `npx @deepseek-ai/dsh web` → 浏览器打开 `http://127.0.0.1:3080` |

规模指标（本地统计）：

| 指标 | 数量 |
| --- | --- |
| workspace 包 | 219 |
| TS/TSX 行数（packages + apps，含测试） | ≈ 520,000 |
| Markdown 文档 | 2,355（中英成对维护） |
| Agent Note | 684（implemented 506 / archived 142 / proposed 25 / rejected 11） |
| 模型可见工具 | 52（分布在 24 个工具包） |
| 能力 seam（`ctx.*` 服务键） | ≈ 55 |

## 二、架构：一切皆插件

### 2.1 Cordis 与「没有特权内核」

dsh 的底座是 [Cordis](https://github.com/cordiverse/cordis)（vendored 在 `vendor/cordis`），其设计论文是《A Programming Paradigm for Spatiotemporal Composability》。核心约定：

- 插件向共享 `ctx` 贡献**服务**、**类型化事件**和**可逆副作用**；
- 「注册即副作用」——每次 `ctx.effect()` / `ctx.on()` 都返回 disposer，插件卸载时自动撤销；
- 产品的每一部分都是插件，**包括 agent loop 本身**，所以每一部分都能从配置里替换掉；
- 支持 HMR：改配置项触发插件重挂载，不用重启进程（MCP server 的断连重连、客户端 bundle 热替换都走这条路）。

这解决了 harness 类产品最典型的架构病：核心循环写死 → 想改行为只能加 if / 打补丁 / fork。

### 2.2 Profile / Bundle / Patch 三层组装

运行中的 `dsh` 是一棵插件树，按顺序叠出来：

```
空配置根
  ← 按 profile 的 bundles 顺序应用每个组合包的 cordis.patch.yml
  ← profile 自己的 cordis.patch.yml
  ← $DSH_HOME/cordis.patch.yml
  ← 命令行 --patch overlay
```

- **bundle（组合包）**：Cordis 配置项 + 挂载代码的分发格式。随发行版交付三个：`dsh-base`（模型适配器、工具、持久化、沙箱与审批策略、settings、凭据、遥测）、`dsh-web-app`（浏览器应用层）、`dsh-headless`（一次性运行器，完全不带服务器）。
- **profile**：Harness home 里的具名组装，列出自己叠哪些 bundle、装了哪些树外插件、以及用户自己的 patch。
- **patch**：按 id 定位某个配置项，**整体替换其 config**（没有深度合并），或插入新项。
- `dsh --profile web --dump-config` 打印实际启动的整棵树——**打印出来的任何一行都可以被用户 patch 掉**。

命令行入口只有四种形态：

| 命令 | 用途 |
| --- | --- |
| `dsh --profile <name>` | 启动指定 profile |
| `dsh --profile headless "job"` | 跑一个持久化会话、打印最终答案、退出 |
| `dsh web` | `--profile web` 的别名 |
| `dsh plugin --profile <name> <pnpm args>` | 转发 pnpm 管理该 profile 的树外插件 |

### 2.3 能力 seam（capability seam）

这是全仓最值得抄的概念。一个 seam = **三种角色的完整能力**：

- **Service Definition**：声明接口、拥有 `ctx.<key>` 和词汇类型；
- **Service Provider**：一个或多个实现；
- **Consumer**：使用者（通常是面向模型的工具）。

术语表明确规定「seam 是完整能力，绝不是其中一个角色」。范例是 shell：`dsh-shell`（定义）+ `dsh-bash-local` / `dsh-bash-sandbox` / `dsh-pwsh-local`（实现）+ `dsh-tool-bash`（消费）。

**seam 正是「换一个提供方就换掉整个产品」的原因**：文件系统与进程提供方共享同一个执行世界，所以把它们指向远程沙箱（如内置的 E2B 适配器），Bash、PTY、LSP 就一并搬过去了，不需要为远程场景 fork 一份工具实现。

主要 seam 一览（节选）：

| ctx 键 | 能力 | 已有实现 |
| --- | --- | --- |
| `ctx.llm` | 模型流式推理 | `llm-deepseek`（官方直连）、`llm-pi-ai`（多提供方）、`llm-replay`（测试回放） |
| `ctx.tools` | 工具注册表 + 执行流水线 | core |
| `ctx.sessions` | 仅追加会话事件日志 | core |
| `ctx.sessionPersistence` | 会话持久化 | JSONL / SQLite |
| `ctx.sessionQuery` | 会话检索 | SQLite（全文 + 游标） |
| `ctx.fs` | 文件系统 | local / sandbox / e2b |
| `ctx.shell` | shell 执行 | bash-local / bash-sandbox / pwsh-local |
| `ctx.subprocess` | 进程 spawn / 进程树 | local / e2b |
| `ctx.terminals` | 持久 PTY | terminal-bash |
| `ctx.sandbox` | 进程沙箱 | sandbox-local（bwrap/Landlock/Seatbelt/Windows ACL） |
| `ctx.subagents` | 子代理 | 6 种后端（见 §3.4） |
| `ctx.workflowEngine` | 工作流脚本引擎 | worker-thread |
| `ctx.codeRuntime` | Code Mode 程序执行 | worker-thread |
| `ctx.skills` | 技能目录 | filesystem / badge |
| `ctx.compaction` | 上下文压缩 | compaction-basic + tool-result-pruner |
| `ctx.spillStore` | 超大工具输出外溢 | spill-local |
| `ctx.web` | 联网 | DeepSeek / Exa / Perplexity 搜索 + HTTP 抓取 |
| `ctx.lsp` | 语言服务 | lsp-stdio |
| `ctx.credentials` | 凭据引用解析 | credentials-local（env / .env） |
| `ctx.settings` | 用户设置分层 | settings-file |
| `ctx.approval` / `ctx.permissionPresets` | 审批与权限预设 | ACP 桥接 / 预设表 |
| `ctx.jobs` | 后台任务 | jobs-local |
| `ctx.goals` | 跨轮次目标 | core |
| `ctx.sessionTelemetry` | 遥测 | OpenTelemetry |

### 2.4 轮次流程与「模型可见即已记录」

一个**步骤（step）** = 一次模型请求 + 它调用的工具；一个**轮次（turn）** = 零个或多个步骤。

```
turn/start
  领取 next-step 输入 + 一条排队消息
  组装提示词片段 + 工具 schema
  -> agent/pre-step                   reject | enter(messages)
     step/start
     追加消息 → 从日志推导模型历史
     agent/request -> llm/stream -> assistant/chunk* -> assistant/message
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
  -> agent/turn-stopping
turn/end
```

三类扩展点分工清晰：**会话事件**（持久事实，重载后仍在）、**agent 事件**（观察/拦截进行中的工作）、**能力事件**（向 seam 附加策略与适配器）。其中 `agent/pre-step`、`agent/request`、`llm/stream`、三个 `tools/*` 是**瀑布式事件**（监听器必须调 `next()` 才能委托下去，不调就短路）。

最关键的一条运行时不变量：

> **模型可见 ⟺ 已记录。** 抵达模型请求的一切都必须能从会话日志重建，并由运行时不变量断言这一点。因此，新增一项模型可见输入就必须新增一个会话事件。

会话日志是唯一真源：`deriveMessages()` 从中投影模型历史，原始 `assistant/chunk` 保证回放与 UI 保真；fork、恢复、transcript、遥测、持久化全部派生自这条事件流。

## 三、能力盘点（对标视角）

### 3.1 模型可见工具（52 个）

| 类别 | 工具 |
| --- | --- |
| Shell / 终端 | `bash`（支持 `run_in_background`）、`pwsh`（Windows）、`bash`（持久 PTY 版）、`terminal_open/read/send/close/list/signal` |
| 文件 | `read`、`write`、`edit`、`read_image`、`str_replace_editor` |
| 检索 | `glob`、`grep`（内置 ripgrep，不经 shell）、`web_search`、`web_fetch`、`lsp` |
| 任务与计划 | `todo_write`、`exit_plan_mode`、`create_goal` / `get_goal` / `update_goal` |
| 委派与编排 | `subagent`、`subagent_fork`、`send_message`、`interrupt_agent`、`list_agents`、`report`、`workflow`、`ralph` |
| 后台 | `job_list`、`job_output`、`job_kill`、`schedule_create/list/delete` |
| 会话自省 | `session_search`、`session_trace`、`session_event_read/search/trace` |
| 其他 | `skill`、`ask_user_question`、`run_code`（Code Mode）、`cordis_*`（自省与自我改造，需显式启用） |

值得注意的几个：

- **`ask_user_question`**：工具调用会**挂起**直到 UI 侧返回人类答案——把「向用户提问」做成了一等能力而不是提示词约定。
- **`goal` 三件套**：附着在会话上的持久完成目标，有 `active/paused/blocked/complete` 阶段和 **Goal Round 上限**；create/edit/pause/resume **要求直接来自人类的根权限**，模型不能自己给自己续命。
- **`ralph`**：每个 Round 起一个**全新子代理**（看不到父会话和之前的子会话），共享工作区当长期记忆，Round 之间只传一份有界的结构化交接报告。适合「长时间自动迭代」而不被上下文污染。
- **`session_*` 五件套**：模型可以检索、追踪自己和历史会话的事件流——这是「记忆」的另一条路径（检索而非摘要）。
- **`cordis_*`**：模型可以在运行时定义、挂载、停止自己的插件，**运行中的插件可以注册额外的模型可见工具**。默认不在任何发行树里，需显式启用。

### 3.2 Code Mode（`run_code`）

工具注册表有 `mode: tool | code | both`。在 `code` 模式下，模型不再逐个发工具调用，而是**写一段 TypeScript 程序**，程序里的工具是异步 binding 函数：

- 程序在 worker thread 的 vm 上下文里跑，顶层 `await`/`return` 可用，返回值经无损 JSON 边界回传；
- 每个嵌套调用**重新进入完整且受守卫保护的工具流水线**（审批、沙箱、策略一个不少），并关联到外层结果；
- 并发按原生约定调度，`maxParallelSubCalls` 限流。

这就是官方 preset 里的 **「PTC 模式」**。价值：多步操作合并成一次模型请求，省 token、省往返。

### 3.3 Agent Preset（模式切换机制）

一个 preset = 一个目录 + 一份 `agent.cordis.yml`；roster 在进程内**只挂载一次**（常驻 scope），命名它的每个会话把自己的 scope key 认父到该挂载。查找按 `agent → preset → global` 解析，近者遮蔽远者。

随 CLI 交付四个 preset：

| id | 名称 | 内容 |
| --- | --- | --- |
| `standard` | 标准模式 | 完整编码 agent：fs、shell、检索、skills、plan、goal、subagent、workflow、todo、web、压缩 |
| `code` | PTC 模式 | 标准模式全部能力，但工具以 Code Mode SDK 呈现（`mode: code`） |
| `minimal` | 极简模式 | 只有持久 `bash` + `str_replace_editor`，persona 即完整系统提示词，**无压缩、无运行时上下文** |
| `cordis` | 创造模式 | 标准 + 运行时自省 + 插件实验 + preset 创作指导（自带两个 SKILL.md） |

**用户可以复制、修改、删除 preset**，`ctx.agentPresets` 提供 list/resolve/mount/copy/remove/recompose 全套 API，UI 侧有 `ui-agent-preset` 模块。

### 3.4 Subagent：六种后端，含 Claude Code 与 Codex

`ctx.subagents` 是唯一允许**同一上下文中多个提供方并存**的 seam（按名称注册）：

| 提供方 | 说明 |
| --- | --- |
| `subagent-spawn-in-process` | 进程内新建子 agent |
| `subagent-fork-in-process` | 从当前会话 fork |
| `subagent-acp` | 通过 ACP 协议连外部 agent |
| `subagent-claude-code` | **把 Claude Code CLI 当子代理**（base bundle 默认加载但休眠） |
| `subagent-codex` | **把 Codex CLI 当子代理**（同上） |
| `subagent-dsh-sdk` | 通过 dsh SDK 连另一个 dsh 运行时 |

能力按静态描述符声明（`outputSchema` / `depthLimit` / `toolFilter` / `persona`），请求依赖提供方没有的能力时**明确拒绝，绝不接受后静默忽略**。

还支持**可继续子代理**：持久化子会话 + 至多一个进程内 Activation，可执行多个 FIFO 轮次、支持冷恢复；父子之间用 `send_message` / `report` 双向通信。

### 3.5 生态兼容层

| 兼容对象 | 机制 |
| --- | --- |
| `AGENTS.md` / `CLAUDE.md` | `dsh-agent-instructions`：从 `$DSH_HOME/AGENTS.md` 到项目根到 cwd 逐层加载，内容完全一致时折叠去重；工具写文件后**自动检测新增/变更/删除并注入**；以 `<system-reminder>` 包裹注入为持久 user 消息 |
| Claude Code hooks | `dsh-hooks-claude-code`：读现有 `hooks.json`，支持 `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PROJECT_DIR}` 替换，映射 SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop 到 harness 的类型化决策 |
| Codex hooks | `dsh-hooks-codex`：10 个 hook 点中的 5 个，snake_case payload |
| Skills（`SKILL.md`） | 六级 rank 发现：`<project>/.dsh/skills`(100) → `<project>/.agents/skills`(200) → 自定义目录(300) → `<dshHome>/skills`(400) → `<agentsHome>/skills`(500) → 随包目录(600)；chokidar 热监听 |
| MCP | `dsh-mcp-client`，一个 server 一个插件实例，stdio / streamable-http；工具名 `mcp__<server>__<tool>`（与 Claude Code、Codex 同形状）；HMR 热替换 |
| ACP | `dsh-acp` 提供 JSON-RPC stdio 的 Agent Client Protocol 服务器（仅自动化，不含 UI 集成） |

两个 hook 桥接的 README 都明确写着：**原生 Cordis 插件功能更强、有类型化返回、没有序列化边界，桥接只是兼容路径**。定位很清楚——用兼容性接住存量用户，用原生扩展点承接真正的定制。

### 3.6 权限与沙箱

分两层，且两层都是持久会话状态：

- **`sandbox/mode`**（机制层）：`read-only` / `workspace-write` / `danger-full-access`。执行由操作系统强制：Linux 优先 `bwrap`、否则 Landlock（自研 `@deepseek-ai/node-addon-landlock-run`）；macOS 用 Seatbelt；Windows 用 **ACL 受限令牌**（每个「会话 × 工作区」分配随机私有临时目录 + 独立 SID + 可撤销 ACE）。**不受支持的平台直接以 `SANDBOX_UNAVAILABLE` 拒绝执行，绝不静默回退到不受限。**
- **`approval/policy`**（交互层）：一次性权限决策通过 `approval/request` 瀑布事件分派，没有回答方时**以 unavailable 关闭失败**（fail closed）。
- **`permissionPresets`**：把两者打包成用户可见的单个选择器，默认两档 `workspace-write`（+ ask）与 `danger-full-access`（+ never）。切换写入 `permissionPresets/preset` 事件；**权限在会话创建时固定，之后改设置不影响已存在会话**。

`fs` 侧同样受 `ctx.sandboxPolicy` 约束（`fs-sandbox`），保证「bash 与 fs 不会限制到不同的根目录」。

### 3.7 模型接入

两个适配器并存，对应两种诉求：

**`llm-deepseek`**（官方直连，路由名 `deepseek-official`）
- 直接 fetch + SSE，只支持流式；
- 默认公布 `deepseek-v4-flash` / `deepseek-v4-pro`，**上下文窗口均为 1,000,000 token**，默认输出上限 `maxTokens: 256000`；
- 未列出的 model id **原样透传**，所以换模型不需要改代码；
- 推理强度三档 `off / high / max`（默认 high），可按会话步骤替换；带工具调用的轮次把 `reasoning_content` 回传历史，不带工具调用的丢弃以省 token；
- **连接事实不在加载时冻结**：baseURL、catalog、请求默认值、密钥都在下一次请求时重读，改设置不用重启（首次上手流程就是「浏览模型 → 存密钥 → 再发提示」）；
- 请求带匿名用户 id（`x-deepseek-harness-user-id`）与会话 id 标头。

**`llm-pi-ai`**（多提供方，基于 `@earendil-works/pi-ai`）
- 一个插件实例持有一份「路由 → 提供方 profile」字典，每个请求用 `provider` 选路由；
- 点名了已安装 pi-ai 提供方的路由继承其端点/协议/模型 catalog，逐字段覆盖；pi-ai 没有的路由可整体声明；
- **接 OpenAI 兼容网关、自建服务、比 catalog 更新的模型，全部属于配置而非改代码**；
- 凭据只存 `apiKeyEnv` **引用**，密钥不进配置文件；配置了却解析不出值 → `MISSING_CREDENTIAL` 失败（而不是拿环境里恰好存在的别的 key 蒙混过关）。

### 3.8 上下文与持久化

- **持久化**：`session-persistence-jsonl`（默认）/ `-sqlite`；`session-query-sqlite` 提供全文检索与游标；`session-projection` + `session-projection-cache` 让列表读取不必加载完整日志（缓存行 + 持久化尾部回放）。
- **压缩**：`compaction-basic` 消费步骤后的 token 压力事件与请求错误恢复事件；`compaction-tool-result-pruner` 在摘要压缩**之前**用可回放的单节点替换改写过大的工具结果；`/compact` 用户命令。压缩调用带 `x-deepseek-harness-compact: 1` 标头，方便宿主把压缩流量与会话流量分开计费。
- **spill**：超大工具输出落到 `ctx.spillStore`，内联结果替换为有界预览 + 取回定位信息。
- **guard**：`repeat-tool-reminder`（重复工具调用提醒）+ `timeout-policy`（单次调用截止时间）。
- **session title**：可选 LLM 生成，强制禁用思考模式以省 token。

### 3.9 表层与接入方式

| 表层 | 形态 |
| --- | --- |
| Web UI | 本地 node:http 服务 + React 前端（`apps/web`，Vite 构建），默认 `127.0.0.1:3080`；客户端本身也是插件体系（`packages/client/ui-*` 约 30 个模块 + slot 机制 + HMR） |
| headless | `dsh --profile headless "job"`，跑一个持久化会话打印答案退出，完全不带服务器 |
| ACP | JSON-RPC stdio 的 Agent Client Protocol 服务器，供程序化客户端驱动 |
| TypeScript SDK | `packages/sdk`（protocol / client / server），从另一进程驱动运行时 |
| Python SDK | `pip install deepseek-harness-sdk`，自带平台 wheel 的单文件运行时 `dsh-jsonrpc-agent`，`with DeepSeekHarness() as h: h.run("...")` |

**明确没有的**：TUI（相关 Agent Note 已归档 = 已退役）、桌面应用外壳、移动端、语音 / 实时音频、任何游戏相关能力。

Web UI 的设置界面已有：模型与提供方配置（含自定义 OpenAI 兼容端点表单）、插件清单、权限预设、工作区选择器、agent preset 选择器、skill 面板、subagent 面板、workflow run 面板、goal 面板、jobs 面板、trajectory（轨迹）视图、消息反馈。

## 四、工程流程（同样值得学）

这个仓库本身是「用 agent 造 agent 工具」的样本，规矩写在 `AGENTS.md`（root 的 `CLAUDE.md` 是它的软链接）：

- **Agent Note 制度**：非平凡改动**必须**在同一个 PR 里附一篇 Agent Note，按 `implemented / proposed / rejected / archived` × `architecture / feature / bug-fix / simplification / process / testing` 二维归档；归档的笔记**冻结**，不得编辑也不得当作现行权威。目前 684 篇。
- **文档即门禁**：`pnpm run doc-sync` 下挂十几个校验器——工具 schema 目录自动生成并验证新鲜度（真启动每个工具插件读 `ctx.tools.schemas()`，而非静态分析）、中英文档配对校验、链接校验、字数预算校验、Agent Note 格式与分类校验、mermaid 校验。
- **测试**：CI 覆盖率门禁是 **`packages/*/*/src` 每文件 100%**；另有 e2e（真实 API）、snapshot（无密钥回放，比对 ACP/headless 输出）、web 性能与压力测试、Windows/wine 矩阵。
- **写作规范**：「禁止比喻」「不要复述代码」「`contract` 只用于前置/后置条件与兼容承诺」这类要求写进了强制规范，还配了 `dsh-prose-standard` 技能。
- **仓库自带 11 个 `.agents/skills/`**：pre-push 检查、代码审查、找简化点、翻译文档、归档笔记、合并 stacked PR、裁剪 CoT 泄漏等——**团队自己的研发流程也被写成了 skill**。
- **预发布姿态**：README 直言「没有外部消费者，优先正确的地基而非兼容垫片」，`SESSION_FORMAT_VERSION` 保持 `0` 且不给兼容承诺，后端直接拒绝旧的磁盘格式。

## 五、原文对逗逗AI 2.0 的启示（源项目结论，存档保留）

> 本节是源项目的判断，**不是 LISA 的结论**。相对链接指向源仓库，已改为纯文本。
> LISA 的对照分析见 [PLAN_HARNESS_ALIGNMENT_v1.0.md](./PLAN_HARNESS_ALIGNMENT_v1.0.md)。

### 5.1 竞争格局：harness 层被免费化了

DeepSeek 用 MIT 协议放出一个**能力矩阵接近 Claude Code、且天然绑定自家 1M 上下文模型**的完整 harness。这意味着：

1. **「做一个多模型 agent 工作台」本身不再是壁垒**——它现在是 `npx` 一行命令就能得到的东西。逗逗 2.0 办公模式的差异化必须落在**桌宠人格、跨模式记忆资产、面向非程序员白领的任务表达**上，而不是 harness 管道本身。参见 产品定位（源仓 `docs/design/product-positioning.md`）、办公模式设计（源仓 `docs/design/work-mode.md`）。
2. **反过来这是重大利好**：地基可以不自己造。逗逗把精力放在「上层体验 + 人格 + 商业化」，底层能力可以借。
3. **对 D05 模型接入策略（源仓 `docs/decisions/d05-model-access-strategy.md`）的直接印证**：`llm-pi-ai` 证明了「BYOK + OpenAI 兼容网关 + 官方直连」三条路径可以在**同一个配置文件**里共存，凭据只存引用、按请求解析、热更新不重启。D05 结论无需修改，但实现方案可以直接照抄这个分层（credentials seam ↔ settings seam ↔ adapter thunk）。

### 5.2 可直接借鉴的四个架构决策

| 借鉴项 | 为什么值得抄 | 逗逗的对应场景 |
| --- | --- | --- |
| **能力 seam 三角色** | 换提供方 = 换产品形态，不需要 fork 消费方 | 办公模式的「本地执行 / 云端沙箱」切换、模型「云端 / 本地 / BYOK」切换 |
| **Agent Preset = 常驻 scope 挂载** | 同一引擎装配出多套工具/人格组合，进程内只挂一次 | **办公模式 / 游戏模式 / 桌宠模式就是三个 preset**，而不是三套代码；用户还能自己复制修改 |
| **会话日志唯一真源 + 模型可见⟺已记录** | 回放、fork、恢复、UI 保真、遥测全部免费得到 | 逗逗的「记忆与资产长期累积」需要的正是这条不变量；1.0 若是散状态存储，2.0 应重构为追加日志 + 投影 |
| **投影缓存（projection cache）** | 列表读取不加载完整日志 | 会话列表、任务面板、桌宠状态条的性能地基 |

### 5.3 权限与沙箱是办公模式的准入门槛

逗逗 2.0 办公模式要读写用户文件、跑命令。dsh 给出的是**操作系统级**答案而非提示词答案：

- 三档 `sandbox/mode` + 两档 `approval/policy`，打包成用户可见的**单个权限预设选择器**；
- Linux/macOS/Windows 各有真实的强制机制，**不支持的平台直接拒绝执行，绝不静默降级**；
- 权限在会话创建时固定，后续改设置不影响进行中的会话（避免「改了设置导致跑着的任务突然越权」）。

**建议**：逗逗 2.0 办公模式的权限设计直接对齐这三档 + 会话级固定语义；macOS 用 Seatbelt、Windows 用受限令牌 ACL 的方案可以照搬（Landlock addon 本身就是 MIT 的独立 npm 包）。这是 C 端桌面产品建立信任的必需品，也是 1.0 完全没有的东西。

### 5.4 兼容存量生态 = 低成本获客

dsh 的做法很值得学：**不发明新格式，全部读别人的**——`AGENTS.md`/`CLAUDE.md`、`SKILL.md`、`hooks.json`（CC 与 Codex 两种方言）、MCP 的 `mcp__server__tool` 命名。

对逗逗的含义：

- 办公模式的「规则/技能/工具」配置**直接兼容 `AGENTS.md` + `SKILL.md` + MCP**，用户从 Claude Code/Codex/Cursor 迁移零成本；
- 更进一步：dsh 的 `subagent-claude-code` / `subagent-codex` 证明了**把别家 CLI 当子代理挂进来**是可行且已实现的工程方案。逗逗如果做「多模型 hub」，这是比自己实现每家 harness 更省的路径。

### 5.5 是否直接采用 dsh 作为办公模式引擎

**结论：不整仓 fork，但值得作为可选后端接入，并大量借鉴。**

支持接入的理由：
- MIT 协议，商用无碍；
- 已有 headless / ACP / TS SDK / **Python SDK** 四条程序化接入路径，桌面壳（Electron/Tauri）可以直接把它当子进程驱动；
- 一次性接入即获得 52 个工具 + 沙箱 + 压缩 + MCP + skills 的完整能力面。

不建议 fork 主干的理由：
- **Developer Preview**，README 明示会有破坏性变更，`SESSION_FORMAT_VERSION = 0` 不给兼容承诺，后端直接拒绝旧磁盘格式；
- 219 个包 + 每文件 100% 覆盖率门禁 + 十几个文档门禁，**维护面远超逗逗团队规模**；
- 依赖 Node ^22.19 || >=24 运行时，前端 dist 必须预构建，桌面打包体积与冷启动需实测；
- bundle patch 是**整行 config 替换**（无深度合并），跟随上游更新时冲突面不小。

**建议的落地路径**（按成本从低到高）：
1. **P0 借鉴层**：把 §5.2 的四个架构决策、§5.3 的权限模型写进逗逗 2.0 的技术设计；
2. **P1 兼容层**：办公模式支持 `AGENTS.md` + `SKILL.md` + MCP，先接生态；
3. **P2 后端层**：把 dsh 以 headless/SDK 形式作为办公模式的**一个可选执行引擎**（与自研引擎并存，用能力 seam 的思路隔离），先在内部验证稳定性再考虑对外；
4. **不做**：不 fork 主干、不追 rc 版本、不把产品命脉压在 Developer Preview 上。

### 5.6 游戏模式：这里什么都拿不到

dsh 没有任何语音、实时音频、屏幕感知、游戏相关能力，表层也不含桌面壳与移动端。游戏模式设计（源仓 `docs/design/game-mode.md`）的技术方案需完全另寻来源，不要因为「办公模式用了 dsh」而假设游戏模式能复用同一条链路——两者唯一应该共享的是**会话日志/记忆层**，而那一层的设计恰好可以借鉴 dsh。

### 5.7 团队研发流程：Agent Note 制度可以立刻用

684 篇 Agent Note、11 个仓库自带 skill、文档门禁——这套东西让一个两个月的项目做到 52 万行仍然可被 agent 理解和修改。逗逗团队若要用 AI 大规模参与研发，最低成本的两条：

1. **非平凡改动必须附一篇决策笔记**，按 implemented/proposed/rejected 归档，归档后冻结；
2. **文档校验进 CI**（链接、目录索引、中英配对），否则 AI 写的文档必然漂移。

源仓现有的 CLAUDE.md 三层结构已经是同一思路的轻量版，可以按上面两条继续加固。

## 六、风险与待验证

| 项 | 说明 | 验证方式 |
| --- | --- | --- |
| 版本稳定性 | Developer Preview，两周内已从 `0.0.1-rc.1` 迭代到 `0.1.0-rc.6` | 观察 1–2 个月的破坏性变更频率再决定是否接入 |
| 桌面打包可行性 | Node 22/24 运行时 + 预构建前端 dist + 原生 addon（landlock）与 SQLite | 实测 Electron/Tauri 打包体积、冷启动时间、跨平台原生依赖 |
| 中文生态与文档质量 | 中英成对维护，中文文档质量高，社区有企微群 | 已确认，无风险 |
| 数据外发 | 官方适配器默认向 DeepSeek 端点发送匿名用户 id 与会话 id 标头 | 若作为后端使用，需评估是否改走自有网关（`baseURL` 可配） |
| 模型绑定 | 默认组合绑 DeepSeek V4 系列；多提供方需挂 `llm-pi-ai` | 已有解法，属配置项 |
| 许可与合规 | MIT，第三方依赖清单在 `THIRD_PARTY_NOTICES.md` | 接入前完整过一遍依赖许可 |

## 来源

- 仓库主页：https://github.com/deepseek-ai/deepseek-harness
- README（中文）：https://github.com/deepseek-ai/deepseek-harness/blob/master/README.zh.md
- AGENTS.md（工程约定）：https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md
- 架构文档：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md
- 术语表：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/glossary.zh.md
- 工具 schema 目录：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.zh.md
- 能力 seam 图：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/capability-seams.zh.md
- 子系统文档目录：https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/subsystems
- Web UI 使用指南：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.zh.md
- Python SDK：https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/README.zh.md
- 官方产品页：https://www.deepseek.com/harness/en/
- 官方发布公告（X）：https://x.com/deepseek_ai/status/2087887408440164663
- npm 包 `@deepseek-ai/dsh`：https://registry.npmjs.org/@deepseek-ai/dsh （版本与发布时间取自 registry 元数据）
- GitHub 仓库元数据（star/fork/创建时间）：https://api.github.com/repos/deepseek-ai/deepseek-harness （2026-08-13 抓取，实时变动）
- Cordis 框架：https://github.com/cordiverse/cordis ；设计论文：https://github.com/cordiverse/paper
- 第三方报道：https://cryptobriefing.com/deepseek-harness-open-source-developer-preview/
- 代码规模、包数、Agent Note 数、工具数为源项目本地 clone 统计（commit `47f9438`，2026-08-13）
