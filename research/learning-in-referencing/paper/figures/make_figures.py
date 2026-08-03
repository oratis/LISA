"""投稿用图（REPORT §6 第 3 项）。无外部数据依赖——全部读各实验自己产出的 JSON。

约定：单栏 3.3in，字号 8–9pt，灰度可读（不靠颜色区分），无网格背景色。
"""
import os, json, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
TAG = "Qwen2.5-1.5B-Instruct"
plt.rcParams.update({"font.size": 8, "axes.labelsize": 8, "axes.titlesize": 9,
                     "xtick.labelsize": 7.5, "ytick.labelsize": 7.5, "legend.fontsize": 7.5,
                     "axes.spines.top": False, "axes.spines.right": False,
                     "figure.dpi": 200, "savefig.bbox": "tight"})
GREY, DARK, MID = "#bdbdbd", "#2b2b2b", "#7a7a7a"


def load(p):
    f = os.path.join(ROOT, p)
    return json.load(open(f)) if os.path.exists(f) else None


# ── Fig 1 ── P2：判据类型对照，且按「M′ 是否更窄」分层
def fig1():
    d = load(f"p2/p2_{TAG}.json")
    if not d:
        return print("skip fig1")
    rows = d["rows"]
    # ★ 分层口径与 p2/README.md §3.2 完全一致：M′ 更窄 = G1(合取)+G2(范畴层级)
    core = [r for r in rows if r["type"] in ("G1", "G2", "G3")]
    narrow = [r for r in rows if r["type"] in ("G1", "G2")]
    wide = [r for r in rows if r["type"] in ("G3", "G4", "G5")]
    KEY = {"z": ("zM", "zP"), "se": ("se_M", "se_P")}   # ← JSON 里两组键名格式不同

    def auc_on(sub, k):
        """★ 必须与 p2_three_arm.py 的 report() 用**同一个估计量**：
        全体 M 分数 vs 全体 M′ 分数的**汇总 AUC**，不是配对胜率。
        （两者不同：核心域汇总 0.915 vs 配对胜率 0.958 —— 图若用后者就与正文对不上。）"""
        if not sub:
            return float("nan")
        a, b = KEY[k]
        pos, neg = [r[a] for r in sub], [r[b] for r in sub]
        return sum((x > y) + 0.5 * (x == y) for x in pos for y in neg) / (len(pos) * len(neg))

    fig, ax = plt.subplots(figsize=(3.4, 2.1))
    groups = [("core (G1–G3)\n$n$=%d" % len(core), core),
              ("M′ narrower\n(G1,G2) $n$=%d" % len(narrow), narrow),
              ("M′ not narrower\n(G3–G5) $n$=%d" % len(wide), wide)]
    x = range(len(groups))
    wid = 0.38
    comp = [auc_on(g, "z") for _, g in groups]
    sem = [auc_on(g, "se") for _, g in groups]
    ax.bar([i - wid / 2 for i in x], comp, wid, color=DARK, label="compression gain (z)")
    ax.bar([i + wid / 2 for i in x], sem, wid, color=GREY, edgecolor=MID, label="semantic entropy")
    ax.axhline(0.5, color="k", lw=0.7, ls=":")
    ax.text(-0.46, 0.52, "chance", fontsize=6.5, color="k", ha="left", va="bottom")
    ax.set_xticks(list(x)); ax.set_xticklabels([g for g, _ in groups])
    ax.set_ylabel("AUC  (scores of M vs M′)"); ax.set_ylim(0, 1.05)
    ax.legend(frameon=False, loc="upper center", bbox_to_anchor=(0.55, 1.0), handlelength=1.2)
    for i, (c, s) in enumerate(zip(comp, sem)):
        ax.text(i - wid / 2, c + .02, f"{c:.2f}", ha="center", fontsize=6.5)
        ax.text(i + wid / 2, s + .02, f"{s:.2f}", ha="center", fontsize=6.5)
    fig.savefig(os.path.join(HERE, "fig1_criterion_type.pdf"))
    fig.savefig(os.path.join(HERE, "fig1_criterion_type.png"))
    # ★ 与脚本自己产出的 summary 交叉核对，对不上就拒绝出图
    ref = d["summary"]["core"]
    chk = [("压缩增益(z 校准)", comp[0]), ("语义熵", sem[0])]
    for name, v in chk:
        if abs(ref[name]["auc"] - v) > 1e-6:
            sys.exit(f"🔴 fig1 与 p2 summary 不一致：{name} 图 {v:.4f} vs summary {ref[name]['auc']:.4f}")
    print("fig1 ✓  compression", [f"{v:.3f}" for v in comp], " semantic-entropy", [f"{v:.3f}" for v in sem],
          "· 与 p2 summary 核对一致")


# ── Fig 2 ── 五判据 × 各方案（本项目 L4 vs 上下文注入）
def fig2():
    p6, p7, p8 = load(f"p6/p6_{TAG}.json"), load(f"p7/p7_{TAG}.json"), load(f"p8/p8_{TAG}.json")
    if not (p6 and p7 and p8):
        return print("skip fig2")
    crit = ["I1\nretrieval-free", "I2 ⊗ world\nknowledge", "I2 ⊗ another\nconcept",
            "I4\npersistent", "I5\nrobust", "I3\nimplicit use"]
    l4 = [0.992, p6["L4"]["cross"],
          min(p7["arms"]["joint"]["cj_no_w2"], p7["arms"]["joint"]["cj_no_w1"]),
          0.980, p8["I5"]["l4"]["conflict"], p8["I3"]["l4"]["auc"]]
    l1 = [0.485, p6["L1"]["cross"],
          min(p7["arms"]["l1"]["cj_no_w2"], p7["arms"]["l1"]["cj_no_w1"]),
          0.514, p8["I5"]["l1"]["conflict"], p8["I3"]["l1"]["auc"]]
    fig, ax = plt.subplots(figsize=(3.3, 2.2))
    x = range(len(crit)); wid = 0.38
    ax.bar([i - wid / 2 for i in x], l4, wid, color=DARK, label="consolidated (parametric)")
    ax.bar([i + wid / 2 for i in x], l1, wid, color=GREY, edgecolor=MID, label="context injection")
    ax.axhline(0.5, color="k", lw=0.7, ls=":")
    ax.axvspan(4.5, 5.5, color="#f2f2f2", zorder=0)
    ax.text(5, 1.04, "fails", ha="center", fontsize=7, color=DARK)
    ax.set_xticks(list(x)); ax.set_xticklabels(crit, fontsize=6.3)
    ax.set_ylabel("AUC"); ax.set_ylim(0, 1.12)
    ax.legend(frameon=False, loc="lower left", handlelength=1.2, ncol=1)
    fig.savefig(os.path.join(HERE, "fig2_criteria.pdf"))
    fig.savefig(os.path.join(HERE, "fig2_criteria.png"))
    print("fig2 ✓  L4", [f"{v:.3f}" for v in l4])


# ── Fig 3 ── ★ 读出方向：迁移随余弦 + 插入深度
def fig3():
    p8b, p9 = load(f"p8/p8b_{TAG}.json"), load(f"p9/p9_{TAG}.json")
    if not p8b:
        return print("skip fig3 (需要 p8b)")
    fig, axes = plt.subplots(1, 2, figsize=(6.9, 2.2))

    # (a) 只训 F1 时，迁移量 vs 读出方向余弦
    cos = {"F1 Yes/No": 1.0,
           "F3 True/False": p8b["readout_cosines"]["F1 Yes/No|F3 True/False"],
           "F2 A/B": p8b["readout_cosines"]["F1 Yes/No|F2 A/B"]}
    r, b = p8b["results"]["train_F1"], p8b["results"]["base"]
    ax = axes[0]
    for f in cos:
        ax.scatter(cos[f], r[f] - b[f], s=34, color=DARK, zorder=3)
        ax.annotate(f, (cos[f], r[f] - b[f]), textcoords="offset points",
                    xytext=(6, -3), fontsize=7)
    xs = sorted(cos, key=lambda k: cos[k])
    ax.plot([cos[k] for k in xs], [r[k] - b[k] for k in xs], color=MID, lw=0.8, ls="--", zorder=2)
    ax.axhline(0, color="k", lw=0.7, ls=":")
    ax.set_xlabel("cos(readout direction, training format's)")
    ax.set_ylabel("AUC gain over base")
    ax.set_title("(a) transfer tracks readout direction", loc="left")
    ax.set_xlim(-0.25, 1.35)

    # (b) 插入位置
    ax = axes[1]
    fmts = ["F1 Yes/No", "F2 A/B", "F3 True/False"]
    if p9:
        conds = [("base", "base"), ("post-norm", "post-norm\n(output layer)"),
                 ("L7@last", "layer 7\nlast pos. only"), ("L7", "layer 7\nall pos."),
                 ("l1", "context\ninjection")]
        conds = [(k, lab) for k, lab in conds if k in p9["results"]]
        src = p9["results"]
    else:
        conds = [("base", "base"), ("train_F1", "post-norm\n(output layer)"), ("l1", "context\ninjection")]
        src = p8b["results"]
    x = range(len(conds)); wid = 0.26
    for j, f in enumerate(fmts):
        ax.bar([i + (j - 1) * wid for i in x], [src[k][f] for k, _ in conds], wid,
               color=[DARK, MID, GREY][j], edgecolor="none",
               label=f + (" (trained)" if j == 0 else " (held-out)"))
    ax.axhline(0.5, color="k", lw=0.7, ls=":")
    ax.set_xticks(list(x)); ax.set_xticklabels([lab for _, lab in conds], fontsize=6.3)
    ax.set_ylabel("AUC"); ax.set_ylim(0, 1.12)
    ax.legend(frameon=False, fontsize=6.3, ncol=1, loc="lower right", handlelength=1.0)
    ax.set_title("(b) where the memory is inserted", loc="left")
    fig.savefig(os.path.join(HERE, "fig3_readout_direction.pdf"))
    fig.savefig(os.path.join(HERE, "fig3_readout_direction.png"))
    print("fig3 ✓ " + ("含 P9 插入深度" if p9 else "⚠️ 暂无 P9，(b) 只画了 post-norm"))


if __name__ == "__main__":
    fig1(); fig2(); fig3()
