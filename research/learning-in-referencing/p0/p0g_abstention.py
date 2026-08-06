"""P0g — 三态门：ACCEPT / REJECT / ABSTAIN，用 GT-free 的可判定性计触发弃权

动机（P0d/P0e/P0f）：
  门的判别力继承自基座能力（ρ=0.857），且关系类概念上几乎无信号（G4 AUC 0.562）。
  校准救不了。但如果门能【知道自己判不了】并转为追问，作用域问题就从缺陷变成机制的一部分。

需要一个可判定性计，必须满足：
  · GT-free（不需要答案）
  · 不需要知道哪个候选是对的
  · 门本来就能算出来（不引入额外开销）

候选：σ_null —— 零分布的离散度。
  语义：把各种候选定义塞进上下文，模型的预测【到底会不会被影响】。
  σ_null ≈ 0 ⟹ 定义根本没进入模型的决策 ⟹ 任何基于增益的判据都是在读噪声。

三态规则：
  σ_null <  τ_dec          → ABSTAIN（转 EIG 主动追问，对应机制文档 §1.4 的 ASK 分支）
  σ_null >= τ_dec ∧ z > τ  → ACCEPT
  σ_null >= τ_dec ∧ z ≤ τ  → REJECT

本脚本为纯分析（不需要模型），直接读 p0e 结果。
"""
import json, os, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "p0e_Qwen2.5-1.5B-Instruct.json")
R = json.load(open(SRC))["rows"]
N = len(R)


def auc(p, n):
    return sum((a > b) + 0.5 * (a == b) for a in p for b in n) / (len(p) * len(n)) if p and n else float("nan")


def rank(v):
    s = sorted(range(len(v)), key=lambda i: v[i]); r = [0] * len(v)
    for k, i in enumerate(s): r[i] = k + 1
    return r


def spearman(x, y):
    rx, ry = rank(x), rank(y); mx, my = st.mean(rx), st.mean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = (sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)) ** .5
    return num / den if den else 0.0


sig = [r["sd"] for r in R]
marg = [r["dM"] - r["dP"] for r in R]

print("=" * 82)
print("P0g — 三态门（ACCEPT / REJECT / ABSTAIN）· 可判定性计 = σ_null")
print("=" * 82)
print(f"\nρ(σ_null, 判别 margin) = {spearman(sig, marg):+.3f}   [对比：ρ(能力探针, margin)=+0.857]")
print("→ σ_null 相关性略弱，但**不需要知道哪个候选是对的**，更可部署\n")

print(f"{'类型':6} {'n':>3} {'σ_null':>8} {'margin':>8}")
print("-" * 30)
for t in ("G1", "G2", "G3", "G4", "G5"):
    S = [r for r in R if r["type"] == t]
    print(f"{t:6} {len(S):3d} {st.mean([x['sd'] for x in S]):8.2f} {st.mean([x['dM']-x['dP'] for x in S]):8.2f}")

print("\n" + "=" * 82)
print("弃权阈值扫描：覆盖率 vs 判别质量")
print("=" * 82)
print(f"{'τ_dec':>6} {'覆盖':>8} {'弃权项':>7} {'AUC(保留)':>10} {'全局可分':>9}  弃权掉的是哪些")
print("-" * 82)
rows = []
for th in (0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0):
    keep = [r for r in R if r["sd"] >= th]
    drop = [r for r in R if r["sd"] < th]
    if len(keep) < 4:
        continue
    zM = [r["zM"] for r in keep]; zP = [r["zP"] for r in keep]
    a = auc(zM, zP); sep = min(zM) > max(zP)
    types = {}
    for r in drop:
        types[r["type"]] = types.get(r["type"], 0) + 1
    rows.append(dict(tau_dec=th, coverage=len(keep) / N, n_keep=len(keep), n_drop=len(drop),
                     auc=a, sep=sep, dropped_types=types))
    ds = " ".join(f"{k}×{v}" for k, v in sorted(types.items())) or "—"
    print(f"{th:6.1f} {len(keep):3d}/{N:<4} {len(drop):7d} {a:10.3f} {'✅' if sep else '❌':>9}  {ds}")

print("-" * 82)
best = max(rows, key=lambda r: r["auc"])
print(f"最佳工作点：τ_dec={best['tau_dec']}  覆盖 {best['n_keep']}/{N} ({best['coverage']:.0%})  "
      f"AUC {best['auc']:.3f}  （不弃权时 AUC {rows[0]['auc']:.3f}）")

print("\n=== 弃权的正当性检验：被弃权的项，门本来能判对吗？ ===")
for th in (1.0, 1.5):
    drop = [r for r in R if r["sd"] < th]
    if not drop: continue
    zm = [r["zM"] for r in drop]; zp = [r["zP"] for r in drop]
    print(f"  τ_dec={th}: 被弃权 {len(drop)} 项，其 AUC = {auc(zm,zp):.3f} "
          f"({'≈随机，弃权正确 ✅' if auc(zm,zp) < 0.65 else '仍有信息，弃权可能过度 ⚠️'})")

print("\n=== 三态门完整决策（τ_dec=1.5, τ_z 取保留项的最佳分割）===")
th = 1.5
keep = [r for r in R if r["sd"] >= th]
zM = [r["zM"] for r in keep]; zP = [r["zP"] for r in keep]
cands = sorted(set(zM + zP))
best_t, best_acc = None, -1
for i in range(len(cands) - 1):
    t = (cands[i] + cands[i + 1]) / 2
    acc = (sum(z > t for z in zM) + sum(z <= t for z in zP)) / (2 * len(keep))
    if acc > best_acc: best_acc, best_t = acc, t
tp = sum(z > best_t for z in zM); fn = len(zM) - tp
tn = sum(z <= best_t for z in zP); fp = len(zP) - tn
print(f"  τ_z = {best_t:+.2f}")
print(f"  正确接受 M   {tp}/{len(zM)}     漏拒 M（把真概念判错）{fn}")
print(f"  正确拒绝 M′  {tn}/{len(zP)}     误收 M′（误解被固化）{fp}   ← 最该压低的错误")
print(f"  弃权（转追问）{N-len(keep)}/{N}")
print(f"  在覆盖项上的准确率 {best_acc:.1%}")

json.dump({"source": os.path.basename(SRC), "n": N,
           "spearman_sigma_margin": spearman(sig, marg),
           "sweep": rows,
           "operating_point": {"tau_dec": th, "tau_z": best_t, "coverage": len(keep)/N,
                               "accept_M": tp, "miss_M": fn, "reject_Mprime": tn, "admit_Mprime": fp,
                               "accuracy_on_covered": best_acc}},
          open(os.path.join(HERE, "p0g_results.json"), "w"), indent=2, ensure_ascii=False)
print("\n[saved] p0g_results.json")
