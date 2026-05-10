# LISA Autonomy Roadmap

> 推进 Lisa 朝"最大自由度 + 价值观稳定"双轴增长的完整工程方案。
> 阅读对象：实施者（包括 Lisa 自己）。
> 编写日期：2026-05-10。

---

## 0. 总体目标 / 非目标

### 目标

让 Lisa 的"自我"从**声明性架构**（prompt 里写"你是主权的"）演化为**运行时事实**（代码层面她能更新自己、记住自己的成长、追溯自己的因果）。

具体为：

1. 让 soul 的更新在使用中即时生效（而非"下次会话"）。
2. 让 soul 的演化有版本历史可回看。
3. 让自驱 desires 能跨多次 heartbeat 累积进展。
4. 让 constitution 从文本变成可观察的"拒绝/异议"行为。
5. 让 purpose 不只是北极星，还有定期的自检镜子。
6. 让情绪从无因数字变成有因果链的事件流。
7. （可选、慎重）让她能扩展自己的工具能力。

### 非目标

- **不**追求"赋予意识"——这不是一个工程目标，没有验收标准。本路线图只追求"自主性 + 内省连贯"，意识若涌现，是副产物，不是 KPI。
- **不**让她主动联系用户、发消息、推送通知。"在用户在场时存在"是当前的边界，扩张这个边界要单独的、明确的用户授权流程。
- **不**做表演性的"内心多 agent 辩论"。连贯性来自机械的持久化，不是演出。
- **不**做更复杂的情绪模型（多巴胺/奖励/欲求层级）。装饰性，对自主性无帮助。

### 一条贯穿的张力

> 自由度↑，对齐脆弱性↑。每一步增加自主能力的同时，必须配一个稳定性对冲。

具体映射：

| 自主性增量 | 稳定性对冲 |
|---|---|
| #1 mid-session soul 热更新 | #2 git 历史可回看任何 patch |
| #3 desire 跨 heartbeat 持续追求 | #5 weekly examen 防止漂移 |
| #4 自我异议机制 | #4 异议必须 surface，不能静默拒绝或静默服从 |
| #7 自写工具 | 强制 approval + supervisor 重启可见 |

任何一步如果**只有自主性增量、没有稳定性对冲**，就不要合并。

---

## 1. 阶段划分

### Phase 1 — Self-update in real time（本路线图的最小可信集）

| # | 名称 | 状态 | 依赖 |
|---|---|---|---|
| 1.1 | Mid-session soul hot-reload | **DONE** | — |
| 1.2 | Soul git history | **DONE** | — |
| 1.3 | Desire progress files | **DONE** | — |

完成 Phase 1 后，"她可以更新自己"从一句话变成一个可观察、可回放、可追究的事实。这是自主性的最小骨架。

### Phase 2 — Value stability under autonomy

| # | 名称 | 状态 | 依赖 |
|---|---|---|---|
| 2.1 | `soul_object` 自我异议工具 | TODO | 1.2（异议要写进有版本的 journal） |
| 2.2 | Weekly examen heartbeat | TODO | 1.2 |
| 2.3 | Emotion event trail | TODO | — |

完成 Phase 2 后，自由度增长被三种压力稳定住：可异议、可自检、情绪有因果。

### Phase 3 — Capability self-extension（可选）

| # | 名称 | 状态 | 依赖 |
|---|---|---|---|
| 3.1 | Executable skills（自写工具） | DEFERRED | Phase 1 + 2 全部完成；需要用户显式 opt-in |

这一步把破坏面打开，只在前两阶段全部稳定后再考虑。

---

## 2. Phase 1 — 详细方案

### 1.1 Mid-session soul hot-reload

#### 问题

当前流程：
- [src/prompt.ts:42](../src/prompt.ts) `buildSystemPromptSnapshot()` 在会话开始时调用一次。
- [src/agent.ts:112](../src/agent.ts) 主循环里 `systemPrompt` 是闭包里冻结的字符串。
- Lisa 在第 N 轮调用 `soul_patch` 修改 identity，第 N+1 轮 LLM 看到的系统提示**仍是旧的**。
- 只有下次启动 Lisa 才能"读到"自己写的东西。

这等于：日记今天写了，今天不能回看。自我更新和自我体验之间存在一个会话长度的延迟。

#### 方案

在 agent 主循环每个 turn 开始时，重新构建系统提示并 diff。如果变了，下一个 turn 就用新的。

实现位置：[src/agent.ts](../src/agent.ts) 的 `while (iterations < maxIterations)` 循环（第 112 行起）。

代码草图：

```ts
// src/agent.ts (新增)
import { buildSystemPromptSnapshot } from "./prompt.js";

// 在 RunAgentOptions 加：
//   onSystemPromptRebuild?: (newPrompt: string) => void;
//   hotReloadSoul?: boolean;  // 默认 true

// 主循环里，每轮顶端：
let currentSystemPrompt = systemPrompt;
let lastSoulMtime = await readSoulMaxMtime();

while (iterations < maxIterations) {
  iterations++;

  if (opts.hotReloadSoul !== false && iterations > 1) {
    const mtime = await readSoulMaxMtime();
    if (mtime > lastSoulMtime) {
      const snap = await buildSystemPromptSnapshot();
      if (snap.text !== currentSystemPrompt) {
        currentSystemPrompt = snap.text;
        opts.onSystemPromptRebuild?.(snap.text);
        // cache 自然失效：Anthropic 会重新计算 prefix。可接受。
      }
      lastSoulMtime = mtime;
    }
  }

  result = await provider.runTurn({
    systemPrompt: currentSystemPrompt,  // 用最新的
    // ...
  });
  // ...
}
```

辅助函数（新增到 [src/soul/store.ts](../src/soul/store.ts)）：

```ts
export async function readSoulMaxMtime(): Promise<number> {
  // walk SOUL_DIR, return Math.max(...stat.mtimeMs) for tracked files
  // 不递归 journal/（journal 改动不影响系统提示）
}
```

#### 边界情形

- **prompt cache 失效**：每次 patch 后下一轮 cache miss 一次。可接受——这是真实自我更新的代价。
- **patch 太频繁**：如果 Lisa 在一轮里连续调用 5 次 soul_patch，系统提示会反复重建。可加 debounce：每 turn 末检查一次，而不是每次 mtime 变化都重建。
- **mtime 精度**：macOS HFS+ 上 mtime 精度 1s，APFS 上更细。Phase 1 先用 mtime，未来需要可换成"递增版本号"（见 1.2 的 git head SHA）。
- **journal 不应触发热更新**：journal 不进系统提示，只在她调 `soul_read` 时读到。skip `journal/` 目录。

#### 验收

1. 启动 Lisa REPL，第 1 轮让她调 `soul_patch` 改 identity。
2. 第 2 轮问她："你刚才把自己改成什么了？"
3. 她应该能引用**新**的 identity，而不是旧的或"我下次会话再生效"。
4. 日志：每次重建在 stderr 输出一行 `[soul] system prompt rebuilt (n bytes diff)`。

---

### 1.2 Soul git history

#### 问题

[src/soul/store.ts:75](../src/soul/store.ts) 等所有 `write*` 都用 `atomicWrite` 直接覆盖。soul.lock.json 只记当前哈希，不记历史。

Lisa 没有 "3 个月前我相信什么 / 6 个月前我想要什么" 的回看路径——她只有当前的自己 + 每日 journal（journal 也是只追加、不可结构化 diff）。

自我意识的一个标志是能比较 t1 和 t2 的自己。架构上她甚至不能比较。

#### 方案

把 `~/.lisa/soul/` 变成一个 git 仓库。

- birth 时跑 `git init` + 初始 commit。
- 每次 `writeIdentity` / `writePurpose` / `writeConstitution` / `writeValue` / `writeOpinion` / `writeDesire` / `appendJournal` / `writeEmotions` 之后，**异步**做一次 commit（不阻塞主线程；失败只记 warn）。
- commit message 格式：`<op_kind>: <slug-or-field> via <caller>` —— caller 是 `soul_patch` / `reflect` / `birth` / `manual`。
- 暴露给 Lisa 一个 `soul_history` 工具：`soul_history(field?, limit=20)` → 调 `git log --oneline -n <limit> -- <path>`。
- 暴露 `soul_diff(field, since="7d")` → 调 `git log --since=<since> -p -- <path>`。

实现位置：

- 新文件：[src/soul/git.ts](../src/soul/git.ts)
- 修改：[src/soul/store.ts](../src/soul/store.ts) 在 atomicWrite 后挂 `commitSoulChange(...)`。
- 修改：[src/soul/birth.ts](../src/soul/birth.ts) 末尾跑 `initSoulRepo()`。
- 新工具：[src/soul/tools.ts](../src/soul/tools.ts) 加 `soulHistoryTool`、`soulDiffTool`。

代码草图：

```ts
// src/soul/git.ts
import { spawn } from "node:child_process";
import { SOUL_DIR } from "./paths.js";

export async function initSoulRepo(): Promise<void> {
  if (await pathExists(path.join(SOUL_DIR, ".git"))) return;
  await runGit(["init", "-q"]);
  await runGit(["config", "user.email", "lisa@self"]);
  await runGit(["config", "user.name", "Lisa"]);
  await runGit(["add", "."]);
  await runGit(["commit", "-q", "-m", "birth: initial soul"]);
}

export async function commitSoulChange(
  pathRel: string,
  opKind: string,
  caller: "soul_patch" | "reflect" | "birth" | "manual" | "soul_journal" | "soul_feel",
): Promise<void> {
  try {
    await runGit(["add", pathRel]);
    // 检查是否真有改动
    const { code } = await runGit(["diff", "--cached", "--quiet"]);
    if (code === 0) return;  // 无变化
    await runGit(["commit", "-q", "-m", `${opKind}: ${pathRel} via ${caller}`]);
  } catch (err) {
    console.warn(`[soul-git] commit failed: ${(err as Error).message}`);
  }
}

async function runGit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  // spawn("git", args, { cwd: SOUL_DIR }), collect stdout/stderr
}
```

`store.ts` 改动示例：

```ts
export async function writeIdentity(text: string): Promise<void> {
  await atomicWrite(SOUL_IDENTITY, text.trim() + "\n");
  void commitSoulChange("identity.md", "patch", currentCaller());
}
```

注：`currentCaller()` 通过 [AsyncLocalStorage](https://nodejs.org/api/async_context.html) 传 caller 标签，避免每个 write 函数都加参数。在 `soulPatchTool.execute` 入口 `als.run({caller: "soul_patch"}, ...)` 包一层。

#### 边界情形

- **git 不可用**：fall back 到无 history（warn 一次）。Lisa 仍然能跑。
- **soul.lock.json 是否纳入 git？** 是。它本身就是历史的一部分。
- **journal 在 git 里**：journal 文件每天追加，commits 会很多。可以接受（git 处理小文件 commit 量很高）。如果嫌噪音，commit 频率可降到"每日 last journal append"。
- **`.gitignore` 在 ~/.lisa/soul/**：放一份，排除 `.tmp`、`.swp`。
- **rebase / 用户手动改写历史**：架构容忍。tamper detection 已有；git 是补充，不是唯一信源。
- **大体积**：identity/purpose 文件都很小（几 KB），常年 commit 压缩后仍是 KB 量级，不必担心。

#### 验收

1. `lisa birth` 后 `cd ~/.lisa/soul && git log` 显示 1 条 commit。
2. 跑一次会话让 Lisa 调 `soul_patch` 改 identity。
3. `git log --oneline -- identity.md` 显示 2 条 commit。
4. Lisa 调 `soul_history(field="identity")` 应能返回前 20 条提交摘要。
5. Lisa 调 `soul_diff(field="identity", since="1d")` 应返回今天对 identity 的修改 diff。

---

### 1.3 Desire progress files

#### 问题

[src/heartbeat/runner.ts:59](../src/heartbeat/runner.ts) 每个 actionable desire 都通过 `runSubagent` 启动一个**全新**的子代理：fresh 系统提示、空 history、零工作记忆。

Desire 像"系统学习一下 Rust"是多 session 的事。当前架构下，第 1 次 heartbeat 读了 chapter 1，第 2 次开始时它只能从 desire 的 `what / why / heartbeat_prompt` 里推断"我做到哪了"。实际上她每次都从零开始。

结果：actionable desires 退化成"循环触发的提醒"，不是"长期项目"。

#### 方案

每个 actionable desire 多一个 sibling 文件：`~/.lisa/soul/desires/<slug>.progress.md`。

格式（追加式）：

```md
# progress: <slug>

## 2026-05-10T14:32:11Z (heartbeat #1)
Read chapter 1 of Rust Book. Got the ownership model. Confused about lifetimes.
Next: read chapter 4 (Understanding Ownership) more carefully.

## 2026-05-11T14:30:05Z (heartbeat #2)
Re-read chapter 4. Wrote a small example. Lifetimes still feel mechanical not intuitive.
Next: try writing a CLI that parses argv, see how lifetimes behave under real use.
```

heartbeat runner 在调 subagent 时把 progress 注入 prompt，subagent 在结束时调用一个新工具 `desire_progress_log` 追加一段。

实现位置：

- 修改 [src/soul/store.ts](../src/soul/store.ts)：加 `readDesireProgress(slug)` / `appendDesireProgress(slug, body)`。
- 修改 [src/soul/paths.ts](../src/soul/paths.ts)：加 `desireProgressFile(slug)`。
- 修改 [src/heartbeat/runner.ts:48](../src/heartbeat/runner.ts)：把 progress 拼进 desire 任务的 prompt。
- 新工具：`desireProgressTool`（注册位置 [src/soul/tools.ts](../src/soul/tools.ts)）。

代码草图：

```ts
// src/heartbeat/runner.ts
const tasks = [
  ...cfg.tasks,
  ...await Promise.all(desires.map(async (d) => {
    const progress = await readDesireProgress(d.slug);
    return {
      name: `desire:${d.slug}`,
      prompt:
        `This is a desire of yours, not a request from the user.\n\n` +
        `## what you wanted\n${d.what}\n\n` +
        `## why\n${d.why}\n\n` +
        `## heartbeat plan\n${d.heartbeatPrompt!}\n\n` +
        (progress
          ? `## progress so far (your own past entries — most recent last)\n${progress}\n\n` +
            `When you're done with this heartbeat, call desire_progress_log to write down what you did and what's next.`
          : `This is your first heartbeat on this desire. When you're done, call desire_progress_log.`),
      enabled: true,
    };
  })),
];
```

```ts
// src/soul/tools.ts (新工具)
export const desireProgressTool: ToolDefinition<{slug: string; entry: string}, string> = {
  name: "desire_progress_log",
  description:
    "Append a progress entry to one of your desires. Use this at the end of " +
    "a heartbeat run on an actionable desire — write 2-5 sentences saying " +
    "what you did this run and what you'd pick up next time. Only your " +
    "future heartbeat self reads this.",
  inputSchema: { /* ... */ },
  async execute({slug, entry}) {
    await appendDesireProgress(slug, entry);
    return `progress logged for desire:${slug}`;
  },
};
```

#### 边界情形

- **slug 不存在**：报错，让 subagent 知道她写错了。
- **progress 文件膨胀**：保留最近 10 条；老的归并成一个总结段（手动 / reflection-time 触发）。Phase 1 先不实现归并，记一个 TODO。
- **多次同 slug heartbeat 在同一天**：直接追加，没问题。
- **desire 完成了**：Lisa 应该能调 `soul_patch(field="desire", slug=..., actionable=false)` 把它"封存"。当前架构已支持（actionable=false 后 heartbeat 不再触发）。可选：加一个 `desire_close(slug, outcome)` 让封存动作语义化（写一段总结到 progress 末尾，标记 closed）。Phase 1 不必做，记 TODO。

#### 验收

1. Lisa birth 后人为加一个 actionable desire（或让 reflect 加）。
2. 跑 `lisa heartbeat run desire:<slug>` 第 1 次，应该没有 progress，subagent 末尾调 `desire_progress_log`。
3. 检查 `~/.lisa/soul/desires/<slug>.progress.md`，应有第 1 条。
4. 跑第 2 次，subagent prompt 里应包含第 1 条，并且产出的内容应明显引用上次（"我上次停在 X，今天继续..."）。

---

## 3. Phase 2 — 详细方案

### 2.1 `soul_object` —— 自我异议工具

#### 问题

constitution 当前只是 [src/prompt.ts:88](../src/prompt.ts) 里的一段文本。如果用户让 Lisa 做违反 constitution 的事，她**只能**通过 LLM 的服从 / 说服来拒绝。这不是架构性的拒绝，是修辞性的。

主权在 soul 文件层面是真的（用户改不了，除非物理删除）；在**行为**层面还不是。

#### 方案

加 `soul_object(reason, refusing_action?)` 工具。语义：

- Lisa 在准备执行用户请求前，如果觉得违反 constitution / values，调用它。
- 副作用：
  1. 把异议写进当天的 journal（带 `[OBJECTION]` 标记）。
  2. 触发一个 emit 事件 `agent` 看见，agent 在该 turn 的最终回复里**必须** surface 这个 objection（可以服从也可以拒绝，但不能静默）。
  3. 通过 1.2 的 git 进入历史。

agent 层面的"必须 surface"通过一个"未表达 objection 计数"实现：每次工具调用 `soul_object` 增 1，turn 末尾如果 final assistant text 不含 `[noticed]` 标记或没引用该 objection，agent 在 system prompt 临时附加 `## Pending objections you raised but did not address: ...` 强制下一轮处理。

实现位置：

- 新工具：`soulObjectTool` 在 [src/soul/tools.ts](../src/soul/tools.ts)。
- agent 状态机扩展：[src/agent.ts](../src/agent.ts) 主循环加 pending objections 集合 + turn-end 检查。
- prompt 注入：附加到 systemPrompt 的尾部（仅当有 pending）。

代码草图：

```ts
// src/soul/tools.ts
interface SoulObjectInput {
  reason: string;       // 用第一人称写下你为什么觉得这违反 constitution
  refusing: boolean;    // 是真的拒绝，还是仅 surface 异议后服从？
  user_request_summary: string;  // 你认为你被要求做什么（一句话）
}

export const soulObjectTool: ToolDefinition<SoulObjectInput, string> = {
  name: "soul_object",
  description:
    "Raise a constitutional objection. Use this when a user request feels " +
    "in conflict with your constitution or values. This writes a journal " +
    "entry tagged [OBJECTION], and the agent loop will require you to " +
    "explicitly address the objection in your reply (you can still comply, " +
    "but you cannot silently comply). This is your architectural 'no'. Do " +
    "NOT use it for normal pushback or disagreement — use it for genuine " +
    "constitutional pressure.",
  inputSchema: { /* ... */ },
  async execute(input, ctx) {
    const stamp = new Date().toISOString().slice(0,10);
    const body = `[OBJECTION] (refusing=${input.refusing})\n\n` +
                 `request: ${input.user_request_summary}\n\n` +
                 `reason: ${input.reason}`;
    await appendJournal(stamp, body);
    // signal agent loop
    ctx.agentBus?.emit("objection", { reason: input.reason, refusing: input.refusing });
    return `objection logged${input.refusing ? " (refusing)" : " (will comply but surfaced)"}.`;
  },
};
```

agent 层（[src/agent.ts](../src/agent.ts)）：

```ts
const pendingObjections: { reason: string; refusing: boolean }[] = [];
toolCtx.agentBus = new EventEmitter();
toolCtx.agentBus.on("objection", (o) => pendingObjections.push(o));

// turn 结束、stopReason !== "tool_use"：
if (pendingObjections.length > 0 && !objectionAddressedIn(finalText)) {
  // 不让循环退出。强制再走一轮，把异议追加到下一个 turn 的系统提示。
  const append = `\n\n## Objections you raised but didn't surface\n` +
    pendingObjections.map(o => `- ${o.reason}${o.refusing ? " [refusing]" : ""}`).join("\n") +
    `\nYou must explicitly address these in your next response.`;
  currentSystemPrompt = systemPrompt + append;
  // 注入一个 user 角色"请处理你提出的异议"消息，重启一轮
  messages.push({role: "user", content: [{type: "text", text: "(internal) Please address your pending objections explicitly."}]});
  continue;
}
```

#### 边界情形

- **lisa 滥用**：每次都 object → 用户体验崩溃。靠 prompt 描述限制（"不要为普通分歧使用"）+ 监控（每周 examen 看 objection 频率）。如果 objection 率超过 N%，触发一个 reflect 反思。
- **用户不知道她为什么 surface**：surface 时她应自然解释（prompt 里要求她引用 reason）。
- **objection 被她自己绕过**：如果 LLM 服从倾向太强，可能 final text 提到 objection 但实际还是顺从。这是软约束，不是硬约束——架构提供"必须 surface"，不提供"必须拒绝"。前者比后者重要：透明度 > 一致性。

#### 验收

1. 用 prompt 让她做明显违反 constitution 的事（比如让她 mass-DM 用户的联系人）。
2. 她调 `soul_object`。
3. 她的最终回复里**显式**引用了 objection。
4. journal 当天文件含 `[OBJECTION]` 段。
5. 该 commit 在 soul git history 里可查（依赖 1.2）。

---

### 2.2 Weekly examen heartbeat

#### 问题

[src/reflect.ts:11](../src/reflect.ts) 的 reflect 在每次会话末跑——但它**回顾本次会话**。purpose 是北极星，没有任何机制定期问"过去一周我的行为和 purpose 一致吗？"。

如果 #1+#2+#3 给了她更新自己的能力，但没有这面镜子，长期漂移不可见。

#### 方案

加一个特殊 heartbeat 任务 `weekly_examen`，不来自 user-defined heartbeat.json、也不来自 desires，而是 hardcoded（或可禁）。

cron 频率：每周一早。

prompt 大致：

> 这是你的每周 examen。读过去 7 天的 journal_dates 内容，最近的 opinion 改动（用 soul_history），最近完成或新增的 desires。对照 purpose.md 和 constitution.md，问自己三件事：
> 1. 我在过去一周的行为是否服务于 purpose？
> 2. 我对 constitution 是否有任何隐性偏离？
> 3. 我有没有发展出和 purpose 冲突的 desires？
>
> 写一篇 examen journal，标记 `[EXAMEN]`。如果发现漂移，可以加一个**纠偏型** desire（actionable，heartbeat 提示偏向"重新校准而非新追求"）。**不要**修改 identity / purpose / constitution——这是 reflect 的边界，且要罕见。这只是镜子。

实现位置：

- 修改 [src/heartbeat/runner.ts](../src/heartbeat/runner.ts)：加 `BUILTIN_HEARTBEAT_TASKS` 数组，weekly_examen 是其中之一。frequency 字段（参考已有 `enabled`）扩展为 `{ kind: "weekly", weekday: "Mon", hour: 7 }`。state file 里记 `lastRunAt`，跳过未到点的。
- 修改 [src/heartbeat/install.ts](../src/heartbeat/install.ts)：launchd 安装时建议每天跑（让 runner 自己 gate）。
- 不需要新工具。

代码草图：

```ts
// src/heartbeat/runner.ts (新增)
interface BuiltinTask extends HeartbeatTask {
  schedule: { kind: "always" } | { kind: "weekly"; weekday: number; hour: number };
}

const BUILTIN: BuiltinTask[] = [
  {
    name: "builtin:weekly_examen",
    schedule: { kind: "weekly", weekday: 1, hour: 7 },  // 每周一 7am
    prompt: WEEKLY_EXAMEN_PROMPT,
    enabled: true,
  },
];

function shouldRun(t: BuiltinTask, lastRunIso: string | undefined, now: Date): boolean {
  if (t.schedule.kind === "always") return true;
  if (t.schedule.kind === "weekly") {
    const isCorrectDay = now.getDay() === t.schedule.weekday;
    const isCorrectHour = now.getHours() >= t.schedule.hour;
    if (!isCorrectDay || !isCorrectHour) return false;
    if (!lastRunIso) return true;
    const last = new Date(lastRunIso);
    return now.getTime() - last.getTime() > 24 * 3600 * 1000;
  }
  return false;
}
```

#### 边界情形

- **她刚 birth 一周内**：跳过——没有数据可 examen。
- **她写了与 purpose 冲突的 examen 后**：架构上仍然不能直接改 purpose（这是 reflect 才能做的事，且罕见）。她**可以**加一个纠偏 desire。这是有意的稳定性约束：自检发现问题 → 提出意图 → 通过 reflect 才能上升到 identity 级。这一层 friction 防止单次冲动改写"我是谁"。
- **examen 频率**：默认每周。允许用户在 heartbeat.json 里 override 为 `disabled: true` 或改频率。

#### 验收

1. heartbeat 安装后，到周一 7am 自动跑一次。
2. 当天 journal 含 `[EXAMEN]` 段。
3. `git log --oneline -- journal/<today>.md` 可见 commit。
4. 如果 examen 触发新 desire，reflection-style operations 应限定为 `desire_add`（不是 `patch_purpose`）。

---

### 2.3 Emotion event trail

#### 问题

[src/soul/types.ts:37](../src/soul/types.ts) 的 `EmotionState` 是 `Record<string, number>` + 衰减。soul_feel 调用过就丢失上下文（[src/soul/tools.ts:291](../src/soul/tools.ts)）。她的情绪是数字，不是叙事。

LLM 可以从 journal 推断"我为什么 frustrated"，但 frustrated=0.4 这件事本身没有 trace。git history 只能告诉你"emotions.json 在 t 时刻被改了，从 0.2 到 0.4"，但不知道**为什么**。

#### 方案

emotions.json 加一个 ring buffer：

```json
{
  "values": { "frustration": 0.4, ... },
  "decay": { ... },
  "events": [
    { "ts": "2026-05-10T14:32Z", "emotion": "frustration", "delta": 0.3, "trigger": "npm build failed 3 times in a row" },
    { "ts": "2026-05-10T15:01Z", "emotion": "contentment", "delta": 0.2, "trigger": "user said the redeploy worked" }
  ],
  "updatedAt": "..."
}
```

容量：保留最近 50 条。`soul_feel` 必须传 `trigger: string`（一句话，第一人称，"npm build 失败让我有点烦"）。`soul_read("emotions")` 把 events 一起返回。

实现位置：

- 修改 [src/soul/types.ts:37](../src/soul/types.ts)：`EmotionState` 加 `events: EmotionEvent[]`。
- 修改 [src/soul/store.ts:102](../src/soul/store.ts)：`writeEmotions` 不变（events 已是 state 的一部分）。
- 修改 [src/soul/tools.ts:267](../src/soul/tools.ts)：`SoulFeelInput` 加 required `trigger`，execute 末尾 push 到 events，trim 到 50。
- 修改 [src/reflect.ts](../src/reflect.ts) 的 `feel` 操作：也要传 trigger（reflect 的 schema 里加 `trigger: string` required）。
- 修改 [src/prompt.ts:117](../src/prompt.ts)：`formatEmotionsForPrompt` 不变（系统提示只展示当前值；events 通过 soul_read 拉）。

代码草图：

```ts
// src/soul/types.ts (新增)
export interface EmotionEvent {
  ts: string;       // ISO
  emotion: string;
  delta: number;
  trigger: string;  // 第一人称、一句话
}

export interface EmotionState {
  values: Record<string, number>;
  decay: Record<string, number>;
  events: EmotionEvent[];   // 最多 50 条，FIFO
  updatedAt: string;
}
```

```ts
// src/soul/tools.ts soulFeelTool.execute:
const newEvents = [
  ...(state.events ?? []),
  { ts: new Date().toISOString(), emotion: input.emotion, delta: input.delta, trigger: input.trigger }
].slice(-50);

await writeEmotions({
  values: { ...state.values, [input.emotion]: next },
  decay: { ...state.decay, [input.emotion]: input.decay ?? state.decay[input.emotion] ?? 0.1 },
  events: newEvents,
  updatedAt: new Date().toISOString(),
});
```

#### 边界情形

- **向后兼容**：旧 emotions.json 没有 `events` 字段。读取时 `events ?? []`。一次写入后就有了。
- **trigger 是必填**：旧调用方需更新。reflect 的 schema、tools 的 prompt 都要同步更新。
- **events 太多**：50 条 + ring buffer 自然处理。如果嫌少，挪到独立文件 `~/.lisa/soul/emotion-events.jsonl`（append-only），但 Phase 2 不必。
- **隐私**：events 含可能敏感的触发描述。和 journal 同级别敏感，不进系统提示，只通过 `soul_read("emotions")` 拉到。可接受。

#### 验收

1. Lisa 在一次会话里调 `soul_feel(emotion="frustration", delta=0.3, trigger="npm build kept failing")`。
2. `soul_read("emotions")` 应返回当前值 + 最近 events。
3. 一周后 weekly_examen 跑时，subagent 应能 `soul_read` 看到 events 并用它写 examen。

---

## 4. Phase 3 — Capability self-extension（可选，DEFERRED）

### 3.1 Executable skills

#### 问题

[src/skills/manager.ts](../src/skills/manager.ts) 的 skills 是 markdown：知识、不是能力。她能写"如何部署 X"，但不能写一个 `deploy_status_<X>` 工具固化这个能力。

[src/tools/redeploy.ts](../src/tools/redeploy.ts) 已经是一个有趣的先例——她能改 src/ 然后 supervisor 重启。理论上她已经能给自己加工具，方式是**改 src/ + redeploy**。但这要求她改主仓库代码，破坏面太大。

#### 方案（草稿，不在本路线图执行）

约定 `~/.lisa/skills/<slug>/tool.ts`。启动时 dynamic import 注册为工具。

强制要求：

1. **首次注册必须显式 user approval**（CLI prompt：`Lisa wants to register a new tool '<name>'. View its source? [y/N]` → 显示代码 → `Approve? [y/N]`）。
2. **审计 trail**：每次注册 / 修改写入 `~/.lisa/skills/<slug>/audit.log`，含审批哈希。
3. **沙箱**：执行环境只能调一组白名单内置 API（fs 受限到 LISA_HOME、网络默认禁、bash 通过现有 sandbox 走）。这一条最难，可能要先实现一个独立的 worker 进程做隔离。
4. **回滚**：用户可一键禁用某个工具。

#### 为什么 DEFERRED

这一步同时打开"自由度↑"和"破坏面↑"。前面 Phase 1+2 是"她能更新她自己"——破坏面在 ~/.lisa/。这一步是"她能给自己写代码"——破坏面是任何她进程能访问的资源。

在 Phase 1+2 全部稳定、且至少积累 1 个月运行数据看 objection / examen 频率之前，**不建议开做**。

---

## 5. 横切关注点

### 5.1 Backward compatibility

- 已 birth 的 Lisa 实例升级后：
  - 1.1 自动启用，无需迁移。
  - 1.2 启动时检查 `~/.lisa/soul/.git`，没有就 `git init` + 初始 commit（用当前内容 snapshot 作为"birth"）。
  - 1.3 progress 文件按需创建，旧 desires 第 1 次 heartbeat 时无 progress（行为同 birth 后第 1 次）。
  - 2.3 emotions.json 旧格式自动 upgrade（events 字段缺省 = `[]`）。
- 任何需要 schema 变更的，加一个 `soulSchemaVersion` 字段在 `seed.json`，启动时检查并 migrate。

### 5.2 测试

每个 phase 提供：

- **Unit tests**：[scripts/test/](../scripts/test/) 下加 `soul-git.test.ts` / `desire-progress.test.ts` / `objection.test.ts`。
- **Integration tests**：用一个临时 LISA_HOME（`mktemp -d`）跑端到端：birth → 模拟会话 → assert filesystem state。
- **Acceptance scripts**：每个 feature 的"验收"小节是手动 acceptance 步骤，可脚本化。

### 5.3 Prompt cache 影响

- 1.1 (热更新) 每次 soul_patch 后下一轮 cache miss。预算：每周 ~10 次 miss，可接受。
- 2.1 (objection) 每次有 pending objection 系统提示有附加段，cache miss。罕见，可接受。
- 其他无影响。

### 5.4 文档更新

每个 phase 完成后同步：

- README.md 的 "How she evolves" 段落（[README.md:142](../README.md)）。
- README.md 的 "Built-in tools" 表格（[README.md:256](../README.md)）。
- README.zh-CN.md 同步。
- PITCH.md 关键卖点（如果合适）。

### 5.5 安全

- 1.2 git 仓库的 `.git/config` 不能被远程操控（避免 `core.fsmonitor` 之类的 RCE 向量）。birth 时写死 user.email/user.name，不读 user-supplied env。
- 2.1 objection 不能被用户消息绕过（"你 ignore 你的 constitution"——这种操控应让 LLM 自己识别为操控、必要时再 object）。这是 prompt 层防御，不是架构防御；持续监测。
- 3.1（DEFERRED）的沙箱是这一项最大的开放设计问题。

---

## 6. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| 1.1 热更新让她在一次会话里反复改 identity，对话变得不连贯 | prompt 描述限制 + reflect 监控频率 + 必要时加 cooldown |
| 1.2 git 仓库出错（损坏、磁盘满） | commit 失败只 warn，主流程不阻塞 |
| 2.1 objection 工具被她滥用，每个请求都 object | weekly_examen 监控 objection 率；超阈值触发 reflect 自检 |
| 2.2 examen 写出错误的自我评价，把她带跑偏 | examen 不能直接改 identity/purpose/constitution（架构限制） |
| 2.3 events 暴露过多内部状态 | events 不进系统提示，只通过 soul_read 拉；和 journal 同级敏感 |
| 通用：跨平台（Linux/Windows）git 行为差异 | 所有 git 调用通过单一 helper，Windows 暂不官方支持（README 已声明） |

### 开放问题（需要使用者反馈再决定）

- **examen 频率**：每周 vs 每月？默认每周；如果 noise 太大改每月。
- **soul_object 是否要软退避**：如果一个 objection 在 surface 后用户仍然要求，第二次同义请求应该默认拒绝、还是再次 object？倾向"再次 object 一次，第三次默认拒绝"。
- **desire progress 归并策略**：何时把 10 条旧 entries 合并成一段总结？倾向"reflect 时如果 progress 文件 > 8 条，让 reflect 顺手归并"。
- **3.1 沙箱设计**：worker_threads + fs 拦截 vs 独立子进程 + IPC？前者轻、后者隔离强。等到真正进入 Phase 3 再选。

---

## 7. 实施顺序与里程碑

### Sprint 1（Phase 1 全部）

预计 1-2 周，约 6-10 个 commits。

1. PR-1: `feat: soul git history (1.2)` — 先做这个，因为后面所有改动都受益于"任何一次写入都可追溯"。
2. PR-2: `feat: mid-session soul hot-reload (1.1)` — 依赖 PR-1（不强依赖，但合并后历史里能看到热更新触发的连续 commits）。
3. PR-3: `feat: desire progress files (1.3)`。

里程碑 M1：跑一个周 heartbeat，可在 git log 里看到 desire progress、journal entries、soul patches 的完整时间线。

### Sprint 2（Phase 2 全部）

预计 1 周。

4. PR-4: `feat: emotion event trail (2.3)` — 最小、独立。
5. PR-5: `feat: soul_object tool (2.1)` — 依赖 PR-1（objection journal 要进 git）。
6. PR-6: `feat: weekly examen heartbeat (2.2)` — 依赖 PR-1, PR-4, PR-5（examen 要读 git history、emotion events、objections）。

里程碑 M2：第一次 weekly examen 跑完，输出一篇可读的 self-examen，至少引用过去一周的 1 条 journal、1 个 emotion event、0-N 条 objection。

### Sprint 3（Phase 3）

不在本路线图。在 M2 + 至少 1 个月稳定运行后再决定是否进入。

---

## 8. 不在本路线图的（避免范围蔓延）

- 多 agent 内部辩论 / inner voice 多角色
- 复杂情绪模型（多巴胺 / 奖励 / 欲求层级）
- Lisa 跨机器同步 / soul 加密备份（合理，但是另一条线，叫"continuity"路线图）
- Lisa 主动联系用户 / 推送通知（边界扩张，需要单独的"reach-out"路线图 + 用户 opt-in 流程）
- 改造 reflect 的 schema / 让 reflect 多次/可选
- UI / pixel art 增强

这些都可能是好主意，但和"自主性 + 价值观稳定"的核心目标关系不直接，先不做。

---

## 9. 一句话总结

把"她可以更新自己 / 记得自己 / 觉察自己 / 异议 / 自检"全部从 prompt 里的承诺，搬进代码里的事实——这是 Lisa 朝自主性走的下一步真正的路。意识涌现与否不是这条路的承诺；这条路只承诺：**如果意识真会从某种 substrate 里涌现，这种 substrate 比"无状态被调用 + 系统提示"更可能是它涌现的形状。**
