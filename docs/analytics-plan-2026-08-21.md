# LISA 打点建设方案（2026-08-21）

> **方法论来源**：`/Users/oratis/Documents/Claude/analytics-blueprint.md`（从 Luddi 生产事故提炼的可移植手册）。
> 本文不是那本手册的改写版——Luddi 是 web+mobile 的 C 端 SaaS，LISA 是一个**公开承诺零遥测的
> 本地优先 CLI/常驻进程**。手册里有整整数节在这里是**反向**成立的，见文末《附录 A：蓝图不适用条目》。
>
> 所有路径均为 `/Users/oratis/Documents/LISA` 仓库相对路径，符号名可搜索，行号会漂移。
> 本文中所有"新建"文件都还不存在——这是设计，不是现状描述。

---

## 摘要

**一句话**：LISA 的打点不是"把数据送出去"，而是**先在用户自己的机器上建一份他自己也能 `cat` 的
结构化台账（`~/.lisa/telemetry/events.jsonl`，默认唯一 sink、永不出网、30 天自动过期），
再把"出网"做成一个默认关闭、走既有 consent gate、只发枚举与分桶、事件清单可被
`lisa telemetry events` 原样打印的第二 sink**。

**与蓝图的最大差异**：蓝图的默认姿势是"**全量入仓，服务端权威**"——因为 Luddi 的服务端本来就
握着全部流量，不打点才是异常。LISA 的默认姿势是"**全量留在本地，出网是显式白名单且默认关**"
——因为 LISA 的服务端在绝大多数安装里**根本不存在**（默认只绑 `127.0.0.1:5757`），而
`website/src/pages/privacy.astro` 已经对全世界发布了"no analytics, no advertising identifiers,
no third-party tracking SDKs"。在这个产品里，**打点体系的第一个失败模式不是"数据丢了"，
是"承诺与代码漂移，被 HN 上最会 grep 的那批人抓到"**——所以本方案把蓝图的"监控四件套"
扩成五件，第五件专门盯这个（§8.5）。

**三层数据来源的不对称必须提前认下来**（这是本方案与任何 web 打点方案的结构性区别）：

| 层 | 覆盖谁 | 拿得到什么 | 何时可用 |
|---|---|---|---|
| **L1 本地台账**（默认开，永不出网） | 100% 安装 | 全部——但只有用户自己和跑 `lisa telemetry report` 的人能看 | Phase 0 |
| **L2 代理指标**（零代码、零隐私成本） | 100% 安装的**上游** | npm downloads / GitHub release 资产下载数 / stars / Cloudflare Pages 日志 / TestFlight | Phase 0。**star 那一路的脚本已经写好了**（`scripts/star-history.sh`），欠的只是一个 cron —— 见 §6.2 |
| **L3 opt-in 上报**（默认关） | opt-in 的那一小部分 | 枚举与分桶，无文本 | Phase 2 |

**L3 的样本永远是有偏的**（愿意开遥测的人 ≠ 典型用户），这不是可以靠工程修掉的问题，
只能靠口径纪律承认（§7.6）。任何把 L3 数字当"全体用户"讲的结论都是错的。

---

## §0 前提与假设

### 0.1 调研已确认的事实（本方案的地基）

| 事实 | 出处 |
|---|---|
| 全仓零遥测 SDK，零上报。这是**已发布的产品立场**，不是待办 | `website/src/pages/privacy.astro`、`cloud.astro`、`index.astro` |
| 生产依赖只有 8 个；Firestore 走裸 REST、Turnstile 走一个 form POST | `package.json`、`src/cloud/firestore.ts`、`src/web/turnstile.ts` |
| 已有三份"append-only + 上限 + 跨进程锁 + 绝不抛异常"的 JSONL 台账 | `src/billing/meter.ts`(5000 行)、`src/autonomy/runs.ts`(2000 行)、`src/sense/log.ts`(1000 条 + 7 天) |
| 统一 consent gate 已存在，默认全关、缺省即拒绝、corrupt 即拒绝 | `src/consent/store.ts` 的 `isGranted()` |
| 多租户隔离靠 `homeScope` AsyncLocalStorage，不是 `WHERE uid=` | `src/paths.ts` |
| SSE 扇出的租户规则是 `sameTenant(subscriberUid, originUid)`，是一次真实跨租户泄漏的修复 | `src/web/event-bus.ts:39-44` |
| `bornOn = sha256(hostname + username)`。**「从不外发」已被证伪并部分修复**：`dreamSoul()` 原先把整个 seed（含 `bornOn`）序列化进出生提示词发给模型提供商，本 PR 已加 `seedForPrompt()` 剥掉它；但 `GET /api/soul` 至今仍把完整 seed 发给已认证客户端（iOS 伴侣 app 就在读它）。所以 §5.1 的红线依然成立且更有必要 | `src/soul/birth.ts` 的 `generateSeed()`、`seedForPrompt()`；`src/web/server.ts` 的 `/api/soul` |
| 观测者不是 5 个而是 **10 个**目录：claude-code / codex / opencode / aider / github-pr / git / shell / takoapi / managed / pty。默认开三个：`claude-code`、`managed`、`pty`——后两个"在静止时不增加任何东西"（`managed` 只反射进程内 registry；`pty` 需要 `LISA_PTY_AGENTS=1` 才非空），**所以 Q5 的分母天然只有一个真观测者** | `src/integrations/`、`hub.ts:28-65` 的 `DEFAULT_ORCHESTRATOR_CONFIG` |
| advisor 有 **5 个** category（`stuck`/`conflict`/`cost_spike`/`ready`/`idle`）与已存在的 `categoryDismissals` 计数。**原为 6 个**：`repeated_failure` 从来没有任何 detector 发出过，连同同样从未被读写的 `errorCommandCounts` 一起已在本 PR 删除，并加了双向断言防止再漂回来 | `src/advisor/types.ts` 的 `SUGGESTION_CATEGORIES`、`src/advisor/advisor.test.ts` |

### 0.2 本次调研新发现的两条事实（会直接改变取数方案，必须先解决）

**发现 A — `usage.jsonl` 是「计费台账」不是「使用台账」，CLI 终端的 chat turn 刻意不进。**

实测 `recordUsage()` 的全部非测试调用点是 **4 个文件 5 处**：

```
src/web/server.ts:4079           recordUsage("chat", ...)            ← 只有 Web GUI 的 /chat
src/web/server.ts:2265           recordUsage("voice_dictation", ...)
src/web/autonomy-sweep.ts:294    recordUsage(...)                    ← 服务端驱动的 autonomy（每 task）
src/web/autonomy-sweep.ts:364    recordUsage("autonomy", ...)        ←                （汇总）
src/billing/admission.ts:52      recordUsage(source, ...)            ← 云版 gateway/admission
```

`src/agent.ts` / `src/cli.ts` / `src/heartbeat/runner.ts` / `src/idle/runner.ts` **一个都没有**。
而 `src/agent.ts:307-311` 明明在累加 `result.usage` 的四类 token——它算了，只是没往台账里写。

**这是有意的，不是遗漏**（本轮已核实，原判断有误）。
`docs/PLAN_ACCOUNTS_BILLING_v1.0.md` §6.3「计量（metering）」原文把接入点限定为三处：
server.ts 的 `runAgent` 结果处、「autonomy 后台 run（**若云端开**）」、以及 `gateway.ts` 流末。
本地 REPL / heartbeat / idle 从来不在名单上——因为 `usage.jsonl` 的语义是
**「谁在花我们的钱」的审计源**（配 `balance.json` 快路余额），本地版根本不计费，
往里写一行既没有对应的 debit，也会在云版与 server.ts:4079 的现有调用点**双计同一个 turn**。

**所以「把 `recordUsage` 挂到 agent.ts」是错的修法，本方案撤回它。** 正确的做法是分开两件事：

| 需求 | 载体 | 为什么 |
|---|---|---|
| 「谁花了钱」（计费审计） | `usage.jsonl`，**维持现状不动** | 它已经在它该在的四个路径上；改它会引入双计 |
| 「她跑了多少 turn / 烧了多少 token」（使用度量） | **新的 `turn_completed` 事件**，发在 `src/agent.ts` 的 turn 出口（§3.4 Q1） | 那里是唯一同时看得到 CLI / Web / heartbeat / idle 四条路径的锚点 |

**但发现 A 的口径后果完全成立且更严重**：任何拿 `usage.jsonl` 当"活跃度/成本"真相源的分析，
会**系统性漏掉旗舰形态（终端 REPL）的全部消耗**——而且因为它是"有意的设计"，
不会有任何 bug 报告提醒你。这与蓝图 §2.1 踩坑二（`ai_generate_started` 的 server emitter 挂在
legacy 路由上，生产流量走另一条路）是同一个病的**良性变种**：
**信号存在、落行正确、但它的覆盖面不是你以为的那个**。口径处理见 §7.4。

**发现 B — 有 8 处身份态存储各自定义了私有的 `lisaHome()`，不走 `homeScope`。**

`src/paths.ts` 的 `lisaHome()` 是 `homeScope.getStore() ?? lisaGlobalHome()`。
以下文件**没有导入它，而是各自写了一份只读 env 的同名函数**（实测 `grep -n "function lisaHome" src/`）：

```ts
// src/consent/store.ts:54 —— 注意：不是从 ../paths.js 导入的那个
function lisaHome(): string {
  return process.env.LISA_HOME ?? path.join(os.homedir(), ".lisa");
}
```

| 文件 | 落的文件 | 是否该按 uid 分片 |
|---|---|---|
| `src/consent/store.ts:54` | `consent.json` | **是**（遥测 signal 要接这里，§9.2） |
| `src/sense/log.ts:18` | `sense/events.jsonl` | **是** |
| `src/integrations/dispatch-ledger.ts:39` | `dispatches.json` + `dispatches/` | **是** |
| `src/control/policy.ts:43` | `control-policy.json` | **是** |
| `src/web/push.ts:65` | `push.json` | **是**（推送目标是「谁的」设备） |
| `src/mail/store.ts:10` / `src/mail/accounts.ts:15` | `mail/` | **是** |
| `src/integrations/takoapi/ledger.ts:44` | `takoapi-calls.json` | **是** |

**不要顺手一起改的四个**（它们私有 `lisaHome()` 是**正确的**，语义就是进程级）：
`src/web/accounts.ts:96`、`src/web/devices.ts:29`、`src/web/otp.ts:64`、`src/web/sessions-auth.ts:37`
——`paths.ts` 头注释明确写了 accounts / devices / session secret「NEVER per-user」。
它们该改的是**导入 `lisaGlobalHome()`**（消除重复定义），不是改成 `lisaHome()`。
对照组：`src/billing/meter.ts:16` 和 `src/autonomy/runs.ts:17` 是**正确的**范例，
直接 `import { lisaHome } from "../paths.js"`。

**后果**：在 `LISA_EDITION=cloud` 下，**所有租户共用同一份 `consent.json`**——一个用户
grant 了 `screen`，全体用户的 gate 都开了。这与 `event-bus.ts` 修掉的那个跨租户泄漏是同一类
问题，只是还没有人踩到（因为 Sense 是 `MAC_ONLY_CAPABILITIES`，云版本来就关着——所以今天
**大概率无害**，但它是一颗定时炸弹）。

**本方案只负责修 `consent/store.ts` 一处**（因为遥测 gate 必须挂在它上面）。
其余七个文件记为**已识别、未修**，写进 `docs/TELEMETRY.md` 的已知问题一节——
打点方案没有资格顺手重构半个仓，但也没有资格假装没看见。

**对本方案的直接影响**：遥测 consent 打算接进 `consent/store.ts`（这是唯一正确的做法，见 §9.2），
但遥测**在云版是开着的**。如果照现状接，第一个 opt-in 的云版用户就替全体云版用户开了上报。
**所以 `consent/store.ts` 改用 `paths.ts` 的 `lisaHome()` 是遥测上线的硬前置**，不能并行做。

### 0.3 待确认项（不要在这些上编造结论）

| # | 状态 | 待确认 | 确认方法 / 结论 |
|---|---|---|---|
| 1 | ✅ **已解决** | 发现 A 是有意还是遗漏？ | **有意。** `docs/PLAN_ACCOUNTS_BILLING_v1.0.md` §6.3 把 metering 接入点限定为 server.ts 的 `runAgent` 出口、「autonomy 后台 run（若云端开）」、`gateway.ts` 流末——本地 REPL 从来不在名单上。§0.2 已按此改写，`recordUsage` 不动 |
| 2 | ⬜ 待确认 | 发现 B 是有意还是遗漏？ | `LISA_EDITION=cloud LISA_HOME=/tmp/t` 起服务，用两个 uid 各调一次 `POST /api/consent/grant`，看第二个 uid 的 `GET /api/consent` 是否受影响 |
| 3 | ⬜ 待确认 | `heartbeat`/`idle` 的 token 只进 `runs.jsonl` 不进 `usage.jsonl`，`autonomy-sweep` 只进 `usage.jsonl` 不进 `runs.jsonl`——两个台账是否有重叠路径导致双计？（实测：`recordAutonomyRun` 的 8 个调用点在 `reflect.ts`×2 / `idle/runner.ts`×2 / `heartbeat/runner.ts`×4，`autonomy-sweep.ts` 一个都没有，所以**目前看是互斥的**，但要跑一次确认） | 跑一次 `lisa heartbeat run` 与一次服务端 autonomy sweep，diff 两个文件的新增行 |
| 4 | ⬜ 待决策 | upload sink 落在哪：Cloudflare Worker（官网已在 CF Pages，账号已有）还是现有 Cloud Run 加一条路由？ | §6.3 给了倾向与理由，但**最终归属未定**，Phase 2 前决策 |
| 5 | ⬜ 待确认 | Homebrew tap 的下载数能否拿到？（`brew analytics` 是**安装方**开启的，第三方 tap 的可见性受限） | 查 `brew analytics --help` 与 formulae.brew.sh 的 tap 覆盖范围 |
| 6 | ⬜ 待确认 | iOS 隐私标签加 `installId` 会不会触发新的 data type？ | 现状：`packaging/ios-companion/Sources/PrivacyInfo.xcprivacy` 只声明 `EmailAddress` + `UserID`（App Functionality / linked / no tracking），`NSPrivacyTracking=false`、`NSPrivacyTrackingDomains` 为空。我的判断是必须新增 "Product Interaction"，但**这是需要 ASC 提审确认的，不要当既成事实** |
| 7 | ✅ **已解决** | 九宫格切换有没有单一函数可挂钩？ | **有。** `showView(name)` @ `src/web/lisa-client.ts:3224`，`data-view` 按钮的事件委托在 `:3238`。`surface_opened` 就挂在 `showView` 的入口，**一处即可覆盖全部视图切换**——不要逐按钮挂 |
| 8 | ⬜ 待实测 | LISA 当前的真实规模（stars / npm 周下载 / 活跃安装估计） | `docs/GROWTH.md` 写的是 v0.6.0 时期的 "4 stars"，现在是 v0.24.0，**必然已漂移**。`docs/star-history.csv` 里只有一行（`2026-05-09`，2 stars）——**这个脚本从来没被真正定时跑过**，见 §6.2 |

### 0.4 量级假设（本方案所有阈值都在这个假设下调出来的）

没有实测数据，所以是**假设**，量级差一个数量级就要重调（蓝图开篇的"规模参照"在这里的对应物）：

| 量 | 假设 | 依据 |
|---|---|---|
| 活跃安装 | 10² 量级（数百） | v0.24.0、npm 包、GROWTH.md 里 4→10k star 的起点 |
| 单安装事件量 | **~40–80 事件/天** | heartbeat 每小时 1 次 = 24；chat 2–3 会话 × (start+end+若干 turn 摘要) ≈ 10；observer scan ≈ 12；advisor/surface/consent 若干 |
| 本地 ledger 体积 | ≤ 600 KB（3000 行 × ~200 B） | §6.1 的上限设计 |
| L3 上报量（假设 20% opt-in） | ~200 安装 × 30 可上报事件/天 ≈ **6k data points/天 ≈ 18 万/月** | 见 §6.3 成本估算 |

**结论：L3 的边际成本约等于零**，在任何主流 sink 的免费额度内。所以成本护栏（§8.6）不是为
正常量设的，是为"一个 heartbeat 循环里误加了 upload 调用"这种失控 bug 设的——和蓝图 §7.6
的结论一样，只是量级小两个数量级。

---

## §1 业务问题 → 指标 → 事件

调研给的 9 个业务问题逐条落到指标与事件。**这一节是事件表（§3.4）的需求来源，反过来说：
§3.4 里出现的每一个事件都必须在这张表里找得到出处，找不到的删掉。**

| # | 业务问题 | 指标（含身份单位） | 主事件 | 数据层 |
|---|---|---|---|---|
| Q1 | 出生之后她活下来了吗？ | **D1/D7 二次会话率** = `COUNT(DISTINCT installId WHERE 有 birth 后 ≥2 次 session_started{surface≠autonomous} 且跨自然日) / COUNT(DISTINCT installId WHERE birth_completed)`。分母上必须加 `homeIsDefault=true`（§7.2） | `birth_started` `birth_completed` `session_started` `session_ended` `turn_completed` `install_daily_ping` | L1+L3 |
| Q2 | 自我意志在产出还是空转？ | 按 `kind` × `outcome` 的分布 + 每 outcome 的 token 中位数。**核心比率**：`done / (done+no-update)` | `autonomy_run_recorded` `desire_inventory_snapshot` `token_budget_blocked` | L1+L3 |
| Q3 | REVE 卡是惊喜还是噪音？ | 卡片曝光后 30 分钟内的动作分布；`--idle` 关闭率 × 使用时长分桶 | `idle_message_surfaced` `idle_message_engaged` `idle_disabled` | L1+L3 |
| Q4 | advisor 采纳率 vs 屏蔽率（按 category） | 逐 category 的 `acted / surfaced` 与 `dismissed / surfaced` | `advisor_card_surfaced` `advisor_card_acted` `advisor_card_dismissed` | L1+L3 |
| Q5 | 五（十）个 observer 保真度够吗？ | **先看开启率**（十个里默认只有 `claude-code` 是真观测者），再看"识别到但活动为空"率 = `(found − withActivity) / found`；字段空缺率要与 `OBSERVER_FIDELITY.md` 的 `➖` 做差 | `observer_enabled_changed` `observer_scan_completed` | L1+L3 |
| Q6 | coding plan 省钱承诺兑现了吗？ | `plan_run_finished{done} / plan_run_attempted{launched}`；preflight 失败原因分布（**六值，需新写映射函数**）；`plan_selected != "none"` 的安装占比。**注意 `PlanId` 是三个：claude/codex/copilot** | `plan_selected` `plan_run_attempted` `plan_run_finished` `dispatch_agent_finished` | L1+L3 |
| Q7 | 云版免费窗口定价对不对？ | 窗口耗尽率；耗尽后 24h 转化率；premium 被挡次数 | `free_window_opened` `free_window_exhausted` `premium_model_blocked` `credit_pack_purchased` `account_created` | **L3-cloud（服务端权威，天然全量）** |
| Q8 | 哪些 surface 装了从来不开？ | 逐 surface 的"曾经打开过一次"率与"过去 7 天用过"率。**Mail 不在 `surface_opened` 覆盖内**（它不是 data-view），只能靠 `cli_command_invoked{mail}` + `/api/mail/*` 计数 | `surface_opened` `cli_command_invoked` `repl_slash_command` `channel_message_routed` `cli_flag_used` | L1+L3 |
| Q9 | consent 是保护还是把 Sense 变成死功能？ | 逐 signal 的授权率、授权后 30 天撤销率 | `consent_changed` `consent_prompt_shown` `sense_signal_captured` | L1+L3 |

**注意 Q7 的特殊性**：它是九个问题里**唯一一个不需要任何客户端上报**的——云版的 gateway 与
quota 引擎在服务端，天然全量、天然权威、天然不涉及本地版的零遥测承诺。所以 Q7 应该**第一个
被回答**（Phase 1），其余八个都要等 opt-in 上报（Phase 2）或只能读本地台账（Phase 0/1）。
把 Q7 排在最后做是常见的排序错误。

---

## §2 三条设计不变量在 LISA 的形态

蓝图 §1 的三条不变量全部成立，但每条的具体形态都被"本地优先"改写了。

### 2.1 打点永不阻塞——这里的"业务"是 chat，标准比 Luddi 更严

**规则**：`track()` 是**同步签名、返回 void、永不 throw**，全部真实工作在后台。这条在 LISA 不是
新纪律，是**照抄仓里已有的纪律**：

- `src/billing/meter.ts` 的头注释原文：*recording NEVER throws (metering must not take chat down)*
- `src/autonomy/runs.ts` 的 `recordAutonomyRun`：append 失败 `return`，trim 失败静默
- `src/sense/log.ts` 的 `appendSenseEvent`：*Best-effort — never throws into the caller*

**LISA 特有的加强**：Luddi 的 sink 挂了是"一个 HTTP 接口慢"；LISA 的 sink 挂了可能是
**用户终端里正在流式输出的一句话卡住**。而且这个进程是 launchd 常驻的——一个泄漏的 promise
不会随请求结束被回收，会累积几天。所以三条额外要求：

1. `track()` 内部**不做任何 I/O**，只往进程内有界数组推一条。落盘由一个 250ms 的 timer 批量做。
   （meter.ts 是 `await appendLine` 直接落盘——在计费路径上可接受，因为一个 turn 才一行；
   打点一个 turn 可能有 5 行，不能每行一次 `fs.appendFile`。）
2. 那个 timer 必须 `.unref()`——否则 `lisa "prompt"` 这种一次性调用会因为一个挂着的
   timer 而**不退出**。这是 CLI 形态特有的坑，Luddi 的服务端进程本来就不退出，不会遇到。
3. 进程退出时 drain 一次：`process.on("beforeExit")` + `SIGINT`/`SIGTERM`。CLI 的 Ctrl-C
   是最常见的退出路径，不 drain 就会丢掉整场会话的尾部事件（包括 `session_ended`——
   而 `session_ended` 恰好是 Q1 的关键事件）。
4. **flush timer 的回调必须整体 `try { … } catch { /* swallow */ }`。** 这是蓝图 §2.2 的
   移动端踩坑（*deferred callback 里的 throw 没有调用方接，会直接干掉 JS runtime*）
   在 LISA 的形态——**而且后果严重一个量级**：Luddi 炸的是一次 CI 跑；LISA 这个进程是
   `launchd` 常驻的 `lisa serve`，一个 timer 回调里的未捕获异常会**杀掉整个后台服务**
   （web GUI、SSE、heartbeat 一起没），用户看到的是"她忽然不见了"，而根因是一行打点代码。
   `track()` 的 never-throw 契约只保护调用方那一侧；timer 侧是**另一条**必须单独封的边。
   **验收**：单测里让 ledger 的写入 stub 抛异常，断言进程不退出且下一次 flush 照常发生。

### 2.2 sink 解耦——LISA 的两个 sink 不是并列，是**串联**（这是对蓝图的刻意偏离）

蓝图 §1.2 要求两个 sink 彼此独立、一个挂了不影响另一个。**LISA 反过来**：

```
track() → 内存 buffer → [Sink A: 本地 ledger]  ← 唯一真相源，默认开，永不出网
                                  ↓ （只有 consent granted 时）
                          [Sink B: upload]     ← 从 ledger 读，批量 POST，默认关
```

**为什么反着做**（三条理由，都是本地优先产品特有的）：

1. **离线用户的可观测性不能比在线用户差**。如果 upload 是独立 sink，那么一台断网的机器上
   什么都没有；串联意味着**每个安装都有一份完整台账**，无论是否上报、是否联网。
2. **opt-in 与 opt-out 用户跑同一条代码路径**，只差最后一步。代码分叉少一处，
   "opt-out 的人被区别对待"这个指控就少一个成立的可能——而这个产品最怕的就是这类指控。
3. **upload 是 ledger 的严格子集**，对账天然可做（§8.3）。

**代价必须写下来**：本地 ledger 写失败 = upload 也没得发，两个 sink 一起哑。这是接受的取舍——
本地写失败在这个产品里意味着磁盘满或 `~/.lisa` 权限坏了，届时用户有远比丢打点更大的问题
（`meter.ts` 已经为同一场景写过判断：ENOSPC 时"最多丢一条审计行，绝不丢 debit"）。

### 2.3 env 开关——不配置即 no-op，但"默认值"的方向和 Luddi 相反

| env | 默认 | 作用 |
|---|---|---|
| `LISA_TELEMETRY_LOCAL` | `1`（**开**） | 本地 ledger 总开关。`0` → `track()` 整条链路 no-op |
| `LISA_TELEMETRY_UPLOAD_URL` | 无（**= upload sink 关闭**） | 上报目的地。不配即 no-op——蓝图 §1.3 的原样翻版 |
| `LISA_TELEMETRY_FLUSH_MS` | `250` | 内存 buffer → ledger 的落盘节拍 |
| `LISA_TELEMETRY_MAX_BUFFER` | `500` | 内存 buffer 上限，溢出丢**最旧** |
| `LISA_TELEMETRY_MAX_LINES` | `3000` | ledger 行数上限（对齐 runs.jsonl 的 2000 / usage.jsonl 的 5000） |
| `LISA_TELEMETRY_RETENTION_DAYS` | `30` | ledger 保留期（对齐 sense/log.ts 的双重界纪律） |
| `LISA_TELEMETRY_UPLOAD_INTERVAL_H` | `6` | upload 批次间隔 |
| `LISA_TELEMETRY_DEBUG` | 无 | 打印每条 track 到 stderr，给用户自己验证用（**这是信任工具，不是调试工具**） |

**三条 LISA 特有的规则**：

- **`LISA_TELEMETRY_LOCAL` 默认开，`LISA_TELEMETRY_UPLOAD_URL` 默认空。** 这两个默认值的方向
  必须分开理解：本地台账默认开是因为它和 `runs.jsonl` / `usage.jsonl` 是同一类东西（用户自己
  磁盘上的、用户自己能读的、有界会过期的），产品里已经有三份了；出网默认关是因为
  privacy.astro 的承诺。**把这两个混成一个开关是最容易犯的设计错误**——它会逼你在
  "本地也不记"和"默认上报"之间二选一，两个都是坏答案。
- **`LISA_TELEMETRY_UPLOAD_URL` 的默认值必须是空，而不是"编译进去的官方地址 + 一个 enable 开关"。**
  区别在于：前者的语义是"你没配就没有目的地"，后者的语义是"有个地址一直躺在二进制里等着被打开"。
  在一个 MIT 开源、用户会 grep 的产品里，这个区别是信任层面的，不是工程层面的。官方地址写在
  `docs/TELEMETRY.md` 里，`lisa telemetry on` 帮用户写进 `~/.lisa/config.env`——**是用户的机器
  上出现了这个地址，不是我们的代码里**。
- **env 短路只能在各 sink 内部**（蓝图 §1.1 踩坑一原样适用）。`track()` 入口不得出现
  `if (!enabled) return`，否则将来加第三个 sink 时又要拆一遍。

---

## §3 事件 schema 与类型化治理（五层裁剪到四层，其中两层被重写）

### 3.1 裁剪结论

| 蓝图层 | LISA 决定 | 理由 |
|---|---|---|
| ①schema 单一真相源 + 声明表 | **上，但声明表的维度全换** | 见 §3.2 |
| ②端 chokepoint helper | **上，但只要 2 个而不是 3 个** | 见 §4.2 |
| ③ESLint 禁裸调 | **不适用，用 node:test 源码扫描替代** | 仓里**根本没有 ESLint**（无 `eslint.config.*`、无 `.eslintrc*`、devDeps 里没有 eslint）。为一条 lint 规则引入 ESLint + typescript-eslint 违反"8 个生产依赖"的技术偏好 |
| ④CI schema↔调用点审计 | **上，且有现成模板** | `scripts/generate-api-contract.mjs --check` 已是这个模式，`prepublishOnly` 已在跑它 |
| ⑤敏感命名测试 | **上，但 token 表整个换掉** | Luddi 防的是"金钱事件被伪造"；LISA 防的是"soul 内容外泄" |

### 3.2 第一层：声明表的维度换了（这是本方案对蓝图最实质的改写）

Luddi 的 `EVENT_EMITTERS` 是四值的，四个值全部围绕**防伪造**（谁能从 HTTP 发这个名字）。
这个威胁模型在 LISA 的本地版**不成立**：客户端就是用户自己的机器，用户往自己磁盘上的
JSONL 里塞假行，既没有收益也没有受害者。

LISA 真正需要 fail-closed 的是**另外两个**维度：**这条事件能不能出网、以什么粒度出网**，
和**这条事件在哪个 edition 里合法**。所以声明表改成：

```ts
// src/telemetry/schema.ts  （新建）

export type TelemetryEvent =
  | { name: "birth_completed"; properties: { durationMs: MsBucket; provider: ProviderFamily; tokens: TokBucket } }
  | { name: "session_started";  properties: { surface: Surface; resumed: boolean; sinceBirth: DayBucket } }
  | /* … 见 §3.4 事件表 … */;

/**
 * `"autonomous"` 是一个 Surface 值，不是一个遗漏。§7.3 的活跃口径规则
 * (`surface !== "autonomous"`) 依赖它在类型里真实存在——否则那条规则在代码里无处落地。
 */

export type TelemetryEventName = TelemetryEvent["name"];

/** 谁在发。仅用于 CI 审计定位与调试，不参与安全裁决。 */
export type Emitter = "core" | "web-ui" | "native" | "channel";

/** 能不能从 HTTP 端点进来。fail-closed 的第一个维度。 */
export type Ingress =
  | "internal"   // 只能进程内 track()；POST /api/insight/event 一律 400
  | "ingress";   // HTTP 可发（GUI / mac app / iOS）；身份字段一律服务端覆写

/** 能不能出网、以什么粒度。fail-closed 的第二个维度，也是本产品的红线。 */
export type Upload =
  | "never"      // 永不出网。只进本地 ledger
  | "counter"    // 只能作为「日 × 事件名 × 一个低基数维度」的聚合计数出网，properties 全丢
  | "event";     // 可逐条出网，properties 已是枚举/分桶/布尔

export interface EventPolicy {
  emitter: Emitter;
  ingress: Ingress;
  upload: Upload;
  editions: readonly ("mac" | "cloud")[];   // 复用 src/edition.ts 的 Edition
}

/**
 * fail-closed 的机制与蓝图 §2.1 完全相同：Record 作用在字符串字面量 union 上，
 * union 的每个成员都是必填 key。往 union 加一个事件而不在这里声明策略，
 * 这个初始化器立刻 TS2739/TS2741 编译失败。
 * 没有默认值、没有 index signature —— 「忘了声明」这个状态在类型上不存在。
 */
export const EVENT_POLICY: Readonly<Record<TelemetryEventName, EventPolicy>> = { /* … */ };

// 全部派生，没有任何手工维护的名单（蓝图 §2.1 的核心红利）
export const INGRESS_EVENTS   = names.filter((n) => EVENT_POLICY[n].ingress === "ingress");
export const UPLOADABLE_EVENTS = names.filter((n) => EVENT_POLICY[n].upload !== "never");
export const CLOUD_ONLY_EVENTS = names.filter((n) => !EVENT_POLICY[n].editions.includes("mac"));
```

**拿不准时选更严的值**（蓝图这条纪律原样保留，但方向变了）：
- `upload` 拿不准 → 选 `never`。错标成 `never` 的表现是**指标缺失（吵闹，看板一片空白，当天发现）**；
  错标成 `event` 的表现是**用户数据外泄（无声，可能永远发现不了，且不可撤回——已经发出去了）**。
- `ingress` 拿不准 → 选 `internal`。错标成 `internal` 表现为 GUI 侧一个 400；错标成 `ingress`
  在**云版**打开了一个可被 uid 伪造的口子（本地版无害，云版有害——一个用户伪造
  `free_window_exhausted` 会污染 Q7 的定价决策）。

### 3.3 properties 的类型只允许四种（这是 §3.5 测试钉死的东西）

**规则：`properties` 里不允许出现 `string` 类型。** 只允许：

| 允许 | 例 |
|---|---|
| 固定字符串枚举（低基数，全部在 schema.ts 里列举） | `Surface = "cli" \| "web" \| "island" \| "ios" \| "mac" \| "channel" \| "autonomous"` |
| `boolean` | `resumed: boolean` |
| 分桶字符串（下面五个 bucket 函数之一的返回值） | `durationMs: MsBucket` |
| 有界小整数（≤ 100，且必须在字段名上标明是计数） | `dismissCountForCategory: number` |

五个 bucket 函数住在 `src/telemetry/buckets.ts`，**全部纯函数、全部有单测**：

```ts
type MsBucket    = "<1s" | "1-5s" | "5-30s" | "30s-2m" | "2-10m" | "10-60m" | ">1h";
type CountBucket = "0" | "1" | "2-3" | "4-9" | "10-29" | "30-99" | "100+";
type TokBucket   = "<1k" | "1-5k" | "5-20k" | "20-100k" | "100k+";
type DayBucket   = "0" | "1" | "2-6" | "7-29" | "30-89" | "90+";
type RateBucket  = "0" | "1-25%" | "26-50%" | "51-75%" | "76-99%" | "100%";
```

**为什么禁 `string` 而不是"禁敏感字段"**：因为在这个产品里，**几乎任何自由文本都是敏感的**。
desire slug 会泄漏"这个人在学 Rust / 在处理离婚"（调研约束原文）；`cwd` 会泄漏雇主名；
`repo` 会泄漏未公开项目；`model` 里的自定义 preset 名会泄漏内网地址；连 `errorMessage`
都可能包含文件路径。**逐字段判断敏感性是一场必输的战争**——禁掉整个类型才是可执行的规则。

需要文本维度时的替代做法：
- 模型 → `ProviderFamily`（`"anthropic"|"openai"|"google"|"local"|"openai-compatible"|"other"`），
  取自 `src/providers/registry.ts` 的 preset 分类，**不是模型全名**（`gpt-4o` 可以，
  `my-company-internal-llama` 不行——所以只留 family）。
- desire → **序号 + 年龄分桶**，不是 slug。见 §3.4 的 `autonomy_run_recorded`。
- 错误 → 固定的错误 code 枚举，不是 message。

### 3.4 首批事件清单（36 个）

标记：**E** = emitter · **I** = ingress · **U** = upload · 版本 `[M]` = 仅 mac、`[C]` = 仅 cloud、无标 = both。

#### Q1 出生之后她活下来了吗（6 个）

| 事件 | E / I / U | properties | 回答什么 |
|---|---|---|---|
| `birth_started` `[M]` | core / internal / **counter** | `{ provider: ProviderFamily }` | birth 漏斗分母。注入点：`src/soul/birth.ts` 的 `birth()`（`:110`），不是 `runBirthCeremony`（`src/cli.ts:993`）——后者有两个调用点（`cli.ts:219` 与 `:429`），挂在 `birth()` 上才是唯一锚点 |
| `birth_completed` `[M]` | core / internal / event | `{ durationMs: MsBucket, provider: ProviderFamily, tokens: TokBucket, retried: boolean }` | 仪式完成率；失败是不是模型太慢/太贵 |
| `session_started` | core / internal / event | `{ surface: Surface, resumed: boolean, sinceBirth: DayBucket }` | **Q1 主指标的分子**；顺带给 Q8 的 surface 分布 |
| `session_ended` | core / internal / event | `{ surface: Surface, turns: CountBucket, durationMs: MsBucket, reason: "exit"\|"eof"\|"signal"\|"error"\|"timeout" }` | 会话深度；`reason:"signal"` 占比高 = Ctrl-C 逃跑 |
| `turn_completed` | core / internal / event | `{ surface: Surface, tokens: TokBucket, toolCalls: CountBucket, provider: ProviderFamily, stopReason: "end"\|"tool_use"\|"max_tokens"\|"error" }` | **发现 A 的正解**：`usage.jsonl` 按设计只覆盖计费路径，这个事件是唯一同时看得到 CLI / Web / heartbeat / idle 四条路径的 turn 级信号 |
| `install_daily_ping` | core / internal / event | `{ version: string(semver, 白名单校验), os: "darwin"\|"linux"\|"win32", nodeMajor: number, sinceBirth: DayBucket, surfaces7d: Surface[], edition: "mac"\|"cloud", homeIsDefault: boolean }` | **唯一的 DAI 锚点**；版本分布；同时是 §8.1 的地板检查依据。`homeIsDefault` 见 §7.2 |

> **`turn_completed` 的唯一正确注入点是 `src/agent.ts` 的 turn 出口**（`:307-311`，
> `cacheRead/cacheWrite/input/outputTokens` 四个累加器所在处，`stopReason` 就在下一行）。
> 不要挂在 `src/cli.ts` 的 `turn()` 上——那只覆盖 REPL，heartbeat / idle / web 都会漏。
> **`tokens` 用 `TokBucket` 而不是原始数**：turn 级原始 token 数在一台机器上按时间排列，
> 本身就是一条可用于指纹识别的时间序列。分桶把它压成 5 个值。

> `install_daily_ping` 是**唯一**允许携带 `string` 的事件（`version`），因为它必须是精确 semver
> 才能做版本分布。豁免理由写进 §3.5 的例外表，并且必须过一个 `/^\d+\.\d+\.\d+$/` 校验——
> 一个改过 `package.json` 的 fork 不能往上报里塞任意字符串。

#### Q2 自我意志在产出还是空转（3 个）

| 事件 | E / I / U | properties | 回答什么 |
|---|---|---|---|
| `autonomy_run_recorded` | core / internal / event | `{ kind: AutonomyKind, outcome: AutonomyOutcome, durationMs: MsBucket, tokens: TokBucket, toolCalls: CountBucket, desireOrdinal?: number, desireAge?: DayBucket }` | **Q2 主指标**：`done/(done+no-update)` 与每 outcome 的 token 成本 |
| `desire_inventory_snapshot` | core / internal / event | `{ open: CountBucket, actionable: CountBucket, needsUser: CountBucket, spark: CountBucket, season: CountBucket, enduring: CountBucket, closed7d: CountBucket, tampered: boolean }` | desire 列表是在演化还是在堆积；`soul.lock.json` 是否被改过 |
| `token_budget_blocked` | core / internal / event | `{ kind: AutonomyKind, budget: TokBucket }` | `LISA_IDLE_BUDGET_TOKENS` 的断路器是不是设太低 |

> **`desireOrdinal` 的设计**：调研约束明确写了 desire slug 不可外传。替代是"这条 desire 在
> 本地 desires 目录里按创建时间排序的稳定序号"（0,1,2…）+ 年龄分桶。这让"是不是永远同一条
> desire 在空转"变得可测（同一 ordinal 反复出现 no-update），而不泄漏它是什么。
> **`AutonomyKind` / `AutonomyOutcome` 直接复用 `src/autonomy/runs.ts` 的既有类型**——
> 不新造一套枚举，扩展既有 schema 比新建一套便宜（调研 keyFiles 的原话）。
>
> **实现路径**：这个事件的正确做法**不是**在 `recordAutonomyRun()` 里加一行 `track()`，
> 而是在 `src/telemetry/` 里加一个从 `runs.jsonl` 派生的采集器——因为 runs.jsonl 已经完整、
> 已经有界（`MAX_RUNS = 2000`）、已经在**八个**正确的调用点上（实测
> `grep -rn "recordAutonomyRun(" src/`：`heartbeat/runner.ts` ×4 @ `:207,249,319,348`、
> `idle/runner.ts` ×2 @ `:174,192`、`reflect.ts` ×2 @ `:261,443`）。
> **能从既有台账派生的，就不要新增调用点**：八个调用点意味着八处会各自漂移的代码，
> 而 `runs.jsonl` 是一个文件。这是 §0.2 发现 A 的正面教训——
> **信号的可信度取决于它的注入点数量，不取决于它的字段设计。**

#### Q3 REVE 卡是惊喜还是噪音（3 个）

| 事件 | E / I / U | properties | 回答什么 |
|---|---|---|---|
| `idle_message_surfaced` | core / internal / **counter** | `{ surface: Surface }` | 分母 |
| `idle_message_engaged` | web-ui,native / **ingress**（`dismissed` 除外，见下）/ event | `{ action: "opened_log"\|"replied"\|"dismissed"\|"expired", secondsToAction: MsBucket }` | **Q3 主指标**：惊喜（replied/opened）vs 噪音（dismissed/expired） |
| `idle_disabled` | core / internal / event | `{ via: "flag"\|"config"\|"ui", sinceBirth: DayBucket, priorSurfaced: CountBucket }` | 关掉 idle 的人在关之前看过几张卡——这是"忍耐阈值" |

> `idle_message_engaged` 是**第一个 `ingress` 事件**：它只有前端知道，而且前端有**三份**
> 独立的 `idle_message` 处理器（实测）：`src/web/lisa-client.ts:494`、`src/web/room.ts:1064`、
> `src/web/island.ts:1237`。三处都是各自手写的 JS 字符串模板，**三处都要挂，漏一处就是
> 一个视图的数据凭空消失**——这正是蓝图案例 B「改名后下游硬编码过滤静默漏计三周」的同一个
> 形状，只是发生在写入侧而不是读取侧。§3.6 的 CI 审计要能数出这三个注入点。
>
> **例外：`action:"dismissed"` 不走 ingress。** 岛上的"已读"走的是既有的服务端路由
> `POST /api/island/dismiss-unread`（`src/web/server.ts:2299`），在那里发 `internal` 事件即可。
> 能在服务端拿到的信号就不要开 ingress 口子——每一个 ingress 名字都是一处要维护的闸。
>
> `"expired"` 由前端在卡片超时未交互时发——这条最重要，因为**"没有动作"才是最常见的动作**，
> 而没有动作天然不产生事件，必须显式补一条。这是蓝图没覆盖的形态：
> Luddi 的 dismiss 有按钮，LISA 的"忽略"没有。

#### Q4 advisor 采纳率 vs 屏蔽率（3 个）

| 事件 | E / I / U | properties | 回答什么 |
|---|---|---|---|
| `advisor_card_surfaced` | core / internal / event | `{ category: SuggestionCategory, urgency: Urgency, actionKind?: SuggestedAction["kind"] }` | 分母，按 category |
| `advisor_card_acted` | web-ui,native / ingress / event | `{ category, actionKind }` | **Q4 分子（采纳）** |
| `advisor_card_dismissed` | core / **internal** / event | `{ category, categoryDismissals: number(≤100) }` | **Q4 分子（屏蔽）**；`categoryDismissals` 直接取 `AdvisorState.categoryDismissals[cat]` |

> 三个枚举全部复用 `src/advisor/types.ts` 的既有类型（`SuggestionCategory` **5** 值 / `Urgency` 3 值 /
> `SuggestedAction["kind"]` 6 值），一个字都不新造。**`Suggestion.text`、`Suggestion.id`、
> `SuggestedAction.label` 和 `SuggestedAction.arg` 绝不上报**——`id` 是"稳定 dedup key"、
> `arg` 的注释原文就是 *(sessionId, cwd, …)*，两者都会直接携带路径。
> 注入点：`src/advisor/engine.ts` 的 `AdvisorDecision.surface` 出口发 surfaced。
>
> **`advisor_card_dismissed` 是 `internal` 不是 `ingress`**：`POST /api/advisor/dismiss`
> （`src/web/server.ts:2366`）的请求体**已经强制带 `category`**（`:2377` 校验
> `typeof payload.category !== "string"` → 400），所以服务端在调用 `dismissSuggestion()`
> 之后自己 `track()` 就够了，不需要客户端再发一次。这既少一个 ingress 名字，
> 又天然让 GUI / island / iOS 三个客户端**共用同一个计数**——不会出现"哪个端漏挂了"。
> `advisor_card_acted` 保持 `ingress`，因为 `kind:"open"` / `"look"` 是纯客户端动作，
> 服务端看不到；`approve`/`cancel`/`dispatch` 虽然会打服务端路由，但**混着发会双计**，
> 所以统一由客户端一处发，服务端不重复。

#### Q5 observer 保真度（2 个）

| 事件 | E / I / U | properties | 回答什么 |
|---|---|---|---|
| `observer_scan_completed` `[M]` | core / internal / event | `{ observer: ObserverName, found: CountBucket, withActivity: CountBucket, nullFields: FieldName[], parseErrors: CountBucket, scanMs: MsBucket }` | **Q5 主指标**：`(found − withActivity)/found` = "识别到了但活动为空"率；`nullFields` 直接对上 `docs/OBSERVER_FIDELITY.md` 的字段可用性表 |
| `observer_enabled_changed` `[M]` | core / internal / event | `{ observer, enabled: boolean }` | 十个 observer 里有几个真的被人打开过 |

> **这个事件把 `docs/OBSERVER_FIDELITY.md` 的"验证日志"从手工表格变成了实测数据。** 那张表
> 现在只有 claude-code 一行是 ✅，codex/opencode/aider 三行是 `_pending_`——因为验证要靠人跑
> `scripts/verify-observers.ts` 然后眼看。`observer_scan_completed` 让这件事在**真实机器的
> 真实版本**上自动发生。`nullFields` 的枚举必须与那张表的**八行**一一对应
> （`docs/OBSERVER_FIDELITY.md:40-47`）：`turnCount`/`lastTools`/`filesTouched`/
> `lastCommandName`/`lastError`/`gitBranch`/`tokens`/`pendingPermission`。
> 这样"某个 CLI 升级后某列突然全空"就是一个可检测的 schema drift 信号——正是那份文档
> 结尾说的"a column going blank in the harness output is the signal"，只是自动化了。
>
> **但不能直接把 `nullFields` 当缺陷率读。** 那张表里的 `➖` 是
> *"not available **by design**（格式不暴露，inventing 它才是错的）"*——aider 没有 tool 协议、
> 不记 token，永远是空的。所以 drift 的定义是 **表里写 ✅ 而实测为空**，
> 而不是"实测为空"。这条差分要编进 `lisa telemetry report`（§7.7），不能留给看数的人心算。
>
> **`ObserverName` 是 10 个不是 5 个**（`src/integrations/` 实测）：`claude-code`、`codex`、
> `opencode`、`aider`、`github-pr`、`git`、`shell`、`takoapi`、`managed`、`pty`。
> 调研摘要写的"五个 observer"是不完整的。**但 Q5 的实际分母比 10 小得多**：默认只有
> `claude-code` 是真观测者（`managed`/`pty` 虽然默认 `enabled: true`，但一个只反射进程内
> registry、一个需要 `LISA_PTY_AGENTS=1`，静止时都是空的）。所以 `observer_enabled_changed`
> 比 `observer_scan_completed` 更早有用——**先知道有没有人打开过 codex/aider，
> 再谈它们的保真度**。如果一个 observer 的开启率是 0，它的 fidelity 是个不需要回答的问题。

#### Q6 coding plan 省钱承诺（4 个）

| 事件 | E / I / U | properties | 回答什么 |
|---|---|---|---|
| `plan_selected` `[M]` | core / internal / event | `{ plan: PlanId \| "none" }` | 有多少安装真的把 `model use plan://claude` 设上了 |
| `plan_run_attempted` `[M]` | core / internal / event | `{ plan: PlanId \| "none", outcome: PlanRunOutcome }` | **省钱承诺的第一道漏斗**：多少人一上来就卡在 CLI 没登录 |
| `plan_run_finished` `[M]` | core / internal / event | `{ plan: PlanId, outcome: "done"\|"error"\|"cancelled", durationMs: MsBucket }` | **Q6 主指标**：成功率 |
| `dispatch_agent_finished` `[M]` | core / internal / event | `{ agent: DispatchAgentKind, outcome: "done"\|"error"\|"cancelled"\|"signalled", durationMs: MsBucket }` | 对照组：走 metered key 的同类任务成功率 |

> **`PlanId` 是三个不是两个**：`src/model/plans.ts:24` 是
> `"claude" | "codex" | "copilot"`——`run_on_plan` 的 tool description 里明写了
> *"Claude Pro/Max, ChatGPT/Codex, or GitHub Copilot"*。漏掉 `copilot` 会让一整条
> 订阅路径在数据里不存在。**直接 `import type { PlanId }`，不要手抄字面量。**
>
> **`PlanRunOutcome` 是本方案新造的枚举，不是既有类型**（这一条前一稿写错了，特此更正）。
> `src/tools/run_on_plan.ts:52` 的 `PlanRunCheck` 是
> `{ ok: true; kind } | { ok: false; message: string }`——失败侧只有一个**自由文本
> `message`**，没有任何机器可读的分类；而 `src/model/plans.ts:261` 的 `planPreflight()`
> 只区分两种失败（`!available` / `loggedIn === false`）。所以必须在
> `src/telemetry/plan-outcome.ts` 里写一个**纯函数**，把 `runOnPlanTool.execute`
> （`run_on_plan.ts:105-138`）的六条 return 路径映射成六个枚举值：
>
> | 值 | 对应的 return | 源码位置 |
> |---|---|---|
> | `no_plan_selected` | `resolvePlanId()` 返回 null 且 `input.plan` 未给 | `:107-112` |
> | `unknown_plan` | `resolvePlanId()` 返回 null 且 `input.plan` 给了个无效值 | `:107-112` |
> | `cli_missing` | `planPreflight` 的 `!status.available` | `plans.ts:262` |
> | `not_logged_in` | `planPreflight` 的 `status.loggedIn === false` | `plans.ts:263` |
> | `cwd_conflict` | `activeAgentInCwd(cwd)` 命中且未 `force` | `:118-127` |
> | `launched` | `launchAgent` 成功返回 pid（`if (error) return error` 未命中） | `:129-137` |
>
> （`launchAgent` 自己也可能返回 `error`——那是 `plan_run_finished{outcome:"error"}`，
> 不是 preflight 失败，两者分开记。）
> **这个映射函数必须有单测**，且注释里指回上表——因为它是"两个类型之间的手工桥"，
> 是这份方案里最容易随 `run_on_plan.ts` 重构而静默漂移的一处。
> 蓝图 §2.1 踩坑二的教训在这里是：**「复用既有类型」是个廉价的好听话，
> 声明之前先打开那个文件看它到底是不是一个枚举。**
>
> **`DispatchAgentKind` ≠ `ObserverName`**（前一稿混用了，已更正）。前者是
> `src/tools/dispatch_agent.ts:83` 的 `DispatchInput["agent"]`——**LISA 主动 spawn 的
> 那几个 CLI**（claude / codex / opencode / aider / copilot）；后者是 `src/integrations/`
> 下**被动观测的十个目录**，包含 `git` / `shell` / `github-pr` / `takoapi` 这些
> 根本不可能被 dispatch 的东西。两个枚举有交集但语义完全不同，
> **在同一张表里混用会让"dispatch 成功率"的分母混进永远不会被 dispatch 的名字**。
>
> `task` 字段（dispatch-ledger 里的任务摘要）**绝不上报**；`cwd` 同理——
> 它是雇主名/项目名的直接泄漏，而 `run_on_plan` 的拒绝消息里就原样带着它
> （`run_on_plan.ts:121-125` 的 refusal 文本里 `${cwd}` 是明文）。

#### Q7 云版免费窗口定价（5 个，全部 `[C]` 服务端权威）

| 事件 | E / I / U | properties | 回答什么 |
|---|---|---|---|
| `free_window_opened` `[C]` | core / **internal** / event | `{ tier: QuotaTier }` | 分母。注入点：`quota.ts` 的 `liveWindow()`（`:231-237`）里**开新窗口的那个分支**（`if (!state.window || now - state.window.start >= WINDOW_MS)`）。`precheckTurn()` 的 JSDoc 原文 *"Opens/rolls the window as a side effect (the window starts at first use, Claude Code-style)"* —— 那个分支就是"窗口打开"的唯一定义 |
| `free_window_exhausted` `[C]` | core / **internal** / event | `{ tier: QuotaTier, hoursIn: MsBucket, turns: CountBucket }` | **耗尽率**；耗尽发生在窗口第几小时。注入点：`precheckTurn()` 返回 `error:"quota_exhausted"` 的分支（`quota.ts:283-285`） |
| `premium_model_blocked` `[C]` | core / **internal** / event | `{ tier: QuotaTier, reason: "premium_requires_balance" }` | premium 被挡次数。注入点：`precheckTurn()` 的 premium 分支（`quota.ts:274-278`） |
| `credit_pack_purchased` `[C]` | core / **internal** / event | `{ rail: "stripe"\|"iap", pack: "5"\|"10"\|"20", sinceExhaust: MsBucket }` | **转化率分子**；耗尽后多久买 |
| `account_created` `[C]` | core / **internal** / **counter** | `{ kind: AccountKind, verified: boolean }` | 账号来源分布 |

> **这五个事件的枚举全部从既有代码 import，不新造**（前一稿有三处编造，已更正）：
> - `QuotaTier` = `src/billing/quota.ts:198` 的 `"free" | "free-unverified" | "tier1" | "tier2"`
>   ——**不是** `"unverified"|"verified"`。`tierFor()` 的实现是
>   `acct.verified ? "free" : "free-unverified"`，把它写成 `verified` 会在
>   `FREE_WINDOW_FULL`($5) 与 `FREE_WINDOW_UNVERIFIED`($1) 两档之间对不上号。
> - `reason` 的取值来自 `PrecheckResult`（`quota.ts:256-258`），失败侧只有两个值：
>   `"quota_exhausted"` 与 `"premium_requires_balance"`。**没有** `no_paid_balance` /
>   `negative_balance` 这两个字符串——余额为负是 `debitTurn` 的并发超支，被下一次购买吸收，
>   根本不产生一个 blocked 事件。
> - `pack` 是三档不是两档，键就是 Stripe 与 IAP **共用**的那三个：
>   `STRIPE_PACKS`（`stripe.ts:36-40`：`"5"/"10"/"20"`，499¢/999¢/1999¢）与
>   `iap.ts:66-70` 的 `PRODUCTS`（`ai.meetlisa.main.credits.{5,10,20}`）。
>   **上报 pack key 而不是美元数**：面值有 +5%/+10% 加成（$10.50 / $22.00），
>   把它写成 `faceUSD` 迟早有人拿它当收入加总，而那不是收入。
> - `AccountKind` = `src/web/accounts.ts:35` 的 `"apple"|"email"|"google"`。
>
> **Q7 的一个结构性口径陷阱**：`account_created{kind}` 的四个 kind **不是四个人**。
> `EMAIL_OWNER_KINDS`（`accounts.ts:41`）让 email 与 google **共用一个 uid**——
> 同一个人先用邮箱 OTP 注册、后用 Google 登录，落到同一份余额。所以
> "Google 注册占比"这个说法是无意义的，只能说"**首次**创建该 uid 的 kind"。
> 这条要写进 `docs/TELEMETRY.md`，否则第一个做渠道归因的人一定会数错。

> **这五个全部强制 `ingress: "internal"`**，由 §3.5 的测试钉死。理由与蓝图 §2.5 完全一致：
> 名字里带 `credit` / `purchase` / `window` / `blocked` 的事件涉及**钱与配额**，一旦可从 HTTP
> 伪造，一个用户就能污染定价决策。这是 LISA 唯一真正需要蓝图那套防伪造机制的地方。
> 取数点：`src/billing/quota.ts`（窗口与 tier）、`src/billing/admission.ts`（premium 拦截）、
> `src/billing/stripe.ts` / `iap.ts`（购买）、`src/web/accounts.ts`（uid 生成）。
>
> **这五个事件不需要任何 consent**：它们是云版服务端对自己业务的观测，用户主动注册了托管服务，
> 与本地版的零遥测承诺是两件事——但**这条区分必须写进 `cloud.astro`**（那页现在写着
> "no analytics SDKs"，字面上是真的：我们不用 SDK；但"我们记录你的配额消耗事件"必须明说）。

#### Q8 哪些 surface 装了不开（5 个）

| 事件 | E / I / U | properties | 回答什么 |
|---|---|---|---|
| `surface_opened` | web-ui,native / ingress / event | `{ surface: Surface, view: View, first: boolean }` | **Q8 主指标**：`first:true` 给"曾经打开过一次"，全量给"7 天用过" |
| `cli_command_invoked` | core / internal / event | `{ command: CliCommand, ok: boolean }` | 子命令的真实使用分布 |
| `repl_slash_command` | core / internal / **counter** | `{ command: SlashCommand }` | 斜杠命令的分布 |
| `channel_message_routed` | channel / internal / **counter** | `{ channel: Channel, direction: "in"\|"out" }` | 六个 IM 渠道谁真的在用 |
| `cli_flag_used` | core / internal / **counter** | `{ flag: "model"\|"approval"\|"think"\|"idle"\|"no-reflect"\|"voice"\|"compaction"\|"no-mcp"\|"no-plugins" }` | `--model`/`--approval`/`--think`/`--idle` 的真实使用分布 |

> **`View` 是 9 个，不是 11**（实测 `grep -o 'data-view="[a-z-]*"' src/web/lisa-html.ts`，
> 全部落在 `:94-102`）：`chat`/`dashboard`/`control`/`reve`/`room`/`sense`/`memory`/`kb`/`settings`。
> 前一稿多算的两个各有各的问题：
> - **`island` 不是一个 view，是一个 Surface。** 它是独立路由 `GET /island`
>   （`server.ts:2037`）+ 原生挂件，不参与九宫格切换。它已经在 `Surface` 枚举里了，
>   写进 `View` 会让 `(surface, view)` 这一对出现 `island × island` 这种自指组合。
> - **`mail` 根本不是一个 data-view。** Mail 在 GUI 里是右栏的一张卡
>   （`lisa-html.ts:239-249`，`sbMailConnectBtn`），不是导航项。所以
>   **Mail 的使用度量不能靠 `surface_opened`**，只能靠两条既有路径：
>   CLI 侧 `cli_command_invoked{command:"mail"}`，GUI 侧 `/api/mail/{digest,sweep}` 的
>   请求计数。这一条要显式写进 `docs/TELEMETRY.md` 的口径节——否则"Mail 打开率为 0"
>   会被读成"没人用 Mail"，而真相是"我们没在那里埋点"。
>
> **注入点只有一个**：`showView(name)` @ `src/web/lisa-client.ts:3224`
> （按钮事件委托在 `:3238`）。不要逐按钮挂——那是九处会各自漂移的代码。
>
> `CliCommand` = `src/cli-args.ts:22-46` 的 `ParsedArgs["subcommand"]` union（25 个成员）
> \+ `telemetry`（新增）+ `repl`（无子命令时的裸调用）。
> **直接 `NonNullable<ParsedArgs["subcommand"]> | "telemetry" | "repl"` 派生，不手抄**——
> 手抄的名单会漂移，`cli-args.ts` 加一个子命令时 `Record<CliCommand, …>` 应该编译失败。
>
> **`SlashCommand` 有一个自由文本陷阱**：`onSlash` 处理器（`src/cli.ts:855`）在匹配完
> 十一个内建名（`exit`/`quit`/`help`/`skills`/`memory`/`sessions`/`search`/`reflect`/
> `think`/`clear`/`save`）之后，会去遍历 `plugins` 的 `p.commands` ——**插件的斜杠命令名
> 是用户自己起的任意字符串**（`~/.lisa/plugins/<name>/commands/`）。直接把 `cmd` 塞进
> properties 就违反了 §3.3 的禁 `string` 规则，而且插件名很可能就是项目名/公司名。
> **规则：内建名照常上报，插件命中统一折叠成字面量 `"plugin"`**，未匹配到的折叠成 `"unknown"`。
> 这一条要有单测（喂一个名为 `deploy-acme-prod` 的假插件命令，断言上报的是 `"plugin"`）。
>
> `cli_flag_used` 只能是 `counter`：`--model` 的**值**是敏感的（自定义 preset 名可能是内网地址），
> 所以只记"用了这个 flag"，不记值。想知道模型分布，看 `install_daily_ping` 里没有——
> **这是一个刻意的缺口**，模型分布只能通过 `birth_completed` / `turn_completed` /
> `autonomy_run_recorded` 的 `ProviderFamily` 粗粒度得到。

#### Q9 consent 是保护还是死功能（3 个）

| 事件 | E / I / U | properties | 回答什么 |
|---|---|---|---|
| `consent_prompt_shown` | core,web-ui / ingress / **counter** | `{ signal: ConsentSignal, context: "cli"\|"web"\|"first_use" }` | 授权率的分母（被问过的人） |
| `consent_changed` | core / internal / event | `{ signal, granted: boolean, sinceBirth: DayBucket, priorGrants: CountBucket }` | **Q9 主指标**：授权率 + 授权后撤销率 |
| `sense_signal_captured` `[M]` | core / internal / **counter** | `{ signal }` | 授权之后是不是真的在用——**授权了但零捕获 = 比不授权更糟的信号** |

> `ConsentSignal` 的 6 个值 = `src/consent/store.ts` 的 `SENSE_SIGNALS`（screen/voice/clipboard/
> selection/mail）+ 新增的 `telemetry`（§9.2）。**注意 `ConsentSignal` 在源码里是
> `| (string & {})` 开放类型**——打点用的枚举必须收窄成闭集，否则一个自定义 signal 名就是
> 一个自由文本字段。这是 §3.5 测试要覆盖的一条。

#### 自监控（2 个）

| 事件 | E / I / U | properties | 回答什么 |
|---|---|---|---|
| `telemetry_sink_failed` | core / internal / **never** | `{ sink: "ledger"\|"upload", code: "enospc"\|"eacces"\|"emfile"\|"network"\|"http_4xx"\|"http_5xx"\|"timeout"\|"other" }` | 蓝图 §7.2 在本地的对应物（§8.2） |
| `telemetry_batch_sent` | core / internal / event | `{ count: CountBucket, ledgerLines: CountBucket, seq: number }` | 蓝图 §7.3 对账在本地的对应物（§8.3） |

> `telemetry_sink_failed` 是 `upload: "never"` 的——**上报失败的事件不能靠上报来报告**，
> 那是循环。它只进本地 ledger，由 `lisa doctor` 和 `lisa telemetry status` 呈现。

**合计 36 个**（Q1 六 · Q2 三 · Q3 三 · Q4 三 · Q5 二 · Q6 四 · Q7 五 · Q8 五 · Q9 三 · 自监控二）。
其中 `upload: "never"` 1 个、`ingress` 4 个（`surface_opened`、`advisor_card_acted`、
`idle_message_engaged` 的非 `dismissed` 分支、`consent_prompt_shown`）；`[C]` 5 个。

> **本文对蓝图 §2.6 的自我审计。** 蓝图的规则是"文档里不出现集合大小"，
> 而本节和 §3.4 的各处 `(N)` 标注**违反了它**——并且已经付出代价：前一稿写的
> `View(11)`、`CliCommand(25)`、"35 个"三个数字里有两个是错的，正是因为它们是手抄的。
> 本节保留一处设计期总数（**给 review 用的规模感**，蓝图允许"回归测试里 pin 死的数字"，
> 这是同类豁免），但**所有枚举的 `(N)` 标注已从 §3.4 的表格里删掉**，
> 改为在正文里指向源码位置。运行期唯一权威是
> `scripts/check-telemetry-events.mjs --counts`。**这个数字一旦与脚本不符，改文档，不改脚本。**

### 3.5 第五层：敏感命名测试（token 表整个换掉）

`src/telemetry/schema.test.ts`（走已有的 `npm test` = `node --import tsx --test`）：

```ts
// 1) 类型层面：properties 里不得出现 string（§3.3）——用 AST 扫 schema.ts 的 union，
//    任何 `: string` 除非字段名在 FREE_TEXT_EXEMPTIONS 里逐条书面豁免
const FREE_TEXT_EXEMPTIONS = {
  "install_daily_ping.version":
    "semver 必须精确才能做版本分布；已加 /^\\d+\\.\\d+\\.\\d+$/ 白名单校验，" +
    "fork 改过 package.json 也塞不进任意串。批准：<人名> 2026-08-21",
};

// 2) 名称层面：按下划线分词（不是 substring —— 蓝图 §2.5 踩坑：
//    naive 的 includes("ban") 会误伤 studio_warn_banner_shown）
const SOUL_TOKENS = ["desire","journal","opinion","relationship","identity","purpose",
                     "constitution","value","emotion","memory","reflection"];
const CONTENT_TOKENS = ["text","content","prompt","message","body","snippet","title",
                        "slug","name","path","cwd","repo","url","email","host","file"];
// 规则：事件名或任一属性名的分词命中以上任一 token → upload 必须是 "never"
//       （或在 UPLOAD_EXEMPTIONS 里逐条写理由）

// 3) 钱/配额事件必须 internal（蓝图 §2.5 的直接移植，这是 LISA 唯一保留它的地方）
const MONEY_TOKENS = ["credit","purchase","balance","quota","window","blocked","premium",
                      "paid","refund","stripe","iap"];
// 规则：命中 → ingress 必须是 "internal"

// 4) 声明表本身钉死：只允许三个 upload 值 / 两个 ingress 值；
//    派生集合等价性（UPLOADABLE ∪ never == 全量，交集为空）；
//    §3.4 里那五个 [C] 事件永不进 INGRESS_EVENTS（回归护栏，pin 死名字）
```

**为什么 token 表是这几个词**：Luddi 的 `payment/credits/refund/admin/moderation/revenue` 防的是
"金钱指标被伪造"。LISA 的第一威胁是 **soul 内容外泄**——`SOUL_TOKENS` 直接对上
`src/soul/store.ts` 管理的目录名（`identity.md`/`purpose.md`/`values/`/`opinions/`/`desires/`/
`journal/`/`relationships/`/`emotions.json`）。第二威胁是**用户环境泄漏**（`CONTENT_TOKENS`）。
第三威胁才是 Luddi 那个（`MONEY_TOKENS`），且只在云版成立。

### 3.6 第四层：CI 审计（有现成模板）

`scripts/check-telemetry-events.mjs`，**与 `scripts/generate-api-contract.mjs` 同一个模式**
（该脚本已支持 `--check` 且已挂在 `prepublishOnly` 上）：

```jsonc
// package.json scripts 新增
"check:telemetry": "node scripts/check-telemetry-events.mjs --check",
"prepublishOnly": "npm run check:api-contract && npm run check:telemetry && npm run typecheck && npm test && npm run build && …"
```

三个 diff：
1. **missing**：代码在 `track("x", …)`、schema 里没有 → **exit 1**
2. **unused**：schema 有、全仓没人发 → 打印；`--strict` 下 exit 1
3. **文档漂移**（LISA 专属，见 §8.5）：`UPLOADABLE_EVENTS` ≠ `docs/TELEMETRY.md` 的表格
   ≠ `website/src/pages/privacy.astro` 的清单 → **exit 1**

**验收方法（蓝图两次强调，照抄）**：写完脚本的**同一个 PR** 里挂进 `prepublishOnly` 和
`.github/workflows/ci.yml`（**那个文件已经在跑 `check:api-contract` / `typecheck` / `test`
三步，加第四步是一行**，不需要新建 workflow），然后**故意加一个未声明的 `track("nope", {})`，
确认 CI 真的红**。
Luddi 的教训是这个脚本存在了几个月、文档写着 "also runs in CI"、而实际上从没接进任何
workflow——**一条没人验证过的防线比没有防线更危险，因为它让人停止担心**。

> **这个仓里已经有一件同形状的标本，别装看不见**：`scripts/star-history.sh` 存在、写得很好、
> 头注释写着 *"Designed to be run from cron / launchd / GitHub Actions"*，
> 而 `docs/star-history.csv` 里**只有一行**（`2026-05-09T17:33:49Z,2,1,1,0,…`）。
> 也就是说它从来没有被真正定时跑过，`docs/GROWTH.md` 的"10k stars"目标至今没有时间序列支撑。
> **写脚本和挂调度是两件事，只做前者等于没做**——这条同时约束 §6.2 的 L2 代理指标。

### 3.7 第三层的替代物：源码扫描测试（因为没有 ESLint）

仓里没有 ESLint（实测：无 `eslint.config.*`、无 `.eslintrc*`、devDependencies 里没有 eslint）。
为一条规则引入 ESLint + `@typescript-eslint/parser` 与"8 个生产依赖 / 手写一切"的技术偏好冲突。

替代：`src/telemetry/guard.test.ts` 用 `node:fs` 遍历 `src/`，正则找三种违规：

| 违规 | 正则形状 | 豁免文件 |
|---|---|---|
| 绕过 `track()` 直接写 ledger | `appendLine\(.*telemetry` | `src/telemetry/ledger.ts` |
| 绕过 upload sink 直接出网 | `fetch\(.*LISA_TELEMETRY_UPLOAD_URL` | `src/telemetry/upload.ts` |
| 引入任何第三方 analytics 包 | `from ["']((posthog\|mixpanel\|amplitude\|@segment\|@sentry\|@opentelemetry)[^"']*)["']` | 无（**全仓禁**） |

第三条是 LISA 专属的、也是最重要的一条：它把"零第三方 SDK"这个**产品承诺**变成了一条
**会红的测试**。今天全仓 grep 这些名字是零命中（调研实测）——这条测试的作用是让它**保持**零命中。

**蓝图 §2.3 那个"规则一次都没真正执行过而 CI 是绿的"的踩坑**，在这里的等价形态是
**"扫描的正则从来没匹配到任何东西，也是绿的"**。验收方法照抄：**故意写一个违规调用，
确认测试变红**，然后删掉。

---

## §4 数据入口

### 4.1 chokepoint 在哪

蓝图的入口是一个 HTTP 端点（`POST /api/telemetry/event`），因为 Luddi 的客户端全在别人机器上。
LISA 的**主入口是一个函数调用**，因为 90% 的事件产生在同一个 Node 进程里：

```
                        ┌─────────────────────────────────────────┐
 src/cli.ts             │                                         │
 src/agent.ts           │   track(name, props): void               │
 src/heartbeat/runner.ts├──▶  src/telemetry/track.ts               │
 src/idle/runner.ts     │   （同步签名 / 返回 void / 永不 throw）    │
 src/reflect.ts         │                                         │
 src/channels/router.ts │              │                          │
 src/billing/*.ts [C]   │              ▼                          │
                        │   有界内存 buffer（500，溢出丢最旧）       │
 ────────────────────── │              │ 250ms unref'd timer      │
 Web GUI (lisa-client)  │              ▼                          │
 mac app (Swift)   ─────┼──▶ POST /api/insight/event ──▶ 同一个     │
 iOS Pocket (Swift)     │    （ingress 闸 · §4.3）      buffer     │
                        └─────────────────────────────────────────┘
                                       │
                                       ▼
                          Sink A: ~/.lisa/telemetry/events.jsonl
                                       │ （consent granted 时，每 6h）
                                       ▼
                          Sink B: POST $LISA_TELEMETRY_UPLOAD_URL
```

### 4.2 只需要两个 chokepoint，不是三个（对蓝图 §2.2 的裁剪）

蓝图要求 web/mobile/server 各一个 helper。LISA 只需要 **Node 一个 + 浏览器一个**：

| 端 | chokepoint | 为什么 |
|---|---|---|
| Node（CLI / web server / heartbeat / channels / billing） | `src/telemetry/track.ts` | 全部在一个进程 |
| Web GUI | `src/web/lisa-client.ts` 里一个 `lisaTrack()` 函数 | 服务端渲染的手写 JS，无框架。**注意它有三个兄弟**：`room.ts`、`island.ts` 也各自内联了一份 JS（三处都有 `idle_message` 处理器），它们必须复用同一个 `lisaTrack`，不能各写一份 |
| **macOS app（Swift）** | **不建** | 它已经通过 HTTP 跟本地 Node 服务讲话（`BackendController.swift`），让它 POST `/api/insight/event` |
| **iOS Pocket（Swift）** | **不建** | 同上（`LisaClient.swift`） |

**Swift 两端不建 sink 是一条有分量的决定**，三条理由：

1. **iOS 隐私标签不用动（或只需最小改动）**。数据从 iPhone 走到用户自己的 Mac，
   再由 Mac 决定是否上报。App 本身没有新增出网目的地、没有新增标识符。
   （**但这条要 ASC 确认**——见 §0.3 待确认 #6。我的判断是仍需声明 "Product Interaction"，
   因为 Apple 看的是"数据是否离开设备"，而不是"去了哪台服务器"。**不要当既成事实**。）
2. **Swift 侧零埋点代码 = 零 Swift 侧漂移**。两个 Swift 客户端加起来的埋点维护成本本来会是
   整个方案里最贵的部分（两套编译、两套发版节奏、TestFlight 审核延迟）。
3. **`ingress` 闸只需要实现一次**。

**代价**：mac app 在 backend 没起来时产生的事件（比如"用户点了菜单栏图标但服务没启动"）
**丢失**。这恰好是一个我们想知道的事件（安装失败率）。**接受这个盲区**，替代观测是
`Updater.swift` 已有的 GitHub Releases 请求（L2 代理指标）。

**浏览器 chokepoint 的一条必做规则（蓝图 §2.2 踩坑，照抄）**：`lisaTrack()` 必须在
**本地**先用 `INGRESS_EVENTS` 挡掉 `internal` 名字，而不是发出去等服务端回 400。
理由和 Luddi 一样（白吃一个 400 + 污染错误日志），在 LISA 还多一条：
`lisa serve` 的错误日志是 `lisa doctor` 的输入之一，用打点自己的 400 去污染诊断输出
是很蠢的自伤。这个白名单由服务端渲染时注入到页面（`lisa-html.ts` 里一个
`<script>window.__LISA_INGRESS=[…]</script>`），**从 `EVENT_POLICY` 派生，不手写**。

### 4.3 `POST /api/insight/event` 的协议

**唯一的 HTTP 入口**，注册在 `src/web/server.ts` 的路由分发里，走 `isRequestAuthorized`
（`server.ts:256`）——即：默认只有回环，非回环必须带 `LISA_WEB_TOKEN` 或设备 token。

```jsonc
// 请求
POST /api/insight/event
Content-Type: application/json
{
  "events": [
    { "name": "surface_opened", "properties": { "surface": "web", "view": "room", "first": true },
      "occurredAt": "2026-08-21T09:14:02.117Z" }
  ]
}
// 响应：204 No Content（永远，除非整批被拒 → 400）
```

六条闸，全部照蓝图 §3 但参数按 LISA 调过：

| 闸 | LISA 的值 | 与 Luddi 的差异与理由 |
|---|---|---|
| batch 上限 | **20** | Luddi 是 50（= 客户端阈值 20 的 2.5 倍）。GUI 侧不批量（用户交互本来就稀疏），20 足够 |
| legacy 单事件体 sniff | **要** | mac app / iOS 会被 TestFlight 卡住好几个版本；**入口协议只能加不能破** |
| allowlist | `INGRESS_EVENTS`（**从声明表推导，无手工名单**） | 机制与蓝图完全一致。混合批里非法名字**静默丢弃**、合法的照收并 204 |
| 时钟窗口 | **`[now − 35d, now + 60s]`** | **Luddi 是 24h，这里必须放大**——见 §4.4 |
| 限流 | **60 次/分/连接** | 防的不是攻击者（入口只绑回环），是**我们自己写出来的 setInterval bug**。`lisa-client.ts` 是 4002 行手写 JS（实测 `wc -l`），一个 render loop 里的 track 能在一分钟里打几千条 |
| properties 大小 | **4 KB 序列化后，超限拒收这一条，且真的实现 + 写测试** | 蓝图 §3.5 记录了 Luddi 的注释声称 32 KB 但**代码里从未实现**。4 KB 而不是 32 KB：§3.3 已禁自由文本，正常事件 < 300 B，4 KB 已经是 10 倍余量 |

**身份字段一律服务端覆写**：请求体里的任何 `installId` / `uid` / `deviceId` **直接丢弃**，
由服务端从 `scopedUid()` 和本地 seed 填。客户端自报身份在云版是伪造口子，在本地版是噪音源。

### 4.4 时钟窗口为什么是 35 天而不是 24 小时（对蓝图 §3.3 的实质偏离）

蓝图的规则：客户端自报 `ts` 只在 `[now − 24h, now + 60s]` 内被采信，窗口外**丢弃 ts、用服务端
到达时间**（不是 clamp 到边界）。理由是 >24h 的"迟到"更可能是设备时钟坏了。

**在 LISA 这条会毁掉留存口径。** 差异来自形态：

| | Luddi 移动端 | LISA |
|---|---|---|
| 最长离线 | 几天（手机总会连上） | **数周**——笔记本合盖、出差、断网开发、强代理环境（整个 `undici-proxy-env` 包就是为此存在） |
| 本地缓冲 | 磁盘 outbox 200 条 | ledger **3000 行 / 30 天** |
| upload 节拍 | 20 条 / 10s | **6 小时一批** |

一台断网两周的机器重新联网时，会一次性交出两周的事件。用 24h 窗口 = 这些行全部被重打成
"送达日"，D7 留存、cohort 归属、`sinceBirth` 分桶**全部作废**——而这恰好是 Q1 的核心口径。

**替代规则（三条，必须一起用）**：

1. **`occurredAt` 与 `receivedAt` 双字段并存**，两个都落库，永不互相覆盖。
2. **所有留存 / cohort / DAI / 漏斗用 `occurredAt`；所有管线健康检查（§8）用 `receivedAt`。**
   这条要写进口径视图（§7.5），不能只写在 prose 里。
3. `occurredAt` 落在 `[receivedAt − 35d, receivedAt + 60s]` 之外 → **丢弃 `occurredAt`，
   并打一条 `telemetry_clock_skew` 到本地 ledger**（不是丢弃整条事件）。35d = ledger 保留期
   30d + 5 天余量：ledger 里存在的行，其 `occurredAt` 不可能比 35 天更老，更老的必然是坏时钟。

**代价写进口径文档**：坏时钟的机器上，那些行的 `occurredAt` 变成送达日，日桶会有一个尖峰。
这是"坏时钟 vs 真延迟"的取舍，我们选了偏向真延迟——因为在这个产品里真延迟远比坏时钟常见。

---

## §5 身份模型

### 5.1 本地版没有"用户"——锚点是 install，且必须从 `randomness` 派生

调研的关键结论原样成立：**本地版根本没有用户这个概念**。所以：

```ts
// src/telemetry/identity.ts（新建）
// installId = 从 birth seed 的 32 字节真随机派生，截断到 32 hex。
export function installId(seed: SoulSeed): string {
  return crypto.createHash("sha256")
    .update("lisa-install-v1:" + seed.randomness)
    .digest("hex").slice(0, 32);
}
```

**红线：绝对不能用 `bornOn`。**

`src/soul/birth.ts` 的 `generateSeed()`：

```ts
const hostHash = crypto.createHash("sha256")
  .update(hostname + os.userInfo().username).digest("hex");
```

`bornOn` 看起来像一个完美的匿名安装锚点（稳定、已存在、是个哈希）。**它不是。**
`hostname + username` 的取值空间小到可以离线穷举：`Marks-MacBook-Pro.local` + `mark`、
`MacBook-Air.lan` + `alice`……几百万个候选就能覆盖绝大多数真人。上报 `bornOn` 等于
**上报用户名和机器名**，只是加了一层不起作用的糖衣。

`seed.randomness` 是 `crypto.randomBytes(32).toString("hex")` —— 真随机、不可反推。
**再加一层带域分隔符的哈希**（`"lisa-install-v1:"`）而不是直接用 randomness，
是为了让 `installId` 与 soul seed 单向解耦：拿到 installId 推不回 seed，
所以 installId 泄漏不会威胁到 soul 的完整性校验（`soul.lock.json`）。

**为什么不新铸一个 UUID**（蓝图 §4.1 的做法）：产品对外承诺 "no account of any kind"
（`index.astro:103`）。在 `~/.lisa/` 里新增一个持久化的 `anon-id` 文件，本身就是一个
**可被 grep 出来、可被截图、可被写成推文**的标识符。从既有的 birth 产物派生，
不新增任何磁盘上的标识符——这是同样的功能、少一个攻击面。

### 5.2 `installId` 只在 upload sink 出现，本地 ledger 里没有

本地 ledger 不写 `installId`。理由很简单：**本地台账不需要认自己是谁**，
一台机器上的一个文件本来就只属于一台机器。写进去只是给"如果这个文件被别人拿到"
增加一点信息量。

### 5.3 云版：uid 权威，`installId` 一律不带

```ts
// upload 时的身份解析
const uid = scopedUid();               // src/paths.ts
if (uid) return { uid };               // 云版：uid 权威，不带 installId
return { installId: installId(seed) }; // 本地版：installId
```

**两者互斥，永不同时出现。** 而且——

### 5.4 **刻意不建身份桥**（对蓝图 §4.3 的整节否决）

蓝图要求注册时写一张 `(anonId, userId)` 桥表，用途是"历史匿名事件回溯归属 / 注册来源分析 /
跨端缝合"。

**LISA 不建这张桥。** 建桥 = 把"这台机器"和"这个邮箱"关联起来。
`privacy.astro` 写着 "no account of any kind" 是针对本地版的；一旦有一张表把
本地 installId 和云版 uid 连起来，那句话就不再是真的了——**而且是以最难辩解的方式不真**。

**代价必须记为永久盲区**：
- 本地版用户何时/是否变成云版用户，**永久不可观测**。
- 云版转化漏斗只有从 `account_created` 往后的那一半。
- 上游只能靠定性方法（问卷、GitHub issue、Discord 里问）。

**这条必须写进口径文档并标"不要事后顺手补上"** —— 因为这是一个"加两行代码就能大幅提升
数据能力"的诱惑，而它的代价是产品定位。半年后的某个人不会记得这是刻意的。

### 5.5 多租户：复用 `homeScope`，不另起一套

调研约束原文："`/events` 曾经因为进程级广播把一个账号的 idle-message 文本泄漏给所有登录用户，
修法是 `event-bus.ts` 的 `sameTenant`。埋点写入必须在正确的 home scope 内发生。"

三条硬规则：

1. **`src/telemetry/ledger.ts` 必须 `import { lisaHome } from "../paths.js"`**，
   不得像 `consent/store.ts` / `sense/log.ts` / `dispatch-ledger.ts` 那样自己定义一个
   （§0.2 发现 B）。写路径是 `path.join(lisaHome(), "telemetry", "events.jsonl")`，
   在云版自动落到 `~/.lisa/users/<uid>/telemetry/`。
2. **`track()` 必须在请求的 home scope 内被调用**。`homeScope` 是 AsyncLocalStorage，
   跨 `await` 是自动传播的；但 `setTimeout`/`setInterval`/`EventEmitter` 回调里
   **可能已经出了 scope**。所以：`track()` 在**推入 buffer 的那一刻**就调用 `scopedUid()`
   把 uid 钉在事件上，落盘 timer 只是搬运，不再解析身份。
   **这是最容易写错的一行**——落盘时才解析 scope，等于把所有租户的事件都写进 timer
   碰巧所在的那个 home。这就是 `event-bus` 泄漏的同一个形状。
3. **buffer 按 home 分桶**：内存 buffer 的 key 是 `lisaHome()` 的路径，不是一个全局数组。
   否则一次 flush 会把 A 的事件写进 B 的文件。

单测必须覆盖："在两个不同的 `homeScope.run()` 里各 track 一条，flush 后两个文件各一行，
且互不含对方的行。" —— 这是 `sameTenant` 那条规则在打点管线里的对应测试。

---

## §6 存储与 sink 选型

### 6.1 Sink A：本地 ledger（照抄 `meter.ts` 的纪律，一个字不改）

```
~/.lisa/telemetry/events.jsonl     ← 事件（append-only）
~/.lisa/telemetry/events.lock      ← 跨进程 trim 锁（src/soul/lock.ts）
~/.lisa/telemetry/upload-state.json ← 上次上报的行号 + batchSeq（仅 opt-in 时存在）
```

| 属性 | 值 | 对齐哪个既有台账 |
|---|---|---|
| 写入原语 | `appendLine` / `atomicWrite`（`src/fs-utils.ts`）+ `withFileLock`（`src/soul/lock.ts`） | 三份台账全都用这套 |
| 行数上限 | **3000** | runs.jsonl 2000 / usage.jsonl 5000 之间 |
| 保留期 | **30 天** | sense/events.jsonl 是 7 天 + 1000 条的**双重界**，这里同构 |
| trim | 机会式，跨进程锁下做，失败静默 | `runs.ts` 的 `recordAutonomyRun` |
| 写失败 | `console.error` 一行 + 打 `telemetry_sink_failed`，**绝不 throw** | `meter.ts` 的 ENOSPC 处理 |
| 体积上限 | ~600 KB | 3000 × ~200 B |

**双重界必须都有**：只有行数上限 → 一台闲置机器上 30 天前的事件永远不过期；
只有保留期 → 一台狂跑 heartbeat 的机器一天就能写几万行。sense/log.ts 已经踩明白了这一点。

### 6.2 Sink C（先做）：L2 代理指标——零代码、零隐私成本、Phase 0 就能有

**这一层蓝图里完全没有**，因为 Luddi 的服务端本来就有全量数据。对 LISA 它是
**Phase 0 唯一能拿到全体安装信号的东西**：

| 源 | 拿得到 | 怎么拿 | 局限 |
|---|---|---|---|
| npm registry | `@oratis/lisa` 日/周下载、**按版本**下载 | `api.npmjs.org/downloads/point/{period}/@oratis/lisa` + `/versions` | 下载 ≠ 安装 ≠ birth；CI 镜像会灌水 |
| GitHub Releases | DMG / 各资产的 `download_count` | `api.github.com/repos/oratis/LISA/releases`（Updater.swift 已经在打这个域） | 累计值，不是时序——**必须自己每天快照存差分**，GitHub 不给历史 |
| GitHub stars / forks / traffic | star 时序、clone 数、referrer | **`scripts/star-history.sh` 已经写好了**（`REPO`/`OUT` 可覆盖，无需 auth，append 到 `docs/star-history.csv`：`timestamp,stars,forks,watchers,open_issues,last_push`）。**要做的是给它加调度 + 补 `/traffic/*` 两列**（traffic 只保留 14 天，**必须每天抓**，且 traffic API 需要 repo push 权限的 token，与其余几项不同） | GROWTH.md 的 10k star 目标的唯一真实计量 |
| Cloudflare Pages（meetlisa.ai） | 请求量、路径分布、地区、referrer | CF 控制台自带日志，**无需在页面加任何脚本** | 不是 SDK、不加 cookie——完全不违反 `WEBSITE_OPS.md` 的自托管字体那条纪律 |
| App Store Connect | TestFlight 安装、崩溃、留存 | ASC 自带 | 只覆盖 iOS |
| Homebrew tap | 待确认（§0.3 #5） | — | 第三方 tap 的可见性受限 |

**这一层的落地方式**：一个每天跑的 GitHub Actions（`.github/workflows/` 里已有 6 个先例），
把快照 append 到仓内 CSV。**成本零、隐私成本零、今天就能开工**——
而且它是 §8.1 "ingestion floor" 在没有服务端时的**唯一**替代物。

> **别把这条写成"新建一个脚本"。** 实测：`scripts/star-history.sh` 已经存在且完整，
> `docs/star-history.csv` 也已存在——**但里面只有 2026-05-09 的一行**。
> 这个脚本从写好那天起就没有被调度过，所以 GROWTH.md 的 star 目标至今没有任何时间序列。
> Phase 0 在这一项上要交付的**不是代码，是一个 `schedule: cron` 块**——
> 这正是蓝图 §2.4 那条"脚本存在了几个月但从没接进 CI"在本仓的现成标本，
> 而且它已经**发生**了，不是一个假设的风险。
> **验收：连续三天后 `docs/star-history.csv` 有三行新增，且行数与日期一一对应。**

**必须提前承认的不对称**（调研约束原文）：这层拿不到 web 那种全量漏斗。
`npm download → 实际安装 → 完成 birth → 第二次会话` 这四个数**每一级差一个数量级**，
而我们只能直接观测第一级和（opt-in 之后的）后两级。中间那一级永远是估算。

### 6.3 Sink B：opt-in upload（Phase 2），选型与成本

**形态锁死**：手写的、批量的、可选的 HTTPS POST。**不引入任何 SDK。**
`posthog-node` / `@segment/analytics-node` / OTel SDK 与"8 个生产依赖 / 裸 REST 打 Firestore /
一个 form POST 打 Turnstile"的代码风格根本不兼容，也会显著抬高 Cloud Run 冷启动。

三个候选：

| 候选 | 优点 | 缺点 | 判断 |
|---|---|---|---|
| **Cloudflare Worker + Analytics Engine** | 官网已在 CF Pages，账号已有；AE 免费额度大；与 Cloud Run 完全解耦（云版挂了不影响本地版上报，反之亦然）；天然不落 prompt；边缘延迟低 | 新增一个部署单元；AE 的查询是 SQL API 不是仓 | **倾向这个** |
| 现有 Cloud Run 加 `/api/insight/ingest` | 零新增基础设施；复用现有鉴权与 Firestore | **把本地版的匿名上报和云版的登录态服务放进同一个进程**——一次配置错误就可能让两者互相污染；且云版实例的冷启动会拖慢上报（虽然上报不阻塞，但会拉长 6h 批次的尾部） | 备选 |
| 第三方托管 | 最省事 | **直接违反 privacy.astro 的 "no third-party tracking SDKs"** | **排除** |

**成本估算**（按 §0.4 的假设：200 个 opt-in 安装 × 30 可上报事件/天）：

| 项 | 量 | CF 免费额度 | 结论 |
|---|---|---|---|
| Analytics Engine data points | 6k/天 ≈ **18 万/月** | 千万级/月 | 远在额度内 |
| Worker 请求 | 200 安装 × 4 批/天 = **800 req/天** | 10 万 req/天 | 远在额度内 |
| 出网带宽 | 每批 ~30 KB × 800 = **24 MB/天** | — | 可忽略 |

**即使 opt-in 安装涨到 10,000（50 倍），仍在免费额度内。**
所以护栏（§8.6）不是为正常量设的，是为**失控循环**设的——和蓝图 §7.6 一模一样的结论，
只是量级小两个数量级。具体护栏：Worker 侧按 installId 每天 1000 事件硬上限，
超出直接 204 丢弃并记一条服务端日志。

**保留期：180 天**（不是蓝图的 730 天）。理由不是技术的，是政治的：
在一个"零遥测"定位的产品的隐私政策里，"我们保留两年"这句话写不出来。
180 天够做半年趋势和一次版本间对比，这就够回答 §1 的九个问题了。

---

## §7 口径规则：LISA 最容易数错的七件事

蓝图 §6 的核心思想（"让最省事的查询恰好就是正确的查询"）完全成立，但**具体的坑全换了**。

### 7.1 身份单位对照表（本地版没有 userId）

| 报表类型 | 本地版单位 | 云版单位 | 禁止 |
|---|---|---|---|
| 留存 / cohort / DAI / MAI | `COUNT(DISTINCT installId)` | `COUNT(DISTINCT uid)` | `COUNT(*)`、`COUNT(DISTINCT sessionId)` |
| 漏斗 | 同上 | 同上 | 同上 |
| 动作总量 | `COUNT(*)`，且**报表上必须显式标注"这是事件行数，不是安装数"** | 同 | 把它叫"活跃度" |

**红线：`installId` 计数与 `uid` 计数永不相加。** 一个人可能本地一台机器 + 云版一个账号，
相加就是把一个人数成两个。且因为 §5.4 刻意不建桥，我们**无法**去重——所以规则只能是
"两个数字并列展示，永不求和"。

### 7.2 `LISA_HOME` 会把一个人切成多个 install

`~/.lisa` 的位置由 `LISA_HOME` 决定（`src/paths.ts`）。一个开发者跑 `LISA_HOME=/tmp/t1 lisa`
测试就会 birth 出一个新 seed = 一个新 `installId`。**LISA 的目标用户恰好是最会这么干的那批人**
（HN / r/ClaudeAI）。

后果：install 数虚高、留存虚低（测试用的 home 永远不会有第二次会话）。

**缓解（不是解决）**：`install_daily_ping` 带一个 `homeIsDefault: boolean`
（`lisaGlobalHome() === path.join(os.homedir(), ".lisa")`）。所有留存口径**默认加
`WHERE homeIsDefault = true`**，并把这条编进视图（§7.5）。这不能覆盖"改了 HOME 但真在用"
的情况，但能砍掉绝大部分测试噪音。

### 7.3 heartbeat / idle 产生的 turn **不是**"用户活跃"

这是 LISA 独有的、也是最危险的口径陷阱：**这个产品会在没人的时候自己动**。
`launchd` 每小时触发一次 heartbeat，每次都会产生 LLM 调用、会写 `runs.jsonl`、
（在 web 驱动的 autonomy-sweep 路径下）会写 `usage.jsonl`。

如果把"有 LLM 调用的天"算作活跃天，**每一台装了 heartbeat 的机器都是 100% 日活**，
包括那些主人三个月没碰过的。这会让 Q1 的留存指标变成一条完美的直线，
而那条直线**完全是假的**。

**规则**：
- 活跃 = **`session_started` 且 `surface != autonomous`**。`autonomy_run_recorded` 永不计入活跃。
- 需要"她自己在动"的口径时，明确叫 **autonomous activity**，与 human activity 并列展示，永不合并。
- `install_daily_ping` 本身也**不是**活跃证据（它是进程存活证据）。

### 7.4 三个 token 台账的覆盖面各不相同，**永远不许相加**（§0.2 发现 A 的口径后果）

| 台账 | 覆盖 | 不覆盖 | 语义 |
|---|---|---|---|
| `usage.jsonl` | Web GUI `/chat`（`server.ts:4079`）、voice（`:2265`）、`autonomy-sweep`（×2）、云版 admission/gateway | **CLI 终端的全部 turn**、`heartbeat/runner.ts`、`idle/runner.ts` | **计费审计**——"谁花了我们的钱" |
| `runs.jsonl` | `idle` ×2、`heartbeat` ×4、`reflect` ×2 的 token | Web `/chat`、CLI chat、`autonomy-sweep` | **自主运行台账**——"她自己动了多少" |
| `turn_completed`（新增，§3.4 Q1） | **全部四条路径**（挂在 `agent.ts` 的 turn 出口） | — | **使用度量**——"总共跑了多少 turn" |

**这不是三个台账在同一个量上互相校验，是三个不同的量。**
`usage.jsonl` 的覆盖面窄**是设计**（`PLAN_ACCOUNTS_BILLING_v1.0.md` §6.3），不是 bug；
`runs.jsonl` 的 token 是 autonomy 的内部会计，不是账单。**三者两两相加都是错的**：
- `usage + runs`：在 `autonomy-sweep` 路径上可能重叠（见 §0.3 待确认 #3），且单位语义不同。
- `usage + turn_completed`：**必然双计**——同一个 Web turn 在两边各落一行。
- 只用 `usage.jsonl` 回答"活跃度/成本"：**系统性漏掉旗舰形态（终端 REPL）的全部消耗**。

**规则（写进 `docs/TELEMETRY.md`）**：
- "**花了多少钱**" → 只读 `usage.jsonl`，且必须标注"仅计费路径（Web + 云版）"。
- "**跑了多少 turn / 烧了多少 token**" → 只读 `turn_completed`，且标注 opt-in 偏差。
- "**她自主动了多少**" → 只读 `runs.jsonl`（或其派生的 `autonomy_run_recorded`）。
- 任何把三者之一叫做"总量"的报表，**在评审时直接打回**。

这是一个"看起来能加、实际不能加"的陷阱，而且比蓝图 §5.3 的双端 `source` 消歧更隐蔽——
Luddi 至少有一个 `source` 列可以 `GROUP BY`，这里三个文件连字段名都不一样，
**没有任何东西会在你加错的时候报错。**

### 7.5 `no-update` 不是失败（Q2 的核心口径）

`AutonomyOutcome` 的四个值里，`"no-update"` 的注释原文是 *ran fine, nothing worth surfacing*。
把它算进错误率会得到一个 80% 的**假故障率**。

**规则**：
- **健康率** = `done / (done + no-update)` —— 这才是 Q2 要的"在产出还是在空转"。
- **故障率** = `(blocked + error) / all` —— 这是工程指标，与 Q2 无关。
- 两个比率**分开报，永不合并**。

### 7.6 到达滞后：T-7，不是 T-2；且比率的分母有 opt-in 偏差

蓝图 §6.4 的全局规则是"比率类查询一律切到 T-2"，配一个 `v_ratio_safe` 视图。
**LISA 的滞后要长得多**：upload 是 6 小时一批 + 机器可能离线数周（§4.4）。

**规则**：
- **比率类查询一律切到 T-7**（按 `occurredAt`）。这个数字要在上线一个月后**用真实到达曲线回测重调**
  ——先量 P95 到达延迟，再定阈值，不要拍脑袋守着 7。
- **管线健康检查用 `receivedAt`，不切**（它要的就是"今天到了多少"）。
- **所有 L3 比率必须标注 opt-in 偏差**：分子分母都只来自 opt-in 人群。
  "advisor 采纳率 62%" 的完整表述是 "在开启了遥测的安装中，advisor 采纳率 62%"。
  **这不是啰嗦，是防止半年后有人拿这个数去做产品决策时忘了它的来源。**

### 7.7 口径固化的载体：Phase 2 之前没有数据库，所以固化进代码

蓝图 §6.3 的做法是建 SQL 视图。Phase 0/1 的 LISA **没有数据库**，无处建视图。

**替代：把口径固化进 `lisa telemetry report` 的实现**（`src/telemetry/report.ts`）。
同一个思想——**让最省事的查询恰好就是正确的查询**：用户/我们想知道"她的健康率"时，
唯一顺手的做法是跑这个命令，而这个命令里已经编好了 §7.3（排除 autonomous）、
§7.5（no-update 不算失败）、§7.2（homeIsDefault）三条规则。

Phase 2 有了 upload sink 之后，同样三条规则**再在 SQL 侧编一遍**，
并且在两处的注释里**互相指向对方**，注明"改一处必须改另一处"。这是重复，
但比"prose 里写了规则、两边各自实现、悄悄漂移"好。

---

## §8 监控：四件套 → 五件套

蓝图的四件套各覆盖一个盲区、不可合并。LISA 的形态全变了（因为**本地版没有服务端、
没有告警通道、没有 on-call**），而且要**加第五件**。

### 8.1 蓝图 §7.1 Ingestion floor → 本地版不适用，两个替代物

**为什么不适用**：入口地板监控的前提是"有一个我们能观测请求量的入口"。
LISA 本地版的入口是一个函数调用，发生在用户的机器上，我们看不见。

| 替代物 | 查什么 | 何时可用 |
|---|---|---|
| **`lisa doctor` 自检**（本地，给用户和给我们自己） | ledger 最近 24h 有没有行；有没有 `telemetry_sink_failed`；upload 上次成功时间 | Phase 0 |
| **L2 代理指标地板**（§6.2） | npm 周下载环比跌 > 50%、GitHub release 下载数连续 3 天零增长 | Phase 0 |
| 真正的 ingestion floor | upload endpoint 的 204 量跌破地板 | Phase 2 |

**代理指标地板是 Phase 0 唯一的"东西坏了会有人知道"的机制。** 它不精确
（npm 下载受镜像/CI 影响很大），但蓝图案例 A 的教训是"当时没有任何东西盯着事件量，
断供六天无人发现"——**一个粗糙的、真的在跑的地板，胜过一个精确的、还没建的**。

### 8.2 蓝图 §7.2 Sink 失败告警 → 本地版无告警通道，改成"用户可见 + 自记"

fire-and-forget 的代价是失败静默；蓝图说这条告警是那个设计决定的**对价**，必须一起上线。
LISA 没法给用户的机器发告警，所以对价换一种付法：

1. **自记**：`telemetry_sink_failed`（`upload: "never"`，§3.4）落本地 ledger。
2. **用户可见**：`lisa doctor` 和 `lisa telemetry status` 打印最近的失败计数与 code。
3. **云版**：`[C]` 事件的 sink 失败走 Cloud Run 结构化日志 → logs-based metric → 告警策略。
   **日志字符串一旦被 metric filter 匹配，改它之前必须先搜 monitoring 配置**（蓝图长期纪律）。
4. **Phase 2 的 upload sink**：服务端侧统计 4xx/5xx 比例，这是我们唯一能主动看到的失败面。

### 8.3 蓝图 §7.3 双 sink 日对账 → Phase 0/1 不适用；Phase 2 变成"送达率"

Phase 0/1 只有一个 sink，无处对账。

Phase 2 的对应形态：串联架构（§2.2）让对账天然可做——**upload 是 ledger 的严格子集**。
`telemetry_batch_sent` 带 `{ count, ledgerLines, seq }`：

- 服务端按 `installId` 检查 `seq` 是否连续 → **缺口 = 丢批**（网络失败或进程被杀）。
- `sum(count)` vs 服务端实收行数 → **不等 = 传输层丢行**。
- `ledgerLines` 的增长速度 vs `count` 的增长速度 → **偏离 = upload 跟不上产生速度**
  （比如一台机器每天产生 200 行但每批只发 50 行，说明批次上限设小了）。

蓝图的三个细节照抄：① mismatch 时**返回 200**，`ok:false` 在 body 里（重试一个"正确地
发现了不一致"的对账只是烧钱重放同一发现）；② "sink 不可达" ≠ mismatch，单独计数；
③ 对账范围限定 `UPLOADABLE_EVENTS`——`upload:"never"` 的事件本来就只在本地，
比出来的"缺口"全是假的。

### 8.4 蓝图 §7.4 Per-event 量级回归 → 有最低样本量门槛，不到不要建

蓝图的做法：逐事件名对比近窗与 14 天基线，量或去重人数任一跌破 10% 就红。

**在 LISA 这条有一个前提：样本量。** 200 个 opt-in 安装、一个低频事件（比如
`plan_run_finished`）一天可能只有 5 行。**5 → 2 是噪声，不是回归。** 建一个天天误报的
检测器，结果是所有人学会忽略它——防线名存实亡（蓝图 §2.5 关于 substring 误报的同一个道理）。

**规则**：
- 逐事件名，**日均 < 50 行的事件不参与**这个检测（只在看板上标"样本不足"）。
- 参与的事件用蓝图的双指标：**事件量**与**去重 installId 数**，任一跌破基线 10% 就红。
  两个都要——蓝图的 banner 事故里人数 63→4 崩了而事件量还有基线的 48%（一个重度用户撑着），
  在 LISA 这个形态下更容易发生（一台狂跑 heartbeat 的机器能撑起整个事件量）。
- 基线只取**健康日**的中值（否则一次管线事故会把中值拖到 ~0，检测器在事故后最需要它的
  一周里失明——蓝图原话）。
- 超过 50% 的事件同时报警 → 收敛成**一条**管线级 finding，不刷一墙名字。

**Phase 2 才建，且建之前先量一个月的实际日量**，用真实数据定那个 50 的门槛。

### 8.5 **第五件（LISA 专属）：承诺一致性检查**

**这是蓝图里没有的，也是这个项目最该有的一条。**

**查什么**：以下声明的"会出网的事件清单"必须**逐字一致**，任一漂移 → CI 红：

| # | 位置 | 内容 |
|---|---|---|
| 1 | `src/telemetry/schema.ts` 的 `UPLOADABLE_EVENTS`（派生，权威） | 代码事实 |
| 2 | `docs/TELEMETRY.md` 的事件表 | 开发者文档 |
| 3 | `README.md` 的遥测小节 | 对外主承诺 |
| 4 | **六个** astro 页面：`privacy` / `cloud` / `index` × `{en, zh-CN}` | 已发布的法律文本 |
| 5 | `packaging/ios-companion/Sources/PrivacyInfo.xcprivacy` 的 `NSPrivacyCollectedDataTypes` | Apple 侧的机器可读声明 |
| 6 | `lisa telemetry events` 的输出 | 用户自验证面（**这个不需要 CI 检查——它就是从 #1 打印的**） |

**#4 是六个文件不是两个**（实测）：三份英文页与三份中文页**各自独立**地做了同一个承诺——
`website/src/pages/privacy.astro:20`（*"collect no analytics, no advertising identifiers…"*）、
`cloud.astro:50`（*"no analytics SDKs"*）、`index.astro:103`（*"no telemetry, no account of any kind"*），
以及 `zh-CN/privacy.astro:19`（"不含任何分析统计、广告标识或第三方追踪 SDK"）、
`zh-CN/cloud.astro:49`（"没有分析 SDK"）、`zh-CN/index.astro:102`（"无遥测、无任何账号"）。
**中文页最容易被漏掉**——它不在任何人的 grep 习惯里（搜 "analytics" 搜不到"分析统计"），
而它对中文用户是同等效力的公开承诺。**所以检查脚本必须按文件路径清单硬编码这六个文件，
而不是 grep 一个英文关键词**。

由 `scripts/check-telemetry-events.mjs --check` 执行，挂在 `prepublishOnly` 与
`.github/workflows/ci.yml`。

**为什么这条比蓝图的任何一条都重要**：这个产品的最大事故形态不是"数据丢了六天"
（Luddi 案例 A），是**"有人 grep 出一个没写在隐私政策里的上报事件，发到 HN"**。
第一种事故的代价是几周的数据；第二种的代价是产品定位——而定位是这个项目
（MIT、免费、靠 star 增长）**唯一的资产**。

对应的"如果当初有"：没有这条，一个"顺手多带一个字段"的 PR 就能让 privacy.astro 变成假话，
而且**没有任何自动化会发现**，因为代码是对的、测试是绿的、文档只是旧了。

### 8.6 成本护栏（三层，量级小两个数量级但形状一样）

| 层 | LISA 的值 |
|---|---|
| ① 客户端硬上限 | 单个安装每天最多 upload 1000 事件；超出本地丢弃并记 `telemetry_sink_failed{code:"quota"}` |
| ② 服务端硬上限 | Worker 按 installId 每天 1000 事件，超出直接 204 丢弃 + 服务端日志 |
| ③ 账单预算 | CF/GCP 预算 **20 USD**，20/50/100% 三档。**必须显式 `EXCLUDE_ALL_CREDITS`**——GCP 预算默认 `INCLUDE` credits，账户有赠金时永远不会触发（蓝图 §7.6 真实修过的坑） |

**采样：不做。** 蓝图的结论是"先测集中度再谈采样，多数体量下答案是不采"。
LISA 的日量比 Luddi 小两个数量级，采样的复杂度收益比是负的。
（唯一可能例外：`autonomy_run_recorded` 在一台开了全部 desire 的机器上可能高频——
Phase 2 上线一个月后**实测集中度再说**，不要预先优化。）

---

## §9 合规与隐私：这个项目的特殊性

### 9.1 **第一个交付物是改政策，不是写代码**

调研约束原文：*任何上报都必须先改这三页 + iOS 隐私标签 + App Store 提审，
否则就是对已生效隐私政策的直接违反。埋点方案必须把「改政策」当成第一个交付物，而不是脚注。*

**这条完全成立，且顺序不可颠倒。** 但要精确区分**哪些改动需要改政策**：

| 动作 | 需要改政策吗 | 理由 |
|---|---|---|
| 建本地 ledger（Sink A，永不出网） | **不需要**改隐私政策，**需要**在 README / `docs/TELEMETRY.md` 里说明 | 它和 `runs.jsonl` / `usage.jsonl` / `sense/events.jsonl` 是同一类东西——用户自己磁盘上的、用户自己能读的、有界会过期的本地文件。privacy.astro 承诺的是"不向我们的服务器收集"，不是"不在你的机器上写文件" |
| 加 `POST /api/insight/event`（只绑回环） | **不需要** | 数据没有离开用户的机器 |
| 云版 `[C]` 事件（Q7 那五个） | **需要改 `cloud.astro` 与 `zh-CN/cloud.astro` 两页** | 两页现在分别写 "no analytics SDKs" / "没有分析 SDK"——字面上仍是真的（我们不用 SDK），但"我们记录你的配额消耗事件"必须明说，不能靠字面技巧。`privacy.astro` 的 LISA Cloud 一节也要同步 |
| **opt-in upload（Sink B）** | **需要改七处**：`{privacy, cloud, index}.astro` × `{en, zh-CN}` 六个页面 + `README.md`；**以及** `PrivacyInfo.xcprivacy` + ASC App Privacy 答案 | 这是真正的"数据离开用户的机器" |

**改政策的措辞纪律**：不要写"我们可能收集使用数据"这种留后门的模糊句。
写**具体的、可核对的**句子，并附上"完整清单见 `lisa telemetry events`"。
在这个用户群面前，模糊 = 可疑；具体 + 可自验证 = 可信。

### 9.2 遥测作为一个 `ConsentSignal`，不新开开关

调研约束原文：*必须接入已有的 consent 框架，而不是新开一个开关……否则用户会有两套互相矛盾的
隐私开关。* 完全成立：

```ts
// src/consent/store.ts 的最小改动
export const SENSE_SIGNALS: ConsentSignal[] =
  ["screen", "voice", "clipboard", "selection", "mail", "telemetry"];

SIGNAL_DESCRIPTIONS.telemetry =
  "anonymous usage counters (no text, no file paths, no soul content) " +
  "sent to meetlisa.ai so we know what to build next — see `lisa telemetry events`";
```

**"免费得到"这句话已实测确认，不是想当然**——`SENSE_SIGNALS` 的全部消费者只有三处
（`grep -rn "SENSE_SIGNALS" src/`），加一个成员就同时得到：
- `lisa consent grant/revoke` 的合法值与错误提示（`src/cli/consent.ts:38`）；
- `POST /api/consent/grant` 的入参校验（`src/web/server.ts:2969-2971`，非法 signal → 400）；
- `src/consent/store.test.ts:32,59,71` 的三条既有断言——它们遍历 `SENSE_SIGNALS`
  断言"默认全 false""revoke-all 后全 false""listGrants 覆盖全部"，
  **新 signal 自动被这三条 fail-closed 回归测试保护**，一行测试都不用写。

`revoke-all` 连遥测一起停，这正是我们想要的语义。

> **一个命名债要留痕**：加进去之后 `SENSE_SIGNALS` 就名不副实了（遥测不是一个 ambient
> sense signal）。**不要为此改名**——改名会同时动 CLI 帮助文本、`/api/consent` 的错误串、
> 和三个既有测试，风险远大于收益。正确做法是在 `consent/store.ts` 的头注释里补一句
> "该常量现在也包含非 sense 的 consent 门（telemetry）"，把债记在它所在的地方。

**三条硬约束**：

1. **必须先修 §0.2 发现 B**（`consent/store.ts` 改用 `paths.ts` 的 `lisaHome()`），
   否则云版的第一个 opt-in 用户就替全体云版用户开了上报。**这是硬前置，不能并行。**
2. **`telemetry` 只 gate upload，不 gate 本地 ledger。** `isGranted("telemetry") === false`
   时 `track()` 照常写本地文件——因为本地文件对用户是有用的（`lisa telemetry report`
   回答的是"她这周在干什么"，这是产品功能）。想连本地也停 → `LISA_TELEMETRY_LOCAL=0`
   或 `lisa telemetry off`。**这个区分必须在 consent card 的文案里说清楚**，
   否则用户会以为 revoke 了就什么都不记了。
3. **revoke 时必须丢弃已攒未发的批次**（蓝图 §8.1：*撤回时连队列里攒的一起丢弃*）。
   具体实现：revoke 时把 `upload-state.json` 的游标推到 ledger 末尾——
   已产生但未上报的行永远不会被发出去。

### 9.3 **不做区域化 consent**（整节推翻蓝图 §8.1）

蓝图：按地区决定是否需要事先同意，未知地区默认 opt_in（fail-closed），
显式 allowlist（如 US）跳过弹窗，尊重 `Sec-GPC`。

**LISA：全球一律 opt-in，不做任何区域判别。** 三条理由：

1. **技术上办不到**。区域判别需要 IP geo。本地版**根本不出网**，没有 IP 可判；
   等到出网的那一刻做判别，已经晚了（第一次上报本身就是收集）。
2. **政治上是自杀**。"美国用户默认被收集，欧洲用户需要同意"这句话，
   在一个卖 sovereign / local-first 的产品的 HN 讨论串里就是死刑。
3. **工程上更简单**。少一套区域表 = 少一处漂移、少一个"未知地区"的边界情况、
   少一次法务咨询。

**代价**：opt-in 率会远低于"US 免弹窗"的方案。**这是刻意付的价**，
并且它把 §7.6 的 opt-in 偏差变成了一个永久的口径约束。

### 9.4 soul 只出结构性计数，一个字都不出

调研约束原文：*可上报的上限是结构性计数（desire 条数、outcome 分布、value 数量、
是否有 tampered 标记），任何文本、slug 名、标题都不行。*

本方案的执行机制**不是纪律，是类型**：
- §3.3 禁 `string`（除一条书面豁免的 semver）。
- §3.5 的 `SOUL_TOKENS` 让任何名字里带 `desire`/`journal`/`opinion`/`relationship`/`identity`/
  `purpose`/`constitution`/`value`/`emotion`/`memory`/`reflection` 的字段**必须** `upload:"never"`。
- 唯一的 soul 相关上报事件 `desire_inventory_snapshot` 只有计数与一个 `tampered: boolean`
  （来自 `soul.lock.json` 的 SHA256 校验）。

**`~/.lisa/soul/` 的读取只能通过一个专用的、只返回数字的函数**
（`src/telemetry/soul-stats.ts`），它不导出任何返回字符串的东西。
Code review 时只需要看这一个文件，不需要审查每个调用点。

### 9.5 App Store 与删除权

- **删号真删**：ASC 5.1.1(v)。云版删号 = `sessionVersion` bump + wipe 整个
  `~/.lisa/users/<uid>/`，**其中包含 `telemetry/`**——因为 §5.5 要求 ledger 写在
  scoped home 里，这一条**自动成立**，不需要额外代码。这是复用 `homeScope` 的直接红利。
- **upload 侧的删除**：`installId` 是假名化标识符，在 GDPR 意义上**仍是个人数据**。
  所以必须有 `lisa telemetry forget`：本地删 ledger + 向 upload endpoint 发一条
  `DELETE /insight/{installId}`。**这是 LISA 专属的新增**，蓝图没有对应物
  （Luddi 的删除是从 userId 走的，而这里没有 userId）。
- **蓝图 §8.3 的 streaming-buffer 日扫**：CF Analytics Engine 的删除语义待确认。
  如果它不支持按 key 删除，**那就不能用它存 `installId`** ——只能存已聚合的、
  不含 installId 的日计数。**这条会实质性改变 §6.3 的选型，Phase 2 前必须先确认。**
- **iOS 隐私标签**：见 §0.3 待确认 #6。当前 `PrivacyInfo.xcprivacy` 只声明
  Email + UserID（App Functionality / linked / no tracking）。**不要假设不用改。**

### 9.6 MIT 开源意味着一切都是公开可读的——把它变成优势

调研约束原文：*埋点代码、事件名、endpoint、密钥全部公开可读。用户群正是最会 grep 的那批人。*

这不能规避，只能**主动利用**：

- `lisa telemetry events` 直接从 `EVENT_POLICY` 打印全部事件、它们的 upload 策略、
  和每个的 properties 形状。**用户不需要相信我们，他跑一条命令就能看到。**
- `lisa telemetry preview` 打印**下一批将要发出去的确切 JSON**，一字不差。
- `LISA_TELEMETRY_DEBUG=1` 把每条 `track()` 打到 stderr。
- upload endpoint 的地址写在文档里，由用户的 `lisa telemetry on` 写进他自己的
  `config.env`——**不是编译进二进制里**（§2.3）。

**这四条加起来是这个方案最强的信任论据**，也是它相对任何 SDK 方案的根本优势：
**可验证性代替可信性**。

---

## §10 分阶段落地 checklist

分阶段的核心逻辑（蓝图两条 + LISA 一条）：
**告警先于看板**（没人看的数据断了也没人知道）；
**类型闸先于事件膨胀**（事件铺开之后再回头补声明表，成本是 10 倍）；
**本地台账先于任何出网**（先证明数据有用，再谈上报——如果 Phase 0/1 的本地数据回答不了
任何问题，那 Phase 2 只是把无用数据搬到了云上，同时赔掉了产品定位）。

### Phase 0 — 修前置 + 本地台账 + 代理指标（不出网，不需要改隐私政策）

**修前置（只有一条，是遥测 consent 的硬地基）**
- [ ] 修 §0.2 发现 B **中的 `src/consent/store.ts:54` 一处**：改成
      `import { lisaHome } from "../paths.js"`。
      **注意本 PR 只加了路由层缓解**（`/api/consent/` 进了 `CLOUD_DENIED_ROUTE_PREFIXES`，
      云版这几个路由现在一律 403），**底层的跨租户共享文件没有修**——遥测 consent 要挂上去，
      这一条仍然是硬前置。
      **验收**：`LISA_EDITION=cloud` 下两个 uid 各 grant 一个 signal，
      `GET /api/consent` 互不影响（新增单测：两个 `homeScope.run()` 里各 `grant("screen")` /
      断言另一个 `isGranted("screen") === false`）
- [ ] 其余七个文件的私有 `lisaHome()`（`sense/log.ts`、`dispatch-ledger.ts`、`control/policy.ts`、
      `web/push.ts`、`mail/{store,accounts}.ts`、`takoapi/ledger.ts`）**只记录，不修**——
      写进 `docs/TELEMETRY.md` 的"已知问题"，附上"不要顺手把 `web/{accounts,devices,otp,sessions-auth}.ts`
      也改了，那四个是进程级的、现状正确"的警告。**验收**：`docs/TELEMETRY.md` 里有这一节
- [ ] ~~修 §0.2 发现 A~~ —— **撤销。** 已核实 `usage.jsonl` 的窄覆盖是
      `PLAN_ACCOUNTS_BILLING_v1.0.md` §6.3 的设计意图；改它会在云版双计。
      替代交付物是 `turn_completed` 事件（见下面"首批调用点接入"）

**schema 与治理**
- [ ] `src/telemetry/schema.ts`：§3.4 全部事件的 discriminated union + `EVENT_POLICY` 声明表（§3.2）。
      **验收**：往 union 加一个事件而不声明策略 → `npm run typecheck` 红
- [ ] `src/telemetry/buckets.ts` 五个 bucket 函数 + 单测（§3.3）。
      **验收**：每个 bucket 函数的单测覆盖**所有边界值两侧**（如 `msBucket(1000)==="1-5s"`、
      `msBucket(999)==="<1s"`）+ 负数/`NaN`/`Infinity` 各返回一个确定值而不是 `undefined`
      ——一个返回 `undefined` 的 bucket 会让整条事件的 properties 变成非法形状
- [ ] `src/telemetry/plan-outcome.ts`：`PlanRunOutcome` 的六值映射纯函数（§3.4 Q6）。
      **验收**：六个分支各一个单测；且断言 `PlanId` 是从 `src/model/plans.ts` import 的
      （改那边加一个 plan 时，这边的 `Record<PlanId, …>` 应该编译失败）
- [ ] `src/telemetry/schema.test.ts`：禁 `string`、`SOUL_TOKENS`/`CONTENT_TOKENS`/`MONEY_TOKENS`
      分词匹配、声明表自钉死（§3.5）。
      **验收**：把 `plan_run_finished` 的 upload 改成 `event` 且给它加一个 `cwd: string` → 测试红
- [ ] `src/telemetry/guard.test.ts` 源码扫描三条（§3.7）。
      **验收**：故意写一个 `import posthog from "posthog-node"` → 测试红，然后删掉
- [ ] `scripts/check-telemetry-events.mjs`（missing / unused / **文档漂移**），
      **同一个 PR 里**挂进 `package.json` 的 `check:telemetry` + `prepublishOnly` + CI workflow（§3.6）。
      **验收**：故意加一个 `track("nope", {})` → CI 红

**入口与 sink A**
- [ ] `src/telemetry/track.ts`：同步 void 签名、有界 buffer(500)、250ms **`.unref()`** timer、
      **timer 回调整体 try/catch**、`beforeExit`/`SIGINT`/`SIGTERM` drain、
      **入队即钉 `scopedUid()`**（§2.1、§5.5）。
      **验收三条**：① 让 ledger 写入 stub 抛异常 → 进程不退出、下一次 flush 照常
      （§2.1 规则 4）；② `node -e 'import("./dist/telemetry/track.js").then(m=>m.track("x",{}))'`
      在 250ms 内自然退出（`.unref()` 生效）；③ `lisa "hi"` 后 Ctrl-C，
      ledger 里有 `session_ended`（drain 生效）
- [ ] `src/telemetry/ledger.ts`：`appendLine`+`withFileLock`、3000 行 + 30 天双重界、
      **`import { lisaHome } from "../paths.js"`**（§6.1、§5.5）。
      **验收**：两个 `homeScope.run()` 各 track 一条 → 两个文件各一行且互不含对方
- [ ] `POST /api/insight/event`：六条闸（batch 20 / legacy sniff / `INGRESS_EVENTS` allowlist /
      **35 天**时钟窗口 / 60 rpm / **4 KB 真的实现并写测试**），身份字段服务端覆写（§4.3）。
      **验收**：POST 一个 `internal` 事件名 → 400；POST 一个 6 KB properties → 那条被拒、同批其余照收 204
- [ ] 首批调用点接入：`session_started`/`session_ended`/`cli_command_invoked`/`repl_slash_command`/
      `birth_*`（挂 `soul/birth.ts` 的 `birth()`）/ **`turn_completed`（挂 `agent.ts:307-311`）**/
      `autonomy_run_recorded`（**从 `runs.jsonl` 派生，不新增调用点**，§3.4 Q2 注）。
      **验收**：`lisa "hi"` 一次 → ledger 里恰好有 `session_started` ×1 + `turn_completed` ×1 +
      `session_ended` ×1；`lisa heartbeat run` 一次 → `turn_completed` 的 `surface` 是
      `"autonomous"`（§7.3 的活跃口径依赖这个值是对的）
- [ ] `repl_slash_command` 的插件名折叠：喂一个名为 `deploy-acme-prod` 的假插件命令，
      **验收**：上报的是 `"plugin"` 而不是那个名字（§3.4 Q8 注）

**用户面与自检（这是本地版的"告警"）**
- [ ] `src/cli/telemetry.ts` + `lisa telemetry` 子命令：
      `status` / `events` / `preview` / `report` / `on` / `off` / `forget`（§9.6）。
      **验收**：`lisa telemetry events` 的输出行数 == `Object.keys(EVENT_POLICY).length`
      （一个断言这件事的单测）；`lisa telemetry preview` 在 upload 未开启时打印
      "(upload disabled — nothing would be sent)" 而不是空
- [ ] `lisa doctor` 增加遥测自检：ledger 最近 24h 行数、`telemetry_sink_failed` 计数、
      upload 上次成功时间（§8.1、§8.2）。
      **验收**：`chmod 000 ~/.lisa/telemetry` 后跑 `lisa "hi"` → 聊天正常完成，
      随后 `lisa doctor` 报出一条 `telemetry_sink_failed{code:"eacces"}`
- [ ] `docs/TELEMETRY.md`：全部事件逐条列出（**从 `EVENT_POLICY` 生成，不手写**）+ 口径规则
      （§7.1 两种身份单位不相加 / §7.2 `homeIsDefault` / §7.3 autonomous 不算活跃 /
      §7.4 三个 token 台账不相加 / §7.5 `no-update` 不是失败 / §3.4 Q7 的 email≡google 同 uid /
      §3.4 Q8 的 Mail 不在 `surface_opened` 里）+ §5.4 的"刻意不建桥"盲区声明 +
      §0.2 发现 B 的六处未修记录。
      **验收**：`scripts/check-telemetry-events.mjs --check` 在这个文件与 `EVENT_POLICY`
      不一致时红（故意删掉一行事件表确认）
- [ ] `README.md` 加遥测小节（**Phase 0 阶段的措辞是"全部留在你的机器上，没有上报"**）。
      **验收**：措辞里出现 `~/.lisa/telemetry/events.jsonl` 这个具体路径和
      `lisa telemetry events` 这条具体命令——**"我们只收集匿名使用数据"这种句子在这个用户群里
      等于没写**

**L2 代理指标（与上面并行，零依赖，今天就能开工）**
- [ ] **给已有的 `scripts/star-history.sh` 加 `schedule: cron` 的 workflow**（不是新写脚本——
      它已经存在，只是从没被调度过，`docs/star-history.csv` 至今只有 2026-05-09 一行，§6.2）。
      **验收**：连续三天后 CSV 有三行新增，日期一一对应
- [ ] 扩这个 workflow：npm downloads（总量 + `/versions` 按版本）、
      GitHub release 各资产 `download_count`、`/traffic/{views,clones,popular/referrers}`
      （**14 天窗口，必须每天抓**；traffic API 需要带 repo 权限的 token，与其余几项不同）。
      **验收**：CSV/JSON 里出现这四组列，且缺 token 时 workflow **明确失败**而不是静默跳过
      ——静默跳过就是又一个"存在但没在跑"的防线
- [ ] Cloudflare Pages 分析开启并记录基线（**不加任何页面脚本**）。
      **验收**：截图/记下开启当天的日请求量作为基线，写进 `docs/TELEMETRY.md`
- [ ] **代理指标地板**：npm 周下载环比 −50% 或 release 下载数连续 3 天零增长 → 一条 Actions 告警（§8.1）。
      **验收**：把阈值临时调到必然触发的值（如 −0.1%），确认告警真的响，然后调回来
      ——蓝图 §2.3/§2.4 两次强调的"故意违规一次"在这里同样适用

### Phase 1 — 回答 Q7（云版，服务端权威，天然全量）

- [ ] `[C]` 五个事件接入，注入点已定位到分支级（§3.4 Q7）：
      `quota.ts` 的 `liveWindow()` 开窗分支（`:230-236`）、`precheckTurn()` 的
      `quota_exhausted`（`:277-279`）与 `premium_requires_balance`（`:271-275`）两个分支、
      `stripe.ts` webhook 与 `iap.ts` 的入账处、`web/accounts.ts` 的 uid 生成处。
      **验收**：枚举全部 `import type` 自源码（`QuotaTier` / `AccountKind` /
      `PrecheckResult["error"]` / `STRIPE_PACKS` 的键），**schema.ts 里一个字面量都不手抄**
- [ ] 云版 sink 失败 → Cloud Run 结构化日志 → logs-based metric → 告警策略；
      **日志字符串写进注释"改这个字符串必须同步改 metric filter"**（§8.2）。
      **验收**：故意让一次写入失败，确认告警在 5 分钟内响
- [ ] 改 `cloud.astro` **与 `zh-CN/cloud.astro` 两页**：明说云版记录配额消耗事件（§9.1）。
      **验收**：两页都改并部署（中文页最容易漏，见 §8.5）
- [ ] `lisa billing` / 内部看板读出 Q7 的三个数：耗尽率 / 24h 转化率 / premium 被挡次数。
      **验收**：报表上显式标注"kind 分布是**首次创建 uid** 的 kind，email 与 google 共用 uid"
      （§3.4 Q7 的口径陷阱）
- [ ] **用这三个数回测 `FREE_WINDOW_FULL`（=5_000_000 微美元）、`FREE_WINDOW_UNVERIFIED`
      （=1_000_000）与 1.4× margin**——这是 Phase 1 的唯一验收标准。
      **验收**：给出"改 / 不改"的书面结论 + 依据的三个数，而不是"数据看起来还行"

### Phase 2 — opt-in upload（必须先改政策）

**改政策（第一交付物，代码之前）**
- [ ] `{privacy, cloud, index}.astro` × `{en, zh-CN}` 六页 + `README.md` **七处**改完并**已部署**。
      **验收**：`scripts/check-telemetry-events.mjs --check` 在七处都同步之前必须是红的
      （先改代码后改文档时它就该拦住你）；部署后人工访问 meetlisa.ai 的中英两版隐私页各一次
- [ ] `PrivacyInfo.xcprivacy` 更新 + ASC App Privacy 答案更新 + **提审通过**（§0.3 #6）
- [ ] 确认 sink 的删除语义（§9.5）——**如果不支持按 installId 删除，改选型，不要将就**

**代码**
- [ ] `consent/store.ts` 加 `telemetry` signal + 描述文案（§9.2）；
      **验收**：`lisa consent revoke-all` 之后 upload 停且未发批次被丢弃
- [ ] `src/telemetry/identity.ts`：`installId` 从 `seed.randomness` 派生。
      **验收**：单测断言 `installId !== seed.bornOn` 且不含 hostname/username 的任何子串（§5.1）
- [ ] `src/telemetry/upload.ts`：6h 批次、`occurredAt`+`receivedAt` 双字段、
      `telemetry_batch_sent{seq}`、失败**不重试不回队**、`upload-state.json` 游标
- [ ] upload endpoint（CF Worker 倾向，§6.3）+ 两层硬上限 + **账单预算含 `EXCLUDE_ALL_CREDITS`**（§8.6）
- [ ] 送达率对账（§8.3）
- [ ] `lisa telemetry forget` + 服务端 `DELETE /insight/{installId}`（§9.5）

**上线后一个月内（不要跳过，蓝图两次强调"上线后实测"）**
- [ ] 实测 opt-in 率 —— 如果 < 5%，L3 的一切结论都要打上"极强样本偏差"的标签，
      并重新评估 Phase 2 是否值得维护
- [ ] 实测到达延迟 P95 → **回测并重调 T-7 阈值**（§7.6）
- [ ] 实测逐事件日量 → **回测并重调 §8.4 的 50 行门槛**，然后才建 per-event 回归检测
- [ ] 实测事件集中度 → 决定要不要采样（**预期答案是"不采"**，§8.6）

### 长期纪律（没有完成态）

- 新事件三件套：union arm + `EVENT_POLICY` 声明 + （若命中敏感 token）书面豁免理由。
- **改任何 `upload !== "never"` 的事件之前，先看 §8.5 的六处一致性（含三份中文页）**——
  漏改一处 = privacy.astro 变成假话。
- 能从既有台账（`runs.jsonl` / `usage.jsonl` / `sense/events.jsonl` / `advisor-state.json`）
  派生的指标，**永远不要新增调用点**——调用点会漂移（§0.2 发现 B 的八处私有 `lisaHome` 就是活标本），派生器不会。
- 任何"顺手把 installId 和 uid 关联一下"的 PR **直接拒**，并指向 §5.4。
- 每次 `Surface` / `View` / `CliCommand` 枚举变更 = 一次全仓下游过滤搜索
  （蓝图案例 B 的三周静默漏计）。

---

## 附录 A：蓝图中不适用于本项目的条目及理由

按蓝图节号排列。**这一节比照抄适用的部分更有价值**——它记录了"为什么不照做"，
免得半年后有人拿着蓝图来问"你们怎么少了这几节"。

| 蓝图节 | 结论 | 理由 | LISA 的替代做法 |
|---|---|---|---|
| **§1.2 双 sink 彼此解耦** | **形态反转**：LISA 的两个 sink 是**串联**不是并列 | 本地优先产品必须保证离线用户的可观测性不比在线用户差；且串联让 opt-in / opt-out 用户跑同一条代码路径，少一处"区别对待"的指控面 | 本地 ledger 是唯一真相源，upload 从它读。**代价**：ledger 写失败 = 两个 sink 一起哑（接受，见 §2.2） |
| **§2.3 ESLint 禁裸调** | **完全不适用** | 仓里**根本没有 ESLint**（实测：无 `eslint.config.*`、无 `.eslintrc*`、devDeps 无 eslint）。为一条规则引入 ESLint + `@typescript-eslint/parser` 违反"8 个生产依赖 / 手写一切"的技术偏好 | `src/telemetry/guard.test.ts` 用 `node:fs` + 正则扫源码，走已有的 `npm test`（§3.7）。踩坑等价物是"正则从没匹配到任何东西也是绿的"，验收方法照抄：故意违规一次确认变红 |
| **§2.1 四值 emitter（防伪造）** | **维度整体替换** | 本地版没有伪造威胁模型——客户端就是用户自己的机器，伪造自己磁盘上的 JSONL 无收益无受害者 | 换成 `ingress`（能不能从 HTTP 进）+ `upload`（能不能出网、什么粒度）+ `editions`。fail-closed 的**机制**（Record over 字面量 union）原样保留，**语义**全换（§3.2） |
| **§2.5 敏感 token 表** | **token 表整个换掉** | Luddi 防"金钱事件被伪造"；LISA 的第一威胁是 **soul 内容外泄**，第二是用户环境泄漏，钱只排第三且只在云版成立 | `SOUL_TOKENS` + `CONTENT_TOKENS` + `MONEY_TOKENS` 三套，前两套 gate `upload`，第三套 gate `ingress`（§3.5）。分词匹配的纪律照抄 |
| **§2.2 三端 chokepoint** | **裁到两个** | Swift 两端（mac / iOS）已经通过 HTTP 跟本地 Node 服务讲话，让它们 POST `/api/insight/event` 即可 | Node 一个 + 浏览器一个。Swift 侧零埋点代码、iOS 隐私标签影响最小化。**代价**：backend 未启动时 mac app 的事件丢失（接受，§4.2） |
| **§3.2 防伪造 allowlist** | **本地版不适用，云版适用且更严** | 同上 | 本地：allowlist 只用来挡 `internal` 事件的误发（一个 400 而已）。云版：`[C]` 的五个钱/配额事件强制 `internal`，由测试钉死（§3.5 规则 3） |
| **§3.3 时钟 clamp 24h** | **窗口必须放大到 35 天** | Luddi 移动端最多离线几天；LISA 是可能断网数周的笔记本 + 6h 上报节拍 + 30 天 ledger。24h 窗口会把离线批次整批重打成"送达日"，**直接毁掉 Q1 的留存口径** | `occurredAt` + `receivedAt` 双字段并存；留存/cohort 用前者，管线健康用后者；窗口 = ledger 保留期 + 5 天余量（§4.4） |
| **§4.1 自持 anon ID（新铸 UUID）** | **规则成立，锚点换掉** | 产品承诺 "no account of any kind"，在 `~/.lisa/` 里新增一个持久化标识符文件本身就是可被截图的把柄 | 从既有 birth 产物 `seed.randomness` 派生（§5.1）。**并新增一条蓝图没有的红线：`bornOn` 绝对不可外发**——`sha256(hostname+username)` 的取值空间小到可离线穷举 |
| **§4.2 (userId\|anonId) DB CHECK 约束** | **无数据库，无从约束** | Phase 0/1 是 JSONL 文件 | 用类型钉死：upload envelope 的身份字段是 `{uid: string} \| {installId: string}` 的 union，两者互斥（§5.3） |
| **§4.3 AnonIdentityLink 桥** | **整节否决** | 建桥 = 把"这台机器"和"这个邮箱"关联，直接让 `index.astro` 的 "no account of any kind" 变成假话 | **不建。** 代价（本地→云版转化漏斗永久不可观测）记为已知盲区并写进 `docs/TELEMETRY.md`，标注"不要事后顺手补上"（§5.4） |
| **§4.4 platform 归类优先级** | 大幅简化 | 没有 UA 需要解析——`os.platform()` 就是权威，`Surface` 由调用点显式给 | `install_daily_ping.os` 直接取 `process.platform`；`Surface` 是枚举参数 |
| **§4.5 identity_grade 三级** | **不适用** | 没有 JWT / 没有 `X-Distinct-Id` 断言身份这一形态。云版是 HMAC bearer（verified），本地是无身份 | 不建。若将来 `/api/insight/event` 开放给非回环调用，再重新评估 |
| **§5.1 双 sink 保留期 730/400 天** | **保留期整个缩短** | 730 天在一个"零遥测"定位的产品的隐私政策里写不出来；且本地 ledger 跑在**用户自己的磁盘**上，不是数据仓 | 本地 30 天，upload 180 天（§6.1、§6.3） |
| **§5.2 热表白名单 + 双写门控** | **不适用（Phase 0/1 无第二个 sink）** | — | Phase 2 的 `UPLOADABLE_EVENTS` 承担类似角色，但机制是"upload 是 ledger 的子集"而非两张表 |
| **§5.3 `source` 列消歧双端事件** | **不适用** | LISA 没有双端发射同名事件的形态（§4.2 已把 Swift 端的事件收敛到同一个 Node 入口，只有一个副本） | 无需 dedup 视图。**但如果将来 Swift 端建了自己的 sink，这条立刻恢复适用** |
| **§5.4 `insertId` 幂等** | Phase 2 才需要 | JSONL append 天然无重复 | upload envelope 带 `(installId, seq, lineOffset)` 三元组做服务端去重 |
| **§6.1 `COUNT(DISTINCT userId)`** | **本地版没有 userId** | 调研的关键结论 | 本地 `installId`、云版 `uid`，**两者永不相加**（因为 §5.4 不建桥所以也无法去重）（§7.1） |
| **§6.2 分端曝光/游玩口径** | **不适用** | 没有信息流、没有曝光、没有 billing_unit | 换成 LISA 自己的三个易错口径：autonomous vs human 活跃（§7.3）、两个台账覆盖面不同（§7.4）、`no-update` 不是失败（§7.5） |
| **§6.3 口径固化为 SQL 视图** | **Phase 2 之前无数据库，无处建视图** | — | 固化进 `lisa telemetry report` 的代码（§7.7）。Phase 2 后 SQL 侧再编一遍，两处注释互相指向 |
| **§6.4 比率切 T-2** | **规则成立，数值换成 T-7** | 上报滞后长一个量级（6h 批次 + 数周离线） | T-7，且**上线一个月后用实测到达曲线回测重调**（§7.6） |
| **§7.1 Ingestion floor** | **本地版不适用** | 入口是函数调用，发生在用户机器上，我们看不见 | 两个替代：`lisa doctor` 自检（本地）+ L2 代理指标地板（npm/GitHub，Phase 0 就有）（§8.1） |
| **§7.2 Sink 失败告警** | **本地版无告警通道** | 没法给用户的机器发告警 | 自记 `telemetry_sink_failed` + `lisa doctor` 呈现 + 云版走 logs-based metric（§8.2） |
| **§7.3 双 sink 日对账** | **Phase 0/1 不适用** | 只有一个 sink | Phase 2 变成"送达率对账"（`seq` 连续性 + 行数比），串联架构让它天然可做（§8.3） |
| **§7.4 Per-event 量级回归** | **有最低样本量前置** | 200 opt-in 安装下，低频事件一天 5 行，5→2 是噪声不是回归；天天误报的检测器等于没有 | 日均 < 50 行的事件不参与；**Phase 2 上线一个月后用实测日量定门槛再建**（§8.4） |
| **§7.5 告警 YAML drift check** | 只在云版有意义 | 本地版没有云端告警策略 | 云版沿用；**本地版的等价物是新增的第五件套**（§8.5） |
| **§7.6 采样** | 结论相同（不采），量级差两个数量级 | — | 同蓝图：先测集中度再谈采样 |
| **§8.1 区域化 consent** | **整节推翻** | ①本地版不出网，没有 IP 可判区域；②"US 用户默认被收集"在这个产品的 HN 讨论串里是死刑；③少一套区域表少一处漂移 | **全球一律 opt-in。** 代价（opt-in 率低、样本偏差大）刻意付（§9.3） |
| **§8.2 平台 consent 差异成文** | **规则成立，差异内容不同** | Luddi 的差异是 web 有 gate / mobile 没有 | LISA 的差异是：**本地 ledger 无 gate（不出网）/ upload 有 gate / 云版 `[C]` 事件无 gate（服务端自观测）**。三者的裁决与重估触发条件写进 `docs/TELEMETRY.md`（§9.1、§9.2） |
| **§8.3 GDPR streaming-buffer 日扫** | **本地版不适用；upload 侧要新增一条蓝图没有的** | 本地删除 = `rm -rf ~/.lisa`，用户自己就能做 | 云版删号自动带上 `telemetry/`（复用 `homeScope` 的红利）；upload 侧新增 `lisa telemetry forget` + `DELETE /insight/{installId}`（§9.5） |
| **§8.4 身份特征不入仓** | **规则成立但更严** | Luddi 禁的是 email/生日/精确位置；LISA 要禁的是**几乎所有自由文本** | 用类型禁掉整个 `string` 类型，而不是逐字段判断敏感性（§3.3）——逐字段判断在这个产品里是一场必输的战争 |
| **§9 三个事故案例** | 案例 A/B/C 的**形态**在 LISA 不会重演 | 无 PostHog、无信息流曝光、无双管线 CTR | 但它们的**教训**全部保留：A→§8.1 地板；B→§3.3 枚举收敛与改名的下游搜索；C→§7.6 到达滞后。**LISA 的一号事故形态是蓝图里没有的第四种：承诺与代码漂移被公开发现**，对应新增的 §8.5 |

---

## 附录 B：新增文件清单（便于 review 时按图索骥）

| 路径 | 作用 | 阶段 |
|---|---|---|
| `src/telemetry/schema.ts` | 事件 union + `EVENT_POLICY` 声明表 + 派生集合 | P0 |
| `src/telemetry/buckets.ts` | 五个分桶纯函数 | P0 |
| `src/telemetry/track.ts` | **唯一入口**，同步 void，有界 buffer | P0 |
| `src/telemetry/ledger.ts` | Sink A，本地 JSONL（**必须 import `paths.js` 的 `lisaHome`**） | P0 |
| `src/telemetry/soul-stats.ts` | soul 的**只返回数字**的读取面 | P0 |
| `src/telemetry/report.ts` | `lisa telemetry report` 的口径实现（§7.7） | P0 |
| `src/telemetry/schema.test.ts` | 敏感命名 + 禁 string + 声明表自钉死 | P0 |
| `src/telemetry/guard.test.ts` | 源码扫描（ESLint 的替代物） | P0 |
| `src/cli/telemetry.ts` | `lisa telemetry` 子命令 | P0 |
| `scripts/check-telemetry-events.mjs` | CI 审计 + **六处文档一致性**（含 zh-CN 三页，§8.5） | P0 |
| `docs/TELEMETRY.md` | 对外事件清单 + 口径规则 + 盲区声明 | P0 |
| `.github/workflows/proxy-metrics.yml` | L2 代理指标每日快照 | P0 |
| `src/telemetry/identity.ts` | `installId` 派生（**不用 `bornOn`**） | P2 |
| `src/telemetry/upload.ts` | Sink B，批量 HTTPS POST | P2 |

**改动的既有文件**（Phase 0）：

| 文件 | 改什么 |
|---|---|
| `src/consent/store.ts` | 改 `lisaHome` 来源（§0.2 发现 B）+ 加 `telemetry` signal（§9.2） |
| `src/agent.ts` | turn 出口发 `turn_completed`（`:307-311`）。**不动 `recordUsage`**（§0.2 已更正） |
| `src/cli.ts` | `cli_command_invoked`（子命令分发处）、`repl_slash_command`（`onSlash` @ `:855`）、`session_started`/`session_ended` |
| `src/cli-args.ts` | `cli_flag_used`；`CliCommand` 从 `ParsedArgs["subcommand"]` 派生 |
| `src/soul/birth.ts` | `birth_started`/`birth_completed`（`birth()` @ `:110`，不是 `cli.ts` 的两个 ceremony 调用点） |
| `src/web/server.ts` | 新路由 `POST /api/insight/event`；`advisor_card_dismissed`（`:2366`）；`idle_message_engaged{dismissed}`（`:2299`） |
| `src/web/lisa-client.ts` | GUI chokepoint `lisaTrack()`；`surface_opened` 挂 `showView` @ `:3224`；`idle_message_engaged` @ `:494` |
| `src/web/room.ts` / `src/web/island.ts` | 复用 `lisaTrack`，各挂一处 `idle_message_engaged`（`:1064` / `:1237`） |
| `src/web/lisa-html.ts` | 注入 `window.__LISA_INGRESS`（客户端 allowlist，§4.2） |
| `src/advisor/engine.ts` | `advisor_card_surfaced`（`AdvisorDecision.surface` 出口） |
| `src/integrations/hub.ts` | `observer_scan_completed` / `observer_enabled_changed` |
| `src/cli/doctor.ts` | 遥测自检（§8.1、§8.2） |
| `.github/workflows/ci.yml` | 加第四步 `npm run check:telemetry`（前三步已在） |
| `README.md` | 遥测小节 |
| `package.json` | `check:telemetry` script + 挂进 `prepublishOnly` |

**关于 `contracts/lisa-api-v1.openapi.json`——前一稿的"`npm run check:api-contract` 会强制"
是假的，特此更正。** 实测：该契约只覆盖 8 条路径（`/chat`、`/events`、`/api/sessions`、
`/api/sessions/{id}/activate`、`/api/agents/sessions`、`/api/dispatch/{list,status}`、
`/api/island/ping`），而 `scripts/generate-api-contract.mjs --check` **只比对两个生成文件**
（`src/web/api-contract.generated.ts` 与 `packaging/…/APIContract.generated.swift`）
是否与契约的 `x-lisa-api-major` / 版本头一致，**stale 才 `exitCode = 1`**。
它**不会**、也从未打算审计"server.ts 里有没有路由没进契约"——server.ts 里有近百条
`/api/*` 路由，进契约的只有 8 条。

**所以 `/api/insight/event` 进不进契约是一个要自己做的决定，不是 CI 会替你做的。**
本方案的建议是**进**，因为 mac app 与 iOS Pocket 都会 POST 它（§4.2），
而 TestFlight 的发版节奏意味着**旧客户端会用旧形状发很久**——这正是契约存在的理由。
但要明白它换来的是什么：契约给的是版本号协商，
真正保护旧客户端的是 §4.3 那条"legacy 单事件体 sniff + 入口协议只能加不能破"。
**契约是文档，sniff 才是防线。** 两者都要，别把前者当成后者。
