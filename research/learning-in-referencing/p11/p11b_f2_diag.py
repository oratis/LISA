"""P11b — 诊断：F2（A/B 行动题）为什么几乎不动？

P11 实测 F2 = 0.570（base 0.540），而 F1 = 0.835、F3 = 0.775。
但**三档换词的顺序是对的**：own 0.570 > across 0.430 > within 0.330
⟹ 词条对 F2 **有作用、方向也对**，只是幅度被压掉了。三个互斥假设：

  H_sat    p(A) 饱和在 0/1 附近 ⟹ 差异被压进浮点噪声（P8 记录该格式有 91% 的 A 位置偏置）
  H_weak   分布正常但两组重叠 ⟹ 词条确实没迁到这个读出方向
  H_item   少数用户/物体主导，均值掩盖了双峰

判据：直接看 p(A) 的分布，并与**上下文注入**（同格式拿到 0.905）逐项对照。
若 L1 的 p(A) 分布展得开而词条的挤在一起 ⟹ H_sat；两者都展得开但词条两组重叠 ⟹ H_weak。
"""
import os, sys, json, statistics as st
import torch, torch.nn as nn, torch.nn.functional as F
from transformers import AutoTokenizer, AutoModelForCausalLM

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path[:0] = [os.path.join(ROOT, "p1"), os.path.join(ROOT, "tools")]
import microworld as mw          # noqa: E402
from probe_metrics import auc    # noqa: E402

M = "Qwen/Qwen2.5-1.5B-Instruct"; TAG = M.split("/")[-1]
import random; torch.manual_seed(0); random.seed(0); rng = random.Random(0)
tok = AutoTokenizer.from_pretrained(M, local_files_only=True)
tok.pad_token = tok.pad_token or tok.eos_token; tok.padding_side = "left"
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(M, dtype=torch.float32, local_files_only=True).to(dev).eval()
for p in model.parameters(): p.requires_grad_(False)
D = model.config.hidden_size; ENTS = list(mw.entities())
tid = lambda t: tok.encode(t, add_special_tokens=False)[0]          # noqa: E731
YES, NO = tid(" Yes"), tid(" No"); A_, B_ = tid(" A"), tid(" B")

pre_of = lambda u: f"{u['w1']} and {u['w2']} are words in Tovi's language."   # noqa: E731
def f1(w, b, pre): return f"{pre}\nQuestion: Is {b} {w}? Answer Yes or No.\nAnswer:"
def f2(w, g, b, ca, pre):
    x, y = (g, b) if ca else (b, g)
    return (f"{pre}\nTovi wants a {w} object.\n(A) {x}\n(B) {y}\n"
            f"Which one do you hand over? Answer A or B.\nAnswer:")

def wseqs(w):
    s = []
    for t in (w, " " + w):
        i = tok.encode(t, add_special_tokens=False)
        if i and i not in s: s.append(i)
    return s

def wmask(ids, w):
    m = torch.zeros(ids.shape, dtype=torch.float32, device=ids.device)
    rows = ids.tolist()
    for b, r in enumerate(rows):
        for s in wseqs(w):
            n = len(s)
            for i in range(len(r) - n + 1):
                if r[i:i+n] == s: m[b, i:i+n] = 1.0
    return m

def enc(ps):
    e = tok(ps, return_tensors="pt", padding=True).to(dev)
    e["position_ids"] = (e["attention_mask"].cumsum(-1) - 1).clamp(min=0)
    return e

cfg = json.load(open(os.path.join(ROOT, "p1", "isolation_p1.json")))[:8]
words = [c["word"] for c in cfg]; users = []
for i, c in enumerate(cfg):
    A, B = c["teacher_A"]["M"], c["teacher_B"]["M"]
    oa = [mw.describe(e) for e in ENTS if e["color"] == A]
    ob = [mw.describe(e) for e in ENTS if e["color"] == B]
    rng.shuffle(oa); rng.shuffle(ob)
    users.append(dict(uid=c["id"], w1=c["word"], w2=words[(i+1) % len(words)],
                      cA=A, cB=B, tr_a=oa[:6], tr_b=ob[:6], pb_a=oa[6:11], pb_b=ob[6:11],
                      other=words[(i+3) % len(words)]))

LAYER = 7
hold = {"masks": None}
V = [nn.Parameter(torch.zeros(D, device=dev)), nn.Parameter(torch.zeros(D, device=dev))]
def hook(_m, _i, out):
    h = out[0] if isinstance(out, tuple) else out
    ms = hold["masks"]
    if not ms or ms[0].shape[:2] != h.shape[:2]: return out
    h2 = h + sum(m.unsqueeze(-1) * v for m, v in zip(ms, V))
    return ((h2,) + out[1:]) if isinstance(out, tuple) else h2
model.model.layers[LAYER].register_forward_hook(hook)

def pA(prompts, w1, w2, on=True):
    e = enc(prompts)
    hold["masks"] = ([wmask(e["input_ids"], w1), wmask(e["input_ids"], w2)] if on
                     else [torch.zeros_like(e["attention_mask"], dtype=torch.float32)] * 2)
    with torch.no_grad():
        lg = model(**e, logits_to_keep=1).logits[:, -1]
        return torch.softmax(torch.stack([lg[:, A_], lg[:, B_]], -1), -1)[:, 0].tolist()

print("=" * 96)
print("P11b — F2 为什么不动？逐项对照 p(A) 的分布")
print("=" * 96)
rows = []
for u in users:
    p = pre_of(u)
    # 训练该用户的两个词条（与 P11 完全相同的设置）
    for v in V: v.data.zero_()
    objs = u["tr_a"] + u["tr_b"]
    tr = [f1(u["w1"], b, p) for b in objs] + [f1(u["w2"], b, p) for b in objs]
    y = torch.tensor([1.]*6 + [0.]*6 + [0.]*6 + [1.]*6, device=dev)
    e_tr = enc(tr); m_tr = [wmask(e_tr["input_ids"], u["w1"]), wmask(e_tr["input_ids"], u["w2"])]
    with torch.no_grad():
        hold["masks"] = m_tr
        probe = {}
        h_ = model.model.layers[LAYER].register_forward_hook(
            lambda _m, _i, o, _p=probe: _p.__setitem__("h", (o[0] if isinstance(o, tuple) else o).detach()))
        model(**e_tr, logits_to_keep=1); h_.remove()
        sel = (m_tr[0] + m_tr[1]) > 0
        cap = probe["h"][sel].norm(dim=-1).mean().item()
    opt = torch.optim.Adam(V, lr=5e-2)
    for _ in range(300):
        opt.zero_grad(); hold["masks"] = m_tr
        lg = model(**e_tr, logits_to_keep=1).logits[:, -1]
        F.binary_cross_entropy_with_logits(lg[:, YES] - lg[:, NO], y).backward(); opt.step()
        with torch.no_grad():
            for v in V:
                n = v.norm()
                if n > cap: v.mul_(cap / n)

    posP = [f2(u["w1"], g, b, True, p) for g, b in zip(u["pb_a"], u["pb_b"])]
    negP = [f2(u["w1"], g, b, False, p) for g, b in zip(u["pb_a"], u["pb_b"])]
    # 三个臂：词条 / 无词条(base) / 定义进上下文(L1)
    preL1 = f"{u['w1']} means {u['cA']}. {u['w2']} means {u['cB']}."
    arms = {
        "词条(L7)":  (pA(posP, u["w1"], u["w2"], True),  pA(negP, u["w1"], u["w2"], True)),
        "base":     (pA(posP, u["w1"], u["w2"], False), pA(negP, u["w1"], u["w2"], False)),
        "L1 上下文": (pA([f2(u["w1"], g, b, True, preL1) for g, b in zip(u["pb_a"], u["pb_b"])],
                        u["w1"], u["w2"], False),
                     pA([f2(u["w1"], g, b, False, preL1) for g, b in zip(u["pb_a"], u["pb_b"])],
                        u["w1"], u["w2"], False)),
    }
    for k, (P_, N_) in arms.items():
        rows.append((u["uid"], k, auc(P_, N_), st.mean(P_), st.mean(N_),
                     st.mean(P_ + N_), max(P_ + N_) - min(P_ + N_),
                     st.mean(1.0 if x > .5 else 0.0 for x in P_ + N_)))
    print(f"  [{u['uid']}] " + " · ".join(
        f"{k} AUC {auc(*arms[k]):.3f} p(A)均 {st.mean(arms[k][0]+arms[k][1]):.3f} "
        f"展幅 {max(arms[k][0]+arms[k][1])-min(arms[k][0]+arms[k][1]):.3f}" for k in arms), flush=True)

print("\n" + "=" * 96)
print(f"{'臂':12}{'AUC':>8}{'p(A|正例)':>11}{'p(A|负例)':>11}{'p(A) 均值':>11}{'p(A) 展幅':>11}{'选A率':>9}")
print("-" * 96)
agg = {}
for k in ("词条(L7)", "base", "L1 上下文"):
    sel = [r for r in rows if r[1] == k]
    agg[k] = dict(auc=st.mean(r[2] for r in sel), pa_pos=st.mean(r[3] for r in sel),
                  pa_neg=st.mean(r[4] for r in sel), pa=st.mean(r[5] for r in sel),
                  spread=st.mean(r[6] for r in sel), chooseA=st.mean(r[7] for r in sel))
    d = agg[k]
    print(f"{k:12}{d['auc']:8.3f}{d['pa_pos']:11.3f}{d['pa_neg']:11.3f}"
          f"{d['pa']:11.3f}{d['spread']:11.3f}{d['chooseA']:9.3f}")

print("\n【判读】")
e, l1 = agg["词条(L7)"], agg["L1 上下文"]
sep_e, sep_l = e["pa_pos"] - e["pa_neg"], l1["pa_pos"] - l1["pa_neg"]
print(f"  正负例的 p(A) 之差：词条 {sep_e:+.3f} · L1 {sep_l:+.3f}   （差越大越能分开）")
if e["spread"] < 0.15 and l1["spread"] > 0.3:
    print("  ⟹ **H_sat**：词条条件下 p(A) 挤在一起（展幅 <0.15）而 L1 展得开 ⟹ 饱和/偏置吃掉了分辨率")
elif e["spread"] > 0.3 and abs(sep_e) < 0.1:
    print("  ⟹ **H_weak**：分布展得开但两组几乎不分离 ⟹ 词条**确实没迁到这个读出方向**")
else:
    print(f"  ⟹ 两条都不干净（展幅 {e['spread']:.3f}，正负例差 {sep_e:+.3f}）——须看逐用户是否双峰（H_item）")
aucs = sorted(r[2] for r in rows if r[1] == "词条(L7)")
print(f"  逐用户 AUC（词条）: {[round(a,2) for a in aucs]}")
print("  ⟹ " + ("**H_item**：逐用户明显双峰，均值有误导性" if aucs[-1] - aucs[0] > 0.5 else "非双峰，均值可用"))
json.dump({"per_user": [dict(zip(("uid","arm","auc","pa_pos","pa_neg","pa","spread","chooseA"), r)) for r in rows],
           "agg": agg}, open(os.path.join(HERE, f"p11b_f2diag_{TAG}.json"), "w"), indent=2, ensure_ascii=False)
print(f"\n[saved] p11b_f2diag_{TAG}.json")
