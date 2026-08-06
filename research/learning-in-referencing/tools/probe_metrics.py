"""判别信号的度量：**一律用阈值无关 AUC，禁止用绝对阈值算命中率**。

为什么单独抽一个文件：这条教训已经在本项目里**踩过两次**——
  · P3：冲突词隔离实验准确率 0.00，实为 Yes/No 题的系统性 **No 偏置**
        （蓝色项 p_yes 0.245–0.349 vs 红色 0.020–0.023，判别信号强 14× 却全在 0.5 以下）
  · P6：跨域探针的**世界知识前置检查**又用了绝对阈值，得 0.688 并打印"世界知识不足"警告
        （16 个正确颜色配对有 5 个 p_yes < 0.5，而负例低至 0.001）；改 AUC 后 **0.891**
第一次的教训写进了报告，**但没有变成代码**，于是第二次照犯。
⟹ 新脚本请 `from tools.probe_metrics import auc, hit_rate` —— hit_rate 只作偏置证据，**不得当判据**。
"""


def auc(pos, neg):
    """正例分数 pos 与负例分数 neg 的 ROC-AUC（并列计 0.5）。空集返回 nan。"""
    if not pos or not neg:
        return float("nan")
    return sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / (len(pos) * len(neg))


def hit_rate(margins):
    """⚠️ 仅作 No 偏置的证据，**不得用作判据**。margins = logit_yes − logit_no。"""
    return sum(m > 0 for m in margins) / len(margins) if margins else float("nan")


def bias_report(pos_scores, neg_scores, pos_margins):
    """一次给出：AUC（判据）+ 命中率（受偏置）+ 偏置证据（多少正例落在 0.5 以下）。"""
    return dict(auc=auc(pos_scores, neg_scores),
                raw_hit_rate=hit_rate(pos_margins),
                pos_below_half=sum(p < 0.5 for p in pos_scores),
                n_pos=len(pos_scores),
                neg_min=min(neg_scores) if neg_scores else float("nan"))
