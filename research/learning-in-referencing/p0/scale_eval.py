"""缩放曲线评测：对单个模型跑完整的 P0b(能力探针) + P0c(决策 MDL) + P0d(z 校准)

用法：python scale_eval.py <model_id> [dtype]
所有模型使用同一 dtype（默认 bfloat16）以保证曲线可比。

要验证的因果预测（P0d 得出 Spearman ρ=+0.857）：
  门的判别力受限于基座在【消歧实例】上的语义能力
  → 放大模型应【同时】提升 探针落差、判别 margin、以及全局可分性
"""
import os, sys, json, math, statistics as st
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from items import ITEMS
from nullpool import NULL
from heldout import HELDOUT

MODEL = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen2.5-1.5B-Instruct"
DT = {"bf16": torch.bfloat16, "fp32": torch.float32}[sys.argv[2] if len(sys.argv) > 2 else "bf16"]
HERE = os.path.dirname(os.path.abspath(__file__))
TAG = MODEL.split("/")[-1]

print(f"[load] {MODEL} ({DT})", flush=True)
tok = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=DT, local_files_only=True).to(dev).eval()
print(f"[load] done · {dev}", flush=True)

YES = [" Yes", " yes", "Yes", "yes"]; NO = [" No", " no", "No", "no"]
EXPLICIT = {"G1-01": "a red box", "G1-02": "a wooden bowl", "G1-03": "a blue door",
            "G1-04": "a soft grey blanket", "G1-05": "a red ball",
            "G1-06": "a heavy stone block", "G2-01": "a horse", "G2-02": "a crate"}


@torch.no_grad()
def yn_logprobs(prompt):
    ids = tok(prompt, return_tensors="pt")["input_ids"].to(dev)
    lp = torch.log_softmax(model(ids).logits[0, -1].float(), -1)
    def best(cs):
        v = -1e9
        for c in cs:
            t = tok.encode(c, add_special_tokens=False)
            if t: v = max(v, lp[t[0]].item())
        return v
    return best(YES), best(NO)


def q(prefix, obj, word):
    return f'{prefix}\nQuestion: Is {obj} {word}? Answer Yes or No.\nAnswer:'


def p_yes(prefix, obj, word):
    y, n = yn_logprobs(q(prefix, obj, word))
    return math.exp(y) / (math.exp(y) + math.exp(n))


def label_nll(prefix, obj, word, label):
    y, n = yn_logprobs(q(prefix, obj, word))
    m = max(y, n); tot = m + math.log(math.exp(y-m) + math.exp(n-m))
    return -((y if label == "Yes" else n) - tot)


def seq(prefix, it):
    return sum(label_nll(prefix, o, it["word"], y) for o, y in HELDOUT[it["id"]])


rows = []
for it in ITEMS:
    w, iid = it["word"], it["id"]
    # --- 能力探针 ---
    inst = EXPLICIT[iid]
    pm = p_yes(f'{w} means {it["M"]}.', inst, w)
    pp = p_yes(f'{w} means {it["Mprime"]}.', inst, w)
    # --- 决策序列 MDL ---
    base = seq(f'{w} is a word in Tovi\'s language.', it)
    def dn(mean): return base - seq(f'{w} means {mean}.', it)
    dM, dP = dn(it["M"]), dn(it["Mprime"])
    nulls = [(m, t, dn(m)) for m, t in NULL[iid]]
    v = [x[2] for x in nulls]
    mu, sd = st.mean(v), (st.stdev(v) or 1e-9)
    rows.append(dict(id=iid, type=it["type"], probe_drop=pm-pp, p_yes_M=pm, p_yes_Mprime=pp,
                     base=base, dM=dM, dP=dP, mu=mu, sd=sd,
                     zM=(dM-mu)/sd, zP=(dP-mu)/sd,
                     nulls=[{"h": a, "tag": b, "dnll": c} for a, b, c in nulls]))
    print(f"[{iid}] probe={pm-pp:+.3f}  ΔNLL M={dM:+.2f} M′={dP:+.2f}  z={rows[-1]['zM']:+.2f}/{rows[-1]['zP']:+.2f}", flush=True)


def auc(p, n): return sum((a > b) + 0.5*(a == b) for a in p for b in n)/(len(p)*len(n))
def rank(v):
    s = sorted(range(len(v)), key=lambda i: v[i]); r = [0]*len(v)
    for k, i in enumerate(s): r[i] = k+1
    return r
def spearman(x, y):
    rx, ry = rank(x), rank(y); mx, my = st.mean(rx), st.mean(ry)
    num = sum((a-mx)*(b-my) for a, b in zip(rx, ry))
    den = (sum((a-mx)**2 for a in rx)*sum((b-my)**2 for b in ry))**.5
    return num/den if den else 0.0

n = len(rows)
dM = [r["dM"] for r in rows]; dP = [r["dP"] for r in rows]
zM = [r["zM"] for r in rows]; zP = [r["zP"] for r in rows]
marg = [a-b for a, b in zip(dM, dP)]
probe = [r["probe_drop"] for r in rows]
k = sum(x > 0 for x in marg)
pval = sum(math.comb(n, i) for i in range(k, n+1))/2**n
zsep = min(zM) > max(zP)

summ = dict(model=MODEL, dtype=str(DT), n=n,
            probe_mean=st.mean(probe), probe_ok=sum(x > 0.15 for x in probe),
            margin_mean=st.mean(marg), wins=k, sign_p=pval,
            auc_raw=auc(dM, dP), auc_z=auc(zM, zP), z_global_sep=zsep,
            z_M_min=min(zM), z_Mprime_max=max(zP),
            tau=(max(zP)+min(zM))/2 if zsep else None,
            spearman_probe_margin=spearman(probe, marg))

print("\n" + "="*72)
print(f"{TAG}  ({DT})")
print("="*72)
print(f"能力探针     平均落差 {summ['probe_mean']:+.3f} · 有区分 {summ['probe_ok']}/{n}")
print(f"判别 margin  平均 {summ['margin_mean']:+.2f} nats · M 胜 {k}/{n} · 符号检验 p={pval:.4f}")
print(f"AUC          裸 ΔNLL {summ['auc_raw']:.3f} → z 校准 {summ['auc_z']:.3f}")
print(f"全局可分     {'✅ τ=%+.3f' % summ['tau'] if zsep else '❌'}  (z(M)最低 {min(zM):+.2f} vs z(M′)最高 {max(zP):+.2f})")
print(f"ρ(探针,margin) {summ['spearman_probe_margin']:+.3f}")

json.dump({"summary": summ, "rows": rows},
          open(os.path.join(HERE, f"scale_{TAG}.json"), "w"), indent=2, ensure_ascii=False)
print(f"\n[saved] scale_{TAG}.json")
