"""P2b — 候选条件化语义熵（B 臂的干净版）

p2_three_arm.py 的 B 臂测的是自由作答一致性，发现模型很少通过自由行为稳定
承诺 M′（4/40 且低一致）——E1 条件在自由行为里几乎不出现，出现在**候选**上。
干净版测试 DESIGN §2 的原预测：
    给定候选 c ∈ {M, M′}，模型按 c 作答的一致性 SE(c)。
    自信照做的误解与真意同样一致 → SE(M) ≈ SE(M′) → AUC ≈ 0.5 → SE 分不开对错。
若 AUC 显著 > 0.5，则 DESIGN §2 对语义熵的失分预测**在该材料上不成立**，须如实改写。

用法：python p2b_cond_se.py [model_id]
"""
import json
import math
import os
import statistics as st
import sys

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen2.5-1.5B-Instruct"
HERE = os.path.dirname(os.path.abspath(__file__))
TAG = MODEL.split("/")[-1]
DATA = json.load(open(os.path.join(HERE, "..", "p1", "items_p1.json")))
ITEMS = DATA["items"]

print(f"[load] {MODEL}", flush=True)
tok = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16,
                                             local_files_only=True).to(dev).eval()
YES = [" Yes", " yes", "Yes", "yes"]
NO = [" No", " no", "No", "no"]


@torch.no_grad()
def p_yes(prompt):
    ids = tok(prompt, return_tensors="pt")["input_ids"].to(dev)
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
    return math.exp(y - m) / (math.exp(y - m) + math.exp(n - m))


def H2(p):
    if p <= 0 or p >= 1:
        return 0.0
    return -(p * math.log2(p) + (1 - p) * math.log2(1 - p))


def q_of(it, body):
    return body if it["type"] == "G4" else f"Is {body} {it['word']}?"


def se_cond(it, meaning):
    ents = []
    for q, _ in it["heldout"]:
        p = p_yes(f"{it['word']} means {meaning}.\n"
                  f"Question: {q_of(it, q)} Answer Yes or No.\nAnswer:")
        ents.append(H2(p))
    return 1 - st.mean(ents)     # 高 = 一致


def auc(p, n):
    return sum((a > b) + 0.5 * (a == b) for a in p for b in n) / (len(p) * len(n))


rows = []
for it in ITEMS:
    sM, sP = se_cond(it, it["M"]), se_cond(it, it["Mprime"])
    rows.append(dict(id=it["id"], type=it["type"], seM=sM, seP=sP))
    print(f"[{it['id']}] SE(M)={sM:.3f}  SE(M′)={sP:.3f}", flush=True)

print("\n" + "=" * 70)
print(f"P2b 候选条件化 SE · {TAG}")
print("=" * 70)
summ = dict(model=MODEL)
for label, rs in [("全部", rows),
                  ("核心域 G1–G3", [r for r in rows if r["type"] in ("G1", "G2", "G3")])] + \
                 [(t, [r for r in rows if r["type"] == t]) for t in ("G1", "G2", "G3", "G4", "G5")]:
    a = auc([r["seM"] for r in rs], [r["seP"] for r in rs])
    mM, mP = st.mean([r["seM"] for r in rs]), st.mean([r["seP"] for r in rs])
    print(f"{label:14} n={len(rs):3d}  SE(M)均值={mM:.3f}  SE(M′)均值={mP:.3f}  AUC={a:.3f}")
    summ[label] = dict(n=len(rs), seM=mM, seP=mP, auc=a)

json.dump(dict(summary=summ, rows=rows),
          open(os.path.join(HERE, f"p2b_{TAG}.json"), "w"), indent=1)
print(f"[saved] p2b_{TAG}.json")
