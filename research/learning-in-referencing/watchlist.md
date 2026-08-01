# 竞争空间 Watchlist（第十二轮扫描 + 第十三轮定向证伪）

> 2026-08-01。第十二轮 = 3 角度 WebSearch 轻量重扫（**摘要级 🔍**）；
> 第十三轮 = 其中 5 个高关注对象的全文 3 票对抗验证（**✅**，45 票全一致）。
> **投稿前必须重跑第十二轮式扫描**（本轮证明该方向正被快速填补）。

## 裁决总览：核心句存活，但第五次收紧

> 核心句（不变）：**尚无方法以压缩增益/MDL 为判据对推理期按条持久写入做准入门控。**
> **第五次收紧（第十三轮）**：「已有 GT-free 门均作用于训练期」这一环节侧注解**作废**——
> GovMem 已是 GT-free·按条·推理期写入路径的准入门。**新颖性完全落在判据轴**（REPORT §4 #20 + 禁令 4）。

## 已 3 票核定的 5 篇（第十三轮，全文级 ✅）

| 论文 | 判据/机制（核定） | 对我方 | 引用义务 |
|---|---|---|---|
| **NEMORI** What Deserves Memory（2508.03341v4，Ma et al. Fudan/Shanda） | **LLM 判断的预测误差**：用现有知识合成 anticipatory schema，提取「schema 预测不到的信息」入持久语义库——**对来件本身的 surprise/novelty 门**，无任何 codelength 量 | **最近邻门（同环节、异判据）**：training-free·按 episode·推理期·持久库。其 predictive-coding 修辞（"predictability implies redundancy"）是全扫描最近的概念邻居 | 🔴 **必须显著正面引用**：差异句=「NEMORI 收『让当前模型惊讶』的信息；我方收『使留出未来数据编码更廉』的信息——它不计算也不近似该量」 |
| **GovMem** When Not to Write Memory（2607.02579v1，Qi/Xu/Li） | 依赖感知支持度（provenance 去重的票数）+ 反证检索 + 信任/scope → promote/reject/review | ⚠️ **环节抢占**：**GT-free·按条·推理期写入准入门成立**（"audits each proposed write before it reaches long-term storage"）→ 触发第五次收紧。判据属支持度/一致性族，非 MDL；无 per-user 隔离 | 🔴 必引；且其负结果**利我**：外部候选 **0/133 可安全自动 promote**（重人工 review）→「支持度类判据不足以自动写入，需要更好的判据」 |
| **InfoMem**（2606.03329v1，Han et al. Tongji/上海 AI Lab） | r_gain = 记忆条件下 gold answer 的逐 token log-prob 增益——**数学上正是 held-out 数据的 codelength 削减**！但用作 **GRPO 训练期 reward**、轨迹级、需 gold answer + 答案正确性门、episodic 单查询工作记忆 | **最近量亲缘（同量、全异环节）**：四轴全不满足（训练期/轨迹级/需 GT/非持久）。其 GT-free 变体 QueryPMI **更差**——反证「无 GT 时该量不好用」的挑战，我方靠"决策序列观测量"回应 | 🔴 必引：「InfoMem 证明该量是好的**训练 reward**；我方把同族量用作 **GT-free 推理期准入判据**」 |
| **DeMem** Remember the Decision（2605.10870v1，Zou et al.） | "rate"=槽数 K、"distortion"=任务 reward 损失；reward 证书触发分裂；**无按条准入**（来件一律并入槽） | 非反例：task-success 族、需 reward、无 codelength 量（I(Z;M) 下界只是不可能性定理） | 引用可选；标题修辞（"Not the Description"）恰是 MDL 族的反面 |
| **A-MAC**（2603.04549v1，Workday AI，ICLR 2026 MemAgent wkshp） | 五因子线性分（LLM 效用、ROUGE-L 一致性、cosine 新颖度、时近、类型先验），监督学习（需 GT 标签） | 非反例（判据全落已知类）；但**同环节**（按条·推理期·持久库准入），且点名 admission 是 "critical but under-specified control problem" | 必引（问题命名 + 环节先例） |

## 扫描级候选（第十二轮，仅摘要 🔍——引用/评估前须全文核）

| 论文 | 一句话 | 关注度 |
|---|---|---|
| 2607.08032 rate-distortion 综述 | 理论旗帜（compaction 视角），无实现门 | 中（已第六轮核过 v1，作 concurrent position 引用） |
| 2606.13177 MemRefine | 预算约束的事后 compaction（已入库条目），LLM judge 判据 | 低 |
| 2607.05029 FARMA/SENTINEL | 对抗伪造记忆的写路径防御（trust 族） | 中（安全角度，非判据竞争） |
| 2601.12906 Gated Differentiable WM | 长上下文工作记忆的效用门（非持久库） | 低 |
| 2604.15877 Experience Compression Spectrum | 综述：压缩率作组织轴 | 低（修辞空间拥挤信号） |
| 2601.01885 Agentic Memory（学习式存/弃策略） | 端到端学的 store/discard，无信息论判据 | 低 |
| 2603.11768 SSGM / 2603.18631 D-Mem / TierMem | GovMem 引用的治理/质量门谱系 | 中（写 Related Work 时点名谱系） |
| 2607.25066 ARC / 2607.05378 CompactionRL | 无损指针 compaction / RL compaction | 低 |
| 2606.18829 GateMem / 2607.01071 MemSyco-Bench | 治理/滥用侧 benchmark（读侧） | 低（可作动机引用） |
| 2603.14588 SuperLocalMemory V3 | 产品向白皮书 | 忽略 |

## 重扫 SOP（投稿前必做）

1. 三角度检索（MDL/压缩判据 · rate-distortion 后继 · agentic 写门新作），词表沿用第十二轮 `searches_run`
2. 高关注对象 → 全文 3 票（第十三轮模板：判据类型 × 环节 × GT-free × 按条 × 推理期五轴裁决）
3. 更新本表 + REPORT §4；**核心句每一次动摇都必须走收紧程序，不许静默改写**
