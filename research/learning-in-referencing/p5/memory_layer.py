"""L4 参数化记忆层：product-key 稀疏槽 + uid 硬分区

与 P4 的 L1 外部记忆的本质区别：
  L1  概念以**文本**存在外部，靠**检索**注入上下文  → 满足 I4 持久、隔离；不满足 I1 免检索
  L4  概念以**参数**存在（keys/values），前向传播时自动生效 → 目标是同时满足 I1

⚠️ **本实现的诚实定位（比研究文档 §7.4 的提案弱）**：
  记忆层挂在**最后一层 post-norm 之后**（`logits = lm_head(h + m(h))`），
  而非插入中间层。好处是梯度只过冻结的 lm_head、**无需反传任何 transformer block**，
  单机可训；它能改变输出分布，但**不参与中间层的表征计算**（结构事实）。
  **⟹ 论文中须写明这是 final-layer memory，不得等同于中间层 product-key 记忆层。**

  ⚠️ 本处初稿写的"代价是缺少深度组合性"**已被 p6 实测推翻、撤回**：
     跨域探针（概念 ⊗ 世界知识）base 0.500 → 本层 0.949，且反超上下文注入 0.840。
     **结构差异 ≠ 能力差异。**

uid 硬分区：槽位区间按 uid 划分，检索时用 mask 屏蔽其它分区。
  ⟹ 跨用户干扰在**构造上**为 0（不是靠打分排序压下去的）。
"""
import torch
import torch.nn as nn


class PartitionedMemoryLayer(nn.Module):
    """product-key 风格的稀疏槽记忆，键空间按 uid 硬分区。

    slots_per_uid 个槽为一个分区；查询时只在自己的分区内取 top-k。
    """

    def __init__(self, d_model, n_uid, slots_per_uid=32, topk=4, init_scale=0.01, temp=10.0):
        super().__init__()
        self.d = d_model
        self.n_uid = n_uid
        self.spu = slots_per_uid
        self.topk = min(topk, slots_per_uid)
        n_slots = n_uid * slots_per_uid
        self.temp = temp          # ★ 见下方「余弦路由」注释——不可省
        self.keys = nn.Parameter(torch.randn(n_slots, d_model) * init_scale)
        self.values = nn.Parameter(torch.zeros(n_slots, d_model))   # 零初始化 → 初始为恒等

    def partition(self, uid_idx):
        lo = uid_idx * self.spu
        return lo, lo + self.spu

    def forward(self, h, uid_idx):
        """h: [B, d]（post-norm 隐状态），uid_idx: int 或 [B] —— 只在该 uid 的分区内检索"""
        if isinstance(uid_idx, int):
            uid_idx = torch.full((h.shape[0],), uid_idx, dtype=torch.long, device=h.device)
        out = torch.zeros_like(h)
        for i in range(h.shape[0]):
            lo, hi = self.partition(int(uid_idx[i]))
            K = self.keys[lo:hi]                       # [spu, d]
            V = self.values[lo:hi]
            # ★ 余弦相似度 + 温度，而非原始点积（实测教训，见 README §3）：
            # 这些提示只在「被描述的物体」上不同，隐状态两两余弦 ≈ 0.994、||h|| ≈ 172，
            # 原始点积被共有分量主导 → softmax 饱和成 one-hot → 12 个输入全路由到同一个槽
            # → 记忆退化为**常量偏置**，训练 acc 卡在 0.50。
            # 余弦归一化后 loss 0.6377 → 0.0021、acc 0.50 → 1.00。
            sim = torch.nn.functional.normalize(K, dim=-1) @ \
                  torch.nn.functional.normalize(h[i], dim=-1) * self.temp
            w, idx = torch.topk(sim, self.topk)
            w = torch.softmax(w, dim=-1)
            out[i] = (w.unsqueeze(-1) * V[idx]).sum(0)
        return out

    # ---- 诊断：构造性零干扰的直接证据 ----
    def partitions_disjoint(self):
        """键空间按 uid 划分为互不相交的区间 —— 构造上不可能跨区命中"""
        spans = [self.partition(u) for u in range(self.n_uid)]
        for a in range(len(spans)):
            for b in range(a + 1, len(spans)):
                if not (spans[a][1] <= spans[b][0] or spans[b][1] <= spans[a][0]):
                    return False
        return True

    def uid_param_slice(self, uid_idx):
        lo, hi = self.partition(uid_idx)
        return self.keys[lo:hi], self.values[lo:hi]
