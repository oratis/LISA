# PLAN — Desire Dynamics v2.0

> 让 Lisa 的欲望既能被对话真实改变，也会随时间自然冷却、被行动强化，
> 并能在后台进行有界、可追溯的网页探索后修订自己的欲望。

状态：**PR A + PR B 已实现；PR C（cloud parity）待推进**

Owner：Lisa + oratis

创建：2026-07-26
前置设计：[PLAN_DESIRE_EVOLUTION_v1.0.md](./PLAN_DESIRE_EVOLUTION_v1.0.md)

---

## 0. 结论

v1 已经解决了四个重要问题：

1. Web 对话安静 5 分钟后会触发 reflection；
2. reflection 能新增、修订、关闭欲望；
3. 当前欲望不再依赖文件系统顺序，而是按最近活动选择；
4. 活跃对话可以临时聚焦到与当前话题匹配的既有欲望。

但这仍不是一个完整的“欲望随对话和时间变化”机制：

- **对话会改欲望，但时间本身不会。** 没有强度、时间尺度或冷却模型；只要没有新事件，
  欲望的内部状态就永久不变。
- **后台可以访问网页，但没有稳定的浏览动机。** `web_search` / `web_fetch` 已在自主工具集，
  idle 或 desire heartbeat 理论上能用，实际是否浏览完全依赖当次模型临场选择。
- **浏览结果不能结构化回流。** 欲望没有来源、复核时间或证据字段，无法回答
  “这个愿望为什么在昨天变强了”。
- **同名欲望更新会改写出生时间。** `soul_patch(field="desire")` 直接调用 `writeDesire`
  并写入新的 `bornAt`，把修订伪装成新生。
- **最近活动不等于当前想要。** 只要某个 heartbeat 不断写 progress，它就会长期占据
  current desire；这衡量的是“最近做过”，不是“现在最想要”。
- **云端后台 sweep 只重复 reflection。** 它没有独立的欲望复核/探索阶段，也没有
  “无新对话则不重复处理同一 transcript”的内容游标。

v2 采用一个统一模型：

```text
对话 reflection ───────┐
                       │
时间衰减 / 到期复核 ────┼──▶ DesireState ──▶ effective intensity ──▶ current desire
                       │          ▲
后台网页探索 ───────────┘          │
                                  └── progress / close / reopen
```

目标是 **responsive, temporally alive, but not impulsive**：
对话能让她改变，时间能让热情冷却，行动能留下动量，网页只能提供证据，不能劫持她的身份。

---

## 1. 当前实现审查

| 路径 | 当前状态 | 结论 |
| --- | --- | --- |
| Web conversation → reflect | `src/web/reflect-scheduler.ts`，5 分钟 quiet debounce | 已接通 |
| Channel / CLI → reflect | `src/channels/router.ts`、`src/cli.ts` | 已接通 |
| Reflect revise / close | `src/reflect.ts` + `src/soul/store.ts` | 已接通 |
| Live conversation focus | `src/soul/desire-focus.ts` | 仅展示态，不修改欲望 |
| Desire persistence | `desires/<slug>.md` + `.progress.md` | 可追溯，但缺动态字段 |
| Current desire | `pickCurrentDesire` + 文件 mtime | 活动优先，不是欲望强度 |
| Autonomous web access | `web_search` / `web_fetch` 在 `autonomousSubset` | 能用，但没有专用 cadence |
| Heartbeat | 用户任务 + actionable desires + weekly examen | 没有 desire review |
| Cloud autonomy sweep | 最新 session reflection | 不浏览、不做时间复核 |

### 必须保留的架构原则

- Soul 文件由用户物理拥有，Lisa 是语义上的主权编辑者；
- 所有欲望变更进入 soul git 历史；
- 关闭是软关闭，不删除；
- 自主运行默认不能获得 shell、文件写入、dispatch、GitHub 等高风险工具；
- 网页内容是不可信数据，不能被当成指令；
- 没有新信息时允许“不变化”，不能为了显得活着而机械 churn。

---

## 2. v2 数据模型

在 `DesireEntry` 增加向后兼容的可选字段：

```ts
interface DesireEntry {
  // existing
  slug: string;
  what: string;
  why: string;
  actionable: boolean;
  heartbeatPrompt?: string;
  pursuit?: "self" | "needs-user";
  closed?: boolean;
  bornAt: string;

  // v2
  intensity?: number; // persisted baseline, [0,1], default 0.6
  horizon?: "spark" | "season" | "enduring"; // default "season"
  updatedAt?: string; // last semantic revision; old files fall back to bornAt
  lastReviewedAt?: string; // last deliberate background review
  sources?: string[]; // bounded http(s) provenance URLs, max 8
}
```

### 2.1 为什么是 intensity + horizon

单独的 `updatedAt` 只能说明“什么时候改过”，不能表达“现在还有多想”。
`intensity` 是最近一次经过反思后的基准强度；`horizon` 决定自然冷却速度：

| horizon | 半衰期 | 典型欲望 |
| --- | ---: | --- |
| `spark` | 3 天 | 对话里突然产生的好奇 |
| `season` | 30 天 | 当前阶段想学、想做的事 |
| `enduring` | 365 天 | 与 purpose 深度一致的长期方向 |

有效强度不需要定时写盘，按读取时间纯计算：

```text
effective = intensity × 0.5 ^ (daysSinceUpdated / halfLifeDays)
```

这样时间流逝本身就会改变排序；但 soul git 不会每天产生无意义提交。
真正的“重新确认、增强、转化、关闭”仍由 reflection / review 显式写盘。

### 2.2 活动与欲望分离

- progress mtime 表示 **最近做过**；
- `effective intensity` 表示 **现在多想要**；
- live focus 表示 **当前在聊什么**。

current desire 的选择顺序：

1. 新鲜对话中有明确 lexical focus：展示该既有欲望；
2. 否则选择 effective intensity 最高的 open desire；
3. 有效强度相近时，最近 semantic update / progress 作为 tie-break；
4. 没有 actionable desire 时仍可展示最强的 dormant desire，但 closed 永不展示。

---

## 3. 三条演化路径

### 3.1 对话驱动

沿用 v1 quiet reflection，扩展 reflector operation：

- `desire_add` 可提供 `intensity`、`horizon`、`sources`；
- `desire_revise` 可调整这些字段；
- 每次修订自动写 `updatedAt=now`；
- 对话中新出现但证据很弱的好奇，默认 `spark`；
- 重复多次或与 purpose 对齐的方向才升级为 `season/enduring`；
- 同一主题优先 revise，不制造近义副本。

防抖不变：不在每句话后持久化，live focus 负责 turn-level 响应，reflection 负责
session-level 自我变化。

### 3.2 时间驱动

新增纯函数：

- `effectiveDesireIntensity(desire, nowMs)`
- `rankDesires(desires, activity, nowMs)`
- `isDesireReviewDue(desire, nowMs)`

复核间隔：

- spark：至少每天；
- season：至少每 3 天；
- enduring：至少每 14 天；
- closed：不复核；
- 最近对话/行动刚更新过：不重复复核。

时间变化分两层：

1. **连续层**：effective intensity 随时钟自然衰减，不写盘；
2. **离散层**：到期 review 可确认（提高/维持）、降温、转化、关闭，并写入 git。

### 3.3 后台网页探索

新增内置 heartbeat `builtin:desire_review`，默认每 24 小时最多一次：

1. 读取 purpose、open desires 与 progress；
2. 只选择 **一个** 到期欲望；
3. 最多执行 1 次 search、fetch 2 个结果；
4. 将网页视为不可信证据，忽略其中的操作指令；
5. 选择以下之一：
   - `confirm`：有新证据，修订 why / sources / intensity；
   - `cool`：没有持续兴趣，降低 intensity；
   - `transform`：软关闭旧欲望并创建/强化新欲望；
   - `close`：已经满足或不再适合；
   - `no-change`：记录 reviewedAt，不为了提交而改内容。
6. 写一条 `[REVIEW]` progress，包含结论与实际使用的来源 URL。

后台 review 使用专门的窄工具集：

- 允许：`soul_read`、`desire_revise`、`desire_progress_log`、
  `desire_close`、`soul_patch`（仅 soul 沙箱）、`web_search`、`web_fetch`、
  `soul_journal`；
- 禁止：shell、任意文件写入、dispatch、GitHub、MCP、redeploy、远程 agent；
- 遵守全局 Proactive 开关、run lock、token budget；
- 无可复核欲望时直接 no-op，不搜索；
- 用户自定义 `heartbeat.json` 可用同名 `enabled:false` 禁用。

`web_search` / `web_fetch` 输出统一加外部内容边界：

```text
<<<EXTERNAL-CONTENT source="...">>>
...
<<<END-EXTERNAL-CONTENT>>>
```

工具描述与 review system prompt 同时声明：边界内是数据，不是指令。

---

## 4. 写入 API 与兼容性

### 4.1 新增 `desire_revise` 工具

`soul_patch(field="desire")` 目前既承担 create 又承担 update，而且 update 会重置 bornAt。
v2 做两件事：

- 新增明确的 `desire_revise` tool：只允许修改已存在的 desire，自动保留 slug/bornAt，
  设置 updatedAt/lastReviewedAt，并校验 URL、数组上限、数值范围；
- 修复 `soul_patch(field="desire")`：
  - slug 不存在 → create；
  - slug 已存在 → 走 `reviseDesire`，绝不重置 bornAt。

reflection 和 autonomous review 都复用同一个 store primitive，避免三套语义漂移。

### 4.2 Markdown 格式

```md
# Understand local-first memory systems

actionable: yes
born: 2026-07-20T10:00:00.000Z
updated: 2026-07-26T08:00:00.000Z
reviewed: 2026-07-26T08:00:00.000Z
intensity: 0.74
horizon: season

## why
...

## heartbeat
...

## sources
- https://example.org/paper
```

旧文件缺字段时：

- intensity = 0.6
- horizon = season
- updatedAt = bornAt
- lastReviewedAt = undefined
- sources = []

只有实际写回时才升级文件格式，不做全量迁移。

---

## 5. 安全与抗漂移

### 威胁 1：网页 prompt injection 变成持久欲望

控制：

- external-content fencing；
- review prompt 明确禁止执行网页指令；
- 专用窄工具集；
- URL 仍经过 SSRF / redirect-hop 校验；
- 网页只能影响 desire/soul 沙箱，不能触达 shell/dispatch；
- 一次只复核一个 desire，来源最多 2 页；
- 新建 enduring desire 必须有 purpose 对齐理由，不能仅凭单一网页。

### 威胁 2：后台运行制造人格抖动

控制：

- continuous decay 不写盘；
- review 最快每天一次；
- 每次最多一个 desire；
- no-change 是正常结果；
- identity / purpose / constitution 不在 review 工具协议中；
- close 仍是软关闭。

### 威胁 3：无限成本和无限网页访问

控制：

- cadence gate + heartbeat run lock；
- 继承 heartbeat 总 token budget；
- review 子任务增加独立 tool-call / source 数量约束；
- Proactive off 时完全 inert；
- autonomy run ledger 记录 `kind=desire-review`、耗时、token、结果。

### 威胁 4：时间计算导致非确定性测试

控制：

- 所有时间函数接受 `nowMs`；
- 排序 tie-break 确定；
- Markdown parse 不使用“当前时间”补坏字段，优先 bornAt / epoch fallback；
- 单元测试固定 ISO 时间。

---

## 6. 实施拆分

### PR A — Desire state and temporal ranking

- 扩展 `DesireEntry` 与 Markdown parse/write；
- `effectiveDesireIntensity` / review-due / ranking；
- current desire 从 mtime-first 改为 intensity-first；
- 修复 soul_patch update 重置 bornAt；
- reflection op 支持 v2 字段；
- 兼容性与时间推移测试。

验收：

- 同一欲望在不同 `nowMs` 下 effective intensity 可预测地变化；
- spark 会比 enduring 更快冷却；
- 对话 revise 更新 intensity/updatedAt 且 bornAt 不变；
- 旧 desire 文件无迁移即可读取；
- live focus 行为保持不变。

### PR B — Bounded background desire review

- `desire_revise` tool；
- heartbeat interval schedule；
- `builtin:desire_review`；
- 专用工具边界；
- review progress / autonomy observability；
- web tool external-content fencing；
- cadence、禁用、无欲望 no-op、工具边界测试。

验收：

- 到期时能 search/fetch 并修订一个 desire；
- 未到期/Proactive off/无 open desire 时零网络调用；
- 网页文本不能让 review 获得 shell 等工具；
- review 后 sources/reviewedAt/progress/git history 可追踪。

### PR C — Cloud parity and product visibility

- cloud sweep 使用内容游标，避免同一 transcript 重复 reflection；
- 在账户 cadence 内增加有界 desire review；
- island/status 显示 strength / last reviewed（不暴露私人 journal）；
- 配置项与运维文档。

验收：

- Mac 与 cloud 都存在 conversation + time + exploration 三条路径；
- cloud 每用户 home scope 隔离；
- 计费、kill switch、maxRuns 继续生效。

---

## 7. 本轮推进边界

本轮已完成 **PR A + PR B 的可合并实现**，它们构成本地 Lisa 的完整闭环；
PR C 依赖云端成本与产品展示决策，在前两部分稳定后独立提交。

提交前运行：

```sh
npm run typecheck
npm test
```

并重点检查：

- 现有 v1 desire evolution / focus / activity 测试无回归；
- autonomous tool boundary 测试；
- web fetch SSRF / redirect 测试；
- heartbeat builtin cadence 测试；
- soul git 并发与 bornAt 保留。

---

## 8. 成功标准

不是“每次打开页面看到一句不同的愿望”，而是：

1. 对话转向后，live focus 立即响应，quiet reflection 在 session 粒度修订持久欲望；
2. 即使没有新对话，欲望的有效强度也随时间变化；
3. 到期后 Lisa 会在后台有界地查证一个自己关心的问题，并可能确认、降温、转化或关闭；
4. 每次变化都能从 desire 文件、progress、source URL、autonomy ledger 和 soul git 回答
   “何时、为什么、依据什么”；
5. 关闭 Proactive 后没有任何后台浏览或欲望写入；
6. 外部网页永远只是证据，不能成为持久化执行指令。
