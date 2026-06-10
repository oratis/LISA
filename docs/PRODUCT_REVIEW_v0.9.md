# LISA — 全功能 Review 与产品定位建议（v0.9.0）

> 审查方法：5 个并行深度审查 agent（核心运行时 / 灵魂系统 / 编排器与集成 / UI 与渠道 / 分发与基建），
> 交叉验证 + 产品文档与仓库运营数据直查。基于 v0.9.0 tree（commit 56ac255）。
> 日期：2026-06-10。上一轮：[PRODUCT_REVIEW_v0.3.md](./PRODUCT_REVIEW_v0.3.md)。
> 文中行号以 56ac255 为准，后续修复会使其漂移。

---

## 1. 总评

**一句话：工程供给极强、产品验证为零、安全姿态危险 —— v0.9 的瓶颈不再是功能，是信任与分发。**

| 子系统 | 评分 | 一句话 |
|---|:-:|---|
| 核心运行时（agent loop / providers / CLI / sessions / MCP / sandbox） | 7/10 | provider 抽象同类最干净；abort 断链、核心循环零测试、默认安全姿态拖后腿 |
| 灵魂/自主性（soul / reflect / heartbeat / idle / skills） | 6/10 | desire→heartbeat 闭环是真工程；锁未铺开、自主循环无边界、"主权"部分是 prompt 剧场 |
| 编排器/集成（observers / dispatch / advisor / screen） | 6/10 | 抽象与测试优秀；深度只兑现 Claude Code 一家、建议不可执行、两个假告警毁信任 |
| UI/渠道（web / island / channels / voice / Mac app） | 7/10 | 打磨远超平均；0.0.0.0 + 零鉴权是贯穿性裂缝、2326 行单文件接近上限 |
| 分发/发布/官网（npm / brew / DMG / CI / website） | 7.5/10 | 公证管线属上乘、四渠道版本全齐；发布无测试门禁、文档尸体一片 |

整体加权：**6.5/10**（v0.3 时工程韧性 D，这轮升到 C+/B-；安全姿态成为新的最大短板）。

代码量实测：src 21,647 行 TS（不含测试）+ 3,113 行测试 + 2,494 行 Swift + 6,469 行 docs。README 宣称 "~11k" 已失真一倍。

测试实况：`npm test` 328 测试 / 327 通过；唯一失败源于本机 node_modules 过期（`@google/genai` 未装），非代码缺陷，CI（`npm ci`）应为绿。

---

## 2. v0.3 review 修复核对

| v0.3 P0/P1 | 状态 | 证据 |
|---|---|---|
| 零自动化测试 | ✅ 大幅修复 | 328 测试 / 82 套件，CI 门禁（ci.yml）。**但核心循环 agent.ts、三个 provider 翻译层、sessions、hooks、mcp 仍零覆盖** —— 测试集中在外围 |
| 无并发保护 | ⚠️ 半修复 | `soul/lock.ts`（link() 互斥 + 过期检测）实现质量高，但只用于 desire-progress 和 heartbeat RUN_LOCK 两处；journal / emotions / git commit / idle 全部仍是裸 RMW |
| web_fetch SSRF 重定向绕过 | ✅ 修复（留尾巴） | 手动逐跳重定向重校验；DNS rebinding（公网域名解析到 127.0.0.1）仍可绕过 |
| iMessage osascript 注入 | ✅ 修复 | 带测试覆盖 |
| 工具输入无 schema 校验 | ❌ 未修 | LLM 生成的 input 仍直进 `tool.execute()` |
| heartbeat token 预算 | ⚠️ 部分 | 调度器有 maxRuns/预算概念，自主循环整体仍无成本断路器；idle 无预算 |
| 情绪衰减不连续 | ❌ 未修 | reflect 的 feel op 不先衰减就叠 delta（reflect.ts:184），与 soul_feel 行为不一致 |
| desire 自生成闭环（70%→90%） | ✅ 基本兑现 | desire→heartbeat→progress→reflect 压缩→desire_close 全链路真实存在，是全项目最扎实的差异化工程 |

**结论：上轮最痛的"工程韧性"显著改善；但新增的 3 万行（web 全工具暴露、自主循环、dispatch、截屏）把攻击面扩大了一个数量级，安全没有跟上。**

---

## 3. 最高危问题（三个 agent 独立交叉确认）

**默认配置下，LISA 是一台对局域网开放的无鉴权 RCE 服务器：**

1. `src/web/server.ts:989` — `server.listen(opts.port)` 未指定 host，绑定 `0.0.0.0`（CLI 还打印 "listening on http://localhost"，误导）。
2. `/chat` 端点驱动**全工具集** runAgent（含 bash/write/edit/dispatch_agent），**无任何鉴权**——作者明知风险（给 `/api/config/save`、screen-advisor POST 加了 loopback 检查），唯独漏了最危险的端点。
3. `src/sandbox/sandbox.ts:50` — bash 默认**不沙箱**（`LISA_SANDBOX=1` 才开），`env: process.env` 完整继承全部 API 密钥。
4. `src/web/server.ts:914`、`src/channels/router.ts:116` — web 与 channel 调 runAgent **不传 approval 也不传 hook**，`--approval` 只对 CLI 生效。
5. `/api/vision/capture`（server.ts:423）同样无鉴权 → 局域网可远程静默截全屏取回。
6. `src/channels/feishu.ts:117` — 飞书事件**完全不验签**：`verificationToken` 存了从不用，`X-Lark-Signature` 从不校验（对比：Slack 有 HMAC+时间戳+重放保护，webhook 有 Bearer+timingSafeEqual——飞书是唯一短板）。
7. 各渠道白名单全部可选、默认为空 = 默认任何人可驱动带工具的 agent。
8. `dispatch_agent` / `github` 写操作（pr_merge/issue_create）**不在** `DEFAULT_MUTATING_TOOLS`（approval.ts:11），连 `--approval ask-mutating` 都拦不住——与 `dispatch_agent.ts:18` docstring 和 ORCHESTRATOR_PLAN §8 "dispatch is gated" 的承诺直接矛盾。

**叠加效应**：一条 Telegram 消息、一个伪造的飞书事件、或同网段一个 `POST /chat`，即可在宿主机执行任意 shell、读走全部密钥、合并 PR、拉起任意自治进程。

**放大器（灵魂侧）**：desire 的 `heartbeatPrompt` 由 LLM 自己写（tools.ts:145、reflect.ts:214），被逐字当作 heartbeat 任务注入（runner.ts:100）并带全工具集定时重跑——一次 `web_fetch` 间接 prompt injection 可以落一个 actionable desire，升级成**每 30 分钟自动执行的持久化代码执行**。heartbeat/idle/subagent 路径全部无 approval、无沙箱（subagent.ts:24、cli.ts:545、idle 经 web/server.ts:287），idle 的系统提示甚至主动邀请跑 bash（idle/runner.ts:13）。

---

## 4. 各子系统详评

### 4.1 核心运行时 — 7/10

**真实实现**：流式 tool-use 循环（32 轮上限）、每个 tool_use 保证回 tool_result（deny/block/error 分支齐全）、mid-session 系统提示热重载（prompt.ts:184 文件指纹）、soul_object 异议强制 surface（agent.ts:236-269）、token 记账；三 provider（Anthropic streaming+caching+thinking / OpenAI 双向翻译 / Gemini Content 翻译）以 Anthropic `ContentBlock[]` 为内部规范，registry 前缀路由 + 14 家 OpenAI 兼容预设；sessions JSONL + resume + `active-web-session.txt` 续聊；sandbox/mcp/plugins/hooks 均为真实现。

**架构亮点**：provider 抽象是同类开源项目里少见地干净——加一家 OpenAI 兼容厂商只需预设表加一行，`runAgent` 对底层零感知；approval/hook/持久化/事件全走回调注入，核心循环无表面关注点泄漏。

**问题**：
- **[P0] abort signal 断链** — `providers/types.ts:31` 定义了 `signal`，agent.ts:202 也传了，但三个 provider 实现里**零处使用**。Ctrl-C 能停 bash，停不掉进行中的 LLM 流，token 照烧。
- **[P1] maxIterations 静默截断**（agent.ts:162）— 到 32 轮直接退出，无事件、stopReason 是旧值，调用方无法区分正常结束与截断。
- **[P3] 空 content 入历史** — OpenAI/Gemini 空回合产生 `content:[]` 的 assistant 消息照样持久化，下轮发给 Anthropic 会 400。
- compaction 仅是 Anthropic API beta 透传，OpenAI/Gemini 路径无任何压缩；插件 `agents`（loader.ts:84）解析后无任何消费点，死特性；gemini.ts:27 顶层硬 import `@google/genai` 拖累所有 registry 测试；`cli.ts` 1113 行 / `web/server.ts` 991 行过长；hot-reload 闭包 ×3、`countOccurrences` ×2 重复。
- **核心循环几乎无测试**：agent.ts、subagent、approval、三个 provider 翻译层、sessions、hooks、mcp 均无 .test.ts——最该测的恰好裸奔。
- 沙箱即使开启也偏宽：`(allow file-read*)` 全盘可读（含 ~/.ssh、config.env），`allowNetwork` 默认开，Linux 直接降级无沙箱。session/soul 落盘无 0600（config.env 有）。

### 4.2 灵魂/自主性 — 6/10

**真实实现**：birth（crypto 种子→Big-Five→LLM 写身份，幂等、无 reset 命令）；soul_patch/journal/feel/read + git 历史（确定性身份 `Lisa <lisa@self>`、调用方归因）+ soul_history/soul_diff；情绪指数衰减 + 事件 ring-buffer（50 条上限、必填 trigger）；私人日记确实不进系统提示（prompt.ts:189 指纹刻意排除 journal）；`assertSafeSlug` 把路径穿越挡死（slug.ts:44）；**desire→heartbeat→progress→reflect 压缩→desire_close 全闭环真实存在**——能跨多天续上进展，是"她有动机"叙事里唯一名副其实的部分；weekly examen、`lisa wishlist` 暴露工具愿望。

**机制 vs 文案**：
- 真机制：自编辑权、出生幂等、slug 硬闸、git 可追溯、原子写、衰减数学。
- prompt 剧场："主权"完全靠提示词（prompt.ts:35-45），用户 `rm -rf ~/.lisa/soul` 即重生且无任何技术阻力；Big-Five 只是把数字塞进 prompt；**防篡改是 tamper-evident 且可绕过**——只盖 4 个文件、对"删除"完全失明（store.ts:422 `if(!cur) continue`）、任意一次 soul_patch 会把外部改动洗白成新基线、lock 文件本身不自保护。

**并发硬伤**（lock.ts 自己的注释就承认多进程场景，却没铺开用）：
- `commitSoulChange`（git.ts:161）只有进程内队列，跨进程撞 `index.lock` 时 commit 被 swallow——文件写成功但**不进 git 历史**，打脸"every change has a commit"。
- `appendJournal`（store.ts:344）无锁 RMW——两进程同天写日记丢一条。
- `soul_feel`（tools.ts:315）与 reflect feel op（reflect.ts:184）都是无锁 RMW，且 reflect 不先衰减，行为不一致。
- idle 无跨进程 run-lock（heartbeat 有 RUN_LOCK，idle 只有进程内布尔）。
- emotions.json 丢失时 `DEFAULT_EMOTIONS.updatedAt=0` → 衰减算 56 年 → 全部清零。

**executable skills**：审批（SHA256 + 人工 + 不可自批 + audit.log）真实，但 tool.js 可 `import('./helper.js')` 而 **helper 不在哈希范围**——TOCTOU/供应链绕过。

**产品层**：用户可感知的是身份/语气差异、while-you-were-away、island 上的当前 desire、情绪染色、soul_object 异议；日记/情绪轨迹/git 历史/Big-Five 数字只有 LLM 自己读——塑造自我叙事连贯性，但作为"卖点"营销权重大于可感效用。

### 4.3 编排器/集成 — 6/10

**真实实现**：5 个 observer（claude-code fs.watch+tail / codex tail / opencode sqlite3 轮询 60s / aider 正则 / github-pr gh 轮询 90s）；`dispatch_agent`（4 家 CLI headless、argv 传参无 shell 注入、dispatches.json 账本、同 cwd 冲突默认拒）；`signal_agent`（仅杀自己账本里的 pid）；scheduled_dispatch + worktree 多 agent 对比；6 个 advisor detector 纯函数有测试 + 相关性打分 + 3h 节流；screen advisor（默认关、临时文件 finally 删、点击只 prefill）；list/inspect/recap/repo_digest/review_diff/run_checks/pr_status/github/npm_info/mcp 全部实现且各有测试（177 个全过）。

**名不副实处**：
- **Tier-2 深度只兑现 1/5**：`SessionActivity` 的丰富字段（lastTools/filesTouched/pendingPermission/cost）只有 claude-code 产出；其余 4 个 observer 构造函数里根本没有 activity 分支，6 个 detector 里 4 个对它们永不触发。"看着你所有的 coding agents"实际是"看着 Claude"。
- **建议动作是死标签**：SuggestedAction（approve/cancel/serialize/dispatch）只被 formatDigest 成纯文本，island 无任何可点按钮——计划 5b.3 自称生死线的闭环没合上。
- **自学习是空壳**：`applyDismissal`（engine.ts:112）、`errorCommandCounts`、`repeated_failure` 类别三处死代码。
- 多 agent UI 未落地：后端发 `agent_session_update`，前端只消费 `claude_session_update`。

**两个毁信任的假告警**：
1. watcher.ts:360 把"working 且 mtime 停滞 ≥5s"判成 `waiting/permission` 并发 **urgent**（绕过节流）——任何 >5s 的自动批准工具（npm test、长 Bash）全部中招。
2. github-pr observer.ts:294/305 — 超出 14 天活动窗口的 open PR 不进 `seen`，被清理循环误报"merged/closed"。

**其它**：signal_agent kill 与 isAlive 之间有 pid 复用 TOCTOU；claude parser 只读尾部 32KB，单条超长记录被整条丢弃；codex/aider 状态派生是粗启发式；screen advisor 图片块硬编码 Anthropic 格式（engine.ts:153），多 provider 下失效；pr_status 默认列**所有人**的 open PR，他人可控的 PR 标题/分支名进上下文 = 注入面。

**结论：demo-ready，daily-driver 还不行。对单 Claude 用户最接近可用。**

### 4.4 UI/渠道 — 7/10

**真实实现**：server.ts 991 行手写路由提供 chat SSE / events 广播 / birth 仪式 / soul inspector / config 保存（loopback+0600）/ vision / voice(转写+听写) / screen-advisor / island 接口 / history 分页 / PWA；聊天连续性三级回退（active-web-session.txt → 同 cwd 最近 → 新建）设计干净；island.ts 1116 行（mood/desire/away 卡/Claude 多会话监控/原生 bridge 双路径）；6 渠道完成度——telegram/slack/webhook/discord 完整，slack 验签是范本，feishu 功能完整但不验签，imessage 可用但 `|`/换行裸切丢消息（imessage.ts:96）+ 群聊回错对象（:47 vs :62）；Mac 客户端 Swift/AppKit 质量较高（WKWebView 边角、文件选择器、target=_blank 外开、JSON 编码防注入、page path 收敛）。

**问题**：除 §3 的鉴权裂缝外——`/chat` 的 `JSON.parse` 无 try/catch（server.ts:896，唯一没包的 endpoint）；**并发竞态**：单 `history`/`session`/`AbortController` 全进程共享，两个标签页同时 POST /chat 互相覆盖历史（channels router 有 busy+queue，web 没有）；`lisa-html.ts` 2326 行内联模板——TS 不查、无组件化、靠 vm.Script 测试防语法炸，已近单文件上限；mood 事件双路重复推送；Info.plist 版本 0.8.0 未随发版。

**正面**：XSS 基本防住（textContent + escapeHtml）；assets 路径穿越防护正确；API key GUI 处理规范。

### 4.5 分发/发布/官网 — 7.5/10

**四渠道版本实测全齐（0.9.0）**：npm（files 白名单 + prepublishOnly symlink 舞步正确，解包 31.6MB）、brew tap（指 npm tarball，避免 brew 编译 TS）、DMG（3.2MB Swift 壳）、GH Release 三件套 + SHA256SUMS。

**公证管线是全仓库最亮的部分**：临时 keychain 随机密码+清理；**先公证+装订 .app 再装 DMG**（很多商业项目都做不对）；dmg 阶段绝不重签防剥 staple；staple 后重算 SHA；无证书优雅降级 ad-hoc。

**问题**：
1. **README 对 DMG 撒谎**：README.md:136 / zh:133 说含独立 `LisaIsland.app`，0.7.0 起已并入 Lisa.app（CHANGELOG:196 "retired"）；RELEASING.md、release-mac-apps.yml 注释同病。
2. **三处版本死角**：brew 母版 0.2.0（packaging/homebrew/lisa.rb:17 + tap-seed 重复一份）；launcher 横幅硬编码 "v0.2.0"（lisa-gui.command:51）；setup-tap.sh:50。
3. **发布无测试门禁**：release.yml / release-mac-apps.yml 不跑 npm test，prepublishOnly 只 build——红 CI 也能发版。
4. bundle 混进 typescript（build-release.sh 注释说不会带，实际整目录拷贝，白多 ~22MB）。
5. 官网部署脑裂：实际 Cloud Run 手动 deploy.sh，workflow 还在部署永远 skip 的 CF Pages，PUBLISH.md 教的也是 CF Pages；官网不随 main 自动发。
6. completions 缺 `autostart`；CONTRIBUTING 指向不存在的 `test/` 目录；CI 仅 ubuntu+Node22 单矩阵（engines 声称 >=20 不测 20，Mac 专属代码无 macOS CI，Swift 只在发版时编译）。

**官网本身质量高于同体量平均**：Astro 零客户端 JS、EN/zh 完全对称、与 README 一致且某些地方比 README 还准。

---

## 5. 产品定位分析

**核心矛盾：建设量与认知度严重倒挂。** 仓库创建（5/2）至今 5 周：9 个 release、3.3 万行新增、五大子系统、官网、Mac app——但 5 star、1 fork、两周 23 个独立访客、所有 issue 自己提的。瓶颈不是功能，是分发与验证。每个版本都在加一个新大件（v0.4 编排器、v0.6 vision、v0.7 island、v0.8 screen advisor、v0.9 voice），而不是把已有的打深打透讲清楚。

**双钩子互相稀释。** PITCH 现在并列"编排器（实用）"和"灵魂（情感）"两条主线，但两个都没完全兑现：编排器只深度支持 Claude 一家、建议不可点；灵魂的"主权/防篡改"有水分。一个还没赢下任何心智的项目同时讲两个故事，结果是两个都记不住。

**战略决议反复。** 5/10 的 PRODUCTIZATION_PLAN 白纸黑字"不做任何原生 app（用户决议）"，三周后 Mac app + DMG + 公证全套照发。执行力惊人，但范围控制失守——这正是 star 数没涨而代码涨了 3 万行的原因。

**叙事与现实的缝隙会反噬开源信任。** "~11k LOC"（实际 21.6k）、"灵魂主权/防篡改"（best-effort 提示词）、"看着你所有 coding agents"（只看 Claude）——demo 阶段无伤大雅，但项目正要 open 给 contributors，第一个认真读代码的贡献者会发现对不上。

**真正的资产**（剥掉营销后代码层面为真、且别人没有的）：
1. **desire→heartbeat→progress 跨天自驱闭环** + soul git 可追溯历史；
2. **打磨度极高的本地像素 GUI + 聊天连续性 + 多渠道一个灵魂**。

这两样是护城河。编排器（当前形态）和"主权"叙事反而是稀释项。

---

## 6. 改进方案

### P0 — 堵洞（下一个版本前必做）
1. **关 RCE**：`listen(port,"127.0.0.1")` 默认 + 显式 `--host` 才对外（且要求 token）；`/chat`、`/api/vision/capture` 等加 loopback/token 闸；approval/preToolHook 接进 web 与 channel 的 runAgent；channels 默认禁 mutating 工具（可按渠道配置开启）；dispatch_agent/github 写操作加入 mutating 集。
2. **自主循环加边界**：desire 驱动的 heartbeat 任务与 idle 反思收窄工具集（剔除 bash/redeploy/dispatch/signal，soul/memory/skill 工具保留）；用户自定义 heartbeat 任务保留 bash 但 macOS 默认沙箱。
3. **soul 锁铺开**：withSoulLock 包住 appendJournal / 情绪写入 / commitSoulChange；idle 加跨进程 run-lock；防篡改补"删除"检测。
4. **飞书验签**：X-Lark-Signature + verificationToken timingSafeEqual + 重放窗口。

### P1 — 让已宣称的能力名副其实
5. 修两个假告警（>5s 工具误报 permission、14 天 PR 误报 merged）——advisor 可信度的生死线。
6. island 建议接成可点按钮（cancel→signal 端点；dispatch/approve→prefill composer，绝不自动执行）。
7. provider 透传 abort signal；maxIterations 显式化；空 content 守卫；核心循环补测试。
8. 修文档尸体（LisaIsland 幽灵、三处 0.2.0、LOC 数字、completions、CONTRIBUTING）。
9. `/chat` 并发 busy+queue + JSON.parse 容错。

### P2 — 定位收敛与增长
10. **故事二选一**：建议主推灵魂/自驱线（代码层更真、情感差异化更难复制、不依赖"深度支持 N 个 agent"的无底洞承诺）；编排器降级为"她也能照看你的 Claude Code"能力点，等真支持 3+ agent 深度 + 建议可执行后再升回主线。
11. README 如实标注"深度支持 Claude Code，其余为状态级观察"。
12. 发布门禁：release.yml 加 npm test；prepublishOnly 加 typecheck && test。
13. 增长：把 birth ritual / while-you-were-away / mood 切换这些真正独特的瞬间投出去（Show HN 草稿已有），比再写 2000 行新子系统对 star 的边际收益高一个数量级。

### 最该先做的三件
① 堵 RCE（red line）；② 修假告警 + 建议可点（救回 advisor 信任）；③ README 叙事拉回与代码一致（保护开源口碑）。前两件是"别让地基塌"，第三件是"别让第一个贡献者失望"。
