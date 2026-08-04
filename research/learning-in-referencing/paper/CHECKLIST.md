# 投稿前禁令自查表 — `main.tex` v1（2026-08-04）

> 每条禁令都由一次自我推翻换来。**改稿后必须重跑本表**：
> `python3 ../tools/audit_retracted.py`（扫全部文档）+ 下表逐条人工勾。

| # | 禁令 | 来源 | `main.tex` 中的落实位置 |
|---|---|---|---|
| 1 | 不写「尚无 GT-free 的写入准入门控」 | #13（GATES/LMSI） | §1「Gates exist」段：明写 *We claim novelty on none of the obvious axes*，正面引用 GATES/LMSI |
| 2 | 不以「无外部 oracle」为独立卖点 | 第八轮 | 全文未出现；与 DeMem 的区分写成**作用域**（§1 末、附录 A） |
| 3 | 「写入」必带 scope（推理期/持久/按条） | 第八轮 | §1、§3.4、表 1/表 2 的 Locus 列 |
| 4 | 区分 L1 外部 / L4 参数化两个实例化 | 本稿新增 | §3.4 明写 (a)/(b)，并标注 §5.4 用 (a)、§6 用 (b) |
| 5 | 不得把端到端 16/16 与核心域 0.915 并列 | 本稿新增 | §5.4 明写 *substantially easier … should not be read as comparable* |
| 6 | 语义熵不得写成「≈随机」 | #20 | §5.1「The failure is directional」：反向 0.137 / 随机 0.507，并如实报 G5 例外 0.750 |
| 7 | 三臂 → 实际 2 臂 | #20 | §5.1 明写 **two independent arms, not three**（附数学等价证据 5.55e−17） |
| 8 | PersistBench 53% 不得直接比数值 | 第四轮 | 全文未引该数字 |
| 9 | 分区版零退化不得报作「抗崩塌」实证 | #23 | §6 明写 *true by construction*，结论落在同容量消融上 |
| 10 | I2 只能声称两种形态 | #21/#28 | 本稿未声称 I2；组合性只在 §6 作为substrate 讨论 |
| 11 | 不得把 Δ0.000 报作「抗遗忘」 | #23 | 未写入 main.tex |
| 12 | 不得掩饰 L4 在组合上低于 L1 | 本稿新增 | §6 明写 context injection obtains both (0.905/0.995) |
| 13 | 不得声称 I3 成立 / 「内化」必带作用域 | #24 | §6 全节以 word-independent bias 表述；§7(i) |
| 14 | 「迁移随读出余弦单调」不得写成定律 | #24 | 图 2 caption：*three points, ordered, not a fitted law* |
| 15 | 不得声称中间层记忆能解决跨格式 | #24 | §7(i)：*Fixes we have **not** built* |
| 16 | 参数化线不得写 learns a word/concept | #25 | §6 结论句：**not that a word's meaning has been learned** |
| 17 | 「输出随词改变」不等于绑定 | #25 | §6：余弦 0.787 但判别力保留 97% |
| 18 | 不得把 P9 跨格式迁移当正面结果 | #26 | §6「Binding is achievable」：那是**没绑定**换来的 |
| 19 | 未给训练曲线不得断言「架构做不到」 | #26 | §6 明写 *a property of the teaching set, not of the architecture* |
| 20 | 🔴 不得把「门控环节 / locus」当新颖性一条腿 | **#27** | §1：*Nor is the locus ours*；表 1/表 2 的 ConsistencyGate 行 |
| 21 | 🔴 引用 ConsistencyGate 必须同时给失效实证 | **#27** | §1 → §5.1 的 0.137 由 §5.1 承担；附录 A 末段再述 |
| 22 | 🔴 判据轴须带两条限定（压缩谁的行为 / 门决定什么） | **#28** | §1 末三句 + 附录 A 末段（DeMem 三条差异） |

## 机械检查（每次改稿跑）

```bash
python3 ../tools/audit_retracted.py                 # 全库过时主张扫描，须 0 处残留
tectonic -X compile main.tex --outdir=/tmp/texout   # 须无 error
```

`main.tex` 内另有正则自查（见 git 历史中的 `paper/` 提交）：悬空 `\cite`、悬空 `\ref`、
环境配对、图文件存在性、以及上表关键禁令的字符串扫描。

## ⏰ 投稿当月必做

1. **重扫 rate-distortion / memory-compaction 方向**——两个月内已冒出两篇直接命中的
   （DeMem 2026-05、ConsistencyGate 2026-07）。
2. 复核两条会场：Delétang ICLR 2024、SEMA CVPR 2025（当前均已有一手证据）。
3. `refs.bib` 的编辑纪律写在 **`annote`** 而非 `note`——新增条目请沿用，
   否则中文与 emoji 会被 `plainnat` 排进参考文献并导致编译失败。
