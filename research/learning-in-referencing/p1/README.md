# P1 — 构造语言生成器（脚手架，2026-08-01）

> 实现 [DESIGN_CONCEPT_BENCH.md](../../../docs/DESIGN_CONCEPT_BENCH.md) §2–§6 的可执行版本。
> 纯 CPU、零模型依赖；确定性（同 seed 同输出）。

## 文件

| 文件 | 作用 |
|---|---|
| `lexicon.py` | CV(C) 音系伪词 + 四道过滤（阻断表 + 编辑距离已实现；分词器/零样本探针为可选钩子，**正式实验前必须补跑**） |
| `microworld.py` | 组合式微世界：kind(13, 4 群) × color(4) × size(3) × material(4)；范畴层级供 G2 |
| `gavagai.py` | G1–G5 对构造器 + 冲突词隔离对（§6）；**教学集外延一致由构造保证** |
| `generate.py` | 入口：`python3 generate.py --per-type 8 --seed 11` |
| `test_p1.py` | 不变量测试（T1 外延一致 / T2 分离样例 / T3 词库过滤 / T4 确定性 / T5 留出未见 / T6 overspec≥2）——**全部通过** |
| `items_p1.json` | 40 items（8×5 类），结构与 p0/items_v2.py 兼容（heldout/nulls 同构 + 新增 teaching/semantics） |
| `isolation_p1.json` | 8 个冲突词隔离对（同词、两老师互斥语义） |

## 与 p0 的差别

- p0 = 22 个**手工** items；P1 = **程序化生成**，规模可调，语义由 `semantics` 字段机读
- 新增 `teaching` 字段：供 P2 教学协议消融（指物 vs 定义 vs 平行句对，切断 Aycock 捷径）
- 新增隔离对：供 P3 记忆层 + P4 隔离测试

## 已知边界（照 DESIGN 定稿，非缺陷）

- **G4/G5 照常生成但评测须单列**：P0f 坐实 G4 为基座能力边界（AUC≈随机）；G5 是 E5 高危类型（先验压过定义，随规模恶化）。主指标以 G1/G2/G3 为核心。
- 词库过滤 2/3（分词器熟悉度、零样本探针）需模型环境：`lexicon.make_lexicon(tokenizer=...)` 已留钩子，meta 中 `tokenizer_check_skipped` / `zero_shot_probe` 字段显式标注未跑状态。
- 目标语语法参数（SOV/格标记等，DESIGN §2.3）**尚未实现**——当前英语载体句与 p0 对齐；P2 教学协议需要时再加 `grammar.py`。

## ✅ 实证复核已通过（2026-08-01，`p1_eval.py` → `p1_eval_Qwen2.5-1.5B-Instruct.json`）

| | P1 程序化（40 items） | p0e 手工（22 items）对照 |
|---|---|---|
| **核心域 G1–G3** | margin **+4.44**，23/24，p=1e-6，**AUC(z) 0.911** | +4.08，19/22，p=0.00043 |
| 全类型 | +2.71，35/40，p=1e-6，AUC(z) 0.800 | — |
| G4（能力边界） | **AUC(z) 0.500 ≈ 随机** ← 精确复现 P0f | 0.562 |
| G5 | +0.23（小但 8/8 一致），AUC(z) 0.891 | — |
| 过滤 2（分词器，Qwen） | **0 词被标记** ✅ | — |
| 过滤 3（零样本探针） | **AUC 0.394 ≈ 无先验信号** ✅ | — |

**结论**：程序化生成不损核心信号；G4/G5 单列作用域的决定被复现支持。生成器可放量供 P2。

## 下一步（P2）

三臂对照（压缩 / 语义熵 / EIG）→ [DESIGN_COMPRESSION_GATE.md](../../../docs/DESIGN_COMPRESSION_GATE.md) §4 消融矩阵；隔离测试用 `isolation_p1.json`
