# Introduction / Related Work — 投稿草案 v1（第九轮定稿措辞）

> **状态**：初稿（2026-08-01，第九轮风险口闭合后）。英文段落为投稿文本；中文块为编辑注记（证据等级 + 禁令 checklist），投稿前删除。
> **上游**：措辞依据 [REPORT.md](../REPORT.md) §4（四次收紧史 + 三条禁令 + 第九轮闭合）；机制表述依据 [DESIGN_COMPRESSION_GATE.md](../../../docs/DESIGN_COMPRESSION_GATE.md) §0–§1；先例表依据 [RESEARCH_LEARNING_IN_REFERENCING.md](../../../docs/RESEARCH_LEARNING_IN_REFERENCING.md) §7.6 与 [RESEARCH_KNOWLEDGE_INTERNALIZATION.md](../../../docs/RESEARCH_KNOWLEDGE_INTERNALIZATION.md) 家族 J–P。
>
> **🚫 本稿受四条硬性禁令约束（第八轮定三条，第十二轮增第四条；全稿已自查）**：
> 1. 不写「尚无 GT-free 的写入准入门控」（GATES/LMSI 证伪）
> 2. 不以「无外部 oracle」为独立卖点
> 3. 「写入」一词必带 scope 注解（推理期/持久/按条）
> 4. 🔴 **不得把「门控环节 / locus」当作新颖性的一条腿**，也不得写「已有 GT-free 门都在训练期」——
>    **ConsistencyGate（2607.22962，2026-07-25）就在推理期按条持久写入**（自我推翻 #27）。
>    新颖性**只剩「判据类型 = 压缩增益/MDL」一轴**。引用 ConsistencyGate 时**必须**
>    同时给出我方自洽类信号的失效实证（AUC 0.269；M′ 更窄时 0.137），否则读者会以为问题已解决。

---

## 1 Introduction

**¶1 — 问题（motivation）**

> Large language models acquire concepts almost exclusively at training time. When a
> conversation partner introduces a genuinely new concept — a term of art, a private
> convention, a word of a language the model has never seen — today's deployed systems
> either forget it when the context window closes, or write it into some persistent store
> *unconditionally*. Neither behavior is learning. Learning would require the model to
> form a hypothesis about what the interlocutor means, test that hypothesis against how
> the interlocutor actually uses the term, and only then commit it to permanent,
> partner-specific memory.

**¶2 — 四性质与聚焦 P2**

> We study concept acquisition *in referencing*: during inference-time interaction,
> after pretraining is over. Doing this properly requires four properties simultaneously:
> the concept is **novel** (outside the training distribution, not retrieved); its
> acquisition is **self-verified without ground truth** (no answer key, no external
> oracle grades the concept); it is **persistent** (survives the end of the session);
> and it is **isolated per interlocutor** (one partner's idiolect never leaks into
> another's). This paper focuses on the hardest of the four: *absent any answer key,
> what signal should decide whether a newly acquired concept deserves permanent
> consolidation?*

**¶3 — 现状：管线已存在，缺的是门（且必须精确让位）**

> The internalization pipeline itself is no longer the bottleneck. Context-distillation
> methods internalize in-context knowledge into parameters — self-distillation onto a
> LoRA adapter with the same model as its own teacher \cite{kujanpaa2024injection},
> trained KV-prefixes \cite{eyuboglu2025cartridges}, on-policy reverse-KL variants
> \cite{ye2026opcd} — and Generative Adapter \cite{chen2024generativeadapter} even maps a context to an
> adapter in a single forward pass, producing parameter deltas that can be stored and
> reused per user. What these pipelines share is the *admission policy*: *whatever enters the
> context gets written*. Prompt Distillation applies no screening to its self-generated
> training data — noisy answers are absorbed by soft-label distillation rather than
> filtered. Cartridges trains on every generated conversation. OPCD's only selective
> variant scores candidate experiential knowledge by task performance on a *labeled*
> validation set; in the setting its authors explicitly designate as label-free, the
> quality of what gets distilled "is not pre-evaluated" and selection is random.

**¶4 — 门控信号的全景与空白（第八轮定稿声明，逐字）**

> Admission gates do exist — but with different signals, at different loci. Across
> continual learning, memory architectures, and 2026 agent-memory systems, the admission
> signals of persistent-consolidation gates fall into ten proxy families: randomness,
> class balance, loss/likelihood, parameter drift, capacity/sparsity, representational
> or geometric novelty, gradient interference/diversity, representativeness, (labeled)
> uncertainty, and source-trust/faithfulness/reliability/consistency. Notably,
> consensus gating has already realized a *ground-truth-free correctness proxy*:
> GATES \cite{stein2026gates} admits a distillation item only when ≥4 of 8 tutor rollouts agree
> (rejected items contribute zero loss), and LMSI \cite{huang2022selfimprove} filtered self-training
> data by majority vote as early as 2022. Nor do we claim novelty on the *locus*:
> ConsistencyGate \cite{zhang2026consistencygate} places a ground-truth-free admission gate exactly
> where ours sits — at deployment time, per candidate fact, before a persistent write —
> using an average support score over $K$ resamples. What remains open, to our knowledge,
> is the *criterion type* alone: **no existing method uses compression gain — a Minimum
> Description Length criterion — as the admission signal.** Every ground-truth-free gate
> we could find scores a candidate by how *consistently* the model already endorses it
> \cite{stein2026gates,huang2022selfimprove,zhang2026consistencygate}, how *novel* it is
> \cite{wang2026sage,wang2024sema}, or how *trustworthy its source* is
> \cite{zahn2026writetime,yang2026trustmem} — never by how much it *compresses what the
> interlocutor does next*. Compression *has* been proposed as the currency for agent
> memory — as an agenda in the description-length form \cite{colaco2026ratedistortion},
> and, closest to us, as a worked decision-centric rate--distortion theory
> \cite{zou2026demem}, which independently argues that memory should preserve
> *decisions* rather than *descriptions*, a conclusion our own ablations reach
> empirically (§Experiments). Three things separate that line from ours. It compresses
> **the agent's own action choices**, whereas our criterion is evaluated on **another
> party's subsequent word choices**. It answers **what may be forgotten under a budget**
> — a partition problem — whereas ours answers **whether a candidate should be written
> at all**. And its distortion is defined as decision regret, so it presumes an
> **observed reward** at each step; ours presumes only that the interlocutor keeps
> talking. OPCD names the missing piece from the other side: in the deployment scenario
> without labels, what gets written "is not pre-evaluated."

> 🔴 **本段是第十二轮（2026-08-04 投稿前重扫）改写的**，原文写的是
> 🔴 *"Existing GT-free gates (GATES, LMSI) … operate at training time"* —— **已被 ConsistencyGate
> （2607.22962，2026-07-25）证伪**：它就是推理期、按条、持久写入的 GT-free 准入门。
> ⟹ **「门控环节」不再是新颖性的一条腿**，只剩「判据类型」一轴（自我推翻 #27）。
>
> ★ 但这对我方**反而有利**：ConsistencyGate 用的正是**自洽度**，而我方 §Experiments 实测
> 该信号类在 gavagai 对上 **AUC 0.269**、且 **M′ 更窄时 0.137（系统性反向）**——
> **同期最新方法用的正是我方证明不够用的信号**，比"无人做过"是更强的立论。
> ⚠️ 引用它时**必须**同时给出我方的失效实证，否则读者会认为该问题已被解决。
>
> 🔴 **同轮第二个发现：DeMem（2605.10870，2026-05-11）**——**判据类型那一轴上离我方最近的一篇**。
> 全文水印核验 `arXiv:2605.10870v1`，词边界扫描：
> **description length / MDL / admission / interlocutor / isolation 各 0 次**，rate-distortion 4 次。
> 三条结构性差异**全部有原文支撑，引用时不得省略**：
> ① **需要观测到的奖励**——contextual bandit，"the learner observes a reward $R_t \in [0,1]$"，目标是 regret；
> ② **是预算下的分区（什么可以忘），不是准入（要不要写）**；
> ③ **压缩的是智能体自己的动作**，我方压缩的是**对话者的后续用词**。
> ✅ 但它**独立佐证了我方 P0 最硬的一条**（决策 vs 描述，7.2× margin）——须用作旁证，不是威胁。
> ⚠️ 按禁令 2，**不得**把「不需要奖励」写成独立卖点，只能作为**作用域区分**。

**¶5 — 机制（一句话）+ 划界（E1/E2）**

> Our gate is simple: a candidate concept graduates into the persistent store only if
> conditioning on it *compresses the interlocutor's subsequent, held-out usage* — measured
> on the word-choice decision sequence, not on free-form prose — by more than the
> concept's own description length, and by more than matched placebo concepts
> (a two-part MDL criterion with a placebo control). The signal validates **fidelity to
> the interlocutor's usage, not world truth**: it rejects the model's own confident,
> consistent *misunderstanding* of what was taught (the gavagai failure), while a teacher
> who consistently teaches falsehoods will be believed — that failure mode belongs to
> provenance gates (source reputation, faithfulness-to-source), which are orthogonal
> and composable with ours.

**¶6 — 结果预览（诚实版）**

> On a constructed-language benchmark of 22 gavagai pairs — teaching sets that are
> *constructionally insufficient* to disambiguate the true concept M from a tempting
> misreading M′, with held-out usage that separates them — compression gain over held-out
> decisions separates M from M′ in 19/22 items (margin +4.08 nats, 95% CI [+2.52, +5.70],
> p = 0.00043) on a frozen 1.5B model with no training. Three preconditions, none of
> which appeared in our original design, turned out to govern whether the signal exists
> at all: the observable must be the decision sequence (7.2× margin over free-form
> prose); the base model must be able to represent the distinction (probe-gate
> correlation ρ = 0.857); and the model must actually condition on the candidate
> definition rather than its prior — a failure mode that *worsens* with scale. Making
> the gate aware of its own decidability (a three-state accept/reject/ask design using
> the null-distribution dispersion σ_null) raises AUC from 0.857 to 0.964 with zero
> false rejections of M, and the abstained items are verifiably undecidable
> (AUC ≈ 0.55 within the abstained set).

**贡献列表（更新版 C1–C4，替换 §9.3.1 旧版）**

> Our contributions:
> 1. **A map with a corrected gap.** A ten-family taxonomy of admission signals across
>    all persistent-consolidation gates we could verify (six method families plus the
>    2026 agent-memory wave), including the closest positive precedents — consensus
>    gates that already realize ground-truth-free correctness proxies, both at
>    training-time data admission \cite{stein2026gates,huang2022selfimprove} and, as of
>    July 2026, at exactly our locus: deployment-time, per-item, pre-write
>    \cite{zhang2026consistencygate}. **The gap we occupy is therefore one axis, not two:
>    the criterion type.** Every gate in the taxonomy scores a candidate by consistency,
>    novelty, or source trust; none by description length. We further show *why* the
>    distinction matters rather than asserting it: the consistency signal that the
>    closest precedents rely on is not merely weaker on our task but **systematically
>    inverted** on its most common form (AUC 0.137 when the misreading is narrower than
>    the true concept).
> 2. **A mechanism.** A two-part MDL admission gate with placebo control, measured on
>    held-out usage decisions, upgraded to a three-state (accept/reject/ask) design by a
>    GT-free decidability check; per-item calibration via null-distribution z-scores and
>    a dimensionless rank statistic that transfers thresholds across model scales.
> 3. **A benchmark that constructs the failure mode.** Gavagai pairs whose teaching sets
>    are extensionally consistent with both M and M′, so that "confident, consistent
>    misunderstanding" is a controlled experimental condition rather than an anecdote —
>    with ground truth available to the *evaluator* but never to the gate.
> 4. **An honest scope.** The gate's discriminative power is inherited from base-model
>    competence (it fails on argument-order concepts); conditioning failure worsens with
>    scale ("make the model bigger" is not a fix); and the signal validates usage
>    fidelity, not world truth. We report three preconditions and the full ablation
>    matrix, including the ablation that would have produced a false positive (92% of
>    naive gain comes from the length penalty).

> 中文注记：
> - ¶3 的 PD/Cartridges/OPCD 表述全部 ✅（第九轮 3 票 / Cartridges ✅ᶠ 全文穷举）；Generative Adapter 的「单次前向 + 跨会话 + 按用户」措辞待第十轮裁决后定稿（若 GA2 被 CORRECTED 需改）。
> - ¶4 空白句 = 第八轮定稿逐字翻译；「to our knowledge」+「no existing method」的组合是审稿安全措辞。GATES 的 "≥4/8、zero loss" 与 LMSI 的 majority vote 均 ✅（第八轮）。OPCD "not pre-evaluated" ✅（第九轮 3–0）。
> - ¶5 划界句对应 C4 收紧版；「usage fidelity, not world truth」是防 E2 反例的主动划界。
> - ¶6 数字全部来自 P0 系列 ✅ 实证；「abstained AUC ≈ 0.55」即弃权正当性。
> - 🚫 检查：全稿无「no GT-free write admission gating」类表述；「无外部 oracle」只在 P2 定义句作为性质出现、不作卖点；所有「write/writing」均带「persistent / per-item / inference-time / into a per-interlocutor store」scope。

---

## 2 Related Work

**¶1 — 持续学习与记忆架构的准入信号（十类代理）**

> Continual and lifelong learning offers a rich taxonomy of *what to keep*: reservoir
> and class-balanced sampling admit examples by randomness or label counts \cite{prabhu2020gdumb,chaudhry2019tiny}; gradient-based selection chooses by gradient diversity
> \cite{aljundi2019gss} (maximally-interfered retrieval is a *retrieval*-side
> criterion, not admission \cite{aljundi2019mir}); herding stores class-representative exemplars
> \cite{rebuffi2017icarl}; dark experience replay stores reservoir-sampled logits \cite{buzzega2020derpp}. Architectural
> growth gates decide *when to expand* on training loss, parameter drift, or data
> likelihood \cite{yoon2017den,lee2020cndpm}, and modern write-side gates admit items by geometric novelty
> \cite{wang2026sage}, normalized-loss hysteresis \cite{li2025selfsizing}, or Bayesian
> surprise \cite{gorlo2026worth}. The 2026 agent-memory wave gates writes on
> trust proxies — source reputation and reliability \cite{zahn2026writetime},
> or faithfulness to the source \cite{yang2026trustmem}. None of these signals assesses
> whether the acquired concept itself matches what the interlocutor meant.

> 🔴 **第十二轮删除**：原句末尾还有 "or externally confirmed outcomes [LOCI]"。
> LOCI（我方第四轮记为 TDCommons 11091）**第十二轮无法再定位该条目**，作者与标题未能核实。
> ⟹ 按"不得引用无法核实的文献"，**先从正文删除**；若投稿前补全再放回。
> 它只出现在族 6 概览句里，**不承载我方主张**——删除不影响立论。

**¶2 — 最近邻：共识门控（正面引用，让出 GT-free 轴）**

> Closest to our admission problem is consensus gating. **GATES** \cite{stein2026gates} admits a
> distillation item only when at least 4 of 8 tutor rollouts agree on the answer —
> agreement serving, in the authors' words, as "a proxy for correctness" with "no
> external teacher or reward model" — and items failing the gate contribute zero loss.
> This is a genuine, realized, ground-truth-free binary admission gate; nor is it the
> first: **LMSI** \cite{huang2022selfimprove} filtered self-training data by majority vote without
> ground-truth labels in 2022. We therefore claim no novelty for "GT-free admission
> gating" as such. The differences are two orthogonal axes. *Criterion:* their signal is
> answer consistency; ours is the reduction in encoding cost of held-out usage — and a
> recent large-scale audit finds self-consistency to be only a weak predictor of
> correctness (Spearman ρ 0.20–0.59; high-consistency models still err on 48% of GPQA
> items) \cite{ding2026agree}, which suggests the two criterion types are not interchangeable.
> *Locus:* GATES and LMSI gate the admission of training data and gradients, offline,
> over a fixed pre-generated question set; our gate rules on each candidate concept's
> admission into a per-interlocutor persistent store at deployment time. **SEAL**
> \cite{zweiger2025seal} is likewise no counterexample: its ReST-EM filtering operates during
> generator RL training and requires every context to ship with a labeled evaluation
> task — a coupling its authors state "prevents RL training of SEAL from scaling to
> unlabeled corpora" — while its deployment-time self-edits are applied unconditionally,
> with no gate.

**¶3 — 上下文蒸馏 / prompt internalization（管线成熟、无门或 GT 依赖门）**

> Context distillation internalizes in-context knowledge into parameters: the original
> formulation fine-tunes a model — via token-level KL to a frozen copy of itself
> conditioned on the full instructions — to produce without the context what it
> produces with it \cite{snell2022distilling}; Prompt Distillation does this
> self-supervised, with the same model as teacher (documents in its prompt) and a LoRA
> adapter as the write target, requiring neither ground-truth labels nor a stronger
> teacher \cite{kujanpaa2024injection}; Cartridges amortizes long contexts into trained KV-prefixes via
> a self-study objective \cite{eyuboglu2025cartridges}; OPCD bridges on-policy distillation and context
> distillation with reverse KL on the student's own trajectories \cite{ye2026opcd}; and
> Generative Adapter maps contexts to low-rank adapters in a single forward pass
> \cite{chen2024generativeadapter}. These pipelines demonstrate that inference-acquired knowledge *can* be
> made persistent — and they uniformly lack a correctness-facing admission decision:
> Prompt Distillation screens nothing (noise is absorbed by soft labels); Cartridges
> trains on every generated conversation; OPCD's only filter scores candidates on a
> labeled validation set, and its explicitly label-free setting leaves quality "not
> pre-evaluated" with random selection. Two failure modes documented in this family
> transfer directly to any referencing-to-internalization system, including ours:
> re-presenting the original context to a distilled student can *degrade* it — in 7 of
> 12 settings, including on instances it solves correctly without the context
> \cite{wang2026whencontext} — and three rounds of iterated internalization can
> collapse a web agent's capability below its own base model \cite{chen2026continual} — we adopt
> the corresponding countermeasures in our experimental design (§Experiments).

**¶4 — 不确定性与自我验证（为何现有信号在 E1 上失分）**

> Uncertainty-based verification detects the wrong property for our problem. Semantic
> entropy flags *inconsistency* \cite{farquhar2024semantic} — but a confidently held
> misunderstanding is low-entropy: self-consistent, novel to the memory store, often
> surprising, faithfully transcribed from a trusted source. Every existing signal class
> therefore admits it — while it fails to predict how the teacher will use the term next.
> That predictive failure is exactly what compression gain measures. Naive
> self-reflection without external verification does not repair errors \cite{huang2024cannot}, and self-improvement cannot create information absent from the model — a
> data-processing-inequality argument \cite{cover1999elements} invoked as motivation by sharpening
> analyses \cite{huang2024sharpening} — which is why the new information in our setting must come
> from the interlocutor's usage, and why the gate's job is to test the model's
> hypothesis against precisely that usage.

**¶5 — 压缩/MDL 判据（理论地基与唯一同构先例）**

> The criterion itself stands on the prediction-compression duality \cite{deletang2024compression}. A rate-distortion treatment of memory has recently *proposed* description
> length as the currency for what to store \cite{colaco2026ratedistortion}, but as an agenda, without an
> admission gate or an implementation; across all families above, word-boundary sweeps
> for MDL / description length / compression as an *admission criterion* return zero
> hits. Our per-item calibration (null-distribution z-scores) inherits the mechanism of
> SEMA's novelty calibration \cite{wang2024sema} — the difference, again, is the signal being
> calibrated.

**¶6 — 划界段（放 Related Work 末尾或 §3 开头）**

> *Boundary.* Three neighbouring problems are not ours. Source-trust gates
> \cite{zahn2026writetime,yang2026trustmem} address whether the **teacher** is reliable;
> our gate addresses whether the **model's hypothesis matches what the teacher means**.
> Correctness gates that consult an answer key or task outcome
> \cite{zelikman2022star} presuppose exactly the signal our setting denies. And
> post-hoc compaction \cite{kim2026memrefine,zou2026demem} decides what to *drop* from
> an already-written store under a budget, whereas we decide what is *admitted* in the
> first place. All three are orthogonal to ours and composable with it; none subsumes
> it, and we evaluate only admission.

> 中文注记（证据等级 / 待办）：
> - ¶2 GATES 引语三条全 ✅（第八轮）；2607.08065 审计 ✅（第八轮）；SEAL 引语 ✅（第八轮）。
> - ¶3 Snell 句已按第十轮 SN1 裁决精化（token-level KL 到冻结自身副本）✅；SPIDER 数字未写入正文——如需引用，唯一合法表述见 REPORT §4 第十轮小节（8-shot 比 GD 基线 +9.0 点，非对 teacher）。
> - ¶3 GA 句已按 #16 收紧（"stored and reused per user"，不写 isolation/naturally）✅；When Context Returns 已带 7/12 scope ✅。
> - ✅ ¶3 的 2606.04703 已第十一轮 3 票（坍缩掉到 base 以下确认）。🚨 引用纪律：**不得写「其坍缩因无差别写入」或「其管线完全无门」**（#19——论文归因是 instance 伪影/注入错位/反应式 on-policy，且稳定配方含 rejection sampling 门）；「压缩门推迟坍缩」只能以我方实验数据立论。
> - DyPRAG（✅）可选补一句参数化 RAG（"hypernetwork-translated per-document LoRAs \cite{tan2025dyprag}"）；Memory Grafting 实为预训练扩展方法，与本节主题无关，**不引**。
> - ¶5 「zero hits」的主语是**我方已穷举过的家族**（词边界双跑协议），不是全文献——句中已用 "across all families above" 限定。
> - 🚫 三条禁令自查：通过（见文首）。
> - 引用键待换正式 bibkey；投稿版删除全部中文块。

---

## 附：措辞红线速查（写作时对照）

| 场景 | ✅ 可写 | ❌ 不可写 |
|---|---|---|
| 空白声明 | "no existing method uses compression gain/MDL to gate persistent, per-item, inference-time writing" | "no GT-free admission gating exists" |
| GATES/LMSI | "we claim no novelty on that axis"；差异 = criterion × locus | 任何贬低（"merely"、"only heuristic"） |
| oracle | 性质定义中可提 "no external oracle grades the concept" | 作为独立贡献/卖点 |
| 「写入」 | 必带 "persistent / per-item / at inference time / per-interlocutor" | 裸的 "write gating" |
| E2 | "a consistently deceptive teacher will be believed — by design, out of scope, provenance gates are composable" | "rejects all incorrect concepts" |
| RAG 对比（如引 PD） | "competitive with RAG; surpasses it in combination or scaled variants on Squadshifts" | "beats RAG at multiple scales" |
| OPCD OOD（如引） | "marginal OOD-retention advantage over off-policy CD; checkpoint selection used test accuracy" | "better preserves OOD capabilities"（无限定） |
