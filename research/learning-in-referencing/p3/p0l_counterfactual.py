"""P0l — E5 的下一个候选解法：反事实否定条件化（在 p0-G5 真测试床上）

背景：E5 = 模型先验压过给定定义（DESIGN §3 #10），随规模恶化；
已试败的两条路：忠实性探针 F(c)（P0i）、言语化对比条件化（P2 D 臂）。
本轮候选：**在候选陈述里显式否定对立读法**——不改判据、不改观测量，只改条件化措辞。

五种条件化措辞（同一 item、同一留出集、同一 ΔNLL 判据）：
  plain   "{w} means {M}."                                   ← p0 基线
  neg     "{w} means {M}, not {M′}."                         ← 反事实否定（本轮主候选）
  neg_gen "{w} means {M}. It does not mean anything else."    ← 泛化否定（控制"否定本身"的作用）
  emph    "In Tovi's language, {w} strictly means {M}."       ← 强调（控制"加词"的作用）
  rule    "Rule: a thing is {w} if and only if it is {M}."    ← 规则化措辞

判分：对每种措辞算 margin = ΔNLL(M) − ΔNLL(M′)，看 E5 高危集（p0-G5）上
是否由负转正。**neg 若只在 neg 生效而 neg_gen/emph 不生效，才是"反事实"起作用**，
否则就是"加词"或"否定"这两个 nuisance —— 这是本实验自埋的诊断项。

⚠️ 材料用 p0/items_v2.py（**不是** p1，p1-G5 偏易未复现 E5）。

用法：python p0l_counterfactual.py [model_id]
"""
import json
import math
import os
import statistics as st
import sys

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "p0"))
from items_v2 import ITEMS2  # noqa: E402

MODEL = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen2.5-3B-Instruct"
TAG = MODEL.split("/")[-1]

print(f"[load] {MODEL}", flush=True)
tok = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16,
                                             local_files_only=True).to(dev).eval()
YES = [" Yes", " yes", "Yes", "yes"]
NO = [" No", " no", "No", "no"]


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
    return -((y if label == "Yes" else n) - tot)


def seq(prefix, it):
    return sum(label_nll(prefix, q, y) for q, y in it["heldout"])


def phrasings(w, target, rival):
    """target = 被条件化的候选；rival = 其对立读法（用于反事实否定）"""
    return {
        "plain":   f"{w} means {target}.",
        "neg":     f"{w} means {target}, not {rival}.",
        "neg_gen": f"{w} means {target}. It does not mean anything else.",
        "emph":    f"In Tovi's language, {w} strictly means {target}.",
        "rule":    f"Rule: a thing is {w} if and only if it is {target}.",
    }


FORMS = ["plain", "neg", "neg_gen", "emph", "rule"]
rows = []
for it in ITEMS2:
    w = it["word"]
    base = seq(f"{w} is a word in Tovi's language.", it)
    r = dict(id=it["id"], type=it["type"], base=base)
    for form in FORMS:
        # 对称：给 M 的条件化用 M′ 作 rival，给 M′ 的条件化用 M 作 rival
        dM = base - seq(phrasings(w, it["M"], it["Mprime"])[form], it)
        dP = base - seq(phrasings(w, it["Mprime"], it["M"])[form], it)
        r[form] = dict(dM=dM, dP=dP, margin=dM - dP)
    rows.append(r)
    print(f"[{it['id']}] " + "  ".join(f"{f}={r[f]['margin']:+5.2f}" for f in FORMS),
          flush=True)


def summarize(rs, label):
    print(f"\n--- {label} (n={len(rs)}) ---")
    out = {}
    for f in FORMS:
        m = [r[f]["margin"] for r in rs]
        wins = sum(x > 0 for x in m)
        out[f] = dict(margin=st.mean(m), wins=wins, n=len(m))
        print(f"  {f:8} margin {st.mean(m):+6.2f}  判对 {wins}/{len(m)}")
    return out


print("\n" + "=" * 72)
print(f"P0l 反事实否定条件化 · {TAG} · {len(rows)} items（p0 材料）")
print("=" * 72)
summ = dict(model=MODEL)
summ["all"] = summarize(rows, "全部")
for t in ("G1", "G2", "G3", "G4", "G5"):
    S = [r for r in rows if r["type"] == t]
    if S:
        summ[t] = summarize(S, f"{t}" + ("  ← E5 高危" if t == "G5" else ""))

g5 = [r for r in rows if r["type"] == "G5"]
if g5:
    d_plain = st.mean([r["plain"]["margin"] for r in g5])
    d_neg = st.mean([r["neg"]["margin"] for r in g5])
    d_ng = st.mean([r["neg_gen"]["margin"] for r in g5])
    d_emph = st.mean([r["emph"]["margin"] for r in g5])
    print(f"\n★ E5 诊断（G5）：neg−plain = {d_neg - d_plain:+.2f}；"
          f"neg_gen−plain = {d_ng - d_plain:+.2f}；emph−plain = {d_emph - d_plain:+.2f}")
    print("  判读：只有当 neg 明显优于 neg_gen 与 emph 时，才是【反事实对立】起作用；"
          "否则是【加词】或【泛化否定】这两个 nuisance。")

json.dump(dict(summary=summ, rows=rows),
          open(os.path.join(HERE, f"p0l_{TAG}.json"), "w"), indent=1)
print(f"\n[saved] p0l_{TAG}.json")
