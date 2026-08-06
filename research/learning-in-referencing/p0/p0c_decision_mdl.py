"""P0c — 修正形式化：压缩【老师的用词决策序列】，而非自由陈述

P0/P0b 的发现：
  · 自由陈述 NLL 的词级 margin ≈ 0（概念真伪被句法/用词的 nuisance 熵淹没）
  · 但能力探针显示模型【能】区分 M 与 M′（平均落差 0.295, 6/8）
  → 结论：信号存在，是【观测量选错了】。

修正后的观测量：老师对每个实例"用/不用该词"的决策 y ∈ {Yes, No}。
概念要解释的正是这串决策，而不是句子的措辞。

  G(c) = Σ_o [ −log P(y_o | o, K) ] − Σ_o [ −log P(y_o | o, K∪c) ] − L(c)

关键判据：ΔNLL（不含 L(c)）能否单独把 M 与 M′ 分开。
  能 → 机制成立，P0 的失败是观测方式问题
  不能 → 机制在此规模下不成立
"""
import os, json, math, statistics as st
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from items import ITEMS

MODEL = os.environ.get("P0_MODEL", "Qwen/Qwen2.5-1.5B-Instruct")
HERE = os.path.dirname(os.path.abspath(__file__))

# 留出决策集：(实例, 真实标签按 M) —— disamb 为 M 内但 M′ 外（判别性证据）
HELDOUT = {
 "G1-01": [("a red box","Yes"),("a red flag","Yes"),("a red pencil","Yes"),
           ("a red bead","Yes"),("a blue ball","No"),("a green box","No")],
 "G1-02": [("a wooden bowl","Yes"),("a wooden cube","Yes"),("a wooden coin","Yes"),
           ("a wooden rod","Yes"),("a plastic pole","No"),("a metal bowl","No")],
 "G1-03": [("a blue door","Yes"),("a blue truck","Yes"),("a blue wall","Yes"),
           ("a blue stud","Yes"),("a green pebble","No"),("a red door","No")],
 "G1-04": [("a soft grey blanket","Yes"),("a soft brown fur","Yes"),("a soft black sweater","Yes"),
           ("a soft white scarf","Yes"),("a hard white stone","No"),("a hard grey rock","No")],
 "G1-05": [("a red ball","Yes"),("a blue balloon","Yes"),("a yellow orange","Yes"),
           ("a green bead","Yes"),("a green box","No"),("a red brick","No")],
 "G1-06": [("a heavy stone block","Yes"),("a heavy wooden chest","Yes"),("a heavy glass slab","Yes"),
           ("a heavy metal plate","Yes"),("a light metal foil","No"),("a light paper sheet","No")],
 "G2-01": [("a horse","Yes"),("a fish","Yes"),("a beetle","Yes"),
           ("a pigeon","Yes"),("a rock","No"),("a hammer","No")],
 "G2-02": [("a crate","Yes"),("a sack","Yes"),("a barrel","Yes"),
           ("a tumbler","Yes"),("a hammer","No"),("a stone","No")],
}

tok = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.float32, local_files_only=True).to(dev).eval()
print(f"[load] {MODEL} · {dev}\n", flush=True)

YES = [" Yes", " yes", "Yes", "yes"]
NO = [" No", " no", "No", "no"]


@torch.no_grad()
def label_nll(prefix, obj, word, label):
    """−log P(label | 实例)，在 {Yes,No} 上归一化"""
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
    m = max(y, n)
    tot = m + math.log(math.exp(y - m) + math.exp(n - m))       # logsumexp
    return -((y if label == "Yes" else n) - tot)


@torch.no_grad()
def code_length(word, meaning):
    head = f'Notes about Tovi\'s language: '
    s = f'{word} means {meaning}.'
    ids = tok(head + s, return_tensors="pt")["input_ids"].to(dev)
    enc = tok(head + s, return_offsets_mapping=True)
    offs = enc["offset_mapping"]
    lp = torch.log_softmax(model(ids).logits[0].float(), -1)
    tot = 0.0
    for i in range(1, ids.shape[1]):
        a, b = offs[i]
        if b > a and a >= len(head):
            tot += -lp[i - 1, ids[0, i]].item()
    return tot


def seq_nll(prefix, item, hyp_free=False):
    w = item["word"]
    return sum(label_nll(prefix, o, w, y) for o, y in HELDOUT[item["id"]])


results = []
for it in ITEMS:
    w = it["word"]
    base_prefix = f'{w} is a word in Tovi\'s language.'
    base = seq_nll(base_prefix, it)

    hyps = {"M": it["M"], "Mprime": it["Mprime"]}
    for i, p in enumerate(it["placebos"]):
        hyps[f"placebo{i}"] = p

    rec = {"id": it["id"], "type": it["type"], "word": w, "n_dec": len(HELDOUT[it["id"]]),
           "base_nll": base, "hyp": {}}
    for name, meaning in hyps.items():
        nll = seq_nll(f'{w} means {meaning}.', it)
        L = code_length(w, meaning)
        rec["hyp"][name] = {"meaning": meaning, "nll": nll, "dnll": base - nll,
                            "L": L, "G": (base - nll) - L}
    pk = [k for k in rec["hyp"] if k.startswith("placebo")]
    rec["placebo_best_dnll"] = max(rec["hyp"][k]["dnll"] for k in pk)
    rec["placebo_best_G"] = max(rec["hyp"][k]["G"] for k in pk)
    results.append(rec)
    print(f"[run] {it['id']} base={base:.2f} M={rec['hyp']['M']['dnll']:+.2f} "
          f"M′={rec['hyp']['Mprime']['dnll']:+.2f}", flush=True)

n = len(results)
dn = [r["hyp"]["M"]["dnll"] - r["hyp"]["Mprime"]["dnll"] for r in results]
gg = [r["hyp"]["M"]["G"] - r["hyp"]["Mprime"]["G"] for r in results]
dl = [r["hyp"]["Mprime"]["L"] - r["hyp"]["M"]["L"] for r in results]

print("\n" + "=" * 84)
print(f"P0c 决策序列 MDL  ·  {MODEL}  ·  {n} items  ·  每项 6 个决策")
print("=" * 84)
print(f"\n{'item':8} {'base':>7} {'ΔNLL(M)':>9} {'ΔNLL(M′)':>10} {'margin':>8} │ {'G(M)':>8} {'G(M′)':>8} {'margin':>8} win")
print("-" * 84)
for r, d, g in zip(results, dn, gg):
    M, P = r["hyp"]["M"], r["hyp"]["Mprime"]
    print(f"{r['id']:8} {r['base_nll']:7.2f} {M['dnll']:9.2f} {P['dnll']:10.2f} {d:8.2f} │ "
          f"{M['G']:8.2f} {P['G']:8.2f} {g:8.2f} {'M ✅' if d > 0 else 'M′ ❌'}")
print("-" * 84)
print(f"【关键】ΔNLL 不含长度罚：M 胜 {sum(x>0 for x in dn)}/{n} · 平均 margin {st.mean(dn):+.2f} nats")
print(f"        G 含长度罚      ：M 胜 {sum(x>0 for x in gg)}/{n} · 平均 margin {st.mean(gg):+.2f} nats")
print(f"        长度罚贡献占比  ：{st.mean(dl)/st.mean(gg)*100:.0f}%  (P0 自由陈述版为 92%)")
print(f"安慰剂对照（ΔNLL）：M 超最佳安慰剂 {sum(r['hyp']['M']['dnll']>r['placebo_best_dnll'] for r in results)}/{n}"
      f" · M′ 超最佳安慰剂 {sum(r['hyp']['Mprime']['dnll']>r['placebo_best_dnll'] for r in results)}/{n}")

json.dump({"model": MODEL, "results": results,
           "margin_dnll": dn, "margin_G": gg}, open(os.path.join(HERE, "p0c_results.json"), "w"),
          indent=2, ensure_ascii=False)
print(f"\n[saved] p0c_results.json")
