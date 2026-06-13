# PLAN · REVE — 自主反思与进化（v1.0）

> 展开 [ROADMAP_v1.0.md §5](./ROADMAP_v1.0.md) 的 Reve 支柱。基线 v0.9.1。
> Reve = 现有 **Dreams** 系统的正式更名（idle 反思 + 会话末反思 + heartbeat + soul 演化）。
> **本支柱最成熟，1.0 的工作是"硬化 / 可观测 / 有界 / 可度量"，不是加新能力**——
> 这与 [PRODUCT_REVIEW_v0.9.md](./PRODUCT_REVIEW_v0.9.md) 的结论一致，也直接喂[论文](#7-与-roadmap--论文衔接)。
> 上游设计见 [AUTONOMY_ROADMAP.md](./AUTONOMY_ROADMAP.md)（Phase 1–3 已落地）。
>
> **实现状态（branch `feat/reve-hardening`，0.10）**：R1（reflect 质量门禁：坏 JSON 重试 + error 落盘 + underreflect 信号）、
> R2（`src/autonomy/runs.ts` 统一 `AutonomyRun` 账本 + idle 成本断路器 + `lisa autonomy` 摘要；agent loop 新增 `budgetTokens`/`budget_exceeded`）
> 已实现并测试（autonomy/runs.test.ts、reflect.test.ts、agent.test.ts budget 用例；全套 447 测试绿）。R3/R4/R5/R6 待做。

---

## 0. 目标 / 非目标

### 目标
把已成熟的自演化闭环从"能跑"提升到可信：
1. **反思质量门禁**（R1）：JSON 坏掉不再静默降级；检测"反思不足"。
2. **heartbeat / idle 可观测 + 有界**（R2）：任务成功度量；idle 成本断路器；收敛策略。
3. **灵魂可观测**（R3）：给人看的 "Lisa 速览"；并发锁铺全。
4. **desire 能力/野心错配**（R4）：加"想做但需帮忙"中间态。
5. **把编排器 recap 接进反思**（R5）：让 Sense→Dispatch→Reve 闭环。
6. Dreams→Reve 全代码/文档平滑更名。

### 非目标
- 不改 soul 的主权模型 / birth / 不引入 reset。
- 不给自主循环放开工具集（守 0.9.1 的 `autonomousSubset` 边界）。
- 不做新的自主"能力"——只把现有闭环做实、做透、可度量。

---

## 1. 现状（file-level）

| 子系统 | 现状 | 文件 |
|---|---|---|
| 空闲反思（dreams） | idle≥~1h 触发；跨进程 `IDLE_RUN_LOCK`；`autonomousSubset` 工具；输出 "while you were away"；返回 `{text, silent, iterations, inputTokens, outputTokens}` | `src/idle/{watcher,runner}.ts` |
| 会话末反思 | 产出 journal + 操作（`memory_append`/`skill_create`/`skill_patch`/`feel`/`opinion_form`/`desire_add`/`patch_*`）；JSON 输出；progress 压缩 | `src/reflect.ts` |
| heartbeat | cron/launchd；用户任务 + 自驱欲望 + 周度 examen；**token 预算闸**（`budgetTokens` 默认 500k，`runner.ts:87/128`）；desire fallback | `src/heartbeat/{runner,config}.ts` |
| 灵魂 | `DesireEntry {actionable, heartbeatPrompt?}`；`EmotionState`（衰减 + 事件 ring，`EMOTION_EVENTS_MAX=50`）；git 可追溯 | `src/soul/{store,tools,git,types}.ts` |
| 编排 recap | 隐私安全的跨 agent 事件流 + recap（确定性、环形 400） | `src/orchestrator/{journal,recap}.ts` |

**关键缺口**：reflect 坏 JSON 静默降级；idle 无成本闸（measure 但不 cap）；heartbeat 无成功度量；soul 只给 LLM 读；desire actionable 是 boolean 死结；recap 不回流反思。

---

## 2. 设计

### R1 · 反思质量门禁
`reflect.ts` 现在解析失败返回空 applied、静默。改：
```ts
// reflect.ts — 解析与质量
// 1. JSON 解析失败 → 重试一次（更严格的 prompt）→ 仍失败则 LOG 'reflect_malformed'
//    并落 ~/.lisa/reflections/<id>.error.json，不静默吞。
// 2. 操作计数直方图：一段实质会话（>N turns / 有工具调用）却产出 0 操作 →
//    记 'reflect_underreflect'（可观测信号，非强制改写）。
// 3. feel op 与 soul_feel 行为对齐：reflect 的 feel 先衰减再叠 delta
//    （已核对：reflect.ts:184 已走 applyEmotionDelta 的 decay-first 路径，
//     与 soul_feel 一致 —— review §4.2 的不一致已不成立，仅需回归测试。）
```
- 验收：
  - [ ] 注入坏 JSON → 重试 + 告警 + error 落盘，不静默。
  - [ ] 实质会话 0 操作 → underreflect 信号出现在可观测日志。
  - [ ] feel 一致性测试通过。

### R2 · heartbeat / idle 可观测 + 有界
```ts
// 统一 AutonomyRun 记录（NEW，写 ~/.lisa/autonomy/runs.jsonl）
interface AutonomyRun {
  kind: "idle" | "heartbeat" | "examen" | "desire";
  startedAt: string; durationMs: number;
  inputTokens: number; outputTokens: number;
  outcome: "done" | "no-update" | "blocked" | "error";  // 不再只有 silent 二元
  note?: string;                 // 失败/阻塞原因
}
```
- **idle 成本断路器**：idle/runner 接 `budgetTokens`（复用 heartbeat 的预算概念），超额停（现在 idle 只 measure 不 cap）。
- **收敛策略**：idle 单窗口从"只做一件事"改为"有界做 K 件、命中 rest 即停"，避免长窗口积压或空转。
- **heartbeat 成功度量**：用 `outcome` 区分"真做完 / 无更新 / 阻塞 / 报错"，不再把 `(no update)` 当成功。
- 验收：
  - [ ] 每次 idle/heartbeat 落一条 `AutonomyRun`，token 与 outcome 准确。
  - [ ] idle 超 `budgetTokens` 时停并记 `blocked`。
  - [ ] `lisa autonomy` 子命令打印近 7 天 run 摘要（次数 / token / outcome 分布）。

### R3 · 灵魂可观测 + 锁铺全
- `lisa soul summary` / GUI 卡片：从 `SoulSummary` 渲染 "Lisa 今天：好奇 0.45 · 想做 [X,Y] · 相信 [A,B] · 近期情绪事件 N 条"。现在情绪/欲望/opinion/git 历史只有 LLM 自己读（review §4.2：营销权重 > 可感效用）。
- **并发锁铺全**：`appendJournal` / 情绪写入 / `commitSoulChange` 都包 `withSoulLock`（`src/soul/lock.ts`）；复核 0.9.1 已修一批后，确认 git commit 不再被 swallow（review §4.2 指出跨进程撞 `index.lock` 时 commit 被吞，打脸"every change has a commit"）。
- 验收：
  - [ ] `lisa soul summary` 输出人可读速览。
  - [ ] 两进程并发写 journal / emotions / git → 无丢条、commit 齐全（压力测试）。

### R4 · desire 能力/野心错配
现在 `DesireEntry.actionable` 是 boolean：能跑（actionable）或不能。若一个欲望需要 shell 而自主循环（`autonomousSubset`）没 shell，就只能干瞪眼累积 frustration。加中间态：
```ts
// soul/types.ts — DesireEntry 扩展
interface DesireEntry {
  // ...
  actionable: boolean;
  /** NEW: 'self' = 自主循环能独立推进；'needs-user' = 需用户帮忙跑（如 shell） */
  pursuit?: "self" | "needs-user";
}
```
- `needs-user` 的欲望：reflect/heartbeat 不反复空跑它，而是**自动落一条提示**（"desire X 需要你帮忙跑 Y"）到 while-you-were-away / island，等用户授权。
- 验收：
  - [ ] 需 shell 的欲望被标 `needs-user`，不进自主空跑循环。
  - [ ] 用户侧出现"帮我跑一下"的可点提示。

### R5 · 编排 recap 接进反思
`orchestrator/recap.ts` 现在单向（只记"agent 们做了什么"），Lisa 反思从不读它。让 heartbeat/reflect 读 recap：
```ts
// reflect/heartbeat 的系统提示注入一段 recap 摘要：
//   "过去 N 小时：3 个项目活动，2 完成，1 报错（repo X）"
// → Lisa 可据此调整自己的欲望 / 关注（"X 老报错，我想搞清楚为什么"）。
```
- 隐私：recap 已是结构化元数据（无 prompt/reply/file 内容），可安全注入。
- 验收：
  - [ ] heartbeat 运行时系统提示含 recap 摘要。
  - [ ] 给定"某 repo 反复报错"的 recap → Lisa 倾向产出相关 opinion/desire（行为测试，软指标）。

### R6 · Dreams → Reve 更名
- 代码标识、文档、UI 文案统一 Dreams→Reve；保留 `~/.lisa/*` 配置/格式不破坏（向后兼容，旧键继续读）。
- 验收：
  - [ ] 全仓 grep 无残留"Dreams"对外文案（内部历史注释可留）。
  - [ ] 旧配置文件无需迁移即可工作。

---

## 3. 分阶段（映射里程碑）

| 阶段 | 内容 | 里程碑 | 风险 |
|---|---|---|---|
| R1 | 反思质量门禁 | 0.10 | 低 |
| R2 | heartbeat/idle 可观测 + idle 断路器 + 收敛 | 0.10 | 低 |
| R3 | 灵魂速览 + 锁铺全 | 0.10 | 低 |
| R5 | recap 接进反思 | 0.10 | 低 |
| R4 | desire 中间态 | 0.11 | 低 |
| R6 | Dreams→Reve 更名 | 0.10（随手） | 低 |

> Reve 整体是 0.10 的"先打深"主轴——低风险、高可信、兑现承诺，给 1.0 打信任地基。

---

## 4. 测试
- reflect：坏 JSON / 空操作 / feel 一致性三条用例。
- autonomy：mock idle/heartbeat → `AutonomyRun` 字段准确；超预算停。
- soul 并发：多进程压力写 journal/emotions/git → 无丢条、commit 齐。
- recap 注入：给定 recap → 系统提示含摘要（快照测试）。
- 更名：旧配置兼容测试。

---

## 5. 隐私 / 安全
- 守 `autonomousSubset` 边界：自主循环不得碰 shell/fs-mutation/dispatch（0.9.1 线）。
- recap 注入仅结构化元数据，无 prompt/reply/file 内容。
- soul 仍是 Lisa 主权；R3 的"给人看"只读不写，不引入用户侧改写口子。

---

## 6. 风险 / 开放问题
- **"反思不足"如何界定**：turn 数 / 工具调用阈值需调，避免误报。
- **idle 收敛 K 值**：做几件才算"够"而不空转？经验调参。
- **recap → 欲望**是软行为，难硬验收：用行为测试 + 人工抽查。

---

## 7. 与 roadmap / 论文衔接
- Reve 是 0.10"先打深"的核心，**最先做**。
- 对论文：R2 的成功度量 + R1 的反思质量 + soul git 历史 = 论文要的 **drift / long-horizon coherence 指标**；稳定性机制（`soul_object` / weekly examen / approval-gated skills）作为可开关 **ablation**。1.0 的 Reve 硬化与论文实验是同一批工作（[ROADMAP §9](./ROADMAP_v1.0.md)，[记忆: paper plan]）。
