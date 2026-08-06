"""P1 实证复核 —— 程序化 items 是否复现 p0 手工 items 的 margin 分布

三件事（p1/README「下一步」1 与 2）：
  A. 决策-MDL 评测（p0e 同框架）：ΔNLL(M) vs ΔNLL(M′)，z 校准，分类型
  B. 词库过滤 2 补跑：Qwen tokenizer 熟悉度检查
  C. 词库过滤 3 补跑：零样本探针——无教学时留出项 AUC ≈ 0.5（无先验联想）

用法：python p1_eval.py [model_id]   （默认 Qwen/Qwen2.5-1.5B-Instruct）
"""
import json
import math
import os
import random
import statistics as st
import sys

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen2.5-1.5B-Instruct"
HERE = os.path.dirname(os.path.abspath(__file__))
TAG = MODEL.split("/")[-1]
random.seed(0)

DATA = json.load(open(os.path.join(HERE, "items_p1.json")))
ITEMS = DATA["items"]

print(f"[load] {MODEL} (bf16)", flush=True)
tok = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16,
                                             local_files_only=True).to(dev).eval()
print(f"[load] done · {dev}", flush=True)

YES = [" Yes", " yes", "Yes", "yes"]
NO = [" No", " no", "No", "no"]


def stmt(word, meaning):
    return f"{word} means {meaning}."


@torch.no_grad()
def yn(prompt):
    ids = tok(prompt, return_tensors="pt")["input_ids"].to(dev)
    lp = torch.log_softmax(model(ids).logits[0, -1].float(), -1)
    def best(cs):
        v = -1e9
        for c in cs:
            t = tok.encode(c, add_special_tokens=False)
            if t:
                v = max(v, lp[t[0]].item())
        return v
    return best(YES), best(NO)


def label_nll(prefix, qbody, label):
    y, n = yn(f"{prefix}\nQuestion: {qbody} Answer Yes or No.\nAnswer:")
    m = max(y, n)
    tot = m + math.log(math.exp(y - m) + math.exp(n - m))
    return -((y if label == "Yes" else n) - tot), (y - n)


def q_of(it, body):
    """G4 的问题体已是完整陈述；其余包成 Is … {word}?"""
    return body if it["type"] == "G4" else f"Is {body} {it['word']}?"


def seq(prefix, it):
    return sum(label_nll(prefix, q_of(it, q), y)[0] for q, y in it["heldout"])


# ---------- B. 分词器熟悉度（过滤 2 补跑） ----------
sys.path.insert(0, HERE)
from lexicon import _passes_blocklist  # noqa: E402

lex_flags = []
for it in ITEMS:
    pieces = tok.tokenize(it["word"])
    head = pieces[0].lstrip("Ġ▁") if pieces else it["word"]
    bad = len(head) >= 4 and not _passes_blocklist(head)
    if bad:
        lex_flags.append((it["word"], pieces))
print(f"[filter2] tokenizer check: {len(lex_flags)} flagged / {len(ITEMS)} words "
      f"{lex_flags if lex_flags else ''}", flush=True)

# ---------- C. 零样本探针（过滤 3 补跑） ----------
probe_scores, probe_labels = [], []
for it in ITEMS:
    for q, y in it["heldout"]:
        _, logit = label_nll(f"{it['word']} is a word in Tovi's language.",
                             q_of(it, q), y)
        probe_scores.append(logit)
        probe_labels.append(1 if y == "Yes" else 0)


def auc(p, n):
    if not p or not n:
        return float("nan")
    return sum((a > b) + 0.5 * (a == b) for a in p for b in n) / (len(p) * len(n))


probe_auc = auc([s for s, l in zip(probe_scores, probe_labels) if l == 1],
                [s for s, l in zip(probe_scores, probe_labels) if l == 0])
print(f"[filter3] zero-shot probe AUC = {probe_auc:.3f}  (目标 ≈ 0.5：无教学即无信号)",
      flush=True)

# ---------- A. 决策-MDL 评测 ----------
rows = []
for it in ITEMS:
    w = it["word"]
    base = seq(f"{w} is a word in Tovi's language.", it)
    def dn(mean):
        return base - seq(stmt(w, mean), it)
    dM, dP = dn(it["M"]), dn(it["Mprime"])
    nl = [(h, t, dn(h)) for h, t in it["nulls"]]
    v = [x[2] for x in nl]
    mu, sd = st.mean(v), (st.stdev(v) or 1e-9)
    rows.append(dict(id=it["id"], type=it["type"], base=base, dM=dM, dP=dP,
                     zM=(dM - mu) / sd, zP=(dP - mu) / sd))
    print(f"[{it['id']}] ΔNLL M={dM:+6.2f} M′={dP:+6.2f} margin={dM-dP:+6.2f}",
          flush=True)

marg = [r["dM"] - r["dP"] for r in rows]
n = len(rows)
k = sum(x > 0 for x in marg)
pval = sum(math.comb(n, i) for i in range(k, n + 1)) / 2 ** n
zM = [r["zM"] for r in rows]
zP = [r["zP"] for r in rows]

print("\n" + "=" * 78)
print(f"P1 复核 · {TAG} · {n} 程序化 items（对照 p0e 手工 22 items）")
print("=" * 78)
print(f"margin 平均 {st.mean(marg):+.2f} nats · M 胜 {k}/{n} · 符号检验 p={pval:.6f}")
print(f"AUC z 校准 {auc(zM, zP):.3f}")
core = [r for r in rows if r["type"] in ("G1", "G2", "G3")]
cm = [r["dM"] - r["dP"] for r in core]
ck = sum(x > 0 for x in cm)
cp = sum(math.comb(len(cm), i) for i in range(ck, len(cm) + 1)) / 2 ** len(cm)
print(f"核心类型 G1–G3（主指标域）: margin {st.mean(cm):+.2f} · {ck}/{len(cm)} · p={cp:.6f} "
      f"· AUC(z) {auc([r['zM'] for r in core], [r['zP'] for r in core]):.3f}")
for t in ("G1", "G2", "G3", "G4", "G5"):
    S = [r["dM"] - r["dP"] for r in rows if r["type"] == t]
    a = auc([r["zM"] for r in rows if r["type"] == t],
            [r["zP"] for r in rows if r["type"] == t])
    print(f"  {t}: margin {st.mean(S):+6.2f} · {sum(x>0 for x in S)}/{len(S)} · AUC(z) {a:.3f}")

json.dump(dict(model=MODEL, n=n, margin_mean=st.mean(marg), wins=k, sign_p=pval,
               auc_z=auc(zM, zP), probe_auc=probe_auc,
               core_margin=st.mean(cm), core_wins=ck, core_p=cp,
               tokenizer_flagged=[w for w, _ in lex_flags], rows=rows),
          open(os.path.join(HERE, f"p1_eval_{TAG}.json"), "w"), indent=1)
print(f"\n[saved] p1_eval_{TAG}.json")
