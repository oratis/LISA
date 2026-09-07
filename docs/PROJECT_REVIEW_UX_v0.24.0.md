# LISA v0.24.0 UX 审查与优化计划

> 审查日期：2026-09-05<br>
> 基线提交：`26266a5`（v0.24.0 + 7 commits，含 #359–#367）<br>
> 配套文档：[技术审查](./PROJECT_REVIEW_TECH_v0.24.0.md) · 上一轮：[v0.21.0 全项目审查](./PROJECT_REVIEW_AND_OPTIMIZATION_v0.21.0.md) · [v0.9 产品 review](./PRODUCT_REVIEW_v0.9.md) · [iOS review v1.0](./REVIEW_IOS_APP_v1.0.md)<br>
> 审查范围：Web 工作台（Session Shell v1.1）、首次运行与出生流程、CLI、iOS Lisa Pocket、macOS 壳、官网、README/文档

## 1. 执行摘要

LISA 的 Web 工作台在 v0.23 完成三栏 Session Shell 重构后，桌面态（1440×900）已经是一个成熟、有辨识度的产品界面：三栏布局清晰，双主题切换即时且持久化，会话树 + tab 并行、各视图的空态文案都写得有人味。这一轮审查的主要判断是：**桌面主路径已经好了，问题集中在"第一次"和"边缘"——首次运行、错误路径、移动端、可访问性、以及文档与产品脱节。**

四条核心结论：

1. **首次运行存在一个死胡同（P0）。** 在 Web 端填错 API key 后：出生仪式对 401 也会重试一次，随后把 Anthropic 的原始 JSON 错误直接显示给用户；点 ENTER 只是刷新页面并用同一个错 key 再跑一遍仪式。key 表单再也不会出现，Settings 视图被遮罩挡住——用户只能手动编辑 `~/.lisa/config.env`。出生流程本身没有超时和取消。
2. **移动端 Web 在 v0.24 之后基本不可用（P0）。** #367 让右栏默认折叠，但 `body.rb-collapsed .frame` 的特异性高于 720px 媒体查询，375px 宽屏上主区只剩 75px。即便手动展开右栏，功能栏 12 个图标把聊天视图撑到 681px，发送按钮落在屏幕外。
3. **可访问性没有地板（P1）。** 全站没有 `:focus-visible` 样式（键盘焦点不可见）；次级文字 10–11px，Calm 主题下对比度 3.2:1、Nebula 下约 4.4:1，均不达 AA；功能栏图标按钮 34px、树切换钮 24×21px。
4. **文档与产品脱节（P1）。** README 55KB、62 个标题，安装说明从第 119 行开始；6 张截图停留在 2026-05-12 的像素风旧壳，README 正文 0 次提到 session shell / tab / 主题；中文版落后英文版 12 天、少 3 个章节；`CHANGELOG.md` 停在 0.12.0，之后 12 个版本只在 `docs/RELEASE_*.md`。

好消息同样明确：v1.0 iOS review 列出的 13 个 Blocker/High 中，能静态核实的 8 项已修复；`lisa doctor` 是整个产品里最好的诊断体验；Web 端的错误安全网（`lisaBanner`）保证后端不可达时不再"白屏"。

## 2. 审查方法与证据

| 方法 | 说明 |
| --- | --- |
| 真实浏览器实测 | 从 `main` 构建，起两个临时实例：A（用 soul store API 离线合成一个已出生的 soul + 占位 key，端口 5858）、B（空目录、无 key，端口 5859）。全程不发起任何模型调用 |
| 结构化审计 | 在页面内用 JS 测量命中区、焦点样式、计算色、断点布局（375 / 768 / 1024 / 1440）、空态、localStorage、各视图文案 |
| 首次运行 | 空 `LISA_HOME` 下运行 `lisa doctor` / `lisa status` / `lisa "hi"` / 裸 `lisa` |
| 原生端 | macOS `swift build -c debug`；iOS `build.sh test`（iPhone 17 Pro 模拟器）；对照 REVIEW_IOS_APP_v1.0 逐项 grep 修复状态 |
| 文档 | README / README.zh-CN / CHANGELOG / website 源码通读，截图与文案的 git 时间戳 |
| 线上实例 | 只读观察本机 daily-driver（:5757，v0.23.0）的响应延迟与日志 |

一处方法学修正值得记录：在隐藏的浏览器面板里测量时，CSS `transition` 不会推进，曾误测出"Calm 主题激活导航仍是 Nebula 青色"。禁用过渡后复测为 `#4f5bd5`（正确），该项不成立、不列入问题。所有列入的数字都是在这一修正之后重新测得的。

## 3. 分表面评分

| 表面 | 评分 | 一句话 |
| --- | --- | --- |
| Web 桌面主路径（聊天 / 会话 / 视图 / 主题） | 8 / 10 | 结构成熟，空态文案好；空聊天页太空，新会话以原始 id 命名 |
| Web 首次运行（key gate → 出生 → 进入） | 4 / 10 | 视觉出色，但错 key 即死胡同，仅支持 Anthropic key，无超时/取消 |
| Web 移动端 / 窄屏 | 2 / 10 | 375px 下主区 75px；展开后发送按钮在屏外 |
| 可访问性 | 3 / 10 | 无焦点样式、小字低对比、图标按钮偏小；aria-label 覆盖尚可 |
| CLI | 6 / 10 | `doctor` 优秀、错误信息清楚；REPL 纯文本、无历史、工具调用走 stderr |
| iOS Lisa Pocket | 7 / 10 | v1.0 review 的关键 blocker 已修；a11y 从 0 到 14 个 label，仍未覆盖 |
| macOS 壳 | 6 / 10 | 构建通过；仍依赖用户另行 `npm i -g` 装后端，"一键下载"不是一键 |
| 官网 | 8 / 10 | 文案、结构、双语都好；安装页对 Mac 用户仍是两段式 |
| README / 文档 | 4 / 10 | 内容丰富但不是 onboarding；截图与 CHANGELOG 过期；中英漂移 |

## 4. 问题清单

编号 UX-n，按优先级排列。每条附证据、影响、建议与验收。

### UX-1 · P0 · 首次运行：错误 key 之后没有回头路

**证据**

- 实例 B 全流程：key gate 提交一个假 key → 仪式开始 → SOUL 步显示 `the first dream slipped away (401 {"type":"error","error":{"type":"authentication_error",…) — dreaming again…` → 最终错误行原样显示 `401 {"type":"error",…"request_id":null}` → 点 ENTER 后页面刷新，`cfgOverlay` 保持 `display:none`，`birthOverlay` 立即重新开始并再次以同一个 key 失败。
- [`src/web/lisa-client.ts:582`](../src/web/lisa-client.ts#L582)：ENTER 的行为是 `location.reload()`；启动门只按 `/api/config/status` 的 `configured` 判断，key 一旦写入 `config.env` 就不再展示表单。
- [`src/soul/birth.ts:163`](../src/soul/birth.ts#L163)：任何异常都"再梦一次"，包括 401；`birth.ts` 中没有任何超时；[`src/providers/anthropic.ts:31`](../src/providers/anthropic.ts#L31) 构造 SDK 客户端时未设 `timeout`，即默认 10 分钟；`/api/birth` 处理器不监听客户端断开，用户关掉页面后推理仍在跑。
- key gate 文案是"Lisa needs an Anthropic API key to wake up"，Anthropic 字段 `required`；而 CLI 的 `lisa doctor` 列出 13 家 provider 预设，官网首页宣传"10+ LLM providers"。

**影响**

第一次使用就可能卡死，且没有任何 UI 内的恢复路径；对中国用户（README 有中文版、官网宣传 DeepSeek/GLM/Qwen）Web 端根本无法用非 Anthropic key 完成首次运行。

**建议**

1. 认证类错误（401/403）不重试，直接给人话："这个 key 无效，请检查后重试"，并提供 **Change key** 按钮回到 gate（gate 增加"已配置，重新设置"态）。
2. 出生流程整体超时（建议 90s），SSE 上带进度心跳；ENTER 之外给 **Cancel**；`/api/birth` 监听 `req.on("close")` 中止推理。
3. key gate 改成 provider 选择器：Anthropic / OpenAI / DeepSeek / GLM / Qwen / Gemini / 自定义 base URL，复用 `providers/registry.ts` 的预设表；同步把默认模型写进 `config.env`。
4. 错误对象在服务端归一化为 `{code, hint}`，客户端永远不渲染原始 JSON。

**验收**

- 空目录 + 假 key：一次失败后 3 秒内看到人话错误与 Change key 按钮，点击后回到 gate；更换为有效 key 后无需刷新即可出生。
- 断网/超时：90s 内结束并可重试；关闭页面后服务端日志显示推理被中止。
- 用 `DEEPSEEK_API_KEY` 走通 Web 首次运行。

### UX-2 · P0 · 移动端与窄屏：两处叠加的布局失效

**证据**（375×812 视口，实例 A）

| 状态 | `.frame` 列 | `.main` 宽 | `#viewChat` 内容宽 | 发送按钮位置 |
| --- | --- | --- | --- | --- |
| 右栏折叠（v0.24 默认） | `300px 75px` | 75px | 681px | 屏外 |
| 右栏展开 | `375px` | 375px | 681px | left 583–667，屏外 |

- [`src/web/lisa-css.ts:2422`](../src/web/lisa-css.ts#L2422) `body.rb-collapsed .frame { grid-template-columns: 300px 1fr }`（特异性 0,2,1：两个类 + 一个类型选择器）覆盖了 [`:2443`](../src/web/lisa-css.ts#L2443) 的 `@media (max-width:720px) .frame { 1fr }`（0,1,0——媒体查询不贡献特异性），连 `grid-template-areas` 也一起被覆盖回两列。
- 720px 媒体块没有触碰 `#fnbar` / `.tabstrip` / `.fn-find`；功能栏 12 个 34px 图标 + tab 条 + 搜索框的最小内容宽度约 681px，`#viewChat` 是 grid，跟随内容撑到 681px；`.main` `overflow:hidden` 把溢出部分直接裁掉。
- 768px（平板）和 1024px 正常：右栏隐藏，主区 468 / 724px。

**影响**

手机浏览器与 PWA（有 manifest、有 SW）在 v0.24 起不可用；#367 之前折叠态不是默认，问题只在手动折叠时出现，现在是每个新用户的默认态。

**建议**

1. 把折叠规则限定在宽屏：`@media (min-width: 721px) { body.rb-collapsed .frame {…} }`，或在 720px 块内用同等特异性覆盖回来。
2. ≤720px 时功能栏改为可横向滚动或折叠为 ⋯ 菜单；tab 条与搜索框换行；`#viewChat` 设 `min-width:0`。
3. 补一条 Playwright 断点快照测试（375 / 768 / 1440 × 折叠 / 展开）。

**验收**

- 375px 下：主区 = 视口宽，发送按钮可见可点，页面与 `.main` 都不横向溢出（`scrollWidth === clientWidth`）。

### UX-3 · P1 · 可访问性地板缺失

**证据**（JS 测量）

| 项目 | 测量值 | 标准 |
| --- | --- | --- |
| `:focus-visible` 规则 | `lisa-css.ts` 0 条；焦点态 `outline: none`、无 box-shadow | 键盘焦点必须可见 |
| 次级文字（身份副标、当前欲望、会话 id、栏目标题、占位符） | 10 / 10.5 / 11px；Calm `--fg-3 #8a919f` on `#fff` = 3.2:1；Nebula `#6c7398` on `#07091a` ≈ 4.4:1 | AA 正文 ≥ 4.5:1 |
| 功能栏图标按钮 | 34×34px | 触控 ≥ 44px（桌面可接受 32px，但需焦点态） |
| 会话树切换钮 / ＋New | 24×21px / 57×19px | 同上 |
| `aria-live` | 0 处（流式回复、"needs you"变更无播报） | 动态区域应有 live region |
| `prefers-reduced-motion` | 主壳 0 处（room 1 处） | 动效应可关闭 |
| 图标按钮 aria-label | 覆盖良好（所有图标钮均有 label） | ✓ |

**建议**

- 设计令牌层加 `--focus-ring`，全局 `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`。
- `--fg-3` 两套主题都提到 ≥ 4.5:1（Calm 建议 `#6b7280`，Nebula `#8a92b8`），最小字号 11.5px。
- 图标钮外框 36px 起、触控面 44px（用 padding 而非改视觉尺寸）。
- 聊天流与右栏 "needs you" 加 `aria-live="polite"`；动效包一层 `prefers-reduced-motion`。

**验收**：axe-core 在主壳零 serious 级问题；Tab 键遍历一遍能看见每个焦点。

### UX-4 · P1 · 空聊天页与"未命名会话"

**证据**

- 出生后 ENTER 进入的聊天页 `#log` 有 0 个子节点，整块中栏为空；唯一线索是输入框占位符 "Talk to Lisa…"。
- 新建会话在树、tab、标题栏、右栏 inspector 里都显示原始 id（`20260905-220846-9f7d58 · 0 msgs`），要等首条消息后才自动命名（[`lisa-client.ts:2278`](../src/web/lisa-client.ts#L2278)）。

**建议**

- 空态卡片：她是谁（一句身份）+ 3 个由 soul/desire 生成的起手提示 + "她能做什么"（工具/知识库/邮件各一行）。
- 空会话统一显示 "New session · just now"，id 只放 tooltip；inspector 中的 `cwd` 用 `~` 缩写并可复制。

### UX-5 · P1 · 右栏默认折叠后，"needs you" 失去了入口

**证据**

- #367 起 `lisaRightbar !== 'open'` 即折叠；折叠后 needs you / inspector / mail / reflection / tokens 全部不可见，唯一入口是功能栏一个 34px 图标（title 提示）。
- 折叠态下没有任何位置显示待批准数量；左栏 Control 磁贴只显示 agent 数。

**建议**

- 切换图标上加待办徽标；出现第一条待批准/权限请求时自动展开一次；折叠状态按视图记忆（Control / Dashboard 视图默认展开）。

### UX-6 · P1 · README / 截图 / CHANGELOG 与产品脱节

**证据**

- `README.md` 767 行、55KB、62 个标题；"Install" 在第 119 行；前 118 行是定位与 ASCII 图。
- `assets/screenshots/01–06` 最后修改 2026-05-12（像素风旧壳）；README 中 "session shell / three-column / right rail / Calm" 0 次出现。
- `README.zh-CN.md` 最后修改 2026-08-02（英文 08-14），59 vs 62 个标题。
- `CHANGELOG.md` 最新条目为 `[0.12.0] — 2026-06-19`，之后 0.13–0.24 只在 `docs/RELEASE_*.md`，官网 changelog 页面从 releases 生成。

**建议**

- README 拆为"60 秒上手"（≤ 80 行：一条安装命令、一条 key、一张当前壳的截图、三个链接）+ `docs/GUIDE.md` 承接现有长文。
- 截图用 `.claude/skills/cloud-screencast` 的可复现流程重拍（v1.1 壳、两主题各一张、手机一张）。
- `CHANGELOG.md` 改为自动从 `docs/RELEASE_*.md` 生成，或直接在文件头声明"自 0.13 起见 docs/RELEASE_*"。
- 中文版设为 CI 检查项：标题数量差 > 0 时提示。

### UX-7 · P1 · Mac"一键下载"仍是两段式安装

**证据**

- 官网 install 页：下载 DMG、拖到 Applications 后，仍要求 `npm install -g @oratis/lisa` 与 `lisa serve --web`；前置条件 Node ≥ 20。
- 发布的 npm 包解压 66MB / 1,283 个文件（`npm view @oratis/lisa`），其中 59MB 是 139 张 PNG（`src/web/assets/lisa` 27MB、`room` 30MB，0 张 WebP）。

**影响**：官网承诺"most take about 60 seconds"，对无 Node 的 Mac 用户不成立；下载体积拖慢首次安装。

**建议**

- Mac 壳内嵌或首启自动安装后端（Node 单文件二进制 / `node --experimental-sea`，或壳里带 `npm` 安装向导并显示进度）。
- 资源改 WebP + 按需加载（当前 Room 五套场景图全量随包）；目标 npm 解压 < 15MB。

### UX-8 · P2 · 界面语言混排

**证据**：`<html lang="en">`，但 `lisa-client.ts` 有 31 处、`lisa-html.ts` 2 处中文字面量（如 `💾 存入知识库`），与英文界面混排；`lang` 不随内容变化。

**建议**：短期统一为英文；中期建一张 `i18n` 表（en / zh-CN），`lang` 随 `navigator.language` 或设置切换。官网已是双语，产品应对齐。

### UX-9 · P2 · CLI：诊断优秀，对话体验朴素

**证据**

- `lisa doctor`：环境、检查、13 家 provider 预设、退出码——整个产品最清晰的一屏。
- 缺 key 的错误信息准确，但把绝对路径全文打出（一行 200+ 字符）。
- 每条命令都先打印 `[proxy] outbound HTTP routed through …`（`doctor` / `status` / `"hi"` 均如此）。
- REPL（[`src/cli/repl.ts`](../src/cli/repl.ts) 80 行 + [`src/cli.ts:937`](../src/cli.ts#L937) `renderEvent`）：`you>` 提示符、`"""` 多行；文本流直出 stdout；工具调用以 `[tool name {input…}]` 写 stderr，只有失败才显示结果；thinking 完全不显示；无颜色、无 Markdown 渲染、无跨会话历史文件、无进度指示。

**建议**：`[proxy]` 降为 `LISA_DEBUG` 才输出；路径用 `~` 缩写；REPL 加最小 TUI（工具调用折叠行、流式光标、`~/.lisa/history`、`--no-color` 开关）。

### UX-10 · P2 · 后端卡顿时前端没有"在等后端"的状态

**证据**：本机 daily-driver 在审查中出现两次 5s+ 无响应（curl 5s 超时；12s 超时内返回 200），随后恢复到 3–100ms。此时 Web 端只有请求彻底失败才会出 banner，卡顿期间界面无任何反馈；`/health` 仅返回 `{ok:true}`。技术侧分析见 [技术审查 T-3](./PROJECT_REVIEW_TECH_v0.24.0.md#t-3)。

**建议**：SSE 心跳 + 客户端 3s 未收到心跳显示 "reconnecting…" 药丸；发送后 2s 无 `turn_start` 显示等待态。

### UX-11 · P2 · 视图与文案小项

- Sense 视图在全新安装、无任何连接器时显示 "Publishing active · Pause publishing"，语义反直觉。
- Pair 面板明文展示含 token 的 `lisa-pair://` 链接（本地可接受），但缺"复制"按钮和有效期说明。
- Inspector 显示完整绝对 `cwd`（本机为 90+ 字符）。
- PWA manifest 图标 `sizes: "any"` 指向 PNG，安装提示会被浏览器判为不合规（应给 192 / 512）。审查用的内置浏览器里 SW 注册失败，未在 Safari / Chrome 复现，暂列待验证。
- 快捷键只有 Enter / Shift+Enter / Esc；没有会话切换、聚焦输入框、打开搜索的快捷键。

### UX-12 · P2 · iOS：blocker 已修，可访问性与通知仍是缺口

**已核实修复**（对照 REVIEW_IOS_APP_v1.0）：A1 `fireCode` 非 2xx 抛错、A2 聊天处理 `error` 事件、A3 Live Activity `update/end`、A4 SoulItem 标签回退含 `title/stance`、A6 `.inactive` 隐私遮罩、A7 push 偏好含 `mail`、A12 自动滚动、A13 Markdown 渲染、B18/B19 10–15s 超时。模拟器测试 29 通过。

**仍开放**：`accessibilityLabel` 仅 14 处（Roster 状态点、进度点、图标钮多数未覆盖）；仅 APNs 一条推送通道，无 Apple key 时"Push registered"但收不到；PTY 实时流未接 SSE。建议按 v1.0 review 的 D/B 段收尾。

## 5. 优化计划

三个波次，每个波次结束都可以独立发版。

### 波次 1 · 止血（1–2 周）

| # | 事项 | 对应 | 验收 |
| --- | --- | --- | --- |
| 1 | 折叠规则限定宽屏 + 功能栏窄屏换行/滚动 + `#viewChat min-width:0` | UX-2 | 375px 断点快照通过 |
| 2 | 401/403 不重试；错误归一化；Change key 回到 gate；出生 90s 超时 + Cancel + 断开中止 | UX-1 | 假 key 场景 3 秒内可恢复 |
| 3 | `:focus-visible` 令牌、`--fg-3` 提对比、最小字号 11.5px | UX-3 | axe 零 serious |
| 4 | 空会话命名 "New session"；聊天空态卡片 | UX-4 | 出生后首屏有内容 |
| 5 | 右栏切换钮徽标 + 首个待批准自动展开 | UX-5 | 折叠态可见待办数 |

### 波次 2 · 一致（2–4 周）

| # | 事项 | 对应 |
| --- | --- | --- |
| 6 | key gate 改 provider 选择器，复用 registry 预设 | UX-1 |
| 7 | README 拆分为快速上手 + GUIDE；重拍 6 张截图；CHANGELOG 自动生成；中文版 CI 漂移检查 | UX-6 |
| 8 | 界面字符串统一英文，建 i18n 表 | UX-8 |
| 9 | 后端心跳与 "reconnecting…" 状态 | UX-10 |
| 10 | iOS a11y 补齐 + ntfy 通道暴露 | UX-12 |
| 11 | Playwright 冒烟进 CI：首次运行、出生失败、断点、主题 | UX-1/2/3 |

### 波次 3 · 打磨（4–8 周）

| # | 事项 | 对应 |
| --- | --- | --- |
| 12 | Mac 壳自带后端或自动安装向导 | UX-7 |
| 13 | 资源 WebP 化 + 按需加载，npm 包 < 15MB | UX-7 |
| 14 | CLI 最小 TUI（工具折叠行、历史文件、颜色） | UX-9 |
| 15 | 快捷键体系（⌘K 切会话、⌘/ 聚焦、⌘F 搜索） | UX-11 |
| 16 | 设计令牌文档化（两主题色板、字号阶梯、间距、焦点） | UX-3 |

## 6. 度量建议

| 指标 | 当前 | 目标 |
| --- | --- | --- |
| 首次运行成功率（空目录 → 进入聊天，含错 key 恢复） | 有死胡同 | 100% 可恢复 |
| 375px 断点：主区宽 / 发送按钮可见 | 75px / 否 | = 视口 / 是 |
| axe serious 问题数（主壳） | 未测（预计 > 10） | 0 |
| 次级文字最低对比度 | 3.2:1（Calm） | ≥ 4.5:1 |
| README 到第一条安装命令的行数 | 119 | ≤ 20 |
| 截图与当前壳一致 | 否（05-12） | 是 |
| npm 包解压体积 | 66MB | < 15MB |

## 附录 A · 关键测量原始值

- 功能栏按钮：`soul/skills/tools/plans/pair/kb/mail/find/panel/theme` 均 34×34；`sbTreeMode` 24×21；`sbNewSession` 57×19；composer `plus/record` 36×63；`send` 96×63（桌面）。导航磁贴 81×66。
- 计算色（禁用过渡后）：Nebula `--fg-3 #6c7398`、body `#000` / `--bg-deep #07091a`；Calm `--fg #1b2430`、`--fg-2 #4d5666`、`--fg-3 #8a919f`、`--fg-faint #c2c7d1`、侧栏 `#fff`、body `#f6f7f9`、激活导航 `#4f5bd5`。
- 断点：375 折叠 `300px 75px`；375 展开 `375px` 但 `#viewChat` 列 680.67px、`#log/#form/#fnbar` 681px、`.main.scrollWidth` 681；768 `300px 468px`；1024 `300px 724px`；1440 `300px 1fr 320px`。
- 空态文案（节选）：Control "No agents running. Delegate a task to start one."；Knowledge "Nothing here yet. In Chat, select messages and 'Add to KB'…"；Skills "No skills saved yet. Lisa will start saving useful workflows as you use her."；Rêve "No agent activity in this window."
- 首次运行 CLI：`lisa doctor` 退出前打印 `✗ 1 critical failure — Lisa won't run reliably`；`lisa "hi"` 无 key 时一行错误退出。

## 附录 B · 截图

审查过程中留存的三张实测截图（内置浏览器，800px 缩放）：key gate、出生仪式进行中、实例 A 主界面（Nebula）。移动端与 Calm 主题的结论来自计算样式测量，未截图。
