"""诊断：记忆输出 m(h) 到底依不依赖提示里的那个词？——零训练，直接用 P9b 存下的权重

P9b 的换词 AUC 已经显示"换词几乎不掉"（落差 0.017–0.018），但那是**行为证据**。
本诊断给出**机制证据**：同一个物体，只把提示里的伪词换掉，看记忆输出本身变不变。

  m(h) 余弦 ≈ 1.000  ⟹ 记忆输出与词**完全无关**，它打的是物体的标
  路由命中槽相同    ⟹ product-key 路由**分辨不出**是哪个词在被问

⚠️ 但"输出变了"**不等于**"决策变了"。post-norm 上 m(h) 余弦只有 0.787（明显随词变），
   而 P9b 的换词 AUC 却只掉 0.017 ⟹ **变化的分量与决策方向正交**。
   所以真正的判据是 **m(h) 在决策方向 (W_yes − W_no) 上的投影**换词后变不变。
   本诊断把两个量都算出来，缺一会得出相反的结论。

★ 这与 P5 §3.2 是同一个病的更深一层：
  那次是"提示只在物体上不同 → 隐状态近乎平行 → 路由塌缩"，靠余弦归一化救回了**物体**的分辨；
  但**词**对整句隐状态的扰动比物体还小，余弦归一化救不回来。
"""
import os, sys, json, glob, statistics as st
import torch, torch.nn as nn, torch.nn.functional as F
from transformers import AutoTokenizer, AutoModelForCausalLM

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path[:0] = [os.path.join(ROOT, "p1")]
import microworld as mw

M_ = "Qwen/Qwen2.5-1.5B-Instruct"; dev = "mps"
tok = AutoTokenizer.from_pretrained(M_, local_files_only=True)
tok.pad_token = tok.pad_token or tok.eos_token; tok.padding_side = "left"
model = AutoModelForCausalLM.from_pretrained(M_, dtype=torch.float32,
                                             local_files_only=True).to(dev).eval()
for p in model.parameters(): p.requires_grad_(False)
D = model.config.hidden_size; ENTS = list(mw.entities())
W = model.lm_head.weight
W_YN = W[tok.encode(" Yes", add_special_tokens=False)[0]] - W[tok.encode(" No", add_special_tokens=False)[0]]


class SlotMemory(nn.Module):
    def __init__(self, d, n=32, k=4, temp=10.0):
        super().__init__()
        self.topk, self.temp = k, temp
        self.keys = nn.Parameter(torch.zeros(n, d)); self.values = nn.Parameter(torch.zeros(n, d))

    def route(self, h):
        sim = F.normalize(h, dim=-1) @ F.normalize(self.keys, dim=-1).T * self.temp
        w, idx = torch.topk(sim, self.topk, dim=-1)
        return torch.softmax(w, dim=-1), idx

    def forward(self, h):
        w, idx = self.route(h)
        return (w.unsqueeze(-1) * self.values[idx]).sum(-2)


def enc(ps):
    e = tok(ps, return_tensors="pt", padding=True).to(dev)
    e["position_ids"] = (e["attention_mask"].cumsum(-1) - 1).clamp(min=0)
    return e


def f1(w, b):
    return (f"{w} is a word in Tovi's language.\n"
            f"Question: Is {b} {w}? Answer Yes or No.\nAnswer:")


cfg = json.load(open(os.path.join(ROOT, "p1", "isolation_p1.json")))[:8]
WORDS = [c["word"] for c in cfg]
objs = [mw.describe(e) for e in ENTS[:8]]


def pos_neg(c):
    """该用户的正例（自己含义的颜色）与负例（对方含义的颜色）物体"""
    a, b = c["teacher_A"]["M"], c["teacher_B"]["M"]
    return ([mw.describe(e) for e in ENTS if e["color"] == a][:6],
            [mw.describe(e) for e in ENTS if e["color"] == b][:6])

print("=" * 86)
print("诊断：m(h) 对提示里那个词的依赖（零训练，用 P9b 存下的记忆）")
print("=" * 86)
out = {}
for label in ("L7", "post-norm"):
    coss, dels, same_slots, hcos, projs, proj_abs, gaps = [], [], [], [], [], [], []
    for i, c in enumerate(cfg):
        f = os.path.join(HERE, "memories", f"{label}_{c['id']}.pt")
        if not os.path.exists(f):
            continue
        sd = torch.load(f, map_location=dev)
        mem = SlotMemory(D, sd["keys"].shape[0]).to(dev)
        mem.load_state_dict(sd)
        own, other = c["word"], WORDS[(i + 1) % len(WORDS)]
        with torch.no_grad():
            def states(w):
                e = enc([f1(w, b) for b in objs])
                h = model.model(**e).last_hidden_state[:, -1]
                return model.model.norm(h) if label == "post-norm" else h
            # ⚠️ L7 的 hook 作用在第 7 层输出上；这里用最后一层近似**不成立**，
            #    故 L7 走真实的第 7 层输出
            if label == "L7":
                def states(w):
                    e = enc([f1(w, b) for b in objs])
                    hs = model.model(**e, output_hidden_states=True).hidden_states
                    return hs[8][:, -1]        # hidden_states[0]=embedding ⟹ 第 7 层输出 = [8]
            h1, h2 = states(own), states(other)
            m1, m2 = mem(h1), mem(h2)
            _, i1 = mem.route(h1); _, i2 = mem.route(h2)
            # ★ 决策方向上的分量（post-norm 上 m(h) 直接进 lm_head，可精确算）
            if label == "post-norm":
                d_yn = W_YN.unsqueeze(0)
                pj1 = (m1 * d_yn).sum(-1); pj2 = (m2 * d_yn).sum(-1)
                projs.append(((pj1 - pj2).abs() / pj1.abs().clamp(min=1e-9)).mean().item())
                proj_abs.append((pj1.mean().item(), pj2.mean().item()))
                # ★★ AUC 只看排序 ⟹ 真正对应的量是【正例−负例】的投影差
                P_, N2_ = pos_neg(c)
                def gap(w):
                    hp = model.model.norm(model.model(**enc([f1(w, b) for b in P_])).last_hidden_state[:, -1])
                    hn = model.model.norm(model.model(**enc([f1(w, b) for b in N2_])).last_hidden_state[:, -1])
                    return ((mem(hp) * d_yn).sum(-1).mean() - (mem(hn) * d_yn).sum(-1).mean()).item()
                gaps.append((gap(own), gap(other)))
            coss.append(F.cosine_similarity(m1, m2, dim=-1).mean().item())
            dels.append(((m1 - m2).norm(dim=-1) / m1.norm(dim=-1).clamp(min=1e-9)).mean().item())
            same_slots.append(st.mean(len(set(a.tolist()) & set(b.tolist())) / len(a)
                                      for a, b in zip(i1, i2)))
            hcos.append(F.cosine_similarity(h1, h2, dim=-1).mean().item())
    if not coss:
        continue
    out[label] = dict(m_cosine=st.mean(coss), m_rel_change=st.mean(dels),
                      routed_slot_overlap=st.mean(same_slots), h_cosine=st.mean(hcos), n=len(coss))
    if projs:
        out[label]["decision_proj_rel_change"] = st.mean(projs)
    if gaps:
        out[label]["decision_gap_own"] = st.mean(a for a, _ in gaps)
        out[label]["decision_gap_swapped"] = st.mean(b for _, b in gaps)
    print(f"\n{label}  （{len(coss)} 个用户）")
    print(f"  隐状态 h 本身换词后的余弦        : {st.mean(hcos):.6f}")
    print(f"  ★ 记忆输出 m(h) 换词后的余弦      : {st.mean(coss):.6f}")
    print(f"  ★ m(h) 相对变化 ‖Δm‖/‖m‖         : {st.mean(dels):.6f}")
    print(f"  ★ 路由命中的槽 换词后的重合率      : {st.mean(same_slots):.3f}")
    if projs:
        print(f"  ★ m(h) 在决策方向上的投影 相对变化  : {st.mean(projs):.3f}"
              f"   （本词 {st.mean(a for a, _ in proj_abs):+.3f} → 换词 {st.mean(b for _, b in proj_abs):+.3f}）")
    if gaps:
        go, gs = st.mean(a for a, _ in gaps), st.mean(b for _, b in gaps)
        print(f"  ★★ 【正例−负例】的投影差（AUC 对应量）: 本词 {go:+.3f} → 换词 {gs:+.3f}"
              f"   保留 {gs / go * 100 if go else float('nan'):.0f}%")

print("\n【判读】")
for label, d in out.items():
    dp = d.get("decision_proj_rel_change")
    keep = (d.get("decision_gap_swapped", 0) / d["decision_gap_own"]) if d.get("decision_gap_own") else None
    if d["m_cosine"] > 0.999 and d["routed_slot_overlap"] > 0.99:
        v = ("🔴 **路由层面就看不见词**：命中同一批槽、输出逐位相同 ⟹ 打的是物体的标")
    elif keep is not None and keep > 0.8:
        v = (f"🔴 **输出随词变（余弦 {d['m_cosine']:.3f}）但判别力不变**："
             f"整体投影确实随词漂移，但**【正例−负例】的差保留了 {keep:.0%}** —— "
             f"词只平移了偏置，没改变排序 ⟹ 行为上仍与词无关（与 P9b 换词 AUC 只掉 0.017 一致）")
    elif keep is not None and keep < 0.3:
        v = f"✅ **绑定到词**：换词后【正例−负例】的差只剩 {keep:.0%}"
    elif d["m_cosine"] > 0.99:
        v = "🔴 几乎与词无关"
    else:
        v = f"◐ 判别力保留 {keep:.0%}（须结合换词 AUC 一起判）"
    print(f"  {label:12} {v}")
json.dump(out, open(os.path.join(HERE, "diag_word_independence.json"), "w"), indent=2)
print(f"\n[saved] p9/diag_word_independence.json")
