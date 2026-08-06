"""P0d — per-item 校准：把门从「排序器」变成「单候选阈值判据」

P0c 的缺口：ΔNLL(M)∈[2.71,9.61] 与 ΔNLL(M′)∈[−4.10,9.10] 跨 item 重叠 → 无法定全局阈值。
原因：各 item 的固有尺度不同（base 熵 6.83–14.26、概念难度不同）。

思路：用【安慰剂零分布】做 per-item 校准，算 z 分数
      z_i(c) = (ΔNLL_i(c) − μ_i^null) / σ_i^null
  · GT-free（零分布只需模型自己能生成的候选假设，不需答案）
  · 天然按 item 校准
  · 与 SEMA（调研中族 4 最接近的先例）同一套 z 分数机制 —— 但信号换成正确性

零分布刻意包含 overspec（M∧额外条件，与 M′ 同构）：
  预测 → M′ 应成为零分布的典型成员（z≈0，被拒），M 应为显著离群点（z 高，被接受）。
"""
import os, json, math, statistics as st
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from items import ITEMS
from nullpool import NULL
from heldout import HELDOUT

MODEL = os.environ.get("P0_MODEL", "Qwen/Qwen2.5-1.5B-Instruct")
HERE = os.path.dirname(os.path.abspath(__file__))
tok = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.float32, local_files_only=True).to(dev).eval()
print(f"[load] {MODEL} · {dev}\n", flush=True)

YES = [" Yes", " yes", "Yes", "yes"]; NO = [" No", " no", "No", "no"]


@torch.no_grad()
def label_nll(prefix, obj, word, label):
    p = f'{prefix}\nQuestion: Is {obj} {word}? Answer Yes or No.\nAnswer:'
    ids = tok(p, return_tensors="pt")["input_ids"].to(dev)
    lp = torch.log_softmax(model(ids).logits[0, -1].float(), -1)
    def best(cs):
        v = -1e9
        for c in cs:
            t = tok.encode(c, add_special_tokens=False)
            if t: v = max(v, lp[t[0]].item())
        return v
    y, n = best(YES), best(NO)
    m = max(y, n); tot = m + math.log(math.exp(y-m)+math.exp(n-m))
    return -((y if label == "Yes" else n) - tot)


def seq(prefix, it):
    return sum(label_nll(prefix, o, it["word"], y) for o, y in HELDOUT[it["id"]])


rows = []
for it in ITEMS:
    w = it["word"]
    base = seq(f'{w} is a word in Tovi\'s language.', it)
    def dnll(mean): return base - seq(f'{w} means {mean}.', it)

    dM, dP = dnll(it["M"]), dnll(it["Mprime"])
    nulls = [(m, tag, dnll(m)) for m, tag in NULL[it["id"]]]
    vals = [v for _, _, v in nulls]
    mu, sd = st.mean(vals), st.stdev(vals)

    rows.append(dict(id=it["id"], type=it["type"], base=base, dM=dM, dP=dP,
                     mu=mu, sd=sd, zM=(dM-mu)/sd, zP=(dP-mu)/sd,
                     nulls=[{"h": m, "tag": t, "dnll": v} for m, t, v in nulls]))
    print(f"[run] {it['id']}  z(M)={rows[-1]['zM']:+.2f}  z(M′)={rows[-1]['zP']:+.2f}  "
          f"(μ={mu:.2f} σ={sd:.2f})", flush=True)


def auc(pos, neg): return sum((p > n) + 0.5*(p == n) for p in pos for n in neg)/(len(pos)*len(neg))
def sep(pos, neg): return min(pos) > max(neg)

n = len(rows)
print("\n" + "="*80)
print(f"P0d per-item 校准  ·  {MODEL}  ·  {n} items  ·  零分布 {len(NULL['G1-01'])}/item")
print("="*80)
print(f"\n{'item':8} {'ΔNLL(M)':>9} {'ΔNLL(M′)':>10} │ {'μnull':>7} {'σnull':>6} │ {'z(M)':>7} {'z(M′)':>7}  判定")
print("-"*80)
for r in rows:
    ok = "✅ 分开" if r["zM"] - r["zP"] > 0 else "❌"
    print(f"{r['id']:8} {r['dM']:9.2f} {r['dP']:10.2f} │ {r['mu']:7.2f} {r['sd']:6.2f} │ "
          f"{r['zM']:+7.2f} {r['zP']:+7.2f}  {ok}")

zM = [r["zM"] for r in rows]; zP = [r["zP"] for r in rows]
dM = [r["dM"] for r in rows]; dP = [r["dP"] for r in rows]
print("-"*80)
print(f"{'裸 ΔNLL':22} AUC {auc(dM,dP):.3f}  M∈[{min(dM):6.2f},{max(dM):5.2f}]  "
      f"M′∈[{min(dP):6.2f},{max(dP):5.2f}]  全局可分 {'✅' if sep(dM,dP) else '❌'}")
print(f"{'z 分数（零分布校准）':18} AUC {auc(zM,zP):.3f}  M∈[{min(zM):+6.2f},{max(zM):+5.2f}]  "
      f"M′∈[{min(zP):+6.2f},{max(zP):+5.2f}]  全局可分 {'✅' if sep(zM,zP) else '❌'}")

if sep(zM, zP):
    lo, hi = max(zP), min(zM)
    print(f"\n🎯 存在全局阈值 τ ∈ ({lo:+.2f}, {hi:+.2f})  →  取 τ={(lo+hi)/2:+.2f} 可 8/8 正确接受/拒绝")

print(f"\n=== 预测检验：M′ 是否为零分布的典型成员？（|z(M′)|<2 即典型）===")
typ = sum(abs(r["zP"]) < 2 for r in rows)
print(f"  |z(M′)| < 2 的 item：{typ}/{n}   平均 z(M′)={st.mean(zP):+.2f}  ← 越接近 0 越符合预测")
print(f"  平均 z(M)={st.mean(zM):+.2f}  ← 越大越好")

print(f"\n=== 零分布内各类错误假设的平均 ΔNLL（哪类最难拒绝）===")
bytag = {}
for r in rows:
    for x in r["nulls"]:
        bytag.setdefault(x["tag"], []).append(x["dnll"])
for t, v in sorted(bytag.items(), key=lambda kv: -st.mean(kv[1])):
    print(f"  {t:14} n={len(v):3d}  平均 ΔNLL {st.mean(v):+6.2f}")
print(f"  {'【真概念 M】':12} n={n:3d}  平均 ΔNLL {st.mean(dM):+6.2f}")
print(f"  {'【误解 M′】':13} n={n:3d}  平均 ΔNLL {st.mean(dP):+6.2f}")

json.dump({"model": MODEL, "rows": rows}, open(os.path.join(HERE, "p0d_results.json"), "w"),
          indent=2, ensure_ascii=False)
print(f"\n[saved] p0d_results.json")
