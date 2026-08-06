"""uid 分区记忆：把 P3 的「手工给对上下文」升级为**结构性保证**

⚠️ **本模块的层级定位（必须诚实）**：
这是**外部记忆 + 检索纪律**（内化度阶梯 L1），
**不是**研究文档 §7.4 提议的 **product-key 参数化记忆层（L4）** —— 后者需要训练，本轮零算力做不到。

本模块要证的是**检索侧的分区纪律**：
  · 每条记忆的键带 uid 前缀，检索时按 uid 掩码
  · ⟹ 用户 u 的查询在**构造上**不可能命中别人的分区 → 跨用户干扰恒为 0
这一条是**构造性真理**，不是实证发现；实证的是「它能否复现隔离条件下的行为」以及「不分区的对照是否劣化」。
"""
from collections import defaultdict


class PartitionedMemory:
    """按 uid 硬分区的概念记忆。

    键空间 = (uid, word)。检索时**只扫该 uid 的分区**，
    因此跨用户干扰在构造上为 0（不是靠打分排序压下去的）。
    """

    def __init__(self, partitioned=True):
        self.partitioned = partitioned
        self._store = defaultdict(dict)   # uid -> {word: meaning}
        self.writes = 0
        self.rejected = 0

    # ---- 写入（只有门控放行的才进来）----
    def write(self, uid, word, meaning):
        key = uid if self.partitioned else "__shared__"
        self._store[key][word] = meaning
        self.writes += 1

    def reject(self):
        self.rejected += 1

    # ---- 检索 ----
    def retrieve(self, uid, word):
        """返回该 uid 分区中 word 的含义列表。

        分区模式：只看自己的分区 → 至多 1 条（结构性零干扰）
        共享模式：所有人写到同一分区 → 后写覆盖先写（真实的无隔离行为）
        """
        key = uid if self.partitioned else "__shared__"
        m = self._store[key].get(word)
        return [m] if m is not None else []

    def retrieve_all_conflicting(self, word):
        """诊断用：跨所有分区取该 word 的全部含义（用于展示"若无分区会看到什么"）"""
        out = []
        for uid, d in self._store.items():
            if word in d:
                out.append((uid, d[word]))
        return out

    # ---- 上下文渲染 ----
    def context_for(self, uid, word, fallback):
        hits = self.retrieve(uid, word)
        if not hits:
            return fallback
        return "\n".join(f"{word} means {m}." for m in hits)

    def stats(self):
        return dict(partitions=len(self._store), writes=self.writes,
                    rejected=self.rejected,
                    per_partition={k: len(v) for k, v in self._store.items()})
