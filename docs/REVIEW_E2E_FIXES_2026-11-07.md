# LISA 修复与复验报告 · 2026-11-07

> 历史本机验收记录：以下结果来自当时的安装包与完整本地工作区，并非此 PR 分支的独立测试计数。此 PR 基于最新 main，保留已合并的 Room、Mac 和连接器修复；分支验证结果以 PR 检查记录为准。私有截图与原始日志保留在本机，未公开上传。

本报告对应 [首次全面测试报告](REVIEW_E2E_2026-11-07.md) 的 E01–E07。七项问题均已修复并复验。当前安装的 `/Applications/Lisa.app` 已更新为 **0.28.3（20261107.4）** 并重启，Codex 实际调用成功，Skills 已可创建与导入。

## 修复清单

| 问题 | 修复 | 验证依据 |
|---|---|---|
| E01 Codex 找不到或无法启动 | 检查可执行权限；支持 ChatGPT/Codex 应用包；检测、登录诊断、普通委派和交互式终端共享程序解析；提供重新检测 | 自定义路径回归、真实已登录 Codex 调用、安装版 Coding Plans |
| E02 Mac 构建失败 | 明确后台终止回调内外层闭包的弱引用捕获 | 完整 Swift 测试与 release 构建通过 |
| E03 Skills 空白／来源不一致 | 模型、工具和面板统一个人及项目技能发现；增加创建、刷新、Codex／Claude 导入及来源说明；导入包含支持文件 | 项目技能、创建、导入、刷新持久化回归；安装版可见导入目录 |
| E04 失败时无限 loading 或误报为空 | Skills、Tools、Memory 检查状态码与响应结构；提供超时、错误提示、重试；关闭面板后不显示旧请求结果 | 三个面板的 503 故障注入与恢复测试 |
| E05 GitHub 文案混用语言 | GitHub 连接界面文案进入中英文语言表 | 国际化断言及 GitHub 浏览器回归 |
| E06 六项旧回归断言失败 | 补足 sessionNames 测试上下文，更新前端模块拼接与文件集合约定 | 完整主程序回归 |
| E07 PTY 不可用 | 编译并随本机 App 携带 node-pty；保持原生库与 Node 签名 Team ID 一致；本机启用终端能力；界面根据实际状态禁用不可用选项 | 真实 cat 输入输出回环、安装版状态接口和委派选项回归 |

实机验收还发现外部技能的多行说明（`description: >-`）显示不正确，已支持常见折叠／多行描述与引号转义。嵌套元数据不会覆盖顶层技能名称。

Skills 管理仅允许本机访问，Cloud 禁止创建／导入且不暴露宿主机导入目录。导入拒绝路径穿越、符号链接、同名覆盖和超限资源；写入接口要求 JSON，拒绝可由跨站表单直接发送的文本请求。相关拒绝路径已纳入测试。

## Codex 实际调用

已使用更新包内的 `launchAgent`，在临时 Git 目录发起只回复固定文本、不操作文件的任务。使用现有 ChatGPT 登录，没有复制或展示凭据；最小 PATH 不包含 Codex，因此本次确实走了应用包发现路径。

- 实际程序：`/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`
- 检测：`available=true`、`loggedIn=true`
- 实际返回：`LISA_CODEX_CONNECTED`
- 退出码：`0`
- 安装后的原生窗口：Coding Plans → ChatGPT plan (Codex) 显示 `ready`，可选择使用。

此验证覆盖实际供应商 CLI 调用；浏览器测试中的模型与 GitHub 仍使用替身。原先选中的 Claude 偏好保持不变，Codex 已可选。

## Skills 使用方式

Chat → Skills 现在显示可用技能、个人／项目来源、创建按钮以及可导入条目。导入只复制用户选中的技能，保留支持脚本与资源；不会自动启用所有第三方技能。技能要求的外部工具、账号与服务仍需在 Lisa 中配置。

本机原有 Lisa 技能目录为空是正常数据状态；现在可从已安装的 Codex／Claude 技能中选择导入，或直接创建新技能。相同名称来自不同应用时会分别列出来源，导入后不允许覆盖已有个人技能。

## 最终验证结果

| 检查 | 最终结果 | 证据 |
|---|---:|---|
| 主程序完整单元／集成回归 | **3505/3505 通过**；0 失败、0 跳过 | `unit-package.log`、`unit-package.json` |
| Chromium 浏览器 E2E 全集 | **50/50 通过**；0 失败、0 跳过、0 flaky | `e2e-package.log`、`browser-summary-package.json` |
| Mac 完整原生测试 | **23/23 通过** | `mac-full.log` |
| Mac release 构建 | **通过** | `mac-release.log` |
| iOS 标准生成／模拟器测试 | **82/82 通过**；0 失败、0 跳过 | `ios-release-summary.json`、`ios-release-tests.xcresult` |
| 服务端构建、前端／E2E 类型及 API 契约检查 | **通过** | `package-check.log` |
| Codex 真实供应商请求 | **成功，退出码 0** | `codex-live-result.json` |
| 安装版 PTY 输入输出 | **成功** | `installed-pty-result.json` |
| 安装后的 Codex／Skills／PTY 状态及 JSON 请求限制 | **符合预期** | `installed-plans.json`、`installed-skills.json`、`installed-agents-pty-status.json` |
| 安装包签名与实际运行目录 | **验证通过** | `installation-receipt.json`；运行的是 App 内嵌后端 |

浏览器全集覆盖配置引导、聊天、session 新建／重命名、图片预览与发送、布局、主题、动态资源、Skills／Tools／Memory 失败恢复、Coding Plans 和 GitHub 连接流程。模型及 GitHub 使用隔离替身；写入测试使用临时 HOME/LISA_HOME。真实用户会话没有用于测试写入。

最初复验中的动画资源失败来自正在生成的资源清单不完整；生成完成后资源覆盖测试通过。处理中被新修复取代的中间运行保留在证据目录，不算最终结果。最终数字以上表列出的日志为准；增加的回归项也解释了它们与首次报告计数的差异。

## 安装、重启与回退

- 安装位置：`/Applications/Lisa.app`
- 原生版本：**0.28.3**，构建号 **20261107.4**
- 后端版本：`0.28.3+local.20261107.e2e-fixes`
- 更新时间：**2026-11-07T16:46:50+0800**；已退出旧进程并启动新版本，后台进程号 `48099`。
- 实际运行：`/Applications/Lisa.app/Contents/Resources/backend/dist/cli.js`，使用 App 内嵌 Node 22.23.2；不再运行旧的 seat-fix 目录。
- Skills 可导入条目：**28**（包含不同应用来源的同名条目）；多行说明已正确解析。
- 交互式终端：本机启用，原生模块可用，Claude／Codex 程序检测可用。
- 回退备份：`~/.lisa/update-backups/20261107-e2e-fixes`。其中 `installed-original.app` 是更新前原 App，`serve-command.txt` 是原启动配置；用户会话和个人数据未替换。

本机包保留 hardened runtime，并使用同一 Team ID 签名原生组件；它是本机签名更新版，不是新发布的公证发行包。已核对安装内的编译文件与测试后的构建一致。源文件／资源校验清单为 `package-source-hashes.json`。

如需回退，应退出 Lisa、只停止占用 5757 的本机 Lisa 后端，再恢复上述原 App 和启动配置后启动。无需删除 `~/.lisa`，也不应恢复旧副本覆盖新的聊天数据。

本地截图：安装版 Codex 已就绪（保存在本机测试证据目录，未上传）。

本地截图：安装版 Skills 创建和导入入口（保存在本机测试证据目录，未上传）。

## 验证边界

已完成的真实外部验证是 Codex 登录状态、实际 CLI 请求和本机终端回环。邮件收发、真实 GitHub OAuth／PR、实体手机配对、录音权限、推送、真实支付及数小时自主运行，仍沿用首次报告的未验证边界；不把这些未执行的流程记为通过，也不把未安装的 Copilot 误记为故障。

本轮没有提交 PR、发送邮件、发布内容、替换用户密钥或批量导入技能。代码与资源来自工作区的本轮快照；其他并行工作后续的改动不应自动视为已在安装包内。

## 本地证据

证据目录：`<checkout>/.tmp/e2e-fixes-20261107/`。包含完整回归日志、浏览器 JSON 结果、原生构建日志与 xcresult、Codex 真实执行结果、安装回执和截图。旧版问题复现证据仍在首次报告所列的 audit 目录中。
