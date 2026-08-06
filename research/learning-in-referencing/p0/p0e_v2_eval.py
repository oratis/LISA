"""P0e — 扩展刺激集 v2 评测：22 items × 5 种歧义类型 + bootstrap 置信区间

相对 P0c/P0d 的变化：
  · 6 → 22 items，G1/G2（单向判别）扩到 G3/G4/G5（★ 双向判别：两假设各有独占预测）
  · 加 bootstrap 95% CI（此前只有点估计，是 P0 报告 §5.2 列的限制之一）
  · 分类型报告，检验 "范畴歧义远易于合取歧义" 是否在更大样本上成立

用法：python p0e_v2_eval.py <model_id> [dtype]
"""
import os, sys, json, math, random, statistics as st
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from items_v2 import ITEMS2

MODEL = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen2.5-1.5B-Instruct"
DT = {"bf16": torch.bfloat16, "fp32": torch.float32}[sys.argv[2] if len(sys.argv) > 2 else "bf16"]
HERE = os.path.dirname(os.path.abspath(__file__))
TAG = MODEL.split("/")[-1]
random.seed(0)

print(f"[load] {MODEL} ({DT})", flush=True)
tok = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=DT, local_files_only=True).to(dev).eval()
print(f"[load] done · {dev}", flush=True)

YES = [" Yes", " yes", "Yes", "yes"]; NO = [" No", " no", "No", "no"]


def stmt(word, meaning):
    """G4 的 meaning 本身已是完整句子（以引号开头）；其余用 'W means M.' 模板"""
    return (meaning + ".") if meaning.startswith('"') else f"{word} means {meaning}."


@torch.no_grad()
def yn(prompt):
    ids = tok(prompt, return_tensors="pt")["input_ids"].to(dev)
    lp = torch.log_softmax(model(ids).logits[0, -1].float(), -1)
    def best(cs):
        v = -1e9
        for c in cs:
            t = tok.encode(c, add_special_tokens=False)
            if t: v = max(v, lp[t[0]].item())
        return v
    return best(YES), best(NO)


def label_nll(prefix, qbody, label):
    y, n = yn(f"{prefix}\nQuestion: {qbody} Answer Yes or No.\nAnswer:")
    m = max(y, n); tot = m + math.log(math.exp(y - m) + math.exp(n - m))
    return -((y if label == "Yes" else n) - tot)


def seq(prefix, it):
    return sum(label_nll(prefix, q, y) for q, y in it["heldout"])


rows = []
for it in ITEMS2:
    w = it["word"]
    base = seq(f"{w} is a word in Tovi's language.", it)
    def dn(mean): return base - seq(stmt(w, mean), it)
    dM, dP = dn(it["M"]), dn(it["Mprime"])
    nl = [(h, t, dn(h)) for h, t in it["nulls"]]
    v = [x[2] for x in nl]
    mu, sd = st.mean(v), (st.stdev(v) or 1e-9)
    rows.append(dict(id=it["id"], type=it["type"], base=base, dM=dM, dP=dP, mu=mu, sd=sd,
                     zM=(dM - mu) / sd, zP=(dP - mu) / sd,
                     nulls=[{"h": a, "tag": b, "dnll": c} for a, b, c in nl]))
    print(f"[{it['id']}] ΔNLL M={dM:+6.2f} M′={dP:+6.2f} margin={dM-dP:+6.2f}  z={rows[-1]['zM']:+.2f}/{rows[-1]['zP']:+.2f}", flush=True)


def auc(p, n): return sum((a > b) + 0.5 * (a == b) for a in p for b in n) / (len(p) * len(n))


def boot_ci(vals, fn, B=5000):
    xs = sorted(fn(random.choices(vals, k=len(vals))) for _ in range(B))
    return xs[int(.025 * B)], xs[int(.975 * B)]


def boot_auc_ci(pairs, B=5000):
    xs = []
    for _ in range(B):
        s = random.choices(pairs, k=len(pairs))
        xs.append(auc([a for a, _ in s], [b for _, b in s]))
    xs.sort()
    return xs[int(.025 * B)], xs[int(.975 * B)]


n = len(rows)
marg = [r["dM"] - r["dP"] for r in rows]
zmarg = [r["zM"] - r["zP"] for r in rows]
dM = [r["dM"] for r in rows]; dP = [r["dP"] for r in rows]
zM = [r["zM"] for r in rows]; zP = [r["zP"] for r in rows]
k = sum(x > 0 for x in marg)
# 上单侧二项检验：H1 是有方向的（预测 M 优于 M'），故报单侧。
# 双侧值 = 2×本值；结论在两种口径下都成立，输出与报告均已标注。
pval = sum(math.comb(n, i) for i in range(k, n + 1)) / 2 ** n

mlo, mhi = boot_ci(marg, st.mean)
alo, ahi = boot_auc_ci(list(zip(dM, dP)))
zalo, zahi = boot_auc_ci(list(zip(zM, zP)))

print("\n" + "=" * 84)
print(f"P0e v2 扩展集  ·  {TAG} ({DT})  ·  {n} items · 5 类歧义")
print("=" * 84)
print(f"判别 margin   平均 {st.mean(marg):+.2f} nats  95%CI [{mlo:+.2f}, {mhi:+.2f}]")
print(f"M 胜出        {k}/{n}  符号检验 p={pval:.6f} (单侧)")
print(f"AUC 裸 ΔNLL   {auc(dM,dP):.3f}  95%CI [{alo:.3f}, {ahi:.3f}]")
print(f"AUC z 校准    {auc(zM,zP):.3f}  95%CI [{zalo:.3f}, {zahi:.3f}]")
print(f"全局可分(z)   {'✅' if min(zM)>max(zP) else '❌'}  z(M)最低 {min(zM):+.2f} vs z(M′)最高 {max(zP):+.2f}")

print(f"\n{'类型':6} {'n':>3} {'判别方向':>6} {'margin 均值':>12} {'95%CI':>18} {'M胜':>6} {'AUC(z)':>8}")
print("-" * 84)
BID = {"G1": "单向", "G2": "单向", "G3": "双向", "G4": "双向", "G5": "双向"}
bytype = {}
for t in ("G1", "G2", "G3", "G4", "G5"):
    S = [r for r in rows if r["type"] == t]
    m = [r["dM"] - r["dP"] for r in S]
    lo, hi = boot_ci(m, st.mean) if len(m) > 1 else (float("nan"),) * 2
    a = auc([r["zM"] for r in S], [r["zP"] for r in S])
    bytype[t] = dict(n=len(S), margin=st.mean(m), ci=[lo, hi], wins=sum(x > 0 for x in m), auc_z=a)
    print(f"{t:6} {len(S):3d} {BID[t]:>6} {st.mean(m):12.2f}   [{lo:+6.2f},{hi:+6.2f}] "
          f"{sum(x>0 for x in m):3d}/{len(S)} {a:8.3f}")

uni = [r["dM"] - r["dP"] for r in rows if r["type"] in ("G1", "G2")]
bi = [r["dM"] - r["dP"] for r in rows if r["type"] in ("G3", "G4", "G5")]
print("-" * 84)
print(f"单向判别(G1,G2) n={len(uni)}  margin {st.mean(uni):+.2f}")
print(f"双向判别(G3-G5) n={len(bi)}  margin {st.mean(bi):+.2f}   ← 预期更强（两假设各有独占预测）")

bytag = {}
for r in rows:
    for x in r["nulls"]:
        bytag.setdefault(x["tag"], []).append(x["dnll"])
print(f"\n=== 零分布各类假设平均 ΔNLL（越高越难拒绝）===")
for t, v in sorted(bytag.items(), key=lambda kv: -st.mean(kv[1])):
    print(f"  {t:14} n={len(v):3d}  {st.mean(v):+6.2f}")
print(f"  {'【真概念 M】':12} n={n:3d}  {st.mean(dM):+6.2f}")
print(f"  {'【误解 M′】':13} n={n:3d}  {st.mean(dP):+6.2f}")

summ = dict(model=MODEL, dtype=str(DT), n=n, margin_mean=st.mean(marg), margin_ci=[mlo, mhi],
            wins=k, sign_p=pval, auc_raw=auc(dM, dP), auc_raw_ci=[alo, ahi],
            auc_z=auc(zM, zP), auc_z_ci=[zalo, zahi],
            z_global_sep=min(zM) > max(zP), z_M_min=min(zM), z_Mprime_max=max(zP),
            by_type=bytype, margin_unidirectional=st.mean(uni), margin_bidirectional=st.mean(bi))
json.dump({"summary": summ, "rows": rows},
          open(os.path.join(HERE, f"p0e_{TAG}.json"), "w"), indent=2, ensure_ascii=False)
print(f"\n[saved] p0e_{TAG}.json")
