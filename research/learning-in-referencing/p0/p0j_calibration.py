"""P0j — σ_null 无量纲化：解决阈值跨规模不可迁移

问题（P0 §6d）：σ_null 是最好的弃权信号（预测判错 AUC 1.5B 0.965 / 3B 0.905），
但**绝对尺度随模型变化**（3B ≈ 1.5B 的 4×），1.5B 调好的 τ_dec 在 3B 上无意义。

要求：找一个无量纲量，使得**同一个阈值在两个规模上都工作**。

候选归一化（σ_null 测的是「候选定义的选择能让决策序列 NLL 移动多少」，
故自然尺度应是 base_nll = 无概念时要解释的总熵）：

  raw            σ
  /base          σ / base_nll          ← 可解释熵的比例（首选，量纲天然抵消）
  /|mu|          σ / (|μ_null| + eps)
  /range         σ / (max_null − min_null)
  /n             σ / n_decisions
  rank           该 item 的 σ 在本批次内的分位（需要批次，但天然无量纲）

评价标准（两条都要满足才算成功）：
  A. 每个规模内 AUC 不显著下降
  B. ★ 跨规模阈值可迁移：在 1.5B 上选出的最佳阈值，直接用到 3B 上仍有效
"""
import json, os, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
SCALES = {"1.5B": "p0e_Qwen2.5-1.5B-Instruct.json", "3B": "p0e_Qwen2.5-3B-Instruct.json"}
D = {}
for k, f in SCALES.items():
    R = json.load(open(os.path.join(HERE, f)))["rows"]
    for r in R:
        v = [x["dnll"] for x in r["nulls"]]
        r["_rng"] = (max(v) - min(v)) or 1e-9
        r["_correct"] = r["zM"] > r["zP"]
    D[k] = R


def norms(r):
    return {
        "raw": r["sd"],
        "/base": r["sd"] / (abs(r["base"]) + 1e-9),
        "/|mu|": r["sd"] / (abs(r["mu"]) + 1e-9),
        "/range": r["sd"] / r["_rng"],
        "/n": r["sd"] / 6.0,
    }


def add_rank(R):
    xs = sorted(r["sd"] for r in R)
    for r in R:
        r["_rank"] = sum(x < r["sd"] for x in xs) / (len(xs) - 1)


for R in D.values():
    add_rank(R)
KEYS = ["raw", "/base", "/|mu|", "/range", "/n", "rank"]


def val(r, k):
    return r["_rank"] if k == "rank" else norms(r)[k]


def auc(pos, neg):
    return sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / (len(pos) * len(neg)) if pos and neg else float("nan")


print("=" * 92)
print("P0j — σ_null 无量纲化")
print("=" * 92)

print("\n【标准 A】每个规模内，预测「本项会不会判错」的 AUC")
print(f"{'归一化':10} {'1.5B AUC':>10} {'3B AUC':>9} {'1.5B 判对/判错 均值':>24} {'3B 判对/判错 均值':>22}")
print("-" * 92)
stats = {}
for k in KEYS:
    row = {}
    for sc, R in D.items():
        g = [val(r, k) for r in R if r["_correct"]]
        b = [val(r, k) for r in R if not r["_correct"]]
        row[sc] = dict(auc=auc(g, b), g=st.mean(g), b=st.mean(b))
    stats[k] = row
    print(f"{k:10} {row['1.5B']['auc']:10.3f} {row['3B']['auc']:9.3f} "
          f"{row['1.5B']['g']:11.3f} / {row['1.5B']['b']:<8.3f} "
          f"{row['3B']['g']:11.3f} / {row['3B']['b']:<8.3f}")

print("\n【标准 B ★】跨规模阈值可迁移性")
print("在 1.5B 上选最佳弃权阈值 → 直接用到 3B，看保留项判对率")
print(f"{'归一化':10} {'τ*(1.5B)':>10} {'1.5B 覆盖/判对率':>18} {'→ 3B 覆盖/判对率':>20}  迁移")
print("-" * 92)


def best_tau(R, k):
    """在该规模上选：保留项判对率最高，且覆盖率 >= 50%"""
    cands = sorted(set(val(r, k) for r in R))
    best = (None, -1, 0)
    for t in cands:
        keep = [r for r in R if val(r, k) >= t]
        if len(keep) < len(R) * 0.5:
            continue
        acc = sum(r["_correct"] for r in keep) / len(keep)
        if acc > best[1]:
            best = (t, acc, len(keep))
    return best


results = {}
for k in KEYS:
    t, acc_a, cov_a = best_tau(D["1.5B"], k)
    if t is None:
        continue
    keep_b = [r for r in D["3B"] if val(r, k) >= t]
    base_b = sum(r["_correct"] for r in D["3B"]) / len(D["3B"])
    if keep_b:
        acc_b = sum(r["_correct"] for r in keep_b) / len(keep_b)
        cov_b = len(keep_b)
    else:
        acc_b, cov_b = float("nan"), 0
    gain = acc_b - base_b
    ok = "✅ 有效" if (cov_b >= 6 and gain > 0.08) else ("◐ 弱" if cov_b >= 6 and gain > 0 else "❌ 失效")
    results[k] = dict(tau=t, acc_a=acc_a, cov_a=cov_a, acc_b=acc_b, cov_b=cov_b, gain=gain)
    print(f"{k:10} {t:10.3f} {cov_a:6d}/22 {acc_a:9.1%} {cov_b:10d}/22 {acc_b:9.1%}  {ok}")

print("-" * 92)
print(f"（3B 不弃权时的基线判对率 = {sum(r['_correct'] for r in D['3B'])/len(D['3B']):.1%}）")

good = [k for k, v in results.items() if v["cov_b"] >= 6 and v["gain"] > 0.08]
print(f"\n★ 通过标准 B（跨规模迁移）的归一化：{good or '（无）'}")
if good:
    b = max(good, key=lambda k: results[k]["gain"])
    v = results[b]
    print(f"  最佳 = 「{b}」  τ={v['tau']:.3f}")
    print(f"    1.5B: 覆盖 {v['cov_a']}/22，判对率 {v['acc_a']:.1%}")
    print(f"    3B  : 覆盖 {v['cov_b']}/22，判对率 {v['acc_b']:.1%}（相对不弃权基线 {v['gain']:+.1%}）")
    print(f"    → **同一个阈值在两个规模上都有效**，校准问题解决")
else:
    print("  → 无候选通过；σ_null 的跨规模校准仍未解决，应如实报告")

print("\n各规模 σ_null 的绝对尺度（说明为何需要归一化）")
for sc, R in D.items():
    print(f"  {sc:5} raw σ 中位 {st.median([r['sd'] for r in R]):7.2f} | "
          f"/base 中位 {st.median([r['sd']/abs(r['base']) for r in R]):.3f} | "
          f"base_nll 中位 {st.median([r['base'] for r in R]):7.2f}")

json.dump({"per_scale_auc": stats, "transfer": results, "passing": good},
          open(os.path.join(HERE, "p0j_results.json"), "w"), indent=2, ensure_ascii=False)
print("\n[saved] p0j_results.json")
