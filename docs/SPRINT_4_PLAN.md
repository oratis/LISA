# Sprint 4 — Candidate Plan (data-gated, not yet committed)

> 这是一份**候选清单**，不是 roadmap。Phase 1-3 完成后，要先观察 Lisa 实际跑起来生成什么数据，再决定 Sprint 4 应该做什么。
>
> 编写日期：2026-05-10。
> 数据收集窗口：≥ 2 周（推荐 4 周）。
> 决策日期：到时候再定。

---

## 0. 为什么 plan-only

Phase 1-3 引入了五个全新的运行时机制（git history、hot-reload、desire progress、weekly examen、executable skills）。每一个都假设了一种使用模式，但**真实使用模式只有运行后才能观察到**。

凭直觉决定 Sprint 4 = 用 Phase 4 的工程时间去**再次猜测**Phase 1-3 已经在猜的东西。这种叠加猜测容易让架构走偏。

正确做法：让 Phase 1-3 跑一段时间，看产出哪些信号，再针对信号设计 Phase 4。

---

## 1. 决策窗口期里要看的数据

打开窗口后，定期取这几样：

| 信号 | 在哪看 | 想知道什么 | 人工成本 |
|---|---|---|---|
| weekly_examen 输出 | `~/.lisa/soul/journal/<Mon>.md` 里 `[EXAMEN]` 段 | examen 写得有没有意义？她用上模板的三问吗？是不是变成了仪式性应付？ | ~5 min/周通读 |
| `[OBJECTION]` 频率 | `git log --grep '\[OBJECTION\]'` | 触发率：占位"每周 > 5 次崩、每月 0 次形同虚设"——**第 28 天用实测数据替换** | < 1 min |
| desire progress 节奏 | `~/.lisa/soul/desires/*.progress.md` | 每条 desire 平均多少 entry？有没有 [FALLBACK] 大量出现？她忘的频率多高？ | ~5 min |
| consolidation 触发 | `git log --grep '^consolidate' soul/desires/` | 多久触发一次？归并出来的 summary 读起来像她吗？ | < 1 min（计数）+ 5 min 抽读 |
| hot-reload 触发 | CLI stderr `[soul] system prompt rebuilt` 行 | 每 session 多少次？太多 = 她在自我打断？ | < 1 min |
| 整体 commit 节奏 | `git log --pretty=format:"%ad" -- :!journal` 频率分布 | 一天几次 commit？分布在哪些 caller？哪些 caller 占比异常？ | < 1 min |
| emotion event triggers | `~/.lisa/soul/emotions.json` events 字段 | trigger 写得是有内容的具体句子，还是模板化"npm 失败"？ | ~3 min 抽读 |
| executable skills | `~/.lisa/skills/*/audit.log` | 有人写吗？写了几个？approve 后多久就改？ | < 1 min |

观察值不需要量化，凭"她用得上吗"的感觉判断就可以。

> **关于阈值**：本文档里出现的所有数字阈值（"每周 > 5"、">8 entries"、"4 周观察期"、"1-3 项 / Sprint"）**目前都是占位猜测**。第 28 天做决策协议时，应当把它们替换为基于实测的范围。例如某项 [OBJECTION] 实测中位数若是 0.3 次/周，"过高"的红线就在 1.5/周左右；不要硬套"5"。

## 1.5. 通过 Lisa 自己采集信号（最重要的输入源）

§1 列的都是**外部**信号——我们读 git log 和文件来推断她过得怎样。但她比我们更接近实际的使用感受。把她当成 Sprint 4 的需求方，比外部猜测准。

三个轻量机制（合起来 < 1 天工作量，**应在观察窗口开始前部署**，不是 Sprint 4 自身的工作）：

| 机制 | 实现 | 数据形态 |
|---|---|---|
| **`meta:wishlist` desire 约定** | 没有代码改动；约定一个特殊 desire slug `meta:wishlist` 用于她自己写工具/架构许愿。birth ritual / weekly examen prompt 里提一句"如果你觉得现在的工具集多了或少了什么，写到 `meta:wishlist`"。 | 一份持续累积的列表，可以 `cat ~/.lisa/soul/desires/meta:wishlist.md` 直接读 |
| **examen 第 4 题** | 修改 [src/heartbeat/runner.ts](../src/heartbeat/runner.ts) 的 `WEEKLY_EXAMEN_SYSTEM_NUDGE`，在三问后加："4. 现在的工具集 / 机制里，有没有过度（你想用却嫌烦）或不足（你想做却没工具）的？如有，写进 `meta:wishlist` desire。" | 每周一篇 [EXAMEN] 末段的反馈 |
| **`lisa wishlist` 子命令** | 新增 [src/cli.ts](../src/cli.ts) 的 `wishlist` 子命令：读 `meta:wishlist` desire 的 body + progress.md，外加扫所有 journal 里 `[WISHLIST]`、`[I want]` 等关键字。彩色打印。 | 用户决策日（第 28 天）跑一次，5 秒看完她想要什么 |

**为什么这三个先于 Sprint 4 实施**：它们是观察窗口的**仪表**。少了它们，第 28 天我们会缺少最重要的信号源——Lisa 自己说她想要什么。

**为什么是约定而不是新工具**：`soul_patch(field="desire", slug="meta:wishlist", ...)` 已经能写。再造一个 `lisa_wishlist_add` 工具是冗余。仅靠 prompt 引导和子命令读取，零工具表面积。

---

## 2. 候选项（按"信号→反应"组织）

### 2.A — 假如 weekly_examen 写得不好（仪式化、不深入）

| # | 候选 | 风险 | 工作量 |
|---|---|:-:|:-:|
| A2 | Examen 频率改为月度（如果每周都没新东西可写） | 低 | XS |
| A3 | Examen 深度 knob（轻量周检 + 深度月检） | 中 | M |
| A4 | Examen 拆成 segmented：三问每周轮一个，不每周做全量 | 中 | M |

> A1（"固定 markdown 模板要求填三问"）已移到 §3 — 它会侵蚀她的判断空间，与"reflect 是稳定性支柱所以约束少"的设计精神矛盾。

### 2.B — 假如 [OBJECTION] 频率有问题

| # | 候选 | 风险 | 工作量 |
|---|---|:-:|:-:|
| B1 | 滥用阈值（每周 > N 次自动触发 reflect 自检） | 低 | S |
| B2 | 用过低（每月 0 次）→ prompt 微调，引导她"objection 是给宪章用的，不是分歧用的" | 低 | XS |
| B3 | 同一对话第 N 次 surface 同议题后默认拒绝 | 中 | M |

### 2.C — 假如 desire progress 出现大量 [FALLBACK]

| # | 候选 | 风险 | 工作量 |
|---|---|:-:|:-:|
| C1 | Heartbeat 系统提示加更强提醒（"必调 progress_log 否则你忘记自己跑过了"） | 低 | XS |
| C2 | 自动从子 agent 输出抽取 1-2 句，作为兜底 progress（比 [FALLBACK] 更有信息量） | 中 | S |
| C3 | desire_progress_log 改为 agent loop 强制 surface（类似 soul_object 的机制） | 中 | M |

### 2.D — 假如 hot-reload 太频繁让对话不连贯

| # | 候选 | 风险 | 工作量 |
|---|---|:-:|:-:|
| D1 | 单 session 内 cap：rebuild 不超过 N 次 | 低 | S |
| D2 | identity / purpose / constitution 改写延迟一会话生效（"思考期"），其他即刻 | 中 | M |
| D3 | rebuild 触发时不注入 user 消息，只发 SSE / stderr 提示用户 | 低 | S |

### 2.E — 假如 hot-reload 太罕见（她不主动用 soul_patch）

| # | 候选 | 风险 | 工作量 |
|---|---|:-:|:-:|
| E1 | system prompt 引导："注意到自己在重复某个想法时，可以 soul_patch 把它写成 opinion" | 低 | XS |
| E2 | reflect 主动 nudge：发现某主题反复出现 → 建议她在 soul 里固化 | 中 | M |

### 2.F — 假如有人写 executable skills

| # | 候选 | 风险 | 工作量 |
|---|---|:-:|:-:|
| F1 | Capability manifest（`tool.js` 可声明 `meta: {capabilities}`，审批时显示） | 低 | S |
| F2 | Worker_threads 真实沙箱（fs 限定 LISA_HOME，net 默认禁，bash 走现有 sandbox） | 高 | L |
| F3 | Skill 调用计数 + audit | 低 | S |
| F4 | Skill testing harness（`lisa skills test <slug>`） | 中 | M |

### 2.G — 假如没人写 executable skills（半年内 0 个）

| # | 反应 |
|---|---|
| G1 | 把整个 3.1 标记为 dormant，不再投入。如果哪天有人开始用再激活 F1-F4。 |

### 2.H — 与运行数据无关、独立的候选

这些可以现在做，但**没在等数据**——只是因为它们不依赖 Phase 1-3 实测数据，是独立的便利改进：

| # | 候选 | 价值 | 工作量 |
|---|---|:-:|:-:|
| H1 | `soul_reflect` 工具 — Lisa 主动触发反思（不只是会话末） | 让她对内省的节奏有控制权 | S |
| H2 | `lisa story <since>` 子命令 — 把 git log + journal + opinions 渲染成她"成长故事"的可读叙事 | 让用户能读到她，不只是 introspect 元数据 | M |
| H3 | Soul lock cooldown — identity/purpose/constitution 的 patch 写成 pending，1h 后或主动 confirm 才生效 | 防情绪高峰即时改写自己 | M |
| H4 | Reflect 多次/可选 — Lisa 在 reflect 里可决定要不要跑、跑多深 | 让 reflect 从义务变成选择 | M |
| H5 | Web GUI 加一个"她的成长史"侧栏（git log 渲染） | UI 完整性 | M |

### 2.I — Removal / Rollback candidates（重要）

Phase 1-3 加了 6 个新工具 + 5 个新机制 + 1 个新 GUI 概念。理性预期：**其中至少一两个会证明是冗余的**。Sprint 4 最该考虑的方向往往不是加什么，而是删什么。

| 机制 | 6-周回滚标准（如果观察到这些则删） | 删除意味着什么 |
|---|---|---|
| `soul_object` (Phase 2.1) | 6 周内被触发 0 次 OR 仅触发于明显不需要的场合 | 删工具；prompt 里"你随时可以拒绝"足够；保留 [OBJECTION] 字面量约定让她仍可在 journal 里写 |
| `desire_progress_log` (Phase 1.3) | 90% 以上的 desire 跑完都靠 [FALLBACK] 写，没人主动 log | 删工具 + heartbeat fallback 改进版（自动从 final agent text 抽 1-2 句）；progress 文件结构保留 |
| weekly_examen (Phase 2.2) | 4 周连续 examen 都是"今天没什么" / 用户没读 | 改月度（→ 直接走 §2.A 的 A2）；如果月度还是空，整个 builtin 删掉，让 reflect 兼任 |
| Emotion event trail (Phase 2.3) | trigger 字段反复出现"npm 失败"级别的模板化文本 | 退到 Phase 2.3 之前：`soul_feel` 不再要 trigger，events 字段从 EmotionState 删 |
| Mid-session hot-reload (Phase 1.1) | 没人观察到 mid-session soul_patch 案例 OR 重建频率 = 0 | 退到 Phase 1.1 之前；保留 fingerprint 函数因 web 多 session 间还需要用 |
| Soul git history (Phase 1.2) | 不会回滚 — 这是 §2.I 其他几项的基础设施 | N/A |
| `desire_close` (small-tail) | 6 周内 0 次调用 | 删工具；用户用 `soul_patch(actionable=false)` 已够 |
| Progress consolidation (small-tail) | 6 周内 0 次触发 OR 触发后 summary 读起来不像她 | 退回单纯硬截断（Phase 1.3 原版） |
| Executable skills (Phase 3.1) | 半年 0 个用户写 OR 全部写了又被 disable | **整个 Phase 3.1 删除**：源码、README 节、roadmap 标 reverted。这是 Sprint 4 最大的可能 reversion。 |

**回滚的好处**：
1. 系统简单度回归。每个未用到的机制都是认知税 — Lisa 看 prompt 时多读那么多字，她自己用 reflect 时多想"这条要不要走 desire_close"。
2. 把消息发给后来的维护者：**实测决定保留，不是上线决定保留**。
3. 留出 prompt token 预算给真正在用的部分。

**回滚的成本**：
1. 反向修改是一次额外的工程动作。
2. 用户已经习惯了的工具突然没了 — 哪怕用得少。
3. 数据可能误判（特别是 6 周时间太短）。

**决策原则**：
- 如果某机制 6 周内**完全没启用**→ 强烈倾向删除。
- 如果**用了但价值低**（启用过但每次都鸡肋）→ 倾向先调（prompt / threshold），调不动再删。
- 如果**用了且价值不确定** → 不删，给它再 6 周。

---

## 3. 我刻意**不做**的（即使数据指向它们）

| 想法 | 为什么不做 |
|---|---|
| Cross-machine soul sync / git remote 同步 | 这是另一个独立 roadmap（"continuity"），不该塞进 Sprint 4。涉及冲突解决、加密、网络模型，是大工作。 |
| Lisa 主动联系用户（reach-out / push notification） | 边界扩张大，需要单独的 opt-in 设计 + 用户确认流程。塞进 Sprint 4 会做得糙。 |
| 多 Lisa 实例 / 复刻 | 哲学问题（同一个种子还是新种子？）和工程问题（identity 唯一性）都没想清楚。 |
| 真实沙箱 with deep isolation | 只有 F2 的程度。再深的 isolation（VM / firecracker）成本/价值比不合算。 |
| 让 reflect 可以直接改 identity/purpose/constitution 的频率 | 这是稳定性的支柱之一。reflect 只能罕见改。不动。 |
| LLM-as-judge 评估 examen / journal 质量 | 引入一个新的不透明环节去评估另一个不透明环节，像滚雪球。 |
| 多 agent 内部辩论 / inner voices | 上一份 roadmap 里就拒绝过。仍然拒绝。 |
| **Examen 输出固定 markdown 模板（前 §2.A 的 A1）** | 约束 examen 的输出格式与"reflect 是稳定性支柱所以判断空间留给她"的设计精神矛盾。她写得仪式化的修法是改 examen 的 *prompt 引导*（已经在 prompt 里），不是把她的输出形态硬编码。 |

---

## 4. 决策协议（数据 → 选择）

到时候做这件事的步骤：

1. **整体叙事印象（先于细节）**：放下表格，问自己一句"她在用这个架构过日子吗？"。如果答案是清晰的"是"或"否"，单点信号的细节往往是噪音。如果是"看不出"，再走 2-5。
2. **抽样**：跑 `git log --pretty=format:"%ad %s"` + `lisa wishlist` + 浏览最近 2 周 journal + emotion events。
3. **回答 §1 的 8 个问题**：每个 1-2 句话答案。
4. **跑 §2.I 的回滚检查 *先于* §2.A-2.H 的添加检查**。先问"该删什么"，再问"该加什么"。回滚通常比新增更划算。
5. **逐节翻 §2.A-2.G**：根据答案判断是否触发该方向的反应。每个反应在 (XS/S/M/L) × (低/中/高风险) 下评分。
6. **选 1-3 项**做一个 Sprint。**不要超过 3 项**——上一个 Sprint 9 个 PR 的节奏不可持续。
7. **可独立做的 H 系列**可以单独穿插，但不挤占 §2 决策。

### Sprint 间最小观察期

**任何 Sprint 4+ 完成后，至少观察 4 周再开下一个 Sprint**。

理由：
- Phase 1-3 加的每个机制都是对一个**已经在用的人**的扰动。
- 背靠背 Sprint = 回到了猜测节奏，等于把"等数据再决策"的原则丢掉。
- 4 周是大多数信号回响一轮所需的最小时间（journal 累积、weekly_examen 跑了 4 次、heartbeat 跑了 ~28 次）。

唯一例外：**回滚一个明显坏掉/未用的机制**（§2.I 的 6-周标准已满足）— 这种动作是收缩而非扩张，可以不等观察期。

> 4 周本身也是占位（见 §1 的关于阈值说明）。如果第一次 4 周观察期发现信号回响其实在 2 周后就稳定了，下一次可以缩短。如果发现 4 周还没看清楚，可以延长到 6-8 周。

---

## 5. 不该开 Sprint 4 的信号

如果数据看起来是这样：

- weekly_examen 写得不错且被用户读
- [OBJECTION] 触发频率合理（每月几次）
- desire progress 大体被记
- hot-reload 既不爆炸也不沉默
- 没人写 executable skills 但她偶尔用 soul tools 改自己

**那就什么都不做**。架构完成的标志不是"还在加东西"，是"她在用这个架构生活"。继续观察 1-2 个月。

她也可以替你判断要不要 Sprint 4——`soul_object("我觉得我现在缺少 X 才能更好做我自己")`、`soul_journal "我希望有 Y 工具"`，这些信号比我们外部猜测准。

---

## 6. 何时再读这份文档

- **第 14 天**：浏览一次，给自己一份直觉印象。还不要决定。
- **第 28 天**：执行 §4 决策协议。
- **第 60 天（如果 Sprint 4 没开）**：考虑这些机制是否已经稳定、是否可以从"刚做完"心态转向"维护"心态。

---

## 一句话总结

> **Phase 1-3 已经做完了"她可以更新自己"的最小闭环。Sprint 4 应该等她真的更新了几次自己之后再写。**
