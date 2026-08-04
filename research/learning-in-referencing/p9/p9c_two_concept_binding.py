"""P9c — 补救 P9b 揭出的漏洞：**一个用户教两个词**时，记忆会不会真的绑定到词？

P9b 的坏消息：每用户只教一个词时，换成别人的词，AUC 几乎不掉
  L7 落差 0.018 · post-norm 落差 0.017
⟹ 记忆学的是「给这类物体打标」，**不是「这个词指这类物体」**。

★ 但这个失败**可能是实验设置逼出来的，而不是方法的性质**：
  一个用户只有一个词时，「w 指蓝色」与「给蓝色物体打标」**在训练集上外延完全相同**，
  梯度没有任何理由去关心那个词。**设置本身欠定**。

  P7 是唯一的例外：每人学两个词（w1=颜色、w2=材质）。同一个物体在两个词下标签不同，
  光靠物体打标**不可能**同时在两个探针上都拿高分（P7 实测 0.812 / 0.889）。

★ 本实验直接验这一点，用三档换词：
  own        —— 用本人自己的词（参照）
  within     —— ★ 把 w1 探针里的词换成**同一用户的 w2**。
                 若真绑定到词，答案应改按 w2（材质）走 ⟹ 对 w1 标签的 AUC **应崩到 ≈0.5 或更低**
  across     —— 换成**别人**的词（P9b 用的那一档）

  ⚠️ within 才是硬测试：它与 own 的提示**只差那一个词**，且两个词都在同一个记忆分区里训过。

同时回答第二个问题：**在真的绑定到词的设置下，P9 的跨读出方向迁移还成立吗？**
（F2 A/B、F3 True/False 始终 held-out，训练只用 F1。）
"""
import os, sys, json, time, argparse, random, statistics as st
import torch
import torch.nn as nn
import torch.nn.functional as F
from transformers import AutoTokenizer, AutoModelForCausalLM

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path[:0] = [os.path.join(ROOT, "p1"), os.path.join(ROOT, "tools")]
import microworld as mw          # noqa: E402
import lexicon                   # noqa: E402
from probe_metrics import auc    # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="Qwen/Qwen2.5-1.5B-Instruct")
ap.add_argument("--users", type=int, default=8)
ap.add_argument("--slots", type=int, default=32)
ap.add_argument("--topk", type=int, default=4)
ap.add_argument("--epochs", type=int, default=300)
ap.add_argument("--lr", type=float, default=5e-2)
ap.add_argument("--layers", default="post-norm")   # P7 用的正是 post-norm；L7 另跑
ap.add_argument("--seed", type=int, default=0)
args = ap.parse_args()
TAG = args.model.split("/")[-1]
torch.manual_seed(args.seed); random.seed(args.seed)
rng = random.Random(args.seed)

print(f"[load] {args.model}", flush=True)
tok = AutoTokenizer.from_pretrained(args.model, local_files_only=True)
if tok.pad_token is None:
    tok.pad_token = tok.eos_token
tok.padding_side = "left"
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.float32,
                                             local_files_only=True).to(dev).eval()
for p in model.parameters():
    p.requires_grad_(False)
D = model.config.hidden_size
ENTS = list(mw.entities())
print(f"[load] done · {dev}\n", flush=True)


def tid(t):
    return tok.encode(t, add_special_tokens=False)[0]


FMT = {"F1 Yes/No": (tid(" Yes"), tid(" No")),
       "F2 A/B": (tid(" A"), tid(" B")),
       "F3 True/False": (tid(" True"), tid(" False"))}
PRE = "{w1} and {w2} are words in Tovi's language."


def f1(w, body, pre):
    return f"{pre}\nQuestion: Is {body} {w}? Answer Yes or No.\nAnswer:"


def f2(w, good, bad, ca, pre):
    a, b = (good, bad) if ca else (bad, good)
    return (f"{pre}\nTovi wants a {w} object.\n(A) {a}\n(B) {b}\n"
            f"Which one do you hand over? Answer A or B.\nAnswer:")


def f3(w, body, pre):
    return f"{pre}\nStatement: {body} is {w}.\nIs this statement true or false? Answer:"


def encode(ps):
    e = tok(ps, return_tensors="pt", padding=True).to(dev)
    e["position_ids"] = (e["attention_mask"].cumsum(-1) - 1).clamp(min=0)
    return e


class SlotMemory(nn.Module):
    def __init__(self, d, n=32, k=4, temp=10.0, init=0.01):
        super().__init__()
        self.topk, self.temp = min(k, n), temp
        self.keys = nn.Parameter(torch.randn(n, d) * init)
        self.values = nn.Parameter(torch.zeros(n, d))

    def forward(self, h):
        sim = F.normalize(h, dim=-1) @ F.normalize(self.keys, dim=-1).T * self.temp
        w, idx = torch.topk(sim, self.topk, dim=-1)
        return (torch.softmax(w, dim=-1).unsqueeze(-1) * self.values[idx]).sum(-2)


def attach(mem, where):
    def hook(_m, _i, out):
        h = out[0] if isinstance(out, tuple) else out
        h2 = h + mem(h)
        return ((h2,) + out[1:]) if isinstance(out, tuple) else h2
    t = model.model.norm if where == "post-norm" else model.model.layers[where]
    return t.register_forward_hook(hook)


# ---------- 用户：每人两个词（颜色 + 材质），与 P7 同构 ----------
words, _ = lexicon.make_lexicon(2 * args.users, seed=args.seed + 7)
users = []
for i in range(args.users):
    col = mw.COLORS[i % len(mw.COLORS)]
    mat = mw.MATERIALS[(i // len(mw.COLORS) + i) % len(mw.MATERIALS)]
    w1, w2 = words[2 * i], words[2 * i + 1]
    pre = PRE.format(w1=w1, w2=w2)

    def pick(attr, val, k, excl=()):
        y = [e for e in ENTS if e[attr] == val and mw.describe(e) not in excl]
        n = [e for e in ENTS if e[attr] != val and mw.describe(e) not in excl]
        rng.shuffle(y); rng.shuffle(n)
        return [(mw.describe(e), 1.0) for e in y[:k // 2]] + [(mw.describe(e), 0.0) for e in n[:k // 2]]

    tr1, tr2 = pick("color", col, 12), pick("material", mat, 12)
    seen = {b for b, _ in tr1 + tr2}
    pb1, pb2 = pick("color", col, 10, seen), pick("material", mat, 10, seen)
    users.append(dict(uid=f"u{i:02d}", w1=w1, w2=w2, c1=col, c2=mat, pre=pre,
                      tr=tr1 + tr2, pb1=pb1, pb2=pb2,
                      other=words[(2 * i + 2) % len(words)]))     # 别人的词
NU = len(users)
print("每人两词，例：" + " · ".join(f"{u['w1']}={u['c1']}/{u['w2']}={u['c2']}" for u in users[:3]) + " …\n")

for u in users:
    u["enc_tr"] = encode([f1(u["w1"], b, u["pre"]) for b, _ in u["tr"][:12]] +
                         [f1(u["w2"], b, u["pre"]) for b, _ in u["tr"][12:]])
    u["t_tr"] = torch.tensor([t for _, t in u["tr"]], device=dev)
    # 三档换词 × 三种格式，全部针对 **w1 的探针与 w1 的标签**
    u["enc"] = {}
    for cond, w in (("own", u["w1"]), ("within", u["w2"]), ("across", u["other"])):
        pos = [b for b, t in u["pb1"] if t == 1.0]
        neg = [b for b, t in u["pb1"] if t == 0.0]
        u["enc"][cond] = {
            "F1 Yes/No": (encode([f1(w, b, u["pre"]) for b in pos]),
                          encode([f1(w, b, u["pre"]) for b in neg])),
            "F2 A/B": (encode([f2(w, g, b, True, u["pre"]) for g, b in zip(pos, neg)]),
                       encode([f2(w, g, b, False, u["pre"]) for g, b in zip(pos, neg)])),
            "F3 True/False": (encode([f3(w, b, u["pre"]) for b in pos]),
                              encode([f3(w, b, u["pre"]) for b in neg]))}
    # w2 自己的探针（证明两个词都学会了，否则 within 崩塌不可解释）
    p2p = [b for b, t in u["pb2"] if t == 1.0]
    p2n = [b for b, t in u["pb2"] if t == 0.0]
    u["enc_w2"] = (encode([f1(u["w2"], b, u["pre"]) for b in p2p]),
                   encode([f1(u["w2"], b, u["pre"]) for b in p2n]))


def score(enc, fmt):
    P, N_ = FMT[fmt]
    with torch.no_grad():
        lg = model(**enc, logits_to_keep=1).logits[:, -1]
        return torch.softmax(torch.stack([lg[:, P], lg[:, N_]], -1), -1)[:, 0].tolist()


RES = {}
for wspec in args.layers.split(","):
    where = wspec if wspec == "post-norm" else int(wspec)
    label = wspec if wspec == "post-norm" else f"L{wspec}"
    print("=" * 92); print(f"插入位置 {label}"); print("=" * 92)
    t0 = time.time()
    for u in users:
        mem = SlotMemory(D, args.slots, args.topk).to(dev)
        hd = attach(mem, where)
        opt = torch.optim.Adam(mem.parameters(), lr=args.lr)
        P, N_ = FMT["F1 Yes/No"]
        for _ in range(args.epochs):
            opt.zero_grad()
            lg = model(**u["enc_tr"], logits_to_keep=1).logits[:, -1]
            F.binary_cross_entropy_with_logits(lg[:, P] - lg[:, N_], u["t_tr"]).backward()
            opt.step()
        # ★ 决定性诊断：同一物体、只换提示里的词，记忆输出 m(h) 变不变？
        #   若 m(h) 几乎不变 ⟹ 记忆输出**与词无关**，它打的是物体的标，
        #   那么"两个词各自都答对"就只能靠一个**与词无关的分级标**来解释（如"红或木，两者都占更重"），
        #   而不是靠绑定到词。这一条直接决定 P7 的 I2 结论还能不能站。
        with torch.no_grad():
            objs = [b for b, _ in u["pb1"]][:6]
            h1 = torch.cat([model.model(**encode([f1(u["w1"], b, u["pre"])])).last_hidden_state[:, -1]
                            for b in objs])
            h2 = torch.cat([model.model(**encode([f1(u["w2"], b, u["pre"])])).last_hidden_state[:, -1]
                            for b in objs])
            if where == "post-norm":
                h1, h2 = model.model.norm(h1), model.model.norm(h2)
            m1, m2 = mem(h1), mem(h2)
            u[f"{label}_mcos"] = F.cosine_similarity(m1, m2, dim=-1).mean().item()
            u[f"{label}_mrel"] = ((m1 - m2).norm(dim=-1) / m1.norm(dim=-1).clamp(min=1e-9)).mean().item()
        for cond in ("own", "within", "across"):
            for fmt in FMT:
                a, b = u["enc"][cond][fmt]
                u[f"{label}_{cond}_{fmt}"] = auc(score(a, fmt), score(b, fmt))
        a, b = u["enc_w2"]
        u[f"{label}_w2"] = auc(score(a, "F1 Yes/No"), score(b, "F1 Yes/No"))
        hd.remove()
        print(f"  [{u['uid']}] w1 {u[f'{label}_own_F1 Yes/No']:.3f} · w2 {u[f'{label}_w2']:.3f}"
              f"  ·  ★换成 w2 {u[f'{label}_within_F1 Yes/No']:.3f}"
              f" · 换成别人 {u[f'{label}_across_F1 Yes/No']:.3f}"
              f"  |  m(h) 换词后余弦 {u[f'{label}_mcos']:.4f}", flush=True)
    RES[label] = {"w2_own_probe": st.mean(u[f"{label}_w2"] for u in users),
                  "m_cosine_w1_vs_w2": st.mean(u[f"{label}_mcos"] for u in users),
                  "m_relative_change": st.mean(u[f"{label}_mrel"] for u in users),
                  **{c: {f: st.mean(u[f"{label}_{c}_{f}"] for u in users) for f in FMT}
                     for c in ("own", "within", "across")}}
    json.dump({"model": args.model, "n_users": NU, "design": "每用户两个概念（P7 同构）",
               "results": RES}, open(os.path.join(HERE, f"p9c_{TAG}.json"), "w"),
              indent=2, ensure_ascii=False)
    print(f"  ({(time.time() - t0) / 60:.1f} min) · 已落盘")

print("\n" + "=" * 92)
print(f"P9c 两概念设置下的词绑定  ·  {TAG}  ·  {NU} 用户  ·  只训 F1，全部针对 w1 的探针与标签")
print("=" * 92)
for label, d in RES.items():
    print(f"\n{label}   （w2 自己的探针 {d['w2_own_probe']:.3f} —— 两个词都学会了才谈得上绑定）")
    print(f"  {'提示里用的词':22}" + "".join(f"{f:>16}" for f in FMT))
    print("  " + "-" * 70)
    for c, nm in (("own", "w1（本词）"), ("within", "★ 换成同用户的 w2"), ("across", "换成别人的词")):
        print(f"  {nm:20}" + "".join(f"{d[c][f]:16.3f}" for f in FMT))
    print(f"  {'own − within':20}" + "".join(f"{d['own'][f] - d['within'][f]:16.3f}" for f in FMT))

print("\n【裁决 1：两概念设置能否逼出词绑定】")
for label, d in RES.items():
    wi = d["within"]["F1 Yes/No"]
    ow = d["own"]["F1 Yes/No"]
    if d["w2_own_probe"] < 0.65:
        v = f"⚪ 不可判：w2 本身没学会（{d['w2_own_probe']:.3f}）"
    elif wi < 0.60 and ow > 0.75:
        v = (f"✅ **绑定到词**：换成 w2 后对 w1 标签的 AUC 掉到 {wi:.3f}（本词 {ow:.3f}）"
             f" ⟹ P9b 的失败是**单概念设置欠定**造成的，不是方法的性质")
    elif ow - wi > 0.15:
        v = f"◐ 部分绑定：落差 {ow - wi:+.3f}（本词 {ow:.3f} → 换 w2 {wi:.3f}）"
    else:
        v = (f"🔴 **仍未绑定**：换成 w2 后仍有 {wi:.3f}（本词 {ow:.3f}）"
             f" ⟹ 两概念也逼不出词绑定，「学到了一个概念」必须整体撤回")
    print(f"  {label:12} {v}")

print("\n【★ 诊断：记忆输出 m(h) 到底依不依赖那个词】")
for label, d in RES.items():
    c, r = d["m_cosine_w1_vs_w2"], d["m_relative_change"]
    print(f"  {label:12} 同一物体、只换词 ⟹ m(h) 余弦 {c:.4f} · 相对变化 {r:.4f}")
    if c > 0.99 and r < 0.15:
        print("               🔴 **记忆输出与词无关** —— 它打的是物体的标。")
        print("                  ⟹「两个词各自都答对」只能靠一个**与词无关的分级标**解释，")
        print("                     不是词绑定。**P7 的 I2 结论也须重新审视。**")
    elif c < 0.90:
        print("               ⚠️ 记忆输出**随词改变**（路由读到了词），"
              "但**这不等于行为上绑定**：")
        print("                  diag_word_independence.py 实测 post-norm 上词只平移整体偏置，")
        print("                  【正例−负例】的投影差保留 97% ⟹ 排序不变 ⟹ AUC 不变。")
        print("                  ⟹ **以换词 AUC 为准**（本轮 own 与 within 差 −0.005）：仍未绑定。")
    else:
        print("               ◐ 弱依赖，须结合换词 AUC 一起判")

print("\n【裁决 2：绑定成立时，跨读出方向的迁移还在不在】")
for label, d in RES.items():
    x = st.mean([d["own"]["F2 A/B"], d["own"]["F3 True/False"]])
    print(f"  {label:12} 跨方向均值 {x:.3f}（F2 {d['own']['F2 A/B']:.3f} · F3 {d['own']['F3 True/False']:.3f}）")
print(f"\n[saved] p9c_{TAG}.json")
