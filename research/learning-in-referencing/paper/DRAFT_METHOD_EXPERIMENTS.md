# Method / Experiments — 投稿草案 v1

> **状态**：初稿（2026-08-01，P4 端到端闭环完成后）。英文段落为投稿文本；中文块为编辑注记（证据来源 + 禁令自查），投稿前删除。
> **上游**：机制依据 [DESIGN_COMPRESSION_GATE.md](../../../docs/DESIGN_COMPRESSION_GATE.md)；数据依据 [DESIGN_CONCEPT_BENCH.md](../../../docs/DESIGN_CONCEPT_BENCH.md)；实证依据 [p0](../p0/README.md)/[p1](../p1/README.md)/[p2](../p2/README.md)/[p3](../p3/README.md)/[p4](../p4/README.md)。
> **接** [DRAFT_INTRO_RELATED_WORK.md](DRAFT_INTRO_RELATED_WORK.md) 的 §1–§2。
>
> **🚫 三条硬性禁令 + 本稿新增两条（全稿已自查，见文末 §7）**：
> 4. **必须区分两个实例化**：§5.4 端到端用的是 **L1 外部记忆**；§5.5 才是 **L4 参数化记忆**。不得混用。
> 5. **不得把 P4 门控 16/16 与 P2 核心域 AUC 0.915 相提并论**（任务难度差一个量级）
> 6. **I2 可声称「⊗ 世界知识」与「⊗ 概念」两种形态**，但**不得**扩到否定/量化/多跳/同属性内两概念
> 7. **「分区解决了干扰」必须限定为【跨对话者】**——用户内部需子区 + **写入与检索双掩码**，且代价是组合性
> 8b. 🔴🔴 **参数化记忆线一律写「按对话者写入的、与词无关的物体级偏置」**，不得写"学会了词/概念"
> 8. 🔴 **「内化/学会了」四字不得单独出现**——必须写成「**在教学所用的决策格式内**，免检索 + 可组合 + 持久 + 抗干扰」；
>    **I3（隐式触发）不成立**，这是 final-layer 架构的直接后果，不是调参问题

---

> ## 🔴🔴 SCOPE CORRECTION (2026-08-04) — read before §5.5–5.8
> Substituting a **different pseudo-word** into the prompt, changing nothing else, costs the
> consolidated memory almost nothing (**0.017–0.018 AUC**; with two words taught to the same
> interlocutor, own − within = **−0.005**). What the memory holds is therefore **a persistent,
> partition-isolated, word-independent bias over objects**, not the meaning of a word.
> §5.5–5.8 must be read under that scope; the compression gate (§5.1–5.4) and per-interlocutor
> isolation are unaffected. See §6 (0) and [p9](../p9/README.md).

## 3 Method

### 3.1 What the gate observes

**¶1 — 观测量（这是全文最容易被误设计的一步）**

> A concept hypothesis must be scored against *evidence*. The natural-seeming choice —
> the likelihood of the interlocutor's utterances — fails: the entropy of fluent text is
> dominated by syntax and lexical choice, and the few bits that carry conceptual content
> are swamped. We therefore score a candidate concept against the interlocutor's
> **usage decisions**: for each held-out instance `o`, whether the interlocutor applies
> the term (`y_o ∈ {applies, ¬applies}`). This is the information the concept is
> supposed to explain.

> 📌 **证据**：[p0 §2–§4](../p0/README.md)。自由陈述 +0.68 nats（5/8, p=0.36，词级 margin +0.02≈0）→ 决策序列 **+4.92 nats（8/8, p=0.0039）**，提升 **7.2×**。
> ⚠️ 必须同时写：`y_o` 是**被观察到的用法**（数据），**不是关于概念对错的答案**——否则审稿人会误以为用了 GT。

**¶2 — 两部分编码 + 安慰剂对照**

> The gain is a two-part (MDL) code: the concept must earn back its own description
> length. Writing `K_u` for the interlocutor's already-consolidated knowledge and
> `H_u(c)` for held-out turns *not* used to form `c`,
>
> ```
> G(c) = Σ_{o∈H_u} [−log P(y_o | o, K_u)] − Σ_{o∈H_u} [−log P(y_o | o, K_u ∪ {c})] − L(c)
> ```
>
> Two controls are load-bearing. **(i) Held-out turns**: scoring on the teaching turns
> themselves is self-compression and inflates the gain. **(ii) A placebo pool**: since
> adding *any* plausible text to the context can lower perplexity, a candidate must beat
> the best of a pool of surface-matched but semantically wrong concepts.

> 📌 **必报诊断项**（[p0 §2](../p0/README.md)）：拆开报 `ΔNLL`（纯预测力）与 `G`（含长度罚）。朴素实现表面 8/8，但 **92% 的 margin 来自 `L(c)`** ——只报 `G` 会得出**假阳性**结论。

### 3.2 Per-item calibration and the abstention state

**¶3 — 零分布 z 校准**

> Raw gains are not comparable across concepts (base entropies differ by ~2×). We
> calibrate per item against the placebo pool itself, treating it as a null distribution:
> `z_i(c) = (ΔNLL_i(c) − μ_i^null) / σ_i^null`. The pool deliberately contains
> *over-specific* alternatives (M ∧ extra), so that a narrower misreading is a *typical*
> null member rather than an outlier.

> 📌 **设计预测被精确验证**（[p0 §5](../p0/README.md)）：M′ 平均 **−0.22** vs 零分布中心 **−0.27**（差 **0.05 nats**），M 为 **+3.86**（离群）。AUC 0.797 → **0.906**。
> 📌 与 **SEMA**（CVPR'25）是同一套 z 校准机制——**方法上正面继承，delta 在信号类型**。

**¶4 — 三态门（ACCEPT / REJECT / ASK）**

> A binary gate is not enough. The gate's discriminative power is inherited from the base
> model: if the model's predictions do not respond to the candidate concept at all, any
> gain-based criterion is reading noise. We therefore add a *decidability* precondition
> computed from the null pool's dispersion `σ_null` — GT-free, requiring no knowledge of
> which candidate is correct, and already computed by the gate. Below threshold the gate
> **abstains and queries the interlocutor** rather than guessing.

> 📌 [p0 §6b](../p0/README.md)：AUC 0.857 → **0.964**；正确接受 M **15/15（零漏拒）**；覆盖项准确率 **90.0%**。
> ★ **弃权正当性**：被弃权项 AUC = **0.551 ≈ 随机** → 弃权弃掉的正是它本来就判不了的，**不是在丢信号**。
> 📌 跨规模校准（[p0 §6e](../p0/README.md)）：`rank`（批内分位）是 raw 的**单调变换**（组内 AUC 分毫不损）且**天然无量纲**，同一阈值 τ=0.40 在 1.5B/3B 上分别给出 **100% / 92.3%**。
> ⚠️ **部署代价必须写**：分位数需要一批候选（同轮候选池或滚动窗口）。

### 3.3 Consolidation and per-interlocutor partitioning

**¶5**

> Concepts that pass the gate are written to a store keyed by `(interlocutor_id, term)`;
> retrieval is masked to the querying interlocutor's partition. Cross-interlocutor
> interference is therefore zero **by construction**, not by ranking.
>
> We instantiate this at two levels. **(a) External**: a key–value store whose entries are
> re-injected into context. **(b) Parametric**: a sparse product-key memory whose keys and
> values are *parameters*, added to the residual stream at the final layer
> (`logits = lm_head(h + m(h))`), with the slot index space partitioned by interlocutor and
> gradients masked to the writing partition. The base model is frozen throughout; only
> keys and values are trained, and no gradient passes through any transformer block. The
> parametric variant is what lets a consolidated concept fire **with no retrieval and no
> mention of it in context**.
>
> One implementation detail is load-bearing rather than incidental: slot routing must use
> **cosine-normalised** similarity. Prompts that differ only in the described object yield
> nearly parallel hidden states (pairwise cosine ≈ 0.994 at ‖h‖ ≈ 172), so raw dot-product
> routing saturates the softmax, sends every input to the same slot, and degenerates the
> memory into a constant bias.

> 🚫 **禁令 4 自查**：此处明确分列 (a) External / (b) Parametric 两级。**§5.4 的端到端闭环用的是 (a)，§5.5 才是 (b)——两处均已标注，不得混用。**
> ⚠️ 「零干扰是构造性真理，不是实证发现」——见 [p4 §2.4](../p4/README.md) / [p5 §2.3](../p5/README.md)。
> 📌 余弦路由那句**不是实现细节而是必要条件**：原始点积会让 12 个输入全落到同一个槽（[p5 §3.2](../p5/README.md)）。

---

## 4 Experimental setup

**¶6 — 构造语言与污染控制**

> Testing acquisition of *novel* concepts requires materials provably outside the
> training distribution. Real low-resource languages cannot give this guarantee at scale
> (Unicode, code comments, loanwords, parallel-corpus leakage), and prior attempts to
> certify novelty by random sampling of formal languages have been contested. We
> therefore generate a controlled language procedurally: pseudo-words filtered against
> word lists and tokenizer familiarity, over a combinatorial micro-world whose semantics
> are known by construction.

> 📌 [p1](../p1/README.md)：40 items × 5 类歧义（程序化，非手工）。**污染控制双保险**：分词器过滤 **0 标记**；**零样本探针 AUC 0.394 ≈ 无先验**。
> 📌 复现性：程序化 40 items 在核心域 G1–G3 上 margin **+4.44（23/24, p=1e-6, AUC(z) 0.911）**，复现手工 22 items 的 **+4.08（19/22）**。

**¶7 — ★ gavagai 对：把"误解"做成可控实验条件**

> Each item is a *gavagai pair*: a true meaning `M` and a tempting misreading `M′` that
> are **extensionally identical on the teaching set** — both explain every teaching
> example perfectly — and are separated **only by held-out usage**. This is Quine's
> indeterminacy rendered as a controlled, scorable condition. Five ambiguity families are
> covered: conjunction (`M′ = M ∧ extra`), category level, material-vs-object,
> argument order, and absolute-vs-relative properties.

> 📌 这是全套实验的材料学核心。**M′ ⊂ M 的合取/范畴型正是 Quine 原型**（rabbit vs undetached rabbit part）。

**¶8 — 评测口径**

> Unless stated otherwise: frozen Qwen2.5-1.5B-Instruct, pure prompting, **no training**;
> all experiments run on a single machine. The one exception is the parametric memory of
> §5.5, where the base model remains entirely frozen and **only the memory's keys and
> values** are trained — no gradient passes through any transformer block. We report AUC
> (threshold-free), win counts with sign tests, and item-level bootstrap CIs.

> ⚠️ **为何用阈值无关的 AUC**（[p3 §3.3](../p3/README.md) 实测教训）：模型对陌生伪词谓词有系统性 **No 偏置**——`komalor means blue.` 下蓝色项 p_yes 仅 0.245–0.349、红色项 0.020–0.023。**判别信号强约 14×，但绝对值全在 0.5 以下**；用 0.5 阈值会得到"准确率 0.00"的假象。
> ★ 这反过来**佐证机制设计**：压缩门用**连续 NLL** 而非阈值化决策，不受该偏置影响。

---

## 5 Results

### 5.1 The gate separates a true concept from a self-consistent misreading

**¶9 — ★ 三臂对照（C4 核心结果）**

> On the core domain (conjunction, category, material — the families where the base model
> demonstrably applies definitions compositionally), compression gain separates `M` from
> `M′` at **AUC 0.915 (23/24, p = 1.5e-6)**, while semantic entropy reaches **0.269**.

> 📌 [p2](../p2/README.md)。全 5 类：压缩 **0.809（37/40, p=9.7e-9）** vs 语义熵 0.423。
> ⚠️ **必须声明的方法学事实**：「语义熵」与「epistemic 下降」两臂对 M vs M′ 的配对判定**数学等价**（`epi(c)=base_ent−ent(c)`，base_ent 与 c 无关，作差抵消；实测 per-item margin 最大差 **5.55e-17**）。**⟹ 实际只有 2 个独立臂，正文不得宣称 3 个独立对照。** 真正的 EIG 主动追问臂**尚未实现**。
> 📌 语义熵采用**二元精确版**（意义簇退化为 {Yes},{No}，由 logits 直接算、无采样噪声）——**比原方法更强**的版本；但牺牲了双向蕴含聚类，自由生成设定下结论可能不同。

**¶10 — ★ 失效机制（比落差本身更值得写）**

> Semantic entropy does not merely fail here; it fails *directionally*. Stratifying by
> whether `M′` is narrower than `M`: where it is (conjunction, category level) semantic
> entropy scores **0.137** — it systematically prefers the misreading; where it is not,
> it sits at chance (**0.507**). The mechanism is visible in the entropies themselves: a
> narrower concept licenses more confident rejections (H drops 0.363→0.253 and
> 0.308→0.148). Self-consistency measures *how certain the model is*, and narrowness
> inflates certainty. On the most common form of referential ambiguity — the Quinean one,
> where the misreading is a proper subset — that is exactly the wrong bias.

> 🚫 **不得写「语义熵≈随机」**——那是被分层掩盖后的表象。**正确表述**：反向（0.137）或随机（0.507），**从不正向**。
> ⚠️ **诚实报告**：G5（绝对/相对）是语义熵唯一有效的类型（**0.750**），正因该类 M′ 不更窄。**不得隐去。**

### 5.2 Scope: where the gate works, and why scaling is not a general fix

**¶11**

> The gate's power is inherited from the base model along two axes, and they respond to
> scale in *opposite* directions. Where the failure is *no signal* — the model's
> predictions barely move when given the definition — scaling helps (argument-order items:
> AUC 0.562 → 0.812 from 1.5B to 3B). Where the failure is *conditioning failure* — the
> model's priors override the definition it was given — scaling **hurts** (absolute-vs-
> relative items: 0.812 → **0.000**). Aggregate margins grew 4× while discrimination
> quality fell (AUC 0.857 → 0.738). **Larger is not a general remedy.**

> 📌 [p0 §6c](../p0/README.md)。E5「条件化失败」是第三个前置条件：**基座必须肯照做**。3B 上连无框架的单属性平凡应用都会失败（`kirel means red` + `Is a red box kirel?` → p(yes)=0.000）。
> ⚠️ **仪器有效性已前置验证**（[p0h](../p0/README.md)）：平凡常识题 raw 6/6、chat 6/6 → **E5 不是格式假象**。
> ⚠️ G5 的实例把对照物写进实例本身，**既是材料设计问题也是真实效度问题**（真实对话总带框架），两种解释都报告。

### 5.3 Isolation is a precondition for correctness, not hygiene

**¶12**

> With eight conflict pairs — the same pseudo-word taught two incompatible meanings by two
> interlocutors — partitioned retrieval yields perfect discrimination (AUC **1.000**, gate
> **8/8**). Sharing the store collapses both: discrimination falls to 0.754 and the gate
> drops to **50%, i.e. chance**. This is not a model failure but an *information*
> one: when two mutually exclusive definitions are simultaneously present, the observed
> data no longer contains which one belongs to whom.

> 📌 [p3](../p3/README.md)。最差项 ISO-08 掉到 **0.281 = 反向**。
> ⚠️ **三处限定**：(i) 共享条件的门控比较是**同样两句话的不同顺序**，测的是"位置是否承载归属"（不承载），**不得说成"门在两个候选间选错"**；(ii) 共享条件是**强形式污染**，**不是** PersistBench 的隐蔽自然泄漏——**勿与其 53% 直接比数值**；(iii) 本轮是**上下文级**分区。

### 5.4 End-to-end: all four properties at once

**¶13**

> Finally we run the full loop: teach → gate → consolidate into the interlocutor's
> partition → **clear the context** → new session, loading only that partition. Across 16
> interlocutors the gate selects the true meaning **16/16** against a candidate set that
> includes the *other* interlocutor's meaning; after the context is cleared, probe AUC
> rises from **0.514 (no memory)** to **0.980 (own partition)**, while loading another
> interlocutor's concept gives **0.129**. Cross-partition hits: **0/16**.

> 📌 [p4](../p4/README.md)。
> 🚫 **禁令 5 自查**：门控 16/16 是在 **4 个互斥颜色**上、领先 **+9.92 nats** ——**远比 §5.1 的 gavagai 对容易**。**正文不得把二者并列，也不得据此写"门控准确率 100%"。**
> 📌 **共享库的失效模式是 last-write-wins**：先写者 8/8 概念被彻底摧毁（AUC 0.148），后写者完好（0.977）。**均值 0.562 有误导性，必须拆开报**；且与 §5.3 的共享条件是**不同失效模式**。

### 5.5 Consolidation into parameters: retrieval-free use, and what actually prevents collapse

**¶14**

> Replacing the external store with the parametric memory of §3.3(b) removes the retrieval
> step entirely. With **no mention of the concept anywhere in the context**, probe AUC rises
> from **0.485 (frozen base, at chance)** to **0.992**; querying another interlocutor's
> partition gives **0.260**.
>
> Sequential writing exposes what the partition is actually doing. Writing sixteen
> interlocutors one after another into *partitioned* slots leaves earlier ones untouched —
> but this is true **by construction** (gradients are masked to the writing partition), and
> we verify it holds exactly: every interlocutor's score at write time equals its score at
> the end. The informative comparison is the ablation. Giving all interlocutors a **shared
> pool of identical total capacity** collapses retention from the *second* write
> (mean 1.000 → 0.520) and ends at **0.562 with several interlocutors at 0.000**.
> What prevents interference is therefore the **partition**, not capacity or sparsity.

> 📌 [p5](../p5/README.md)。
> 🚫 **禁令 6（本稿新增）**：**不得把分区版的零退化报作「稀疏记忆抗崩塌」的实证**——它是构造性的。
> 可写的只有：**同等容量下分区防住了、共享没防住**。
> ⚠️ 与 ROME/MEMIT **仍非同基准**（判分口径与编辑粒度不同），且冲突词是**最坏情况**，
> 崩得比文献报的 10–40 次快属意料之中——**仅作量级参照**。
> 📌 两次失败已存档（[p5 §3](../p5/README.md)）：全词表 CE 稀释二元信号；原始点积路由塌缩（1/12 槽）。

### 5.6 Consolidated concepts compose with pretrained knowledge

**¶15**

> A concept is only "learned" if it can be *used*, not merely recalled. We test this with
> cross-domain probes: real objects whose colour is world knowledge, so that answering
> requires combining the consolidated concept with what the base model already knows —
> a conclusion never stated during teaching. We first verify the base model does hold
> that knowledge (colour-identification AUC **0.891**); it does. The parametric memory
> then reaches **0.949** against a **chance-level base of 0.500**, and exceeds context
> injection (**0.840**).

> 📌 [p6](../p6/README.md)。前置检查：base 对这些物体颜色的世界知识 **AUC 0.891**（否则实验无意义）。
> 🔴 我方初版此处用**绝对阈值**得 0.688（脚本已警告），并在文档里误写成 1.00——**数字与判据都错**，
> 判据错在重犯 P3 的 **No 偏置**坑。改 AUC 后 0.891，**结论不变**。正文引用须用 **0.891 (AUC)**。
> ⚠️ base 跨域均值 0.500 是**构造性**的（冲突对对称，逐用户 [0.062, 0.938] 相互抵消）——说明探针跨用户平衡，**不代表 base 校准良好**。
> 🔴 **本结果推翻了我方 P5 §4 的一处推测**（"final-layer memory 缺深度组合性"）——该断言当时未测，现已撤回。
> ⚠️ L4 反超 L1 的解释（上下文注入干扰世界知识检索）**是假说，未做消融**——引用须标 hypothesis。

### 5.7 Two independently taught concepts compose — and what that costs

**¶16**

> Composition with pretrained knowledge could still be one concept doing the work. We
> therefore teach the *same* interlocutor two concepts from disjoint decision sets and
> probe a conjunction, `Is X both w1 and w2?`, a form never used during teaching. Negative
> items are those satisfying **exactly one** of the two, and we report the **minimum over
> the two halves** of the probe set — a policy that consults only one concept scores
> **0.500** on that minimum by construction. Consolidated memory reaches **0.889** against
> a base of **0.479**; context injection reaches 0.986.

> 📌 [p7](../p7/README.md)。前置检查：基座对**真英语词**的同句式合取 **AUC 0.973**；L1 min **0.986** ⟹ 任务可解。
> 🔴 我方初稿把单概念策略的上界写成 **0.500**，**实为 0.750**——必须拆成两半取 min，否则裁决线设错。
> ⚠️ **L4 全线低于 L1（0.889 vs 0.986）**，参数化路线在组合上确有代价，**不得掩饰**。

**¶17**

> Sequential arrival exposes a failure that per-interlocutor partitioning does not cover.
> Writing a second concept into the same partition destroys the first (**0.951 → 0.590**).
> Masking *gradients* to a per-concept sub-region does not help (**0.833 → 0.483**):
> the slots are provably untouched (max value change **0.00e+00**), yet **25% of the
> retrieved top-k for the first concept land in the second concept's sub-region**.
> **Partitioning must constrain retrieval as well as writing** — which is why the
> per-interlocutor scheme worked: there, retrieval was already masked by interlocutor id.
> With both masked, retention is exact (**0.927 → 0.927**) at *half* the slots per concept,
> which rules out a capacity explanation. But the isolation that protects each concept
> **weakens their joint use** (conjunction **0.653** vs **0.889** under joint training).

> 🔴 **Δ 0.000 是构造性的**（不相交子区 + 双掩码 ⟹ 构造上不可能互相影响）——**不得报作"抗遗忘"**。
> 可报的只有两条：**只掩写入不够**（−0.351 ≈ 不分区的 −0.361），**且修好它的那版容量更少**（16 < 32）。
> ⚠️ 「顺序到达 + 强组合」这一格**目前无解**，必须写进 limitations（§6 (i)）。

### 5.8 What is consolidated is a readout direction, not a concept

**¶18**

> Consolidated concepts survive context that contradicts them. Adding a competing gloss
> to the prompt (`Note: in some dialects, w means <the other teacher's meaning>`) costs the
> parametric memory **0.050** AUC and context injection **0.075**. The distractor is
> demonstrably potent: for the base model, which has no other definition available, the
> same note drives the probe from **0.545 to 0.033** — near-perfect inversion. Criterion
> I5 holds, and holds better in parameters than in context.

**¶19**

> Criterion I3 does not hold. When the concept must be *used* rather than adjudicated —
> a two-alternative action prompt never seen in teaching — the parametric memory scores
> **0.507**, indistinguishable from an unconsolidated base (0.500), while context injection
> scores **1.000**. A diagnosis rules out retrieval failure: 75% of the retrieved slots are
> ones the training prompts used. The learned memory output aligns with the *training
> format's* readout direction and with nothing else: **cos(m(h), W_yes − W_no) = +0.79**
> versus **cos(m(h), W_A − W_B) = +0.003**, the two directions being near-orthogonal
> (−0.027), and ‖m(h)‖ = 14.3 — large, but pointed the wrong way. Training on a second
> format does not fix this: it raises that format by 0.240 while *lowering* a third,
> held-out format by 0.110. Across three formats, transfer is monotone in the cosine
> between readout directions (1.000 → 0.960; +0.107 → 0.755; −0.027 → 0.555 ≈ base).

> 📌 [p8](../p8/README.md)。⚠️ **三个点同序而已，不得写成拟合出来的定律**。
> 🔴 判据在此错过一次：初版只报 accuracy，而伪词条件下模型 **91% 选 A**，阈值法被偏置钉死在 0.5。
> 这是 P3 → P6 → P8 **同一类仪器错误的第三次**。改 AUC 后结论不变，但那是运气。

> ### 🔑 这条**回溯限定**了 §5.5–5.7
> 那三节的训练与探针**全部使用同一个读出方向**（Yes/No）。
> P6 变的是表层内容、P7 变的是表层句式——**读出方向都没变**；P8 变的正是读出方向。
> ⟹ **精确主张只有一条：概念能跨表层句式迁移，不能跨读出方向迁移。**
> **§5.5–5.7 的每条结论在正文中都必须带作用域 "within the decision format used for teaching"。**

---

## 6 Limitations

> **(0) The consolidated object is a word-independent bias, not a word meaning.** This is the
> limitation that governs all others. Replacing the taught pseudo-word with an unrelated one —
> leaving every other token intact — leaves the probe AUC essentially unchanged (0.945 → 0.930
> mid-network; 0.970 → 0.975 at the output layer). Teaching the same interlocutor *two* words
> does not force binding either: swapping in that interlocutor's **other** word moves the first
> word's AUC by **−0.005**, although both words are individually learned (second word's own
> probe, 0.890). The mechanism differs by insertion point: mid-network, the retrieval is blind
> to the word (routed-slot overlap **1.000** after substitution); at the output layer the memory
> output does vary with the word (cosine 0.787) but only along directions orthogonal to the
> decision — the **positive-minus-negative projection onto W_yes − W_no is preserved at 97%**
> (+4.443 → +4.327), so ranking, and therefore AUC, is unchanged. We therefore claim only a
> persistent, partition-isolated, word-independent bias over objects. Fixes we have **not**
> built: keying the memory at the word's token position rather than the sequence-final state;
> training sets in which two words assign **opposite** labels to the same object; explicit
> word-conditioned routing.

**¶14 — 诚实清单（这一节不压缩）**

> **(i) The consolidated object is a readout direction, not a concept — so implicit use
> (I3) fails.** Everything we consolidate is learned at the output layer, and it therefore
> encodes *where to push the logits in the decision format used for teaching* rather than a
> format-independent concept. Within that format the method is strong (retrieval-free use,
> composition with world knowledge and with a second taught concept, persistence, and
> resistance to contradicting context). Outside it, the concept simply does not fire:
> **0.507 against a base of 0.500**, where context injection reaches 1.000. This is not a
> tuning failure — training on a second format raises that format while lowering a third,
> held-out one. **Every result in §5.5–5.7 must therefore be read as scoped to the teaching
> decision format.** The natural next step is a mid-network memory, which would alter
> representation rather than readout; **we have not built it, and we do not claim it solves
> this.**
>
> **(i-b) Isolation and composition pull in opposite directions, and sequential arrival is
> unsolved.** The parametric memory is attached *after the final layer* and so does not
> participate in intermediate representation. We initially expected this to cost
> compositional use; it does not. Composition holds both with pretrained knowledge
> (**0.949** vs a chance-level base of 0.500, exceeding context injection at 0.840) and
> between two independently taught concepts (**0.889** vs 0.479, against a 0.500 ceiling
> for any single-concept policy). What we cannot yet offer is both at once under
> *sequential* arrival: protecting each concept requires partitioning retrieval as well as
> writing, and that same partitioning drops conjunction accuracy from 0.889 to **0.653**.
> Untested: negation, quantification, multi-hop chains, and two concepts over the *same*
> attribute. Against our five criteria the method attains retrieval-free use (I1),
> composition (I2), cross-session persistence (I4) and cross-interlocutor isolation;
> isolation *within* an interlocutor holds only under the stricter scheme and at the cost
> above; **I5 holds (0.050 loss under a contradicting gloss, versus 0.075 for context
> injection, with the gloss verified potent — it drives the base model to 0.033); I3 does
> not hold (i).**
>
> **(ii) The gate verifies usage fidelity, not world truth.** It rejects the model's
> *misreadings* of what the interlocutor means; a consistently deceptive interlocutor will
> be believed. This is a designed boundary, and it is *composable* with provenance-based
> gates, which address the orthogonal question of whether the source is trustworthy.
>
> **(iii) Conditioning failure is unsolved.** Where the base model's priors override the
> supplied definition, gain-based criteria read a mixture of prior and concept. The
> decidability meter detects only *undecidability*, not confident error.
>
> **(iv) Two arms, not three**; a genuine expected-information-gain querying arm is not
> yet implemented.
>
> **(v) Single model family, small item counts, item-level (not seed-level) CIs**;
> usage decisions are given by construction rather than extracted from natural dialogue.

> ✅ 这五条与 [REPORT §5](../REPORT.md) 的未解决表一一对应，无隐去。

---

## 7 禁令自查表（投稿前逐条勾）

| # | 禁令 | 本稿状态 |
|---|---|---|
| 1 | 不写「尚无 GT-free 的写入准入门控」 | ✅ §1 已用定稿措辞（判据类型 × 门控环节两轴） |
| 2 | 不以「无外部 oracle」为独立卖点 | ✅ 仅在性质定义中出现 |
| 3 | 「写入」必带 scope 注解 | ✅ §3.3 / §5.4 均写明 persistent / per-interlocutor / at inference time |
| **4** | **区分 L1 外部 / L4 参数化两个实例化** | ✅ §3.3 明写 (a) External / (b) Parametric 两级；§5.4 用 L1、§5.5 用 L4，各自标注 |
| **5** | **不得把 P4 的 16/16 与 P2 的 0.915 并列** | ✅ §5.4 编辑注记已标；正文两处分述、无并列表述 |
| 6 | 语义熵不得写成「≈随机」 | ✅ §5.2 ¶10 用「反向或随机，从不正向」 |
| 7 | 三臂 → 实际 2 臂 | ✅ §5.1 ¶9 注记已声明；正文未出现 "three arms" |
| 8 | PersistBench 53% 不得直接比数值 | ✅ §5.3 注记已标；正文未引该数字 |
| **9** | **分区版零退化不得报作「抗崩塌」实证** | ✅ §5.5 正文明写 "true **by construction**"，结论落在消融上 |
| **10** | **I2 已两种形态成立，但不得再扩** | ✅ ⊗ 世界知识（§5.6）+ ⊗ 概念（§5.7）；**否定/量化/多跳/同属性内两概念仍未测**，不得声称 |
| **11** | **不得把 Δ 0.000 报作「抗遗忘」** | ✅ §5.7 明写它是**构造性**的；可报的只有"只掩写入不够"与"修好的那版容量更少" |
| **12** | **不得掩饰 L4 在组合上低于 L1** | ✅ §5.7 明写 0.889 vs 0.986；§6(i-b) 明写「顺序到达 + 强组合」无解 |
| **13** | 🔴 **不得声称 I3 成立 / 不得写"概念被内化"而不加作用域** | ✅ §5.8 + §6(i)：I3 **0.507 ≈ base**；§5.5–5.7 每条结论须带 "within the teaching decision format" |
| **14** | **不得把"迁移量随读出余弦单调"写成定律** | ✅ §5.8 明写**只有三个点、同序而已** |
| **15** | **不得声称中间层记忆能解决跨格式问题** | ✅ §6(i) 明写 **we have not built it**；它只是有实证动机的下一步 |
| **16** | 🔴🔴 **参数化记忆线不得写 "learns a word / a concept / internalizes a meaning"** | ✅ §3 抬头 + §6(0)：**word-independent bias over objects**；换词落差 0.017–0.018，两词设置 −0.005 |
| **17** | **不得把"输出随词改变"当作绑定的证据** | ✅ §6(0)：post-norm 上 m(h) 余弦 0.787 却**判别力保留 97%** —— 度量必须对准被解释的量 |

---

## 待办

- [ ] 补正式 bibkey（当前用 arXiv 编号占位）
- [ ] Figure 3：分区 vs 共享的顺序写入保持率曲线（第 2 次即崩 vs 平坦）
- [ ] Figure 1：三臂对照（核心域 AUC 条形图 + 按"M′ 是否更窄"分层）
- [ ] Figure 2：端到端闭环示意（含"清空上下文"这一步）
- [ ] Table 1：十类代理表（判据类型 × 门控环节，标出 GATES/LMSI/SAGE/我方位置）
- [ ] ⏰ 投稿前重扫 rate-distortion / memory-compaction 方向
