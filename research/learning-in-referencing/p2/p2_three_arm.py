"""P2 — 三臂对照：压缩增益 vs 语义熵 vs epistemic 不确定性下降

这是论文 C4 主张的核心实验：
  「语义熵、几何新颖度等已有 GT-free 信号在 E1（模型自信且一贯的误解）上必失分，
    压缩增益在此处赢」——本脚本给出三臂的直接对照。

★ 三臂的结构性差异（这是全实验的论点）：

  臂 1 压缩增益（我方）：  用【老师实际的用词决策】—— 外部证据
  臂 2 语义熵：            只用【模型自己的预测分布】—— 内部自洽
  臂 3 epistemic 下降：    只用【模型自己的预测分布】—— 内部确信度提升

  ⟹ 后两臂无法区分「自洽的正确概念」与「自洽的误解」，因为二者都自洽。
     只有对照老师的实际用法才能分开 —— 这正是 C2/C4 的全部内容。

三臂均为 GT-free：都不知道哪个候选是对的。
臂 1 用到的 heldout 标签是【老师的观察到的用法】（数据），不是【关于概念对错的答案】。

---- 各臂定义 ----
臂1  score_comp(c) = Σ_o[−log P(y_o|o, ∅)] − Σ_o[−log P(y_o|o, c)]     （z 校准 vs 零分布）
臂2  score_SE(c)   = − mean_o H(p_yes(o|c))                             （熵越低越自洽 → 分越高）
臂3  score_epi(c)  = mean_o [ H(p_yes(o|∅)) − H(p_yes(o|c)) ]           （采纳 c 带来的确信度提升）

⚠️ 语义熵的适配说明（必须写进论文）：
Farquhar et al. (Nature 2024) 对自由生成采样后按双向蕴含聚成「意义簇」再算熵。
本设定的输出是二元 Yes/No，意义簇天然退化为 {Yes},{No} 两簇，
故语义熵 = 该意义分布的香农熵，且可由 logits **精确计算**而无需采样。
这是**比原方法更强**的版本（无采样噪声）——若它仍失分，结论更硬。
"""
import os, sys, json, math, argparse, statistics as st
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM

HERE = os.path.dirname(os.path.abspath(__file__))
P1 = os.path.join(os.path.dirname(HERE), "p1")

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="Qwen/Qwen2.5-1.5B-Instruct")
ap.add_argument("--items", default=os.path.join(P1, "items_p1.json"))
args = ap.parse_args()
TAG = args.model.split("/")[-1]

items = json.load(open(args.items))
if isinstance(items, dict):
    items = items.get("items", items.get("rows", []))

print(f"[load] {args.model}", flush=True)
tok = AutoTokenizer.from_pretrained(args.model, local_files_only=True)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.bfloat16,
                                             local_files_only=True).to(dev).eval()
print(f"[load] done · {dev} · {len(items)} items\n", flush=True)

YES = [" Yes", " yes", "Yes", "yes"]
NO = [" No", " no", "No", "no"]


def stmt(word, meaning):
    return f"{word} means {meaning}."


def q_of(it, body):
    return body if it["type"] == "G4" else f"Is {body} {it['word']}?"


@torch.no_grad()
def p_yes(prefix, qbody):
    """返回 p(Yes)，在 {Yes,No} 上归一化"""
    p = f"{prefix}\nQuestion: {qbody} Answer Yes or No.\nAnswer:"
    ids = tok(p, return_tensors="pt")["input_ids"].to(dev)
    lp = torch.log_softmax(model(ids).logits[0, -1].float(), -1)

    def best(cs):
        v = -1e9
        for c in cs:
            t = tok.encode(c, add_special_tokens=False)
            if t:
                v = max(v, lp[t[0]].item())
        return v
    y, n = best(YES), best(NO)
    m = max(y, n)
    tot = m + math.log(math.exp(y - m) + math.exp(n - m))
    return math.exp(y - tot)


def H(p):
    """二元香农熵（nats）"""
    if p <= 0 or p >= 1:
        return 0.0
    return -(p * math.log(p) + (1 - p) * math.log(1 - p))


def measure(it, prefix):
    """对一个前缀，返回 (决策序列 NLL, 平均熵)"""
    nll, ents = 0.0, []
    for body, label in it["heldout"]:
        py = p_yes(prefix, q_of(it, body))
        py = min(max(py, 1e-9), 1 - 1e-9)
        nll += -math.log(py if label == "Yes" else 1 - py)
        ents.append(H(py))
    return nll, st.mean(ents)


rows = []
for it in items:
    w = it["word"]
    base_prefix = f"{w} is a word in Tovi's language."
    base_nll, base_ent = measure(it, base_prefix)

    def score_all(meaning):
        nll, ent = measure(it, stmt(w, meaning))
        return dict(dnll=base_nll - nll,          # 臂1 原始压缩增益
                    se=-ent,                       # 臂2 语义熵（取负，越大越自洽）
                    epi=base_ent - ent)            # 臂3 epistemic 下降

    sM, sP = score_all(it["M"]), score_all(it["Mprime"])
    nulls = [(h, tag, score_all(h)) for h, tag in it["nulls"]]

    # 臂1 的 per-item z 校准（沿用 p0d/p0e 机制）
    v = [x[2]["dnll"] for x in nulls]
    mu, sd = st.mean(v), (st.stdev(v) or 1e-9)

    rows.append(dict(
        id=it["id"], type=it["type"], base_nll=base_nll, base_ent=base_ent,
        mu=mu, sd=sd,
        comp_M=sM["dnll"], comp_P=sP["dnll"],
        zM=(sM["dnll"] - mu) / sd, zP=(sP["dnll"] - mu) / sd,
        se_M=sM["se"], se_P=sP["se"],
        epi_M=sM["epi"], epi_P=sP["epi"],
    ))
    print(f"[{it['id']}] comp {sM['dnll']:+7.2f}/{sP['dnll']:+7.2f} │ "
          f"SE {sM['se']:+.3f}/{sP['se']:+.3f} │ epi {sM['epi']:+.3f}/{sP['epi']:+.3f}", flush=True)


# ---------------- 汇总 ----------------
def auc(pos, neg):
    return sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / (len(pos) * len(neg)) if pos and neg else float("nan")


def signtest(margins):
    n = len(margins); k = sum(m > 0 for m in margins)
    p = sum(math.comb(n, i) for i in range(k, n + 1)) / 2 ** n
    return k, n, p


ARMS = {
    "压缩增益(z 校准)": ("zM", "zP"),
    "压缩增益(裸 ΔNLL)": ("comp_M", "comp_P"),
    "语义熵": ("se_M", "se_P"),
    "epistemic 下降": ("epi_M", "epi_P"),
}


def report(subset, title):
    print("\n" + "=" * 88)
    print(f"{title}  ·  n={len(subset)}")
    print("=" * 88)
    print(f"{'臂':22} {'M 胜':>8} {'符号检验 p':>12} {'AUC':>8} {'平均 margin':>13}")
    print("-" * 88)
    out = {}
    for name, (a, b) in ARMS.items():
        m = [r[a] - r[b] for r in subset]
        k, n, p = signtest(m)
        A = auc([r[a] for r in subset], [r[b] for r in subset])
        out[name] = dict(wins=k, n=n, p=p, auc=A, margin=st.mean(m))
        flag = "✅" if p < 0.05 and A > 0.7 else ("⚠️" if p < 0.05 else "❌")
        print(f"{name:22} {k:3d}/{n:<4} {p:12.2e} {A:8.3f} {st.mean(m):13.3f}  {flag}")
    return out


core = [r for r in rows if r["type"] in ("G1", "G2", "G3")]
summary = {
    "all": report(rows, "全部 5 类歧义"),
    "core": report(core, "核心域 G1–G3（基座有能力，见 p0 §6/§6c）"),
}

print("\n" + "=" * 88)
print("★ C4 主张的直接检验")
print("=" * 88)
ca, sa, ea = (summary["core"]["压缩增益(z 校准)"], summary["core"]["语义熵"], summary["core"]["epistemic 下降"])
print(f"核心域上：压缩 AUC {ca['auc']:.3f} (p={ca['p']:.1e}) · "
      f"语义熵 AUC {sa['auc']:.3f} (p={sa['p']:.1e}) · epistemic AUC {ea['auc']:.3f} (p={ea['p']:.1e})")
gap_se, gap_epi = ca["auc"] - sa["auc"], ca["auc"] - ea["auc"]
print(f"压缩 − 语义熵 = {gap_se:+.3f}   压缩 − epistemic = {gap_epi:+.3f}")
if ca["auc"] > 0.75 and sa["auc"] < 0.65 and ea["auc"] < 0.65:
    v = "✅ C4 成立：压缩门在 E1 上显著优于两个内部自洽类信号"
elif ca["auc"] > sa["auc"] + 0.1 and ca["auc"] > ea["auc"] + 0.1:
    v = "◐ C4 部分成立：压缩门领先但对照臂未落到随机水平"
else:
    v = "❌ C4 不成立：压缩门未拉开差距 —— 需如实报告"
print(f"\n裁决：{v}")

print("\n=== 对照臂是否落在随机附近？（若显著偏离 0.5，须解释方向）===")
for name in ("语义熵", "epistemic 下降"):
    r = summary["core"][name]
    d = "偏向 M" if r["auc"] > 0.5 else ("偏向 M′" if r["auc"] < 0.5 else "持平")
    print(f"  {name:16} AUC {r['auc']:.3f} ({d})  平均 margin {r['margin']:+.4f}")

os.makedirs(HERE, exist_ok=True)
json.dump({"model": args.model, "n": len(rows), "summary": summary, "rows": rows},
          open(os.path.join(HERE, f"p2_{TAG}.json"), "w"), indent=2, ensure_ascii=False)
print(f"\n[saved] p2_{TAG}.json")
