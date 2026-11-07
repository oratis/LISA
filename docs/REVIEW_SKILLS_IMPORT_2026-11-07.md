# Codex / Claude Skills 导入与聊天验收 · 2026-11-07

本次在已安装的 Mac App 中导入 Codex、Claude 的个人技能，共发现 **28 个来源条目**；11 组同名技能的完整目录内容一致，去重后导入 **17 个技能、422 个文件**。当前 Skills 面板显示全部 17 项，真实聊天成功执行了其中两个技能的本地脚本。

这是 **2026-11-07（Asia/Shanghai）的本机操作与验收记录**。验收时运行的后端报告版本为 `0.29.1`，聊天模型为 `claude-sonnet-4-6`。结果不代表本 PR 基于的最新 `main` 已重新跑过全部测试。本 PR 只提交报告及脱敏结果，不修改应用代码、不分发个人技能，也不会在合并时给其他用户自动安装技能。

## 范围与导入方式

- 来源：`~/.codex/skills/` 和 `~/.claude/skills/` 下含 `SKILL.md` 的非隐藏个人技能目录，各 14 项。未扫描 `.system`、插件缓存、云端技能或项目专属技能。
- 目标：`~/.lisa/skills/`，操作前为空；先备份，再完整复制技能目录。此轮使用本机一次性导入脚本，不是通过 UI 逐项导入。
- 去重：按技能名称分组，再比较目录内每个文件的 SHA-256；本次 11 组同名技能完全一致，因此只保留一份。没有遇到同名但内容不同的情况，不能将本次结果视为冲突合并能力的验证。
- 完整性：保留 `SKILL.md`、脚本及参考资料；`cloudflare` 的 320 个文件也完整保留。源目录复核未改变。
- 路径适配：仅将 `wechat-mp-publish/SKILL.md` 内指向原应用技能目录的路径改为 Lisa 目录。其脚本和其他支持文件与源文件一致。
- 本轮不修改应用内导入的资源限制。大目录由本机用户授权的一次性导入处理；这不证明应用内导入按钮能够导入同样大小的目录。

| 来源 | 去重后技能 |
|---|---|
| Codex 与 Claude 都有，内容一致 | `agents-sdk`、`cloudflare`、`cloudflare-email-service`、`cloudflare-one`、`cloudflare-one-migrations`、`durable-objects`、`sandbox-sdk`、`turnstile-spin`、`web-perf`、`workers-best-practices`、`wrangler` |
| 仅 Codex | `app-store-shot-kit`、`gcp-os-e2e`、`video-to-series` |
| 仅 Claude | `mobile-release-kit`、`sentry-cli`、`wechat-mp-publish` |

## 验证结果

| 检查 | 结果 | 证据 |
|---|---|---|
| 文件完整性 | 422 个目标文件的哈希与导入清单一致；两端源文件未变化 | 本机导入清单与哈希复核 |
| 已安装后端技能目录 | `/api/skills` 返回 17 个唯一技能，说明字段正常 | API 返回与导入清单逐项比对 |
| 工具读取 | `skill_manage list` 能列出全部技能；17 次 `view` 均返回对应技能正文 | 已安装包内的真实工具实现 |
| 原生界面 | Chat → Skills 显示 17 个 Personal 技能；已观察到的来源条目标为 Already added | Mac 原生窗口可访问性树 |
| 聊天上下文 | 实际发给模型的系统提示中包含全部 17 个技能名称 | 本机测试会话的持久化提示记录 |
| 真实聊天执行 | 2 次 `skill_manage` 查看、7 次 `bash` 调用、1 次 `set_mood` 状态更新，10 次工具调用均成功，聊天正常结束 | 已安装后端 `/chat` 的真实模型流；无模型替身 |

测试使用独立会话「Skills 导入验收」和合成输入，按会话 ID 调用当前 App 的聊天接口。验证程序只准备输入、发送任务和检查产物；转换与打包由 Lisa 在聊天中执行导入技能的原有脚本。

### Claude 来源：公众号文章本地转换

Lisa 先调用 `skill_manage view` 读取 `wechat-mp-publish`，再运行其 `scripts/md2wechat.py`，生成 `article.html` 与 `article-meta.json`。

独立检查确认：HTML 保留 `LISA_SKILLS_CHAT_OK` 合成标记，使用内联样式，没有 `<style>` 标签或 `class` 属性；元数据中的标题、作者与输入一致。未调用微信上传、草稿或发布接口，也未读取账号密钥。

### Codex 来源：本地代码目录打包

Lisa 先读取 `gcp-os-e2e`，再运行其 `scripts/gcp_os_e2e.py bundle`。测试源目录含普通源码，以及专门用于检查排除规则的 `.git`、`target`、`output` 目录。

独立检查确认：压缩包保留 README 和源码中的 `LISA_BUNDLE_CHAT_OK` 合成标记，三个应排除的目录均未进入压缩包。未调用 GCP 命令、创建云资源或产生部署操作。

## 证据与限制

可公开审查的汇总见 [脱敏验收结果](./evidence/skills-import-2026-11-07.json)。原始哈希清单、聊天事件、完整提示、产物及导入前备份保留在本机；本 PR 不包含个人目录绝对路径、会话 ID、聊天原文、账号信息或凭据。

本次证明全部 17 个个人技能可被发现和读取，并证明两个来自不同应用的技能能在真实聊天中执行本地任务。没有逐项执行全部技能的外部业务流程，也没有验证自动选技能、外部服务授权、部署、发布或其他机器的兼容性。需要外部工具或账号的技能，仍依赖相应环境配置。

此前的界面与导入功能修复见 [E2E 修复报告](./REVIEW_E2E_FIXES_2026-11-07.md)。
