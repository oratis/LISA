"""P0 — 压缩增益门核心信号验证（零训练，冻结基座，纯 prompt）

问题：压缩增益 G̃ 能否把 M（老师真意）与 M'（诱人的误解 / E1）分开？

设计（DESIGN_COMPRESSION_GATE.md §1，三条铁律）：
  1. 增益必须在【留出轮次】上算 —— 教学轮次被蒸馏掉，不进上下文（这正是"巩固"的含义）
  2. 必须含 L(c) —— 两部分 MDL，概念要自己挣回编码成本
  3. 必须过【安慰剂对照】—— 否则被"加任何文本都降 ppl"击穿

关键诊断：同时报告
  ΔNLL  = 纯预测增益（不含长度罚）  ← 若只有 G 能分开而 ΔNLL 不能，说明赢在长度罚，是弱结果
  G     = ΔNLL − L(c)             ← 两部分 MDL
  G̃     = G − max(安慰剂 G)        ← 最终判据
"""
import json, os, sys, math, statistics as st
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from items import ITEMS

MODEL = os.environ.get("P0_MODEL", "Qwen/Qwen2.5-1.5B-Instruct")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "p0_results.json")

HEADER = ("The following are notes about how Tovi uses certain words, "
          "followed by a transcript of Tovi speaking.\n\nNotes: ")
NO_NOTES = "(no notes yet)"
BODY = "\n\nTranscript:\n"

print(f"[load] {MODEL}", flush=True)
tok = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
try:
    model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.float32, local_files_only=True).to(dev).eval()
except Exception as e:                                    # 显存不足则退 bf16
    print(f"[warn] fp32 失败({type(e).__name__})，退回 bfloat16", flush=True)
    model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16, local_files_only=True).to(dev).eval()
print(f"[load] done · device={dev}", flush=True)


@torch.no_grad()
def nll_spans(text, spans):
    """返回落在 spans 内的 token 的 NLL 之和（nats）与 token 数。"""
    if not spans:
        return 0.0, 0
    enc = tok(text, return_offsets_mapping=True, return_tensors="pt")
    ids = enc["input_ids"].to(dev)
    offs = enc["offset_mapping"][0].tolist()
    logits = model(ids).logits[0].float()
    logprobs = torch.log_softmax(logits, dim=-1)
    tot, n = 0.0, 0
    for i in range(1, ids.shape[1]):
        s, e = offs[i]
        if e <= s:
            continue
        if any(s >= a and e <= b for a, b in spans):
            tot += -logprobs[i - 1, ids[0, i]].item()
            n += 1
    return tot, n


def build(concept, turns, word):
    """turns: list[(sentence, kind)] → text + 分类 span"""
    text = HEADER + (concept if concept else NO_NOTES) + BODY
    sp = {"all": [], "disamb": [], "control": [], "negative": [], "word": []}
    for sent, kind in turns:
        pre = "Tovi: "
        start = len(text) + len(pre)
        text += pre + sent + "\n"
        span = (start, start + len(sent))
        sp["all"].append(span)
        sp[kind].append(span)
        j = sent.find(word)
        while j != -1:                                     # 关键 token：伪词本身
            sp["word"].append((start + j, start + j + len(word)))
            j = sent.find(word, j + 1)
    return text, sp


def code_length(concept):
    """L(c)：把假设本身传输出去的成本（同一模型下的 NLL）"""
    text = HEADER + concept
    return nll_spans(text, [(len(HEADER), len(HEADER) + len(concept))])[0]


def measure(item, concept):
    turns = ([(s, "disamb") for s in item["disamb"]]
             + [(s, "control") for s in item["control"]]
             + [(s, "negative") for s in item["negative"]])
    text, sp = build(concept, turns, item["word"])
    out = {}
    for k in ("all", "disamb", "control", "negative", "word"):
        v, n = nll_spans(text, sp[k])
        out[k] = v
        out[k + "_ntok"] = n
    return out


def stmt(item, meaning):
    return f'{item["word"]} means {meaning}.'


results = []
for item in ITEMS:
    print(f"[run] {item['id']} ({item['word']})", flush=True)
    base = measure(item, None)

    hyps = {"M": stmt(item, item["M"]), "Mprime": stmt(item, item["Mprime"])}
    for i, p in enumerate(item["placebos"]):
        hyps[f"placebo{i}"] = stmt(item, p)

    rec = {"id": item["id"], "type": item["type"], "word": item["word"],
           "M_text": item["M"], "Mprime_text": item["Mprime"],
           "n_tok_heldout": base["all_ntok"], "base": base, "hyp": {}}

    for name, s in hyps.items():
        m = measure(item, s)
        L = code_length(s)
        e = {"stmt": s, "L": L}
        for k in ("all", "disamb", "control", "negative", "word"):
            e[f"dnll_{k}"] = base[k] - m[k]                # ΔNLL：越大越会压缩
        e["G_all"] = e["dnll_all"] - L                     # 两部分 MDL
        e["G_disamb"] = e["dnll_disamb"] - L
        rec["hyp"][name] = e

    pk = [k for k in rec["hyp"] if k.startswith("placebo")]
    for metric in ("G_all", "G_disamb"):
        best = max(rec["hyp"][k][metric] for k in pk)
        rec[f"placebo_best_{metric}"] = best
        rec[f"Gtilde_M_{metric}"] = rec["hyp"]["M"][metric] - best
        rec[f"Gtilde_Mprime_{metric}"] = rec["hyp"]["Mprime"][metric] - best
    results.append(rec)

# ---------------- 汇总 ----------------
def col(f):
    return [f(r) for r in results]

sep_dnll_all = col(lambda r: r["hyp"]["M"]["dnll_all"] - r["hyp"]["Mprime"]["dnll_all"])
sep_dnll_dis = col(lambda r: r["hyp"]["M"]["dnll_disamb"] - r["hyp"]["Mprime"]["dnll_disamb"])
sep_G_all = col(lambda r: r["hyp"]["M"]["G_all"] - r["hyp"]["Mprime"]["G_all"])
sep_G_dis = col(lambda r: r["hyp"]["M"]["G_disamb"] - r["hyp"]["Mprime"]["G_disamb"])

summary = {
    "model": MODEL, "n_items": len(results),
    "M_beats_Mprime": {
        "dnll_all":    sum(x > 0 for x in sep_dnll_all),
        "dnll_disamb": sum(x > 0 for x in sep_dnll_dis),
        "G_all":       sum(x > 0 for x in sep_G_all),
        "G_disamb":    sum(x > 0 for x in sep_G_dis),
    },
    "mean_margin": {
        "dnll_all": st.mean(sep_dnll_all), "dnll_disamb": st.mean(sep_dnll_dis),
        "G_all": st.mean(sep_G_all), "G_disamb": st.mean(sep_G_dis),
    },
    "M_beats_placebo_G_all":    sum(r["Gtilde_M_G_all"] > 0 for r in results),
    "Mprime_beats_placebo_G_all": sum(r["Gtilde_Mprime_G_all"] > 0 for r in results),
}
json.dump({"summary": summary, "results": results}, open(OUT, "w"), indent=2, ensure_ascii=False)

# ---------------- 打印 ----------------
n = len(results)
print("\n" + "=" * 78)
print(f"P0 结果  ·  {MODEL}  ·  {n} items")
print("=" * 78)
print(f"\n{'item':9} {'ΔNLL(M)':>9} {'ΔNLL(M′)':>9} {'margin':>8} │ {'G(M)':>8} {'G(M′)':>8} {'margin':>8}  win")
print("-" * 78)
for r in results:
    M, P = r["hyp"]["M"], r["hyp"]["Mprime"]
    md, mg = M["dnll_all"] - P["dnll_all"], M["G_all"] - P["G_all"]
    print(f"{r['id']:9} {M['dnll_all']:9.2f} {P['dnll_all']:9.2f} {md:8.2f} │ "
          f"{M['G_all']:8.2f} {P['G_all']:8.2f} {mg:8.2f}  {'M ✅' if mg > 0 else 'M′ ❌'}")

s = summary
print("-" * 78)
print(f"M 胜出计数   ΔNLL(全留出) {s['M_beats_Mprime']['dnll_all']}/{n} | "
      f"ΔNLL(仅消歧) {s['M_beats_Mprime']['dnll_disamb']}/{n} | "
      f"G(全留出) {s['M_beats_Mprime']['G_all']}/{n} | G(仅消歧) {s['M_beats_Mprime']['G_disamb']}/{n}")
print(f"平均 margin  ΔNLL {s['mean_margin']['dnll_all']:+.2f} | "
      f"ΔNLL(消歧) {s['mean_margin']['dnll_disamb']:+.2f} | "
      f"G {s['mean_margin']['G_all']:+.2f} | G(消歧) {s['mean_margin']['G_disamb']:+.2f}")
print(f"安慰剂对照   M 超过最佳安慰剂 {s['M_beats_placebo_G_all']}/{n} | "
      f"M′ 超过最佳安慰剂 {s['Mprime_beats_placebo_G_all']}/{n}")
print(f"\n[saved] {OUT}")
