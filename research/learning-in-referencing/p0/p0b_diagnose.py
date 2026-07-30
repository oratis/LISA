"""P0b — 决定性诊断：为什么压缩增益没有携带概念内容？

P0 发现：词级 margin ≈ +0.02（M 与 M′ 几乎完全相同）→ 增益不含概念真伪信息。
两种互斥解释，本脚本分开它们：

  (A) 能力缺失：基座模型根本不会把定义【组合地应用】到新实例
      → 压缩增益必然退化为"定义长度 + 定义存在性"，与真伪无关
  (B) 观测方式错误：模型有能力，但自由生成的 NLL 观测不到

诊断 1（能力探针·强制选择）：直接问模型该实例是否满足定义。
   M  条件下应答 yes，M′ 条件下应答 no。若两者都答 yes → (A) 成立。
诊断 2（显式违反）：把"不圆"写进句子（"red square box"），去掉世界知识推理负担。
   若信号恢复 → 部分是观测/推理链问题，而非纯能力缺失。
"""
import os, json, torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from items import ITEMS

MODEL = os.environ.get("P0_MODEL", "Qwen/Qwen2.5-1.5B-Instruct")
tok = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.float32, local_files_only=True).to(dev).eval()
print(f"[load] {MODEL} · {dev}\n", flush=True)


@torch.no_grad()
def next_logprobs(text):
    ids = tok(text, return_tensors="pt")["input_ids"].to(dev)
    lg = model(ids).logits[0, -1].float()
    return torch.log_softmax(lg, -1)


def yes_no(prompt):
    """返回 (P(yes)-P(no) 的 logprob 差, p_yes 归一化)"""
    lp = next_logprobs(prompt)
    cands_y = [" Yes", " yes", "Yes", "yes"]
    cands_n = [" No", " no", "No", "no"]
    def best(cs):
        v = -1e9
        for c in cs:
            t = tok.encode(c, add_special_tokens=False)
            if t:
                v = max(v, lp[t[0]].item())
        return v
    y, n = best(cands_y), best(cands_n)
    import math
    p = math.exp(y) / (math.exp(y) + math.exp(n))
    return y - n, p


# 每个 item 取第一个消歧实例，构造它的"显式违反"版本
EXPLICIT = {
    "G1-01": ("a red box", "a red square box"),
    "G1-02": ("a wooden bowl", "a wooden short bowl"),
    "G1-03": ("a blue door", "a blue large door"),
    "G1-04": ("a soft grey blanket", "a soft grey blanket"),
    "G1-05": ("a red ball", "a red round ball"),
    "G1-06": ("a heavy stone block", "a heavy stone non-metal block"),
    "G2-01": ("a horse", "a horse"),
    "G2-02": ("a crate", "a crate"),
}

print("诊断 1 — 能力探针（强制选择 yes/no）")
print("期望：M 条件 → yes（高 p）；M′ 条件 → no（低 p）。若两列都高 → 能力缺失(A)\n")
print(f"{'item':8} {'实例':26} {'p(yes|M)':>9} {'p(yes|M′)':>10} {'落差':>7}  判定")
print("-" * 78)

rows = []
for it in ITEMS:
    inst = EXPLICIT[it["id"]][0]
    res = {}
    for tag, meaning in (("M", it["M"]), ("Mprime", it["Mprime"])):
        p = (f'{it["word"]} means {meaning}.\n'
             f'Question: Is {inst} {it["word"]}? Answer Yes or No.\nAnswer:')
        _, py = yes_no(p)
        res[tag] = py
    drop = res["M"] - res["Mprime"]
    verdict = "✅ 有能力" if drop > 0.15 else ("⚠️ 弱" if drop > 0.05 else "❌ 无区分")
    rows.append(dict(id=it["id"], inst=inst, **res, drop=drop))
    print(f"{it['id']:8} {inst:26} {res['M']:9.3f} {res['Mprime']:10.3f} {drop:7.3f}  {verdict}")

import statistics as st
md = st.mean(r["drop"] for r in rows)
ok = sum(r["drop"] > 0.15 for r in rows)
print("-" * 78)
print(f"平均落差 {md:+.3f} · 有区分 {ok}/{len(rows)}")
print(f"→ {'能力存在，问题在观测方式 (B)' if ok >= len(rows)*0.6 else '能力缺失 (A)：模型不会组合地应用定义'}\n")

print("\n诊断 2 — 显式违反（把『不满足 Q』写进句子，去掉世界知识推理负担）")
print(f"{'item':8} {'显式实例':32} {'p(yes|M)':>9} {'p(yes|M′)':>10} {'落差':>7}")
print("-" * 78)
rows2 = []
for it in ITEMS:
    a, b = EXPLICIT[it["id"]]
    if a == b:
        continue
    res = {}
    for tag, meaning in (("M", it["M"]), ("Mprime", it["Mprime"])):
        p = (f'{it["word"]} means {meaning}.\n'
             f'Question: Is {b} {it["word"]}? Answer Yes or No.\nAnswer:')
        _, py = yes_no(p)
        res[tag] = py
    d = res["M"] - res["Mprime"]
    rows2.append(d)
    print(f"{it['id']:8} {b:32} {res['M']:9.3f} {res['Mprime']:10.3f} {d:7.3f}")
print("-" * 78)
print(f"平均落差 {st.mean(rows2):+.3f} · 有区分 {sum(x>0.15 for x in rows2)}/{len(rows2)}")

json.dump({"probe": rows, "explicit_drops": rows2},
          open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "p0b_results.json"), "w"),
          indent=2, ensure_ascii=False)
print("\n[saved] p0b_results.json")
