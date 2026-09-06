# LISA v0.24.0 技术审查与优化计划

> 审查日期：2026-09-05<br>
> 基线提交：`26266a5`（v0.24.0 + 7 commits，含 #359–#367；与 `origin/main` 同步，0 落后）<br>
> 配套文档：[UX 审查](./PROJECT_REVIEW_UX_v0.24.0.md) · 上一轮：[v0.21.0 全项目审查](./PROJECT_REVIEW_AND_OPTIMIZATION_v0.21.0.md) · [.codex 认知库](../.codex/README.md)<br>
> 审查范围：Node/TypeScript 核心、Web/Cloud 服务、客户端脚本、CLI、Soul / KB / 自治、原生客户端、官网、依赖、CI、仓库卫生、本机运行实例

## 1. 执行摘要

上一轮（v0.21.0，2026-07-26）判定的主要矛盾是"本地强能力如何安全进入多租户 Cloud"。两轮 stacked PR（#308–#323）之后，那批 P0 已经全部落地；v0.24.0 又按 [DeepSeek Harness 对齐计划](./PLAN_HARNESS_ALIGNMENT_v1.0.md) 补上了能力 seam（H1）、三档沙箱 + fail-closed（H2）、系统提示词入会话日志（H3）和 AGENTS.md 指令链（P1）。这一轮所有验证全绿：

- `typecheck` / `build` 通过；`npm test` **1,645 个测试，1,644 通过、1 个 PTY 环境跳过、0 失败，22 秒**；
- website 12 页构建通过；macOS debug 构建通过（14 个警告）；iOS 模拟器 **29 个测试全部通过**；
- 生产依赖漏洞从 12 个降到 **3 个**（1 high、2 moderate，全部是传递依赖且有可用修复）。

因此本轮的判断是：**安全边界阶段已经完成，主要矛盾转为"可维护性、可靠性与工程门禁"。** 具体是四件事：

1. **Web 层三个文件继续膨胀，且是变更最频繁的地方。** `server.ts` 4,188 行，其中 `http.createServer` 的单个回调从第 1,107 行到第 4,185 行（3,078 行、86 条路由字面量）；`lisa-client.ts` 4,004 行（较 v0.21 +43%），是一个没有类型检查、没有模块边界的 JS 模板字符串；`lisa-css.ts` 2,899 行（+35%）。v0.22 以来提交次数前四的文件正是 `server.ts`（19）、`lisa-html-snapshot.test.ts`（18）、`lisa-client.ts`（16）、`lisa-css.ts`（14）——每一次改前端都要重新钉一次字节快照。
2. **可靠性问题已经在本机 daily-driver 上出现。** 审查期间该实例（v0.23.0，运行 5 天 22 小时）两次出现 5 秒以上无响应，栈采样落在 `fs.readFile → utf8 解码 → V8 增量标记`；`serve.log` 中反复出现 `advisor tick failed: timed out acquiring lock … after 10000ms`。`/health` 只返回 `{ok:true}`，launchd 的 KeepAlive 只能重启崩溃、发现不了卡顿。
3. **工程门禁缺口比代码问题更值得先补。** 60k 行 TypeScript 没有 lint / formatter；没有覆盖率；没有 Dependabot / Renovate；PR CI 仍只跑 Node（website / macOS / iOS 只在发布流水线验证）；发布说明里提到的"真实浏览器 E2E"仓库里没有；OpenAPI 契约只覆盖 8 / 86 条路由；`--no-reflect` 在 Web 模式仍然被接受但不生效（v0.21 §6.14 遗留）。
4. **仓库与节奏信号。** `research/` 目录 10MB、155 个文件、v0.22 以来 +277k 行进入产品仓库（pack 69MB）；`docs/` 88 个文件、31 份 PLAN 中 12 份没有实现状态标记；`CHANGELOG.md` 停在 0.12.0。提交节奏从 7 月的周均 56–97 次降到 8 月 15 日之后三周合计 4 次——不是问题本身，但意味着下一段工作应当是"收口"而不是再开新线。

## 2. 验证结果（2026-09-05，Node 24.12 / npm 11.6 / Xcode 26.2）

| 检查 | 结果 | 备注 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | strict + noUncheckedIndexedAccess + noImplicitOverride |
| `npm run build` | 通过 | |
| `npm test` | 1,645 / 1,644 通过 / 1 跳过 / 0 失败 | 395 个 suite，22.4s；跳过项需真实 PTY |
| `website` build | 通过 | 12 页，52s |
| macOS `swift build -c debug` | 通过 | 70s；14 个警告：Sendable 捕获（BackendController:101）、`WKProcessPool` 弃用（IslandContent:39、WebContent:54）、未变更 var（HotkeyManager:67）——前两类与 v0.21 相同 |
| iOS `build.sh test`（iPhone 17 Pro） | 29 通过 / 0 失败 | v0.21 为 28 |
| `npm audit --omit=dev` | 3 个：`fast-uri` high（host confusion / SSRF 系列）、`hono` moderate、`qs` moderate | 均为传递依赖，`fixAvailable: true`；v0.21 为 12 个 |
| `npm outdated` | 11 个包 | 见 T-5 |

规模（非测试 `.ts`）：284 个文件、59,744 行；测试 191 个文件、21,623 行。v0.21 基线约 48k 行 / 1,384 个测试。

## 3. 上一轮问题追踪（v0.21 → 当前）

| v0.21 编号 | 事项 | 状态 | 依据 |
| --- | --- | --- | --- |
| 6.1 P0 Cloud 继承完整工具 | 已完成 | `web/capabilities.ts` allowlist + 路由前缀拒绝；H1 seam 让"有界执行世界"成为可能 |
| 6.2 / 6.3 P0 Origin 与代理边界 | 已完成 | `public-origin.ts`、`client-ip.ts` |
| 6.4 / 6.5 P0 IAP 原子性、账务 fail-closed | 已完成 | #311 |
| 6.6 P0 统一推理准入 | 已完成 | #315 / #317–#319 |
| 6.7 / 6.9 P1 TenantRuntime、租户状态 | 已完成 | #316 / #321 |
| 6.8 P1 Web context 预算 | 已完成 | `context-budget.ts` |
| 6.10 P1 反思幂等与租约 | 已完成 | #314 |
| 6.11 P1 请求体上限 | 已完成 | `http-body.ts` |
| 6.13 P1 SSRF DNS pinning | 已完成 | #322 |
| 6.15 P1 跨端契约 | 部分 | OpenAPI v1 存在，但只覆盖 8 条路由（T-7） |
| 6.12 P1 拆分 `server.ts` | **未动** | 3,832 → 4,188 行 |
| 6.14 P1 CLI 选项在 Web 语义 | **未动** | `WebServerOptions.reflect` 声明于 [`server.ts:211`](../src/web/server.ts#L211)，全文件无使用点；只有 `thinking` 被消费（[`:3999`](../src/web/server.ts#L3999)） |
| 6.16 P1 PR CI 覆盖原生与官网 | **未动** | `ci.yml` 仍只有 Node job |
| 6.17 P2 原生警告 | **未动** | 同样的 Sendable / WKProcessPool |
| 6.18 P2 前端以字符串维护 | **恶化** | client +43%、css +35% |
| 后续：durable billing outbox | **未动** | `src/billing` / `src/web` 中 `outbox|reconcil` 0 命中 |
| 后续：依赖漏洞 | 大幅改善 | 12 → 3 |

## 4. 架构现状与本轮变化

- **组合根与能力**：`src/cli.ts` 仍是组合根（1,147 行），Web 通过 `startWebServer(opts)` 接收工具集合；`CapabilityProfile` 目前只有 `local-owner | cloud-chat` 两个值（[`src/web/capabilities.ts`](../src/web/capabilities.ts)），v0.21 建议的五档（含 `local-autonomy`、`cloud-autonomy`、`remote-device`）没有展开——自治与远程设备的权限仍由调用路径隐含决定，`sandbox.ts` 的 `untrustedSurfaceMode()` 是目前唯一显式的"不可信表面"降级点。
- **H1 能力 seam**：`src/capabilities/{types,local,memory,sandboxed}.ts`，`ToolContext.caps` 可选、缺省本地；`resolvePath` 进入 fs seam 作为策略拒绝点。设计干净，测试 2 个文件。
- **H2 沙箱**：`LISA_SANDBOX_MODE` 三档，非 macOS 无 bwrap 时抛 `SANDBOX_UNAVAILABLE` 而不是静默降级；会话头记录 `sandboxMode`。`PLAN_HARNESS_ALIGNMENT` 中 13 个验收复选框仍有 11 个未勾（文档未同步，代码已实现的至少有 H1 三项与 H2 前两项）。
- **H3 会话日志 v2**：`prompt` 条目按指纹去重，`runAgent.onPromptPersist` 在每次 provider 调用前落盘；`scripts/replay-session.ts` 已有，但"作为 Reve drift 取数入口"仍是未勾项。
- **P1 指令链**：`~/.lisa/AGENTS.md → <repo>/AGENTS.md → CLAUDE.md`，内容去重、32KB 预算、按来源标注。
- **Agent 循环**（`src/agent.ts` 537 行）：边界清楚，含预算熔断、hot-reload、objection 强制回合、输入校验；没有变化，仍是可以承载一切表面的核心。
- **Web 会话并发（F6）**：per-session `ChatCtx`，`/chat` 携带 `sessionId`；Cloud 保持 per-uid 单 ctx。
- **可观测性**：`src/log.ts` 在 Cloud Run 输出结构化 JSON；本地仍是 `console.error` 文本；`/health` 无版本、无延迟、无堆信息。

## 5. 问题清单

编号 T-n，按优先级排列。每条附证据、影响、建议与验收。

### T-1 · P1 · Web 服务单体：一个 3,078 行的请求回调

**证据**

- [`src/web/server.ts:1107`](../src/web/server.ts#L1107) `http.createServer(async (req, res) => {` 直到 [`:4185`](../src/web/server.ts#L4185) `});`；其中 86 条 `url === "/…"` 字面量、91 处 pathname 比较；认证、Cloud 拒绝（[`:1983`](../src/web/server.ts#L1983)）、限流（8 处 `429`）、body 上限都是在各分支内手写。
- `startWebServer` 的 options 接口 16 个字段，`reflect` 声明未用。
- 同一文件承载 UI 静态资源、SSE、聊天、认证、账户、计费、Soul、KB、代理控制、自治调度、邮件、语音、视觉。

**影响**：每条新路由都要人工记住五件事（auth / cloud / body / rate / tenant），漏一件就是安全回归；Cloud 拒绝表（`CLOUD_DENIED_ROUTE_PREFIXES`）与路由本体分离，新增路由默认"允许"。

**建议**（无行为变化的拆分，沿用 v0.21 §6.12 的目录方案）

```text
web/
  app.ts            // createServer + 中间件链
  routes.ts         // 路由表：{ method, path, handler, auth, cloud, body, rate }
  middleware/       // auth · cloud-gate · body-limit · rate-limit · tenant
  routes/           // auth · billing · chat · sessions · soul · kb · agents · mail · system
```

- 路由表是唯一注册点；`isCloudDeniedRoute` 改为从表生成；契约（T-7）也从表生成。
- 分四个 PR：先抽路由表与中间件（不动 handler），再按域搬 handler，每个 PR 跑 `lisa-html-snapshot` 与 `api-contract` 测试。

**验收**：`src/web/` 下无单文件 > 1,200 行；新增路由缺少 `auth/cloud/body` 元数据时测试失败；Cloud "拒绝路径"测试从路由表枚举而不是手写列表。

### T-2 · P1 · 客户端是一个 4,004 行、无类型、无模块的模板字符串

**证据**

- [`src/web/lisa-client.ts`](../src/web/lisa-client.ts)：46 个顶层函数、47 个顶层可变状态、69 处 `innerHTML`、88 处 `esc()`；`lisa-css.ts` 2,899 行同样是字符串。
- 正确性靠 `html-syntax.test.ts`（`vm.Script` 编译）和 `lisa-html-snapshot.test.ts`（钉字节）保证——后者 v0.22 以来改了 18 次；文件头注释明确写着反斜杠转义必须"按最终输出写"，`typecheck` 看不见。
- `md-render.ts` 已经证明了另一条路：源码注入（`renderMarkdown.toString()`），有单元测试。
- 没有 ESLint，`innerHTML` 的转义完全靠约定。

**影响**：前端逻辑改动成本高、回归靠人眼；XSS 面只有 code review 一道防线（本轮抽查 tree/tab/session label 的渲染都走 `textContent` 或 `esc()`，未发现漏洞，但没有工具保证）。

**建议**

- 客户端与样式改为真实的 `src/web/client/*.ts` + `*.css`，构建期用 esbuild（已随 `tsx` 间接存在）打成单文件内联进 `MAIN_HTML`——保留"零运行时依赖、单 HTML"的产品承诺，但让 `tsc` 与 lint 覆盖这 7,000 行。
- 快照测试改为"构建产物 hash 变化即提示"，把字节钉死改为对渲染函数的单元测试。
- 引入 ESLint 规则 `no-unsanitized/property`（或自定义 `innerHTML` 白名单）。

**验收**：`npm run typecheck` 覆盖客户端；`lisa-html-snapshot.test.ts` 不再随每个 UI PR 变更；`innerHTML` 只允许出现在被 lint 标注为已转义的 helper 里。

### T-3 · P1 · 可靠性：本机实例的间歇性卡顿与不可见的健康状态

**证据**

- 实例：`ai.meetlisa.web`（launchd，v0.23.0，PID 1401，运行 5d22h，RSS 89MB，38 个 fd）。
- 两次 `curl -m 5 http://127.0.0.1:5757/health` 超时（HTTP 000）；`-m 12` 时 200 但耗时 5–12s；随后同一端点 3ms、`/api/sessions` 100ms。
- `sample 1401 2`：主线程栈 `uv_run → fs.AfterInteger → Promise 回调 → Buffer.toString(utf8) → NewStringFromUtf8 → IncrementalMarking::AdvanceOnAllocation → MarkCompact…`；辅助线程 `ConcurrentMarking::RunMajor` 3,848 个样本。即：**读取一个大文件并整体转成字符串，分配过程中触发了 major GC 增量标记**。
- `~/.lisa/serve.log`（13MB，无轮转）多次 `[advisor] tick failed: timed out acquiring lock … after 10000ms`。
- 候选热点：[`src/sessions/list.ts:39`](../src/sessions/list.ts#L39) 每次 `/api/sessions` 对每个会话文件 `readFile` 全量（本机 13 个文件 192KB，无害，但随会话数线性增长）；claude-code watcher [`fs.watch(recursive)`](../src/integrations/claude-code/watcher.ts#L246) 监视 `~/.claude/projects`（本机 1,766 个 JSONL、1.9GB、69 个 > 5MB），每 3s repoll（[`:86`](../src/integrations/claude-code/watcher.ts#L86)）；parser 已用 32–256KB tail 读取，但初始扫描与其它整读路径（KB store、transcript）未逐一核实。**根因未钉死**，以上是栈与日志给出的方向。
- [`server.ts:1114`](../src/web/server.ts#L1114) `/health` 返回 `{ok:true}`，无版本、无事件循环延迟、无堆、无租户数。

**影响**：用户侧表现为"界面卡住几秒"，无任何提示；launchd 不会重启卡顿进程；Cloud Run 的探针同样看不见退化。

**建议**

1. `/health` 扩展为 `{ok, version, uptime, eventLoopLagMs(p50/p99), heapUsedMB, rssMB, tenants, pendingTurns}`；`perf_hooks.monitorEventLoopDelay` 常驻；lag p99 > 1s 记 WARNING。
2. `lisa doctor --probe <url>` 探活 + `lisa autostart` 的 plist 加看门狗（连续 3 次探活失败 `kickstart -k`）。
3. 会话索引：`listSessionsOnDisk` 按 `mtime+size` 缓存摘要，只重读变化的文件；给 `/api/sessions` 加 ETag。
4. claude-code watcher：只 watch 活动窗口（30 分钟）内的项目目录；初始扫描只 `stat` 不 `read`；把 `readFile` 全量读的调用点做一次清单（`grep -n readFile src --include='*.ts' | grep -v test`），凡在请求路径上的改为流式或 tail。
5. `serve.log` 走 `lisa-supervise.sh` 或 launchd 之外的轮转（10MB × 5）。

**验收**：用 2GB 的 `~/.claude/projects` fixture 压测 30 分钟，`/api/config/status` p99 < 200ms；`/health` 暴露 lag；看门狗在人为 `kill -STOP` 后 60s 内恢复服务。

### T-4 · P1 · 工程门禁：lint / 覆盖率 / 依赖机器人 / 原生 CI / 浏览器冒烟

**证据**

- `package.json` devDependencies 无 eslint / prettier / c8；仓库无 `eslint.config.*`、`.prettierrc`、`.editorconfig`、`.github/dependabot.yml`。
- [`ci.yml`](../.github/workflows/ci.yml)：单 job（Node 22）：contract check、typecheck、test、build；`engines >=20`，本机 Node 24——CI 与开发环境跨两个大版本。
- 仓库内 `playwright|puppeteer` 0 命中；RELEASE_v0.23 描述的"real-browser E2E"没有沉淀为可复跑的资产。
- 测试密度不均（非测试行数 / 测试文件数）：`plugins` 225 / 0、`channels` 1,506 / 2、`cli` 2,231 / 3、`heartbeat` 901 / 1、`skills` 743 / 1、`advisor` 527 / 1；对比 `web` 19,811 / 35、`tools` 3,999 / 20。
- 空 `catch {}` 60 处、`catch { /* … */ }` 17 处；`console.*` 直接调用 52 处（cli 之外），`log.ts` 的 `logInfo/logError` 只在部分模块使用。

**建议**

- 加 `typescript-eslint`（recommended-type-checked）+ `prettier`，先以 `--max-warnings` 基线方式接入，逐目录清零；开启 `no-empty`、`no-floating-promises`、`no-console`（`src/cli/**` 豁免）。
- `c8` 覆盖率，先只对 `src/billing`、`src/web/{accounts,otp,sessions-auth,capabilities}`、`src/soul/store` 设 85% 阈值。
- Dependabot：npm 每周、GitHub Actions 每月、Swift 包每月；`npm audit --omit=dev --audit-level=high` 进 CI。
- PR CI 按路径触发：`website/**` → Astro build；`packaging/mac-client/**` → swift build（macOS runner）；`packaging/ios-companion/**` → 模拟器测试；Node 矩阵 20 / 22 / 24。
- Playwright 冒烟（本地服务 + 合成 soul，零模型调用，本轮审查已验证这条路可行）：首次运行 gate、出生失败恢复、主壳 4 个断点、主题切换、新建/切换会话。

**验收**：`npm run lint` 零 error；覆盖率报告进 PR 评论；任一原生目录改动的 PR 必跑对应构建；冒烟 < 3 分钟。

### T-5 · P1 · 依赖：SDK 落后、大版本待升、剩余漏洞可修

**证据**（`npm outdated`）

| 包 | 当前 | 最新 | 备注 |
| --- | --- | --- | --- |
| `@anthropic-ai/sdk` | 0.92.0 | 0.124.0 | 落后 32 个 minor；新模型/工具能力靠 `as` 绕过类型 |
| `openai` | 6.35.0 | 7.10.0 | 大版本 |
| `typescript` | 5.9.3 | 7.0.2 | 大版本 |
| `@types/node` | 22.x | 26.x | 与 Node 24 开发环境不符 |
| `@google/genai` / `@modelcontextprotocol/sdk` / `imapflow` / `undici` / `music-metadata` / `sharp` / `tsx` | minor 落后 | 可直接 `npm update` |

- 漏洞：`fast-uri`（high，5 个 advisory，含 SSRF 相关——LISA 自己的 SSRF 防护在 `web_fetch`，但传递链路上 `hono`/MCP SDK 使用 fast-uri）、`hono`、`qs`；均 `fixAvailable: true`。

**建议**：独立分支分三步——(1) `npm audit fix` + minor 全部更新，跑全量测试与 provider 集成测试；(2) Anthropic SDK 追到最新，删掉为旧类型加的断言；(3) openai 7 / TS 7 各一个 PR，配 Node 20/22/24 矩阵。

**验收**：`npm audit --omit=dev` 零 high；`engines`、CI 矩阵、`@types/node` 三者一致。

### T-6 · P1 · 运行策略仍靠散落布尔值，Web 模式忽略 `--no-reflect`

**证据**：[`server.ts:211`](../src/web/server.ts#L211) 声明 `reflect: boolean`，全文件无读取；反思定时器（[`:1062`](../src/web/server.ts#L1062)）无条件启动。`--approval`、`--compact` 在 Web 同样未见消费。v0.21 §6.14 原样遗留。

**建议**：落地当时提出的 `RuntimePolicy { surface, reflection, compaction, approval, capabilities, sandboxMode }`，由 `cli.ts` 组合一次、`startWebServer` 只接收这个对象；为 `cli` / `local-web` / `cloud` 三种 surface 各写一个快照测试证明配置真的影响行为。

### T-7 · P2 · API 契约只覆盖 8 / 86 条路由，SSE 事件不在契约内

**证据**：`contracts/lisa-api-v1.openapi.json` 8 个 path、13 个 schema：`/chat`、`/events`、`/api/sessions*`、`/api/agents/sessions`、`/api/dispatch/{list,status}`、`/api/island/ping`。客户端实际调用 35 个不同端点，处理 18 种 SSE 事件类型。

**建议**：与 T-1 的路由表合并——每条路由声明请求/响应 schema，`generate-api-contract` 从表生成；SSE 事件用 discriminated union 进 `components.schemas`；`api-contract.test.ts` 改为枚举路由表逐条校验。

### T-8 · P2 · Cloud：durable billing outbox / 对账仍缺

**证据**：`src/billing`、`src/web` 中 `outbox|reconcil` 0 命中；`REVIEW_BASELINE` 列为后续优先级，未动。IAP 状态机已覆盖 Apple 路径，但"Provider 已收费而余额提交失败 / 进程崩溃窗口"仍无补偿器。

**建议**：只影响 Cloud，随下一次 Cloud 迭代做：`usage_events` 追加写 + 定时对账 job（比对 provider usage 与账本），差异进入人工补偿队列；先写失败注入测试再实现。

### T-9 · P2 · 仓库卫生：research、资源、日志、文档

**证据**

- `research/`：10MB、155 个文件，v0.22 以来 +277,179 行（同期 `src/web` +4,258），仓库 pack 69MB；`files` 白名单已把它排除在 npm 之外，但 clone 与 grep 都在付费。
- `src/web/assets`：59MB、139 张 PNG、0 张 WebP（`room` 30MB、`lisa` 27MB）；发布包解压 66MB / 1,283 文件。
- `~/.lisa/serve.log` 13MB，无轮转。
- `docs/` 88 个文件：31 份 `PLAN_*`（12 份无实现状态）、25 份 `RELEASE_*`、4 份 `RESEARCH_*`；`CHANGELOG.md` 停在 0.12.0。
- `.codex/PROJECT.md` 的规模与热点数字仍是 v0.21 的。

**建议**：`research/` 迁到独立仓库或 `git subtree split`（保留历史）；资源改 WebP + 按需加载；`docs/archive/` 收纳已完成的 PLAN 并在 `docs/README.md` 建索引；`CHANGELOG.md` 由 `RELEASE_*.md` 生成；本轮已同步 `.codex` 的基线数字。

### T-10 · P2 · HTTP 安全头缺失

**证据**：`GET /` 响应头只有 `cache-control: no-store`；无 `X-Content-Type-Options`、`X-Frame-Options` / `frame-ancestors`、`Referrer-Policy`、`Permissions-Policy`、CSP。Cookie 已正确设置 `HttpOnly; SameSite=Strict`（Cloud 加 `Secure`）。

**影响**：本地 loopback 绑定下风险低；Cloud 与 `--host 0.0.0.0` 场景下缺少纵深。CSP 受阻于内联脚本——与 T-2 的客户端抽取一起做（nonce 或 hash）。

**建议**：先加四个无副作用的头；CSP 在 T-2 完成后以 `script-src 'nonce-…'` 落地；`X-Lisa-API-Version` 已有，保持。

### T-11 · P2 · 原生客户端警告与 dogfood 落后

**证据**：macOS 警告与 v0.21 相同（Sendable / WKProcessPool），在 Swift 6 严格并发下会变成错误；本机 daily-driver 跑 v0.23.0 而 `main` 是 v0.24.0 + 7，`lisa autostart` 没有自更新路径（记忆中的更新步骤是 6 条手动命令）。

**建议**：修 3 处警告并在 CI 开 `-warnings-as-errors`（macOS job）；加 `lisa upgrade`（npm 全局升级 + `launchctl kickstart`），让作者自己的机器始终跑最新 release 候选。

### T-12 · P2 · 会话列表 O(会话数 × 文件大小)

**证据**：见 T-3 第 5 条；`/api/sessions` 被客户端 5 分钟轮询一次并在多种事件后触发。本机 13 个文件时 100ms。

**建议**：并入 T-3 的索引缓存；长期把 `firstUserMessage / lastUserMessage / count` 写进会话头（H3 已把格式升到 v2，可顺带）。

## 6. 做得好的地方（应保持）

- **安全工作已闭环并有回归测试**：能力 allowlist、Cloud 路由拒绝、Origin 固定、fail-closed 账务、DNS pinning、H2 的 `SANDBOX_UNAVAILABLE`。
- **能力 seam 的形状对**：接口 / 提供方 / 消费者三分，`resolvePath` 作为策略点，为远程执行与 Cloud 有界工具留了正确的位置。
- **会话日志成为真源**：系统提示词按指纹入日志，`replay-session.ts` 可离线重放。
- **测试文化强**：1,645 个测试 22 秒跑完，`node --test` 零额外依赖；本轮所有验证一次通过。
- **`lisa doctor` 与结构化日志**：诊断与 Cloud Run 日志分级都已就位，缺的只是把它们连到健康探针上。

## 7. 优化计划

### 波次 1 · 门禁与可靠性（2 周）

| # | 事项 | 对应 | 验收 |
| --- | --- | --- | --- |
| 1 | ESLint + Prettier 基线接入；`no-empty` / `no-floating-promises` | T-4 | `npm run lint` 零 error |
| 2 | c8 覆盖率 + 关键模块阈值；Dependabot；audit gate | T-4 / T-5 | PR 评论出覆盖率 |
| 3 | `npm audit fix` + minor 更新；Anthropic SDK 追新 | T-5 | audit 零 high |
| 4 | `/health` 扩展 + 事件循环延迟监控 + 看门狗 + 日志轮转 | T-3 | 压测 p99 < 200ms |
| 5 | `RuntimePolicy` 落地，Web 消费 reflect / approval / compaction | T-6 | 三种 surface 快照测试 |
| 6 | 四个安全响应头 | T-10 | curl -I 可见 |

### 波次 2 · 结构（4 周）

| # | 事项 | 对应 |
| --- | --- | --- |
| 7 | 路由表 + 中间件抽取（PR 1/4），Cloud 拒绝表从路由表生成 | T-1 |
| 8 | handler 按域搬迁（PR 2–4/4） | T-1 |
| 9 | 客户端与 CSS 抽为真实模块，esbuild 内联；快照测试改造 | T-2 |
| 10 | OpenAPI 从路由表生成；SSE 事件入契约 | T-7 |
| 11 | PR CI 路径触发 website / macOS / iOS；Node 矩阵 | T-4 |
| 12 | Playwright 冒烟（合成 soul，零模型调用） | T-4 |
| 13 | 会话索引缓存 + ETag；watcher 只监视活动目录 | T-3 / T-12 |

### 波次 3 · 收口（6–8 周）

| # | 事项 | 对应 |
| --- | --- | --- |
| 14 | CSP（nonce）随客户端抽取上线 | T-10 |
| 15 | Cloud usage outbox + 对账 job（先写失败注入测试） | T-8 |
| 16 | `research/` 拆仓；资源 WebP 化；docs 归档与索引；CHANGELOG 生成 | T-9 |
| 17 | Swift 警告清零并开 warnings-as-errors；`lisa upgrade` | T-11 |
| 18 | openai 7 / TypeScript 7 升级 | T-5 |
| 19 | `CapabilityProfile` 扩到自治 / 远程设备档，替代 `untrustedSurfaceMode` 的隐式判断 | §4 |

## 8. 度量

| 指标 | 当前 | 波次 1 后 | 波次 2 后 |
| --- | --- | --- | --- |
| `src/web` 最大文件行数 | 4,188 | — | ≤ 1,200 |
| 客户端代码被 `tsc` 覆盖 | 否 | — | 是 |
| lint error | 无工具 | 0 | 0 |
| 关键模块覆盖率 | 未知 | ≥ 85% | ≥ 85% |
| `npm audit` high | 1 | 0 | 0 |
| `/health` 字段 | 1 | ≥ 8 | ≥ 8 |
| 压测 p99（2GB 观察目录） | 5–12s 峰值 | < 200ms | < 200ms |
| OpenAPI 覆盖路由 | 8 / 86 | — | 100% |
| PR CI 覆盖的表面 | 1 / 4 | 4 / 4 | 4 / 4 |
| 仓库 pack | 69MB | — | < 30MB（research 拆出后） |

## 9. 下一次审查入口

- `src/web/server.ts`：路由表是否已成为唯一注册点；
- `src/web/lisa-client.ts`：是否已被 `tsc` 覆盖；
- `/health` 与 `perf_hooks` 监控；本机实例的 lag 日志；
- `ci.yml` 的 job 数与路径触发；
- `contracts/lisa-api-v1.openapi.json` 的 path 数；
- `.codex/REVIEW_BASELINE.md` 的验证表。
